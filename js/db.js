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
    updatedAt: serverTimestamp(),
  };
  if (!existing.exists()) payload.createdAt = serverTimestamp();
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

export { Timestamp };
