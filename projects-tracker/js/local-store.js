// ===================================================================
//  local-store.js — offline, no-server data layer
//  Drop-in replacement for db.js that persists to localStorage.
//  Used automatically when Firebase is NOT configured, so the app is
//  fully usable with zero setup. Data lives on THIS device only.
//
//  Data model mirrors db.js: everything tied to one job site (units,
//  complaints, parts, visits, workdays, updates, contacts, crew, tasks,
//  media) is keyed by projectId (e.g. "ac_units__<projectId>"); vacations
//  and vehicle inventory are staff-level and stay under flat, unsuffixed
//  keys.
// ===================================================================

const PROJ_LIST_KEY = "ac_projects";
const UNITS_KEY   = "ac_units";
const SVC_KEY     = "ac_services";
const PHOTO_KEY   = "ac_photos";
const CMPL_KEY    = "ac_complaints";
const PART_KEY    = "ac_parts";
const VISIT_KEY   = "ac_visits";
const UPD_KEY     = "ac_updates";
const WD_KEY      = "ac_workdays";
const CONTACTS_KEY = "ac_contacts";
const CREW_KEY      = "ac_crew";
const TASK_KEY      = "ac_tasks";
const MEDIA_KEY     = "ac_media";
const VAC_KEY     = "ac_vacations";
const VEH_KEY     = "ac_vehicle_items";

const k = (base, pid) => `${base}__${pid}`;

let projectsList = {};  // { id: {id,name,client,address,notes,cover,createdAt} }
let vacations = {};     // { id: {..vacation..} }         (global)
let vehItems = {};      // { id: {owner,item,missing,createdAt} }  (global)

const projListeners = new Set();
const vacListeners  = new Set();
const vehListeners  = new Set();

const now = () => Date.now();
const newId = () => `id_${now()}_${Math.random().toString(36).slice(2, 7)}`;

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch { return fallback; }
}
function writeJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

// ---- Projects (top-level: one per job site) ------------------------
function loadProjects() { projectsList = readJSON(PROJ_LIST_KEY, {}); }
function saveProjects() { writeJSON(PROJ_LIST_KEY, projectsList); }
function projectsArray() {
  return Object.values(projectsList).sort((a, b) => String(a.name).localeCompare(String(b.name), "he"));
}
function notifyProjects() { const arr = projectsArray(); projListeners.forEach((fn) => fn(arr)); }

export function watchProjects(onData) {
  projListeners.add(onData);
  onData(projectsArray());
  return () => projListeners.delete(onData);
}
export async function addProject(data) {
  const id = newId();
  projectsList[id] = {
    id,
    name:    data.name?.trim()    || "",
    client:  data.client?.trim()  || "",
    address: data.address?.trim() || "",
    notes:   data.notes?.trim()   || "",
    cover:   data.cover || "",
    createdAt: now(),
  };
  saveProjects();
  notifyProjects();
  return id;
}
export async function updateProject(id, fields) {
  if (!projectsList[id]) return;
  Object.assign(projectsList[id], fields);
  saveProjects();
  notifyProjects();
}
/** Delete a project and every per-project bucket that belongs to it. */
export async function deleteProject(id) {
  delete projectsList[id];
  saveProjects();
  for (const base of [UNITS_KEY, SVC_KEY, PHOTO_KEY, CMPL_KEY, PART_KEY, VISIT_KEY, UPD_KEY, WD_KEY, CONTACTS_KEY, CREW_KEY, TASK_KEY, MEDIA_KEY]) {
    localStorage.removeItem(k(base, id));
  }
  notifyProjects();
}

// ===================================================================
//  Per-project store — one instance of this state machine per pid,
//  cached in memory so repeated watch() calls don't re-hit localStorage.
// ===================================================================
const projectStores = new Map(); // pid -> { units, services, photos, complaints, parts, visits, updates, workdays, contacts, crew, tasks, media, listeners: {...} }

function projectStore(pid) {
  if (projectStores.has(pid)) return projectStores.get(pid);
  const st = {
    units:       readJSON(k(UNITS_KEY, pid), {}),
    services:    readJSON(k(SVC_KEY, pid), {}),
    photos:      readJSON(k(PHOTO_KEY, pid), {}),
    complaints:  readJSON(k(CMPL_KEY, pid), {}),
    parts:       readJSON(k(PART_KEY, pid), {}),
    visits:      readJSON(k(VISIT_KEY, pid), {}),
    updates:     readJSON(k(UPD_KEY, pid), {}),
    workdays:    readJSON(k(WD_KEY, pid), {}),
    contacts:    readJSON(k(CONTACTS_KEY, pid), {}),
    crew:        readJSON(k(CREW_KEY, pid), {}),
    tasks:       readJSON(k(TASK_KEY, pid), {}),
    media:       readJSON(k(MEDIA_KEY, pid), {}),
    unitListeners: new Set(),
    svcListeners:  new Map(),   // barcode -> Set<fn>
    photoListeners: new Map(),  // barcode -> Set<fn>
    cmplListeners: new Set(),
    partListeners: new Set(),
    visitListeners: new Set(),
    updListeners:  new Set(),
    wdListeners:   new Set(),
    contactListeners: new Set(),
    crewListeners: new Set(),
    taskListeners: new Set(),
    mediaListeners: new Map(),  // category -> Set<fn>
  };
  projectStores.set(pid, st);
  return st;
}
const saveUnits      = (pid) => writeJSON(k(UNITS_KEY, pid), projectStore(pid).units);
const saveServices   = (pid) => writeJSON(k(SVC_KEY, pid), projectStore(pid).services);
const savePhotos     = (pid) => { try { writeJSON(k(PHOTO_KEY, pid), projectStore(pid).photos); } catch (e) { console.warn("photo storage full", e); } };
const saveComplaints = (pid) => writeJSON(k(CMPL_KEY, pid), projectStore(pid).complaints);
const saveParts      = (pid) => writeJSON(k(PART_KEY, pid), projectStore(pid).parts);
const saveVisits      = (pid) => writeJSON(k(VISIT_KEY, pid), projectStore(pid).visits);
const saveUpdates    = (pid) => writeJSON(k(UPD_KEY, pid), projectStore(pid).updates);
const saveWorkdays   = (pid) => writeJSON(k(WD_KEY, pid), projectStore(pid).workdays);
const saveContacts   = (pid) => writeJSON(k(CONTACTS_KEY, pid), projectStore(pid).contacts);
const saveCrew       = (pid) => writeJSON(k(CREW_KEY, pid), projectStore(pid).crew);
const saveTasks      = (pid) => writeJSON(k(TASK_KEY, pid), projectStore(pid).tasks);
const saveMedia      = (pid) => { try { writeJSON(k(MEDIA_KEY, pid), projectStore(pid).media); } catch (e) { console.warn("media storage full", e); } };

// ---- notify (mimics Firestore real-time) --------------------------
function unitsArray(pid) {
  return Object.values(projectStore(pid).units)
    .map((u) => ({ id: u.barcode, ...u }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function notifyUnits(pid) {
  const arr = unitsArray(pid);
  projectStore(pid).unitListeners.forEach((fn) => fn(arr));
}
function svcArray(pid, barcode) {
  return [...(projectStore(pid).services[barcode] || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
function notifyServices(pid, barcode) {
  const set = projectStore(pid).svcListeners.get(barcode);
  if (set) { const arr = svcArray(pid, barcode); set.forEach((fn) => fn(arr)); }
}

// ===================================================================
//  Public API (same signatures as db.js)
// ===================================================================
export const isConfigured = false;

export function initDb() { loadProjects(); vacations = readJSON(VAC_KEY, {}); vehItems = readJSON(VEH_KEY, {}); return true; }

export function watchUnits(pid, onData) {
  const st = projectStore(pid);
  st.unitListeners.add(onData);
  onData(unitsArray(pid));              // fire immediately
  return () => st.unitListeners.delete(onData);
}

export async function saveUnit(pid, unit) {
  const barcode = String(unit.barcode).trim();
  if (!barcode) throw new Error("ברקוד חסר");
  const st = projectStore(pid);
  const prev = st.units[barcode];
  st.units[barcode] = {
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
  saveUnits(pid);
  notifyUnits(pid);
  return barcode;
}

export async function updateUnit(pid, barcode, fields) {
  const st = projectStore(pid);
  const u = st.units[barcode];
  if (!u) return;
  Object.assign(u, fields, { updatedAt: now() });
  saveUnits(pid);
  notifyUnits(pid);
}

export async function deleteUnit(pid, barcode) {
  const st = projectStore(pid);
  delete st.units[barcode];
  delete st.services[barcode];
  saveUnits(pid);
  saveServices(pid);
  notifyUnits(pid);
  notifyServices(pid, barcode);
}

export function watchServices(pid, barcode, onData) {
  const st = projectStore(pid);
  if (!st.svcListeners.has(barcode)) st.svcListeners.set(barcode, new Set());
  st.svcListeners.get(barcode).add(onData);
  onData(svcArray(pid, barcode));       // fire immediately
  return () => st.svcListeners.get(barcode)?.delete(onData);
}

export async function addService(pid, barcode, { date, description, technician }) {
  const st = projectStore(pid);
  if (!st.services[barcode]) st.services[barcode] = [];
  const entry = {
    id: newId(),
    date: date || new Date().toISOString().slice(0, 10),
    description: description?.trim() || "",
    technician: technician?.trim() || "",
    createdAt: now(),
  };
  st.services[barcode].push(entry);
  saveServices(pid);
  // update the unit's "last service" summary
  if (st.units[barcode]) {
    st.units[barcode].lastService = entry.description;
    st.units[barcode].lastServiceDate = entry.date;
    st.units[barcode].updatedAt = now();
    saveUnits(pid);
  }
  notifyServices(pid, barcode);
  notifyUnits(pid);
}

export async function updateService(pid, barcode, id, fields) {
  const st = projectStore(pid);
  const arr = st.services[barcode] || [];
  const it = arr.find((s) => s.id === id);
  if (!it) return;
  Object.assign(it, {
    date: fields.date ?? it.date,
    description: fields.description?.trim() ?? it.description,
    technician: fields.technician?.trim() ?? it.technician,
  });
  saveServices(pid);
  recomputeLast(pid, barcode);
  notifyServices(pid, barcode);
  notifyUnits(pid);
}

export async function deleteService(pid, barcode, id) {
  const st = projectStore(pid);
  st.services[barcode] = (st.services[barcode] || []).filter((s) => s.id !== id);
  saveServices(pid);
  recomputeLast(pid, barcode);
  notifyServices(pid, barcode);
  notifyUnits(pid);
}

/** Refresh a unit's "last service" summary from its newest remaining entry. */
function recomputeLast(pid, barcode) {
  const st = projectStore(pid);
  const u = st.units[barcode];
  if (!u) return;
  const arr = svcArray(pid, barcode);   // newest first
  u.lastService = arr.length ? arr[0].description : "";
  u.lastServiceDate = arr.length ? arr[0].date : "";
  u.updatedAt = now();
  saveUnits(pid);
}

export async function seedFromLegacy(pid, records) {
  const st = projectStore(pid);
  let added = 0;
  for (const r of records) {
    const barcode = String(r["ברקוד"] ?? r.barcode ?? "").trim();
    if (!barcode || st.units[barcode]) continue;
    st.units[barcode] = {
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
      if (!st.services[barcode]) st.services[barcode] = [];
      st.services[barcode].push({
        id: newId(), date: new Date().toISOString().slice(0, 10),
        description: done, technician: "", createdAt: now(),
      });
    }
    added++;
  }
  saveUnits(pid);
  saveServices(pid);
  notifyUnits(pid);
  return added;
}

// ---- Photos -------------------------------------------------------
function photoArray(pid, barcode) {
  return [...(projectStore(pid).photos[barcode] || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function notifyPhotos(pid, barcode) {
  const set = projectStore(pid).photoListeners.get(barcode);
  if (set) { const arr = photoArray(pid, barcode); set.forEach((fn) => fn(arr)); }
}
export function watchPhotos(pid, barcode, onData) {
  const st = projectStore(pid);
  if (!st.photoListeners.has(barcode)) st.photoListeners.set(barcode, new Set());
  st.photoListeners.get(barcode).add(onData);
  onData(photoArray(pid, barcode));
  return () => st.photoListeners.get(barcode)?.delete(onData);
}
export async function addPhoto(pid, barcode, url, label = "") {
  const st = projectStore(pid);
  if (!st.photos[barcode]) st.photos[barcode] = [];
  st.photos[barcode].push({ id: newId(), url, label, createdAt: now() });
  savePhotos(pid);
  notifyPhotos(pid, barcode);
}
export async function deletePhoto(pid, barcode, id) {
  const st = projectStore(pid);
  st.photos[barcode] = (st.photos[barcode] || []).filter((p) => p.id !== id);
  savePhotos(pid);
  notifyPhotos(pid, barcode);
}

// ---- Complaints / service requests --------------------------------
function complaintsArray(pid) {
  return Object.values(projectStore(pid).complaints).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function notifyComplaints(pid) { const arr = complaintsArray(pid); projectStore(pid).cmplListeners.forEach((fn) => fn(arr)); }
export function watchComplaints(pid, onData) {
  const st = projectStore(pid);
  st.cmplListeners.add(onData);
  onData(complaintsArray(pid));
  return () => st.cmplListeners.delete(onData);
}
export async function addComplaint(pid, data) {
  const id = newId();
  projectStore(pid).complaints[id] = {
    id,
    customer:   data.customer?.trim()   || "",
    phone:      data.phone?.trim()      || "",
    barcode:    data.barcode?.trim()    || "",
    description:data.description?.trim()|| "",
    status:     data.status || "open",
    createdAt: now(), updatedAt: now(),
  };
  saveComplaints(pid);
  notifyComplaints(pid);
  return id;
}
export async function updateComplaint(pid, id, fields) {
  const st = projectStore(pid);
  if (!st.complaints[id]) return;
  Object.assign(st.complaints[id], fields, { updatedAt: now() });
  saveComplaints(pid);
  notifyComplaints(pid);
}
export async function deleteComplaint(pid, id) {
  delete projectStore(pid).complaints[id];
  saveComplaints(pid);
  notifyComplaints(pid);
}

// ---- Missing parts / equipment ------------------------------------
function partsArray(pid) {
  return Object.values(projectStore(pid).parts).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function notifyParts(pid) { const arr = partsArray(pid); projectStore(pid).partListeners.forEach((fn) => fn(arr)); }
export function watchParts(pid, onData) {
  const st = projectStore(pid);
  st.partListeners.add(onData);
  onData(partsArray(pid));
  return () => st.partListeners.delete(onData);
}
export async function addPart(pid, data) {
  const id = newId();
  projectStore(pid).parts[id] = {
    id, item: data.item?.trim() || "", note: data.note?.trim() || "",
    done: false, createdAt: now(),
  };
  saveParts(pid);
  notifyParts(pid);
  return id;
}
export async function updatePart(pid, id, fields) {
  const st = projectStore(pid);
  if (!st.parts[id]) return;
  Object.assign(st.parts[id], fields);
  saveParts(pid);
  notifyParts(pid);
}
export async function deletePart(pid, id) {
  delete projectStore(pid).parts[id];
  saveParts(pid);
  notifyParts(pid);
}

// ---- Scheduled visits -----------------------------------------------
function visitsArray(pid) {
  return Object.values(projectStore(pid).visits).sort((a, b) =>
    String(a.date + (a.time || "")).localeCompare(String(b.date + (b.time || ""))));
}
function notifyVisits(pid) { const arr = visitsArray(pid); projectStore(pid).visitListeners.forEach((fn) => fn(arr)); }
export function watchVisits(pid, onData) {
  const st = projectStore(pid);
  st.visitListeners.add(onData);
  onData(visitsArray(pid));
  return () => st.visitListeners.delete(onData);
}
export async function addVisit(pid, data) {
  const id = newId();
  projectStore(pid).visits[id] = {
    id, title: data.title?.trim() || "",
    date: data.date || "", time: data.time || "",
    location: data.location?.trim() || "", workers: data.workers?.trim() || "",
    notes: data.notes?.trim() || "", createdAt: now(),
  };
  saveVisits(pid);
  notifyVisits(pid);
  return id;
}
export async function updateVisit(pid, id, fields) {
  const st = projectStore(pid);
  if (!st.visits[id]) return;
  Object.assign(st.visits[id], fields);
  saveVisits(pid);
  notifyVisits(pid);
}
export async function deleteVisit(pid, id) {
  delete projectStore(pid).visits[id];
  saveVisits(pid);
  notifyVisits(pid);
}

// ---- Team updates -------------------------------------------------
function updatesArray(pid) {
  return Object.values(projectStore(pid).updates).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function notifyUpdatesFn(pid) { const arr = updatesArray(pid); projectStore(pid).updListeners.forEach((fn) => fn(arr)); }
export function watchUpdates(pid, onData) {
  const st = projectStore(pid);
  st.updListeners.add(onData);
  onData(updatesArray(pid));
  return () => st.updListeners.delete(onData);
}
export async function addUpdate(pid, data) {
  const id = newId();
  projectStore(pid).updates[id] = { id, text: data.text?.trim() || "", author: data.author?.trim() || "", createdAt: now() };
  saveUpdates(pid);
  notifyUpdatesFn(pid);
  return id;
}
export async function deleteUpdate(pid, id) {
  delete projectStore(pid).updates[id];
  saveUpdates(pid);
  notifyUpdatesFn(pid);
}

// ---- Workdays (project day log) -----------------------------------
function workdaysArray(pid) {
  return Object.values(projectStore(pid).workdays).sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
function notifyWorkdays(pid) { const arr = workdaysArray(pid); projectStore(pid).wdListeners.forEach((fn) => fn(arr)); }
export function watchWorkdays(pid, onData) {
  const st = projectStore(pid);
  st.wdListeners.add(onData);
  onData(workdaysArray(pid));
  return () => st.wdListeners.delete(onData);
}
export async function addWorkday(pid, data) {
  const id = newId();
  projectStore(pid).workdays[id] = {
    id, date: data.date || new Date().toISOString().slice(0, 10),
    note: data.note?.trim() || "", createdAt: now(),
  };
  saveWorkdays(pid);
  notifyWorkdays(pid);
  return id;
}
export async function deleteWorkday(pid, id) {
  delete projectStore(pid).workdays[id];
  saveWorkdays(pid);
  notifyWorkdays(pid);
}

// ---- Contacts (per project) ----------------------------------------
function contactsArray(pid) {
  return Object.values(projectStore(pid).contacts).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
function notifyContacts(pid) { const arr = contactsArray(pid); projectStore(pid).contactListeners.forEach((fn) => fn(arr)); }
export function watchContacts(pid, onData) {
  const st = projectStore(pid);
  st.contactListeners.add(onData);
  onData(contactsArray(pid));
  return () => st.contactListeners.delete(onData);
}
export async function addContact(pid, data) {
  const id = newId();
  projectStore(pid).contacts[id] = {
    id, name: data.name?.trim() || "", role: data.role?.trim() || "",
    phone: data.phone?.trim() || "", notes: data.notes?.trim() || "", createdAt: now(),
  };
  saveContacts(pid);
  notifyContacts(pid);
  return id;
}
export async function updateContact(pid, id, fields) {
  const st = projectStore(pid);
  if (!st.contacts[id]) return;
  Object.assign(st.contacts[id], fields);
  saveContacts(pid);
  notifyContacts(pid);
}
export async function deleteContact(pid, id) {
  delete projectStore(pid).contacts[id];
  saveContacts(pid);
  notifyContacts(pid);
}

// ---- Project crew (workers on this project) ------------------------
function crewArray(pid) {
  return Object.values(projectStore(pid).crew).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
function notifyCrew(pid) { const arr = crewArray(pid); projectStore(pid).crewListeners.forEach((fn) => fn(arr)); }
export function watchCrew(pid, onData) {
  const st = projectStore(pid);
  st.crewListeners.add(onData);
  onData(crewArray(pid));
  return () => st.crewListeners.delete(onData);
}
export async function addCrewMember(pid, data) {
  const id = newId();
  projectStore(pid).crew[id] = {
    id, name: data.name?.trim() || "", role: data.role?.trim() || "",
    phone: data.phone?.trim() || "", createdAt: now(),
  };
  saveCrew(pid);
  notifyCrew(pid);
  return id;
}
export async function deleteCrewMember(pid, id) {
  delete projectStore(pid).crew[id];
  saveCrew(pid);
  notifyCrew(pid);
}

// ---- Tasks (open/closed) --------------------------------------------
function tasksArray(pid) {
  return Object.values(projectStore(pid).tasks).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function notifyTasks(pid) { const arr = tasksArray(pid); projectStore(pid).taskListeners.forEach((fn) => fn(arr)); }
export function watchTasks(pid, onData) {
  const st = projectStore(pid);
  st.taskListeners.add(onData);
  onData(tasksArray(pid));
  return () => st.taskListeners.delete(onData);
}
export async function addTask(pid, data) {
  const id = newId();
  projectStore(pid).tasks[id] = {
    id, title: data.title?.trim() || "", assignee: data.assignee?.trim() || "",
    dueDate: data.dueDate || "", done: false, createdAt: now(),
  };
  saveTasks(pid);
  notifyTasks(pid);
  return id;
}
export async function updateTask(pid, id, fields) {
  const st = projectStore(pid);
  if (!st.tasks[id]) return;
  Object.assign(st.tasks[id], fields);
  saveTasks(pid);
  notifyTasks(pid);
}
export async function deleteTask(pid, id) {
  delete projectStore(pid).tasks[id];
  saveTasks(pid);
  notifyTasks(pid);
}

// ---- Media (plans / gallery / warranty — one store, filtered by
//      category, since the three sections are structurally identical) --
function mediaArray(pid, category) {
  return Object.values(projectStore(pid).media)
    .filter((m) => m.category === category)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function notifyMedia(pid, category) {
  const set = projectStore(pid).mediaListeners.get(category);
  if (set) { const arr = mediaArray(pid, category); set.forEach((fn) => fn(arr)); }
}
export function watchMedia(pid, category, onData) {
  const st = projectStore(pid);
  if (!st.mediaListeners.has(category)) st.mediaListeners.set(category, new Set());
  st.mediaListeners.get(category).add(onData);
  onData(mediaArray(pid, category));
  return () => st.mediaListeners.get(category)?.delete(onData);
}
export async function addMedia(pid, category, url, label = "") {
  const id = newId();
  projectStore(pid).media[id] = { id, category, url, label, createdAt: now() };
  saveMedia(pid);
  notifyMedia(pid, category);
}
export async function deleteMedia(pid, id) {
  const st = projectStore(pid);
  const category = st.media[id]?.category;
  delete st.media[id];
  saveMedia(pid);
  if (category) notifyMedia(pid, category);
}

// ---- Vacation requests (staff-level, shared across all projects) --
function saveVacations() { writeJSON(VAC_KEY, vacations); }
function vacationsArray() {
  return Object.values(vacations).sort((a, b) => String(b.from).localeCompare(String(a.from)));
}
function notifyVacations() { const arr = vacationsArray(); vacListeners.forEach((fn) => fn(arr)); }
export function watchVacations(onData) {
  vacListeners.add(onData);
  onData(vacationsArray());
  return () => vacListeners.delete(onData);
}
export async function addVacation(data) {
  const id = newId();
  vacations[id] = {
    id, name: data.name?.trim() || "", from: data.from || "", to: data.to || data.from || "",
    note: data.note?.trim() || "", status: "pending", decidedBy: "", createdAt: now(),
  };
  saveVacations();
  notifyVacations();
  return id;
}
export async function updateVacation(id, fields) {
  if (!vacations[id]) return;
  Object.assign(vacations[id], fields);
  saveVacations();
  notifyVacations();
}
export async function deleteVacation(id) {
  delete vacations[id];
  saveVacations();
  notifyVacations();
}

// ---- Vehicle inventory (per worker, staff-level) -------------------
function saveVehItems() { writeJSON(VEH_KEY, vehItems); }
function vehItemsArray() {
  return Object.values(vehItems).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
function notifyVehItems() { const arr = vehItemsArray(); vehListeners.forEach((fn) => fn(arr)); }
export function watchVehicleItems(onData) {
  vehListeners.add(onData);
  onData(vehItemsArray());
  return () => vehListeners.delete(onData);
}
export async function addVehicleItem(data) {
  const id = newId();
  vehItems[id] = {
    id, owner: data.owner?.trim() || "", item: data.item?.trim() || "",
    missing: !!data.missing, createdAt: now(),
  };
  saveVehItems();
  notifyVehItems();
  return id;
}
export async function updateVehicleItem(id, fields) {
  if (!vehItems[id]) return;
  Object.assign(vehItems[id], fields);
  saveVehItems();
  notifyVehItems();
}
export async function deleteVehicleItem(id) {
  delete vehItems[id];
  saveVehItems();
  notifyVehItems();
}

// ---- Bulk actions -------------------------------------------------
export async function bulkAddService(pid, barcodes, svc) {
  for (const bc of barcodes) await addService(pid, bc, svc);
}
export async function bulkAppendNote(pid, barcodes, note) {
  const t = String(note || "").trim();
  if (!t) return;
  const st = projectStore(pid);
  for (const bc of barcodes) {
    const u = st.units[bc];
    if (!u) continue;
    u.notes = u.notes ? `${u.notes} • ${t}` : t;
    u.updatedAt = now();
  }
  saveUnits(pid);
  notifyUnits(pid);
}
