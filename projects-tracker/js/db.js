// ===================================================================
//  db.js — Firestore data layer
//  All reads/writes to the cloud database go through this module.
//  Uses the Firebase v10 modular SDK loaded from Google's CDN.
//
//  Data model: everything that belongs to one job site lives under
//  projects/{projectId}/... as a subcollection (units, buildings,
//  complaints, parts, visits, workdays, updates). Vacations and vehicle
//  inventory are staff-level, not tied to any one project, so they stay
//  as top-level collections.
// ===================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  addDoc, onSnapshot, query, orderBy, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig, isConfigured } from "./firebase-config.js";

export { isConfigured };

let db = null;

/** Initialise Firebase + Firestore (with offline persistence). */
export function initDb() {
  if (!isConfigured) return null;
  const app = initializeApp(firebaseConfig);
  // Offline-first: cache keeps the app working with no signal in the field
  // and syncs automatically when the connection returns.
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  return db;
}

// ---- Projects (top-level: one per job site) ------------------------
const projectsCol = () => collection(db, "projects");

export function watchProjects(onData, onError) {
  return onSnapshot(projectsCol(),
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "he"))),
    (err) => onError && onError(err)
  );
}
export async function addProject(data) {
  const ref = await addDoc(projectsCol(), {
    name:    data.name?.trim()    || "",
    client:  data.client?.trim()  || "",
    address: data.address?.trim() || "",
    notes:   data.notes?.trim()   || "",
    cover:   data.cover || "",
    createdAt: serverTimestamp(),
  });
  return ref.id;
}
export async function updateProject(id, fields) {
  await updateDoc(doc(db, "projects", id), fields);
}
/** Delete a project and every subcollection doc that lives under it. */
export async function deleteProject(id) {
  const subcols = ["units", "buildings", "complaints", "parts", "visits", "workdays", "updates"];
  for (const name of subcols) {
    const snap = await getDocs(collection(db, "projects", id, name));
    for (const d of snap.docs) {
      // units carry their own services/photos sub-subcollections
      if (name === "units") {
        for (const sub of ["services", "photos"]) {
          const subSnap = await getDocs(collection(db, "projects", id, "units", d.id, sub));
          for (const s of subSnap.docs) await deleteDoc(s.ref);
        }
      }
      await deleteDoc(d.ref);
    }
  }
  await deleteDoc(doc(db, "projects", id));
}

// ---- Units ----------------------------------------------------------
const unitsCol = (pid) => collection(db, "projects", pid, "units");
const servicesCol = (pid, barcode) => collection(db, "projects", pid, "units", String(barcode), "services");

/**
 * Subscribe to ALL units of a project in real time.
 * @param {string} pid  project id
 * @param {(units: object[]) => void} onData  called on every change
 * @param {(err: Error) => void} onError
 * @returns {() => void} unsubscribe
 */
export function watchUnits(pid, onData, onError) {
  const q = query(unitsCol(pid), orderBy("updatedAt", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err)
  );
}

/** Create or fully overwrite a unit. Uses the barcode as the document id. */
export async function saveUnit(pid, unit) {
  const barcode = String(unit.barcode).trim();
  if (!barcode) throw new Error("ברקוד חסר");
  const ref = doc(db, "projects", pid, "units", barcode);
  const existing = await getDoc(ref);
  const payload = {
    barcode,
    building: unit.building?.trim() || "",
    type:     unit.type?.trim()     || "",
    location: unit.location?.trim() || "",
    notes:    unit.notes?.trim()    || "",
    oldSku:   unit.oldSku?.trim()   || "",
    area:     unit.area?.trim()     || "",
    updatedAt: serverTimestamp(),
  };
  if (unit.status) payload.status = unit.status;
  if (!existing.exists()) { payload.createdAt = serverTimestamp(); if (!payload.status) payload.status = "not_started"; }
  await setDoc(ref, payload, { merge: true });
  return barcode;
}

/** Patch a subset of fields on a unit. */
export async function updateUnit(pid, barcode, fields) {
  const ref = doc(db, "projects", pid, "units", String(barcode));
  await updateDoc(ref, { ...fields, updatedAt: serverTimestamp() });
}

/** Delete a unit (note: service subcollection docs are left as orphans in
 *  Firestore — fine for personal scale; a Cloud Function could cascade). */
export async function deleteUnit(pid, barcode) {
  await deleteDoc(doc(db, "projects", pid, "units", String(barcode)));
}

// ---- Service history ----------------------------------------------

/** Watch the service log for one unit, newest first. */
export function watchServices(pid, barcode, onData, onError) {
  const q = query(servicesCol(pid, barcode), orderBy("date", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err)
  );
}

/** Add a service entry AND update the unit's "last service" summary. */
export async function addService(pid, barcode, { date, description, technician }) {
  await addDoc(servicesCol(pid, barcode), {
    date: date || new Date().toISOString().slice(0, 10),
    description: description?.trim() || "",
    technician: technician?.trim() || "",
    createdAt: serverTimestamp(),
  });
  await updateUnit(pid, barcode, {
    lastService: description?.trim() || "",
    lastServiceDate: date || new Date().toISOString().slice(0, 10),
  });
}

/** Edit an existing service entry, then refresh the unit summary. */
export async function updateService(pid, barcode, id, fields) {
  const ref = doc(db, "projects", pid, "units", String(barcode), "services", id);
  await updateDoc(ref, {
    date: fields.date,
    description: fields.description?.trim() || "",
    technician: fields.technician?.trim() || "",
  });
  await recomputeLast(pid, barcode);
}

/** Delete a service entry, then refresh the unit summary. */
export async function deleteService(pid, barcode, id) {
  await deleteDoc(doc(db, "projects", pid, "units", String(barcode), "services", id));
  await recomputeLast(pid, barcode);
}

/** Recompute a unit's "last service" from its newest remaining entry. */
async function recomputeLast(pid, barcode) {
  const q = query(servicesCol(pid, barcode), orderBy("date", "desc"));
  const snap = await getDocs(q);
  const top = snap.docs[0]?.data();
  await updateUnit(pid, barcode, {
    lastService: top?.description || "",
    lastServiceDate: top?.date || "",
  });
}

// ---- One-time seed / migration ------------------------------------

/** Import an array of legacy records (Hebrew keys) into a project.
 *  Safe to run once; skips barcodes that already exist. */
export async function seedFromLegacy(pid, records) {
  let added = 0;
  for (const r of records) {
    const barcode = String(r["ברקוד"] ?? r.barcode ?? "").trim();
    if (!barcode) continue;
    const ref = doc(db, "projects", pid, "units", barcode);
    if ((await getDoc(ref)).exists()) continue;
    await setDoc(ref, {
      barcode,
      building: r["מבנה"]  ?? r.building ?? "",
      type:     r["סוג"]   ?? r.type     ?? "",
      location: r["מיקום"] ?? r.location ?? "",
      notes:    r["הערות"] ?? r.notes    ?? "",
      oldSku:   r["מק\"ט ישן"] ?? r.oldSku ?? "",
      area:     r["קומה"] ?? r.area ?? "",
      status:   "not_started",
      lastService: r["מה בוצע"] ?? "",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    // preserve the original "what was done" as the first history entry
    const done = (r["מה בוצע"] ?? "").trim();
    if (done) {
      await addDoc(servicesCol(pid, barcode), {
        date: new Date().toISOString().slice(0, 10),
        description: done,
        technician: "",
        createdAt: serverTimestamp(),
      });
    }
    added++;
  }
  return added;
}

// ---- Photos (per unit) --------------------------------------------
const photosCol = (pid, barcode) => collection(db, "projects", pid, "units", String(barcode), "photos");

export function watchPhotos(pid, barcode, onData, onError) {
  const q = query(photosCol(pid, barcode), orderBy("createdAt", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err)
  );
}
export async function addPhoto(pid, barcode, url, label = "") {
  await addDoc(photosCol(pid, barcode), { url, label, createdAt: serverTimestamp() });
}
export async function deletePhoto(pid, barcode, id) {
  await deleteDoc(doc(db, "projects", pid, "units", String(barcode), "photos", id));
}

// ---- Complaints / service requests --------------------------------
const complaintsCol = (pid) => collection(db, "projects", pid, "complaints");

export function watchComplaints(pid, onData, onError) {
  const q = query(complaintsCol(pid), orderBy("createdAt", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err)
  );
}
export async function addComplaint(pid, data) {
  const ref = await addDoc(complaintsCol(pid), {
    customer:   data.customer?.trim()   || "",
    phone:      data.phone?.trim()      || "",
    barcode:    data.barcode?.trim()    || "",
    building:   data.building?.trim()   || "",
    description:data.description?.trim()|| "",
    status:     data.status || "open",
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  return ref.id;
}
export async function updateComplaint(pid, id, fields) {
  await updateDoc(doc(db, "projects", pid, "complaints", id), { ...fields, updatedAt: serverTimestamp() });
}
export async function deleteComplaint(pid, id) {
  await deleteDoc(doc(db, "projects", pid, "complaints", id));
}

// ---- Buildings (cover photos) -------------------------------------
const buildingsCol = (pid) => collection(db, "projects", pid, "buildings");

export function watchBuildings(pid, onData, onError) {
  return onSnapshot(buildingsCol(pid),
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))),
    (err) => onError && onError(err)
  );
}
export async function saveBuilding(pid, name, fields) {
  const key = String(name).trim();
  if (!key) return;
  await setDoc(doc(db, "projects", pid, "buildings", key),
    { name: key, ...fields, updatedAt: serverTimestamp() }, { merge: true });
}
export async function deleteBuilding(pid, name) {
  await deleteDoc(doc(db, "projects", pid, "buildings", String(name).trim()));
}

// ---- Missing parts / equipment ------------------------------------
const partsCol = (pid) => collection(db, "projects", pid, "parts");
export function watchParts(pid, onData, onError) {
  const q = query(partsCol(pid), orderBy("createdAt", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err));
}
export async function addPart(pid, data) {
  const ref = await addDoc(partsCol(pid), {
    building: data.building?.trim() || "", item: data.item?.trim() || "",
    note: data.note?.trim() || "", done: false, createdAt: serverTimestamp(),
  });
  return ref.id;
}
export async function updatePart(pid, id, fields) {
  await updateDoc(doc(db, "projects", pid, "parts", id), fields);
}
export async function deletePart(pid, id) {
  await deleteDoc(doc(db, "projects", pid, "parts", id));
}

// ---- Scheduled visits -----------------------------------------------
const visitsCol = (pid) => collection(db, "projects", pid, "visits");
export function watchVisits(pid, onData, onError) {
  const q = query(visitsCol(pid), orderBy("date", "asc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err));
}
export async function addVisit(pid, data) {
  const ref = await addDoc(visitsCol(pid), {
    building: data.building?.trim() || "", date: data.date || "", time: data.time || "",
    location: data.location?.trim() || "", workers: data.workers?.trim() || "",
    notes: data.notes?.trim() || "", createdAt: serverTimestamp(),
  });
  return ref.id;
}
export async function updateVisit(pid, id, fields) {
  await updateDoc(doc(db, "projects", pid, "visits", id), fields);
}
export async function deleteVisit(pid, id) {
  await deleteDoc(doc(db, "projects", pid, "visits", id));
}

// ---- Team updates -------------------------------------------------
const updatesCol = (pid) => collection(db, "projects", pid, "updates");
export function watchUpdates(pid, onData, onError) {
  const q = query(updatesCol(pid), orderBy("createdAt", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err));
}
export async function addUpdate(pid, data) {
  const ref = await addDoc(updatesCol(pid), {
    text: data.text?.trim() || "", author: data.author?.trim() || "", createdAt: serverTimestamp(),
  });
  return ref.id;
}
export async function deleteUpdate(pid, id) {
  await deleteDoc(doc(db, "projects", pid, "updates", id));
}

// ---- Workdays (project day log) -----------------------------------
const workdaysCol = (pid) => collection(db, "projects", pid, "workdays");
export function watchWorkdays(pid, onData, onError) {
  const q = query(workdaysCol(pid), orderBy("date", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err));
}
export async function addWorkday(pid, data) {
  const ref = await addDoc(workdaysCol(pid), {
    date: data.date || new Date().toISOString().slice(0, 10),
    note: data.note?.trim() || "", createdAt: serverTimestamp(),
  });
  return ref.id;
}
export async function deleteWorkday(pid, id) {
  await deleteDoc(doc(db, "projects", pid, "workdays", id));
}

// ---- Vacation requests (staff-level, shared across all projects) --
const vacationsCol = () => collection(db, "vacations");
export function watchVacations(onData, onError) {
  const q = query(vacationsCol(), orderBy("from", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err));
}
export async function addVacation(data) {
  const ref = await addDoc(vacationsCol(), {
    name: data.name?.trim() || "", from: data.from || "", to: data.to || data.from || "",
    note: data.note?.trim() || "", status: "pending", decidedBy: "", createdAt: serverTimestamp(),
  });
  return ref.id;
}
export async function updateVacation(id, fields) {
  await updateDoc(doc(db, "vacations", id), fields);
}
export async function deleteVacation(id) {
  await deleteDoc(doc(db, "vacations", id));
}

// ---- Vehicle inventory (per worker, staff-level) -------------------
const vehCol = () => collection(db, "vehicle_items");
export function watchVehicleItems(onData, onError) {
  const q = query(vehCol(), orderBy("createdAt", "asc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err));
}
export async function addVehicleItem(data) {
  const ref = await addDoc(vehCol(), {
    owner: data.owner?.trim() || "", item: data.item?.trim() || "",
    missing: !!data.missing, createdAt: serverTimestamp(),
  });
  return ref.id;
}
export async function updateVehicleItem(id, fields) {
  await updateDoc(doc(db, "vehicle_items", id), fields);
}
export async function deleteVehicleItem(id) {
  await deleteDoc(doc(db, "vehicle_items", id));
}

// ---- Bulk actions -------------------------------------------------
export async function bulkAddService(pid, barcodes, svc) {
  for (const bc of barcodes) await addService(pid, bc, svc);
}
export async function bulkAppendNote(pid, barcodes, note) {
  const t = String(note || "").trim();
  if (!t) return;
  for (const bc of barcodes) {
    const ref = doc(db, "projects", pid, "units", String(bc));
    const snap = await getDoc(ref);
    if (!snap.exists()) continue;
    const prev = snap.data().notes || "";
    await updateDoc(ref, { notes: prev ? `${prev} • ${t}` : t, updatedAt: serverTimestamp() });
  }
}

export { Timestamp };
