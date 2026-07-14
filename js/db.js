// ===================================================================
//  db.js — Firestore data layer
// ===================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  addDoc, onSnapshot, query, orderBy, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref as sRef, uploadBytes, getDownloadURL }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

import { firebaseConfig, isConfigured } from "./firebase-config.js";

export { isConfigured };

let db = null;
let storage = null;

export function initDb() {
  if (!isConfigured) return null;
  const app = initializeApp(firebaseConfig);
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  storage = getStorage(app);
  return db;
}

/** מעלה תמונה ל-Firebase Storage (לא נשמרת בדיסק המכשיר) ומחזירה URL. */
export async function uploadUnitPhoto(barcode, file) {
  const path = `units/${barcode}/${Date.now()}.jpg`;
  const ref = sRef(storage, path);
  await uploadBytes(ref, file);
  return await getDownloadURL(ref);
}

const unitsCol = () => collection(db, "units");
const servicesCol = (barcode) => collection(db, "units", String(barcode), "services");

export function watchUnits(onData, onError) {
  const q = query(unitsCol(), orderBy("updatedAt", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err)
  );
}

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

export async function updateUnit(barcode, fields) {
  const ref = doc(db, "units", String(barcode));
  await updateDoc(ref, { ...fields, updatedAt: serverTimestamp() });
}

export async function deleteUnit(barcode) {
  await deleteDoc(doc(db, "units", String(barcode)));
}

export function watchServices(barcode, onData, onError) {
  const q = query(servicesCol(barcode), orderBy("date", "desc"));
  return onSnapshot(q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err)
  );
}

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

export async function updateService(barcode, id, fields) {
  const ref = doc(db, "units", String(barcode), "services", id);
  await updateDoc(ref, {
    date: fields.date,
    description: fields.description?.trim() || "",
    technician: fields.technician?.trim() || "",
  });
  await recomputeLast(barcode);
}

export async function deleteService(barcode, id) {
  await deleteDoc(doc(db, "units", String(barcode), "services", id));
  await recomputeLast(barcode);
}

async function recomputeLast(barcode) {
  const q = query(servicesCol(barcode), orderBy("date", "desc"));
  const snap = await getDocs(q);
  const top = snap.docs[0]?.data();
  await updateUnit(barcode, {
    lastService: top?.description || "",
    lastServiceDate: top?.date || "",
  });
}

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
