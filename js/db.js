// ===================================================================
//  db.js — Firestore data layer
//  All reads/writes to the cloud database go through this module.
//  Uses the Firebase v10 modular SDK loaded from Google's CDN.
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

const unitsCol = () => collection(db, "units");
const servicesCol = (barcode) => collection(db, "units", String(barcode), "services");

// ---- Units --------------------------------------------------------

/**
 * Subscribe to ALL units in real time.
 * @param {(units: object[]) => void} onData  called on every change
 * @param {(err: Error) => void} onError
 * @returns {() => void} unsubscribe
 */
export function watchUnits(onData, onError) {
  const q = query(unitsCol(), orderBy("updatedAt", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err)
  );
}

/** Create or fully overwrite a unit. Uses the barcode as the document id. */
export async function saveUnit(unit) {
  const barcode = String(unit.barcode).trim();
  if (!barcode) throw new Error("ברקוד חסר");
  const ref = doc(db, "units", barcode);
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
export async function updateUnit(barcode, fields) {
  const ref = doc(db, "units", String(barcode));
  await updateDoc(ref, { ...fields, updatedAt: serverTimestamp() });
}

/** Delete a unit (note: service subcollection docs are left as orphans in
 *  Firestore — fine for personal scale; a Cloud Function could cascade). */
export async function deleteUnit(barcode) {
  await deleteDoc(doc(db, "units", String(barcode)));
}

// ---- Service history ----------------------------------------------

/** Watch the service log for one unit, newest first. */
export function watchServices(barcode, onData, onError) {
  const q = query(servicesCol(barcode), orderBy("date", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err)
  );
}

/** Add a service entry AND update the unit's "last service" summary. */
export async function addService(barcode, { date, description, technician }) {
  await addDoc(servicesCol(barcode), {
    date: date || new Date().toISOString().slice(0, 10),
    description: description?.trim() || "",
    technician: technician?.trim() || "",
    createdAt: serverTimestamp(),
  });
  await updateUnit(barcode, {
    lastService: description?.trim() || "",
    lastServiceDate: date || new Date().toISOString().slice(0, 10),
  });
}

/** Edit an existing service entry, then refresh the unit summary. */
export async function updateService(barcode, id, fields) {
  const ref = doc(db, "units", String(barcode), "services", id);
  await updateDoc(ref, {
    date: fields.date,
    description: fields.description?.trim() || "",
    technician: fields.technician?.trim() || "",
  });
  await recomputeLast(barcode);
}

/** Delete a service entry, then refresh the unit summary. */
export async function deleteService(barcode, id) {
  await deleteDoc(doc(db, "units", String(barcode), "services", id));
  await recomputeLast(barcode);
}

/** Recompute a unit's "last service" from its newest remaining entry. */
async function recomputeLast(barcode) {
  const q = query(servicesCol(barcode), orderBy("date", "desc"));
  const snap = await getDocs(q);
  const top = snap.docs[0]?.data();
  await updateUnit(barcode, {
    lastService: top?.description || "",
    lastServiceDate: top?.date || "",
  });
}

// ---- One-time seed / migration ------------------------------------

/** Import an array of legacy records (Hebrew keys) into Firestore.
 *  Safe to run once; skips barcodes that already exist. */
export async function seedFromLegacy(records) {
  let added = 0;
  for (const r of records) {
    const barcode = String(r["ברקוד"] ?? r.barcode ?? "").trim();
    if (!barcode) continue;
    const ref = doc(db, "units", barcode);
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
      await addDoc(servicesCol(barcode), {
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
const photosCol = (barcode) => collection(db, "units", String(barcode), "photos");

export function watchPhotos(barcode, onData, onError) {
  const q = query(photosCol(barcode), orderBy("createdAt", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err)
  );
}
export async function addPhoto(barcode, url) {
  await addDoc(photosCol(barcode), { url, createdAt: serverTimestamp() });
}
export async function deletePhoto(barcode, id) {
  await deleteDoc(doc(db, "units", String(barcode), "photos", id));
}

// ---- Complaints / service requests --------------------------------
const complaintsCol = () => collection(db, "complaints");

export function watchComplaints(onData, onError) {
  const q = query(complaintsCol(), orderBy("createdAt", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err)
  );
}
export async function addComplaint(data) {
  const ref = await addDoc(complaintsCol(), {
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
export async function updateComplaint(id, fields) {
  await updateDoc(doc(db, "complaints", id), { ...fields, updatedAt: serverTimestamp() });
}
export async function deleteComplaint(id) {
  await deleteDoc(doc(db, "complaints", id));
}

// ---- Buildings (cover photos) -------------------------------------
const buildingsCol = () => collection(db, "buildings");

export function watchBuildings(onData, onError) {
  return onSnapshot(buildingsCol(),
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))),
    (err) => onError && onError(err)
  );
}
export async function saveBuilding(name, fields) {
  const key = String(name).trim();
  if (!key) return;
  await setDoc(doc(db, "buildings", key),
    { name: key, ...fields, updatedAt: serverTimestamp() }, { merge: true });
}
export async function deleteBuilding(name) {
  await deleteDoc(doc(db, "buildings", String(name).trim()));
}

// ---- Missing parts / equipment ------------------------------------
const partsCol = () => collection(db, "parts");
export function watchParts(onData, onError) {
  const q = query(partsCol(), orderBy("createdAt", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err));
}
export async function addPart(data) {
  const ref = await addDoc(partsCol(), {
    building: data.building?.trim() || "", item: data.item?.trim() || "",
    note: data.note?.trim() || "", done: false, createdAt: serverTimestamp(),
  });
  return ref.id;
}
export async function updatePart(id, fields) {
  await updateDoc(doc(db, "parts", id), fields);
}
export async function deletePart(id) {
  await deleteDoc(doc(db, "parts", id));
}

// ---- Scheduled projects -------------------------------------------
const projectsCol = () => collection(db, "projects");
export function watchProjects(onData, onError) {
  const q = query(projectsCol(), orderBy("date", "asc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err));
}
export async function addProject(data) {
  const ref = await addDoc(projectsCol(), {
    building: data.building?.trim() || "", date: data.date || "", time: data.time || "",
    location: data.location?.trim() || "", workers: data.workers?.trim() || "",
    notes: data.notes?.trim() || "", createdAt: serverTimestamp(),
  });
  return ref.id;
}
export async function updateProject(id, fields) {
  await updateDoc(doc(db, "projects", id), fields);
}
export async function deleteProject(id) {
  await deleteDoc(doc(db, "projects", id));
}

// ---- Team updates -------------------------------------------------
const updatesCol = () => collection(db, "updates");
export function watchUpdates(onData, onError) {
  const q = query(updatesCol(), orderBy("createdAt", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err));
}
export async function addUpdate(data) {
  const ref = await addDoc(updatesCol(), {
    text: data.text?.trim() || "", author: data.author?.trim() || "", createdAt: serverTimestamp(),
  });
  return ref.id;
}
export async function deleteUpdate(id) {
  await deleteDoc(doc(db, "updates", id));
}

// ---- Workdays (project day log) -----------------------------------
const workdaysCol = () => collection(db, "workdays");
export function watchWorkdays(onData, onError) {
  const q = query(workdaysCol(), orderBy("date", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err));
}
export async function addWorkday(data) {
  const ref = await addDoc(workdaysCol(), {
    date: data.date || new Date().toISOString().slice(0, 10),
    note: data.note?.trim() || "", createdAt: serverTimestamp(),
  });
  return ref.id;
}
export async function deleteWorkday(id) {
  await deleteDoc(doc(db, "workdays", id));
}

// ---- Vacation requests --------------------------------------------
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

// ---- Vehicle inventory (per worker) -------------------------------
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
export async function bulkAddService(barcodes, svc) {
  for (const bc of barcodes) await addService(bc, svc);
}
export async function bulkAppendNote(barcodes, note) {
  const t = String(note || "").trim();
  if (!t) return;
  for (const bc of barcodes) {
    const ref = doc(db, "units", String(bc));
    const snap = await getDoc(ref);
    if (!snap.exists()) continue;
    const prev = snap.data().notes || "";
    await updateDoc(ref, { notes: prev ? `${prev} • ${t}` : t, updatedAt: serverTimestamp() });
  }
}

export { Timestamp };
