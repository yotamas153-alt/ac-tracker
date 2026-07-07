// ===================================================================
//  local-store.js — offline, no-server data layer
//  Drop-in replacement for db.js that persists to localStorage.
//  Used automatically when Firebase is NOT configured, so the app is
//  fully usable with zero setup. Data lives on THIS device only.
// ===================================================================

const UNITS_KEY   = "ac_units";
const SVC_KEY     = "ac_services";
const PHOTO_KEY   = "ac_photos";
const CMPL_KEY    = "ac_complaints";
const BLD_KEY     = "ac_buildings";
const PART_KEY    = "ac_parts";
const PROJ_KEY    = "ac_projects";

let units = {};        // { barcode: {..fields..} }
let services = {};      // { barcode: [ {..entry..} ] }
let photos = {};        // { barcode: [ {id,url,createdAt} ] }
let complaints = {};    // { id: {..complaint..} }
let buildings = {};     // { name: {name, cover, updatedAt} }
let parts = {};         // { id: {building,item,note,done,createdAt} }
let projects = {};      // { id: {building,date,time,location,workers,createdAt} }

const unitListeners = new Set();               // Set<fn>
const svcListeners  = new Map();               // barcode -> Set<fn>
const photoListeners = new Map();              // barcode -> Set<fn>
const cmplListeners = new Set();               // Set<fn>
const bldListeners  = new Set();               // Set<fn>
const partListeners = new Set();               // Set<fn>
const projListeners = new Set();               // Set<fn>

// ---- persistence --------------------------------------------------
function load() {
  try { units      = JSON.parse(localStorage.getItem(UNITS_KEY) || "{}"); } catch { units = {}; }
  try { services   = JSON.parse(localStorage.getItem(SVC_KEY)   || "{}"); } catch { services = {}; }
  try { photos     = JSON.parse(localStorage.getItem(PHOTO_KEY) || "{}"); } catch { photos = {}; }
  try { complaints = JSON.parse(localStorage.getItem(CMPL_KEY)  || "{}"); } catch { complaints = {}; }
  try { buildings  = JSON.parse(localStorage.getItem(BLD_KEY)   || "{}"); } catch { buildings = {}; }
  try { parts      = JSON.parse(localStorage.getItem(PART_KEY)  || "{}"); } catch { parts = {}; }
  try { projects   = JSON.parse(localStorage.getItem(PROJ_KEY)  || "{}"); } catch { projects = {}; }
}
function saveUnits()      { localStorage.setItem(UNITS_KEY, JSON.stringify(units)); }
function saveServices()   { localStorage.setItem(SVC_KEY,   JSON.stringify(services)); }
function savePhotos()     { try { localStorage.setItem(PHOTO_KEY, JSON.stringify(photos)); } catch (e) { console.warn("photo storage full", e); } }
function saveComplaints() { localStorage.setItem(CMPL_KEY, JSON.stringify(complaints)); }
function saveBuildings()  { try { localStorage.setItem(BLD_KEY, JSON.stringify(buildings)); } catch (e) { console.warn("building storage full", e); } }
function saveParts()      { localStorage.setItem(PART_KEY, JSON.stringify(parts)); }
function saveProjects()   { localStorage.setItem(PROJ_KEY, JSON.stringify(projects)); }

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
    area:     unit.area?.trim()     ?? prev?.area ?? "",
    status:   unit.status || prev?.status || "not_started",
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

export async function updateService(barcode, id, fields) {
  const arr = services[barcode] || [];
  const it = arr.find((s) => s.id === id);
  if (!it) return;
  Object.assign(it, {
    date: fields.date ?? it.date,
    description: fields.description?.trim() ?? it.description,
    technician: fields.technician?.trim() ?? it.technician,
  });
  saveServices();
  recomputeLast(barcode);
  notifyServices(barcode);
  notifyUnits();
}

export async function deleteService(barcode, id) {
  services[barcode] = (services[barcode] || []).filter((s) => s.id !== id);
  saveServices();
  recomputeLast(barcode);
  notifyServices(barcode);
  notifyUnits();
}

/** Refresh a unit's "last service" summary from its newest remaining entry. */
function recomputeLast(barcode) {
  const u = units[barcode];
  if (!u) return;
  const arr = svcArray(barcode); // newest first
  u.lastService = arr.length ? arr[0].description : "";
  u.lastServiceDate = arr.length ? arr[0].date : "";
  u.updatedAt = now();
  saveUnits();
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
      area:     r["קומה"] ?? r.area ?? "",
      status:   "not_started",
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

// ---- Photos -------------------------------------------------------
function photoArray(barcode) {
  return [...(photos[barcode] || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function notifyPhotos(barcode) {
  const set = photoListeners.get(barcode);
  if (set) { const arr = photoArray(barcode); set.forEach((fn) => fn(arr)); }
}
export function watchPhotos(barcode, onData) {
  if (!photoListeners.has(barcode)) photoListeners.set(barcode, new Set());
  photoListeners.get(barcode).add(onData);
  onData(photoArray(barcode));
  return () => photoListeners.get(barcode)?.delete(onData);
}
export async function addPhoto(barcode, url) {
  if (!photos[barcode]) photos[barcode] = [];
  photos[barcode].push({ id: newId(), url, createdAt: now() });
  savePhotos();
  notifyPhotos(barcode);
}
export async function deletePhoto(barcode, id) {
  photos[barcode] = (photos[barcode] || []).filter((p) => p.id !== id);
  savePhotos();
  notifyPhotos(barcode);
}

// ---- Complaints / service requests --------------------------------
function complaintsArray() {
  return Object.values(complaints).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function notifyComplaints() { const arr = complaintsArray(); cmplListeners.forEach((fn) => fn(arr)); }
export function watchComplaints(onData) {
  cmplListeners.add(onData);
  onData(complaintsArray());
  return () => cmplListeners.delete(onData);
}
export async function addComplaint(data) {
  const id = newId();
  complaints[id] = {
    id,
    customer:   data.customer?.trim()   || "",
    phone:      data.phone?.trim()      || "",
    barcode:    data.barcode?.trim()    || "",
    building:   data.building?.trim()   || "",
    description:data.description?.trim()|| "",
    status:     data.status || "open",
    createdAt: now(), updatedAt: now(),
  };
  saveComplaints();
  notifyComplaints();
  return id;
}
export async function updateComplaint(id, fields) {
  if (!complaints[id]) return;
  Object.assign(complaints[id], fields, { updatedAt: now() });
  saveComplaints();
  notifyComplaints();
}
export async function deleteComplaint(id) {
  delete complaints[id];
  saveComplaints();
  notifyComplaints();
}

// ---- Buildings (cover photos) -------------------------------------
function buildingsArray() {
  return Object.values(buildings).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
function notifyBuildings() { const arr = buildingsArray(); bldListeners.forEach((fn) => fn(arr)); }
export function watchBuildings(onData) {
  bldListeners.add(onData);
  onData(buildingsArray());
  return () => bldListeners.delete(onData);
}
export async function saveBuilding(name, fields) {
  const key = String(name).trim();
  if (!key) return;
  buildings[key] = { name: key, ...(buildings[key] || {}), ...fields, updatedAt: now() };
  saveBuildings();
  notifyBuildings();
}
export async function deleteBuilding(name) {
  delete buildings[String(name).trim()];
  saveBuildings();
  notifyBuildings();
}

// ---- Missing parts / equipment ------------------------------------
function partsArray() {
  return Object.values(parts).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function notifyParts() { const arr = partsArray(); partListeners.forEach((fn) => fn(arr)); }
export function watchParts(onData) {
  partListeners.add(onData);
  onData(partsArray());
  return () => partListeners.delete(onData);
}
export async function addPart(data) {
  const id = newId();
  parts[id] = {
    id, building: data.building?.trim() || "",
    item: data.item?.trim() || "", note: data.note?.trim() || "",
    done: false, createdAt: now(),
  };
  saveParts();
  notifyParts();
  return id;
}
export async function updatePart(id, fields) {
  if (!parts[id]) return;
  Object.assign(parts[id], fields);
  saveParts();
  notifyParts();
}
export async function deletePart(id) {
  delete parts[id];
  saveParts();
  notifyParts();
}

// ---- Scheduled projects -------------------------------------------
function projectsArray() {
  return Object.values(projects).sort((a, b) =>
    String(a.date + (a.time || "")).localeCompare(String(b.date + (b.time || ""))));
}
function notifyProjects() { const arr = projectsArray(); projListeners.forEach((fn) => fn(arr)); }
export function watchProjects(onData) {
  projListeners.add(onData);
  onData(projectsArray());
  return () => projListeners.delete(onData);
}
export async function addProject(data) {
  const id = newId();
  projects[id] = {
    id, building: data.building?.trim() || "",
    date: data.date || "", time: data.time || "",
    location: data.location?.trim() || "", workers: data.workers?.trim() || "",
    notes: data.notes?.trim() || "", createdAt: now(),
  };
  saveProjects();
  notifyProjects();
  return id;
}
export async function updateProject(id, fields) {
  if (!projects[id]) return;
  Object.assign(projects[id], fields);
  saveProjects();
  notifyProjects();
}
export async function deleteProject(id) {
  delete projects[id];
  saveProjects();
  notifyProjects();
}

// ---- Bulk actions -------------------------------------------------
export async function bulkAddService(barcodes, svc) {
  for (const bc of barcodes) await addService(bc, svc);
}
export async function bulkAppendNote(barcodes, note) {
  const t = String(note || "").trim();
  if (!t) return;
  for (const bc of barcodes) {
    const u = units[bc];
    if (!u) continue;
    u.notes = u.notes ? `${u.notes} • ${t}` : t;
    u.updatedAt = now();
  }
  saveUnits();
  notifyUnits();
}
