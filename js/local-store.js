// ===================================================================
//  local-store.js — offline, no-server data layer
//  Drop-in replacement for db.js that persists to localStorage.
//  Used automatically when Firebase is NOT configured, so the app is
//  fully usable with zero setup. Data lives on THIS device only.
// ===================================================================

const UNITS_KEY = "ac_units";
const SVC_KEY   = "ac_services";

let units = {};        // { barcode: {..fields..} }
let services = {};      // { barcode: [ {..entry..} ] }

const unitListeners = new Set();               // Set<fn>
const svcListeners  = new Map();               // barcode -> Set<fn>

// ---- persistence --------------------------------------------------
function load() {
  try { units    = JSON.parse(localStorage.getItem(UNITS_KEY) || "{}"); } catch { units = {}; }
  try { services = JSON.parse(localStorage.getItem(SVC_KEY)   || "{}"); } catch { services = {}; }
}
function saveUnits()    { localStorage.setItem(UNITS_KEY, JSON.stringify(units)); }
function saveServices() { localStorage.setItem(SVC_KEY,   JSON.stringify(services)); }

const now = () => Date.now();
const newId = () => `s_${now()}_${Math.random().toString(36).slice(2, 7)}`;

// ---- notify (mimics Firestore real-time) --------------------------
function unitsArray() {
  return Object.values(units)
    .map((u) => ({ id: u.barcode, ...u }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function notifyUnits() {
  const arr = unitsArray();
  unitListeners.forEach((fn) => fn(arr));
}
function svcArray(barcode) {
  return [...(services[barcode] || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
function notifyServices(barcode) {
  const set = svcListeners.get(barcode);
  if (set) { const arr = svcArray(barcode); set.forEach((fn) => fn(arr)); }
}

// ===================================================================
//  Public API (same signatures as db.js)
// ===================================================================
export const isConfigured = false;

export function initDb() { load(); return true; }

export function watchUnits(onData) {
  unitListeners.add(onData);
  onData(unitsArray());                 // fire immediately
  return () => unitListeners.delete(onData);
}

export async function saveUnit(unit) {
  const barcode = String(unit.barcode).trim();
  if (!barcode) throw new Error("ברקוד חסר");
  const prev = units[barcode];
  units[barcode] = {
    barcode,
    building: unit.building?.trim() || "",
    type:     unit.type?.trim()     || "",
    location: unit.location?.trim() || "",
    notes:    unit.notes?.trim()    || "",
    oldSku:   unit.oldSku?.trim()   || "",
    lastService:     prev?.lastService     || "",
    lastServiceDate: prev?.lastServiceDate || "",
    createdAt: prev?.createdAt || now(),
    updatedAt: now(),
  };
  saveUnits();
  notifyUnits();
  return barcode;
}

export async function updateUnit(barcode, fields) {
  const u = units[barcode];
  if (!u) return;
  Object.assign(u, fields, { updatedAt: now() });
  saveUnits();
  notifyUnits();
}

export async function deleteUnit(barcode) {
  delete units[barcode];
  delete services[barcode];
  saveUnits();
  saveServices();
  notifyUnits();
  notifyServices(barcode);
}

export function watchServices(barcode, onData) {
  if (!svcListeners.has(barcode)) svcListeners.set(barcode, new Set());
  svcListeners.get(barcode).add(onData);
  onData(svcArray(barcode));            // fire immediately
  return () => svcListeners.get(barcode)?.delete(onData);
}

export async function addService(barcode, { date, description, technician }) {
  if (!services[barcode]) services[barcode] = [];
  const entry = {
    id: newId(),
    date: date || new Date().toISOString().slice(0, 10),
    description: description?.trim() || "",
    technician: technician?.trim() || "",
    createdAt: now(),
  };
  services[barcode].push(entry);
  saveServices();
  // update the unit's "last service" summary
  if (units[barcode]) {
    units[barcode].lastService = entry.description;
    units[barcode].lastServiceDate = entry.date;
    units[barcode].updatedAt = now();
    saveUnits();
  }
  notifyServices(barcode);
  notifyUnits();
}

export async function seedFromLegacy(records) {
  let added = 0;
  for (const r of records) {
    const barcode = String(r["ברקוד"] ?? r.barcode ?? "").trim();
    if (!barcode || units[barcode]) continue;
    units[barcode] = {
      barcode,
      building: r["מבנה"]  ?? r.building ?? "",
      type:     r["סוג"]   ?? r.type     ?? "",
      location: r["מיקום"] ?? r.location ?? "",
      notes:    r["הערות"] ?? r.notes    ?? "",
      oldSku:   r["מק\"ט ישן"] ?? r.oldSku ?? "",
      lastService: r["מה בוצע"] ?? "",
      lastServiceDate: "",
      createdAt: now(),
      updatedAt: now(),
    };
    const done = (r["מה בוצע"] ?? "").trim();
    if (done) {
      if (!services[barcode]) services[barcode] = [];
      services[barcode].push({
        id: newId(), date: new Date().toISOString().slice(0, 10),
        description: done, technician: "", createdAt: now(),
      });
    }
    added++;
  }
  saveUnits();
  saveServices();
  notifyUnits();
  return added;
}
