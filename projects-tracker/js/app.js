// ===================================================================
//  app.js — UI controller
// ===================================================================
import { isConfigured } from "./firebase-config.js";
import { startScan, stopScan } from "./scanner.js";

// Pick the data backend: cloud (Firebase) if configured, else local device
// storage — so the app is fully usable with zero setup.
const store = isConfigured ? await import("./db.js") : await import("./local-store.js");
const {
  initDb,
  watchProjects, addProject, updateProject, deleteProject,
  watchUnits, saveUnit, updateUnit, deleteUnit,
  watchServices, addService, updateService, deleteService,
  watchPhotos, addPhoto, deletePhoto,
  watchComplaints, addComplaint, updateComplaint, deleteComplaint,
  watchParts, addPart, updatePart, deletePart,
  watchVisits, addVisit, updateVisit, deleteVisit,
  watchUpdates, addUpdate, deleteUpdate,
  watchWorkdays, addWorkday, deleteWorkday,
  watchContacts, addContact, updateContact, deleteContact,
  watchCrew, addCrewMember, deleteCrewMember,
  watchTasks, addTask, updateTask, deleteTask,
  watchMedia, addMedia, deleteMedia,
  watchVacations, addVacation, updateVacation, deleteVacation,
  watchVehicleItems, addVehicleItem, updateVehicleItem, deleteVehicleItem,
  bulkAddService, bulkAppendNote,
} = store;
const isGuy = () => (localStorage.getItem("ac_username") || "").trim() === "גיא";

// ---- Work-status definitions ---------------------------------------
const STATUS = {
  not_started:  { label: "לא התחיל",   icon: "⚪", cls: "st-not" },
  in_progress:  { label: "בתהליך",     icon: "🔧", cls: "st-prog" },
  completed:    { label: "הושלם",      icon: "✅", cls: "st-done" },
  waiting_part: { label: "ממתין לחלק", icon: "📦", cls: "st-wait" },
  issue:        { label: "תקלה",       icon: "⚠️", cls: "st-issue" },
};
const STATUS_ORDER = ["not_started", "in_progress", "completed", "waiting_part", "issue"];
const st = (k) => STATUS[k] || STATUS.not_started;

// common missing-part quick items
const PART_ITEMS = ["קבל", "מנוע", "גז", "צינור", "כבל", "משאבת ניקוז", "ברגים", "אחר"];

// project-home section cards
const HOME_SECTIONS = [
  { view: "plans",     icon: "📐", label: "תוכניות לביצוע" },
  { view: "contacts",  icon: "👤", label: "אנשי קשר" },
  { view: "gallery",   icon: "🖼️", label: "גלריית תמונות" },
  { view: "warranty",  icon: "📄", label: "אחריות מזגנים" },
  { view: "crew",      icon: "👷", label: "צוות הפרויקט" },
  { view: "calendar",  icon: "📅", label: "יומן עבודה" },
  { view: "messages",  icon: "💬", label: "הודעות צוות" },
  { view: "complaints",icon: "📣", label: "תקלות ופניות" },
  { view: "parts",     icon: "🧰", label: "חוסרים" },
];

// ---- Local state -----------------------------------------------------
// PROJECTS = the job sites themselves (top-level). Everything below is
// scoped to whichever one is currently open (currentProjectId), except
// VACATIONS / VEHICLE_ITEMS which are staff-level and shared by all.
let PROJECTS = [];              // live mirror of the projects list (job sites)
let currentProjectId = localStorage.getItem("ac_current_project") || null;
let projectsBooted = false;     // true once the first projects snapshot has arrived

let UNITS = [];                 // live mirror of the current project's installed equipment (AC units)
let COMPLAINTS = [];            // live mirror of complaints
let PARTS = [];                 // live mirror of missing parts
let VISITS = [];                // live mirror of this project's scheduled visits
let UPDATES = [];               // live mirror of team messages
let WORKDAYS = [];              // live mirror of the work log
let CONTACTS = [];              // live mirror of project contacts
let CREW = [];                  // live mirror of the project's crew roster
let TASKS = [];                 // live mirror of open/closed tasks
let MEDIA = { plan: [], gallery: [], warranty: [] };  // plans / photo gallery / warranty photos
let VACATIONS = [];             // live mirror of vacation requests (staff-level)
let VEHICLE_ITEMS = [];         // live mirror of vehicle inventory (staff-level)
let vehicleSel = "יותם";        // currently viewed vehicle owner
const viewStack = ["projects"]; // visited views, for the Back button
let suppressPush = false;       // true while restoring via Back (don't re-record)
let currentServiceUnsub = null; // active service-log subscription
let currentServiceList = [];    // latest service entries for the open unit
let currentPhotoUnsub = null;   // active photo subscription
let selectMode = false;
let pendingAddPhotoLabel = null; // camera capture (model nameplate) waiting to upload with a new unit
let pendingAddPhotoEvap  = null; // camera capture (evaporator) waiting to upload with a new unit
const selected = new Set();     // barcodes selected for bulk actions

// per-project realtime subscriptions — torn down and rebuilt every time
// the open project changes
let unsubUnits = null, unsubComplaints = null, unsubParts = null, unsubVisits = null,
    unsubUpdates = null, unsubWorkdays = null, unsubContacts = null, unsubCrew = null,
    unsubTasks = null, unsubMediaPlan = null, unsubMediaGallery = null, unsubMediaWarranty = null;

// views that need a project open; anything else (projects picker, vehicles,
// vacations) works regardless of which — or whether any — project is open
const PROJECT_SCOPED_VIEWS = new Set([
  "home", "equipment", "add", "dash", "tasks", "contacts", "crew",
  "plans", "gallery", "warranty", "messages", "complaints", "calendar",
]);

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// digits only, leading zeros stripped — for matching scanned labels like "000142172"
const digitsNoZero = (s) => String(s ?? "").replace(/\D/g, "").replace(/^0+/, "");
// canonical barcode for storage: strip leading zeros only when fully numeric
const cleanBarcode = (s) => {
  const t = String(s ?? "").trim();
  return /^\d+$/.test(t) ? (t.replace(/^0+/, "") || "0") : t;
};

// ===================================================================
//  Boot
// ===================================================================
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW:", e));
}

initDb();
startGlobalRealtime();
wireUI();
initBackHandler();
updateGreeting();
setInterval(updateGreeting, 60000);           // keep it current
document.addEventListener("visibilitychange", () => { if (!document.hidden) updateGreeting(); });
if (isConfigured) {
  window.addEventListener("online",  () => setSync("מחובר ✓", "is-online"));
  window.addEventListener("offline", () => setSync("לא מקוון — נשמר מקומית", "is-offline"));
  // detect units that were saved only on THIS device (from an earlier local-only
  // period) and offer to upload them so nothing is lost.
  setTimeout(checkLocalRecovery, 3500);
}

let recoveryChecked = false;
function checkLocalRecovery() {
  if (!currentProjectId) return setTimeout(checkLocalRecovery, 2000);
  if (recoveryChecked) return;
  recoveryChecked = true;
  if (!UNITS.length) { recoveryChecked = false; return setTimeout(checkLocalRecovery, 2000); }
  let lu;
  try { lu = JSON.parse(localStorage.getItem(`ac_units__${currentProjectId}`) || "{}"); } catch { return; }
  const cloudIds = new Set(UNITS.map((u) => u.id));
  const missing = Object.keys(lu).filter((bc) => !cloudIds.has(bc));
  if (missing.length) showRecoveryBanner(missing.length);
}

function showRecoveryBanner(n) {
  let el = document.getElementById("recoverBanner");
  if (!el) { el = document.createElement("div"); el.id = "recoverBanner"; el.className = "recover-banner"; $("#app").prepend(el); }
  el.innerHTML = `⚠️ נמצאו <b>${n}</b> פריטי ציוד שנוספו במכשיר זה ולא סונכרנו לענן.
    <button class="btn btn--primary btn--sm" id="recoverBtn">☁️ שחזר לענן</button>`;
  $("#recoverBtn").addEventListener("click", async () => {
    const btn = $("#recoverBtn"); btn.disabled = true; btn.textContent = "משחזר…";
    try {
      const c = await recoverLocal();
      el.innerHTML = `✅ שוחזרו ${c} פריטים לענן. הנתונים סונכרנו לכל המכשירים.`;
      setTimeout(() => el.remove(), 6000);
    } catch (e) { console.error(e); btn.disabled = false; btn.textContent = "נסה שוב"; toast("שגיאה בשחזור", true); }
  });
}

/** Upload any units in THIS device's local storage (for the current project)
 *  that are missing from the cloud (plus their maintenance history and
 *  photos). Never overwrites cloud data. */
async function recoverLocal() {
  const pid = currentProjectId;
  const lu = JSON.parse(localStorage.getItem(`ac_units__${pid}`) || "{}");
  const ls = JSON.parse(localStorage.getItem(`ac_services__${pid}`) || "{}");
  const lp = JSON.parse(localStorage.getItem(`ac_photos__${pid}`) || "{}");
  const cloudIds = new Set(UNITS.map((u) => u.id));
  let n = 0;
  for (const bc in lu) {
    if (cloudIds.has(bc)) continue;                 // already in cloud — skip, never clobber
    try {
      await saveUnit(pid, lu[bc]);
      for (const s of (ls[bc] || [])) await addService(pid, bc, { date: s.date, description: s.description, technician: s.technician });
      for (const p of (lp[bc] || [])) await addPhoto(pid, bc, p.url);
      n++;
    } catch (e) { console.error("recover failed for", bc, e); }
  }
  console.log("recovered", n, "units to cloud");
  return n;
}
window.recoverLocal = recoverLocal;

/** On-demand diagnostic: show which units exist only on THIS device (for the
 *  current project), and offer restore. */
async function runRecoveryDiag() {
  const box = document.getElementById("recoverDiag");
  if (!box) return;
  let lu = {};
  try { lu = JSON.parse(localStorage.getItem(`ac_units__${currentProjectId}`) || "{}"); } catch {}
  const localCount = Object.keys(lu).length;
  const cloudIds = new Set(UNITS.map((u) => u.id));
  const missing = Object.keys(lu).filter((bc) => !cloudIds.has(bc)).sort();
  if (!localCount) {
    box.innerHTML = `<p class="tl-empty">אין נתונים מקומיים במכשיר זה עבור הפרויקט הנוכחי. נסה במכשיר אחר שבו הוספת ציוד.</p>`;
    return;
  }
  if (!missing.length) {
    box.innerHTML = `<p class="tl-empty">במכשיר זה יש ${localCount} פריטים מקומיים — כולם כבר בענן. אין מה לשחזר כאן.</p>`;
    return;
  }
  box.innerHTML = `
    <p style="font-weight:600;margin:0 0 8px">נמצאו <b>${missing.length}</b> פריטים שקיימים רק במכשיר זה:</p>
    <p style="color:var(--muted);font-size:13px;margin:0 0 12px">${missing.join(", ")}</p>
    <button class="btn btn--primary" id="doRecover">☁️ שחזר ${missing.length} פריטים לענן</button>`;
  document.getElementById("doRecover").addEventListener("click", async () => {
    const b = document.getElementById("doRecover");
    b.disabled = true; b.textContent = "משחזר…";
    try {
      const c = await recoverLocal();
      box.innerHTML = `<p class="form-msg is-ok">✅ שוחזרו ${c} פריטים לענן. הם יופיעו כעת אצל כולם.</p>`;
    } catch (e) { console.error(e); b.disabled = false; b.textContent = "נסה שוב"; }
  });
}
window.runRecoveryDiag = runRecoveryDiag;

/** Time-of-day greeting, based on the device's local clock. */
function updateGreeting() {
  const el = $("#greeting");
  if (!el) return;
  const h = new Date().getHours();
  let text, icon;
  if (h >= 5 && h < 12)       { text = "בוקר טוב";     icon = "🌅"; }
  else if (h >= 12 && h < 18) { text = "צהריים טובים"; icon = "☀️"; }
  else                        { text = "ערב טוב";      icon = "🌙"; }
  el.innerHTML = `<span class="greeting__icon">${icon}</span> ${text} לחברת <b>ג.פ מיזוגים בע"מ</b>`;
}

// ===================================================================
//  Real-time data
// ===================================================================

/** Subscribed once at boot: the projects list itself, plus the two
 *  staff-level collections that aren't tied to any one project. */
function startGlobalRealtime() {
  watchProjects(
    (list) => {
      PROJECTS = list;
      if (!projectsBooted) {
        bootIntoProject();
      } else {
        // the current project may have been deleted from another device
        if (currentProjectId && !PROJECTS.find((p) => p.id === currentProjectId)) {
          currentProjectId = null;
          localStorage.removeItem("ac_current_project");
          stopProjectRealtime();
          switchView("projects");
        }
        updateHeaderProject();
        if ($("#view-projects").classList.contains("is-active")) renderProjects();
      }
    },
    (err) => console.error(err)
  );
  watchVacations(
    (list) => {
      VACATIONS = list; renderVacationWeek();
      if ($("#view-vacations").classList.contains("is-active")) renderVacations();
      if ($("#view-calendar").classList.contains("is-active")) renderCalendar();
    },
    (err) => console.error(err)
  );
  watchVehicleItems(
    (list) => { VEHICLE_ITEMS = list; if ($("#view-vehicles").classList.contains("is-active")) renderVehicles(); },
    (err) => console.error(err)
  );
}

/** First time the projects list arrives: jump straight back into the
 *  last-used project, or show the picker if there isn't one (yet). */
function bootIntoProject() {
  projectsBooted = true;
  if (currentProjectId && PROJECTS.find((p) => p.id === currentProjectId)) {
    openProject(currentProjectId);
  } else {
    currentProjectId = null;
    updateHeaderProject();
    switchView("projects");
  }
}

/** Open one project: tear down the previous project's subscriptions (if
 *  any), remember the choice, and subscribe to this one's data. */
function openProject(id) {
  const p = PROJECTS.find((x) => x.id === id);
  if (!p) return;
  stopProjectRealtime();
  currentProjectId = id;
  localStorage.setItem("ac_current_project", id);
  updateHeaderProject();
  startProjectRealtime(id);
  switchView("home");
}

function updateHeaderProject() {
  const el = $("#headerProjectName");
  if (!el) return;
  const p = PROJECTS.find((x) => x.id === currentProjectId);
  el.textContent = p ? p.name : "בחר פרויקט";
}

/** Everything that belongs to ONE job site. Re-subscribed every time the
 *  open project changes. */
function startProjectRealtime(pid) {
  $("#syncStatus").hidden = !isConfigured;
  setSync("···", "");
  unsubUnits = watchUnits(pid,
    (units) => { UNITS = units; onUnitsChanged(); if (isConfigured) setSync("מחובר ✓", "is-online"); },
    (err)   => { console.error(err); setSync("שגיאת חיבור", "is-error"); toast("שגיאת חיבור למסד הנתונים", true); }
  );
  unsubComplaints = watchComplaints(pid,
    (list) => { COMPLAINTS = list; if ($("#view-complaints").classList.contains("is-active")) renderComplaints(); },
    (err) => console.error(err)
  );
  unsubParts = watchParts(pid,
    (list) => { PARTS = list; if ($("#view-dash").classList.contains("is-active")) renderDashboard(); refreshPartsModal(); },
    (err) => console.error(err)
  );
  unsubVisits = watchVisits(pid,
    (list) => {
      VISITS = list; renderUpcoming();
      if ($("#view-calendar").classList.contains("is-active")) renderCalendar();
      if ($("#view-dash").classList.contains("is-active")) renderDashboard();
    },
    (err) => console.error(err)
  );
  unsubUpdates = watchUpdates(pid,
    (list) => {
      UPDATES = list; renderUpdates();
      if ($("#view-messages").classList.contains("is-active")) renderMessages();
    },
    (err) => console.error(err)
  );
  unsubWorkdays = watchWorkdays(pid,
    (list) => { WORKDAYS = list; if ($("#view-calendar").classList.contains("is-active")) renderCalendar(); },
    (err) => console.error(err)
  );
  unsubContacts = watchContacts(pid,
    (list) => { CONTACTS = list; if ($("#view-contacts").classList.contains("is-active")) renderContacts(); },
    (err) => console.error(err)
  );
  unsubCrew = watchCrew(pid,
    (list) => { CREW = list; if ($("#view-crew").classList.contains("is-active")) renderCrew(); },
    (err) => console.error(err)
  );
  unsubTasks = watchTasks(pid,
    (list) => {
      TASKS = list;
      if ($("#view-tasks").classList.contains("is-active")) renderTasks();
      if ($("#view-dash").classList.contains("is-active")) renderDashboard();
    },
    (err) => console.error(err)
  );
  unsubMediaPlan = watchMedia(pid, "plan",
    (list) => { MEDIA.plan = list; if ($("#view-plans").classList.contains("is-active")) renderMedia("plan"); },
    (err) => console.error(err)
  );
  unsubMediaGallery = watchMedia(pid, "gallery",
    (list) => { MEDIA.gallery = list; if ($("#view-gallery").classList.contains("is-active")) renderMedia("gallery"); },
    (err) => console.error(err)
  );
  unsubMediaWarranty = watchMedia(pid, "warranty",
    (list) => { MEDIA.warranty = list; if ($("#view-warranty").classList.contains("is-active")) renderMedia("warranty"); },
    (err) => console.error(err)
  );
}

/** Unsubscribe from the currently-open project's data and clear it from
 *  memory (called before switching to another project, or when the open
 *  project disappears). */
function stopProjectRealtime() {
  [unsubUnits, unsubComplaints, unsubParts, unsubVisits, unsubUpdates, unsubWorkdays,
   unsubContacts, unsubCrew, unsubTasks, unsubMediaPlan, unsubMediaGallery, unsubMediaWarranty]
    .forEach((u) => u && u());
  unsubUnits = unsubComplaints = unsubParts = unsubVisits = unsubUpdates = unsubWorkdays =
    unsubContacts = unsubCrew = unsubTasks = unsubMediaPlan = unsubMediaGallery = unsubMediaWarranty = null;
  UNITS = []; COMPLAINTS = []; PARTS = []; VISITS = []; UPDATES = []; WORKDAYS = [];
  CONTACTS = []; CREW = []; TASKS = []; MEDIA = { plan: [], gallery: [], warranty: [] };
}

function onUnitsChanged() {
  populateDatalists();
  renderEquipment();
  renderDashboard();
  // if detail modal open, refresh its fields from the latest data
  const openBarcode = $("#modal").dataset.barcode;
  if (openBarcode && !$("#modal").hidden) {
    const u = UNITS.find((x) => x.id === openBarcode);
    if (u) refreshDetailFields(u);
  }
}

function setSync(text, cls) {
  const b = $("#syncStatus");
  const span = b.querySelector("span");
  if (span) span.textContent = text; else b.textContent = text;
  b.className = "sync-badge " + cls;
}

// ===================================================================
//  UI wiring
// ===================================================================
function wireUI() {
  // tab navigation
  $$(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));

  // project switcher
  $("#headerProjectName").addEventListener("click", () => switchView("projects"));
  $("#btnAddProject").addEventListener("click", () => openProjectForm());

  // equipment (search + bulk select)
  $("#search").addEventListener("input", debounce(renderEquipment, 120));
  $("#btnScan").addEventListener("click", () =>
    startScan((code) => { $("#search").value = code; renderEquipment(); }));
  $("#btnSelect").addEventListener("click", toggleSelectMode);
  $("#bulkAll").addEventListener("change", (e) => selectAll(e.target.checked));
  $("#bulkNote").addEventListener("click", bulkNotePrompt);
  $("#bulkMaint").addEventListener("click", bulkMaintPrompt);

  // add form
  $("#addForm").addEventListener("submit", onAddSubmit);
  $("#btnScanAdd").addEventListener("click", () =>
    startScan((code) => { $('#addForm [name=barcode]').value = cleanBarcode(code); }));
  // camera capture for a new unit (in-app; not saved to the device gallery)
  // two slots: the model nameplate sticker, and the evaporator (indoor coil)
  $("#btnAddUnitPhotoLabel").addEventListener("click", () => $("#addPhotoInputLabel").click());
  $("#addPhotoInputLabel").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingAddPhotoLabel = file;
    const prev = $("#addPhotoPreviewLabel");
    prev.src = URL.createObjectURL(file);
    prev.hidden = false;
    $("#addPhotoStatusLabel").textContent = "📷 התמונה תישמר עם המזגן";
  });
  $("#btnAddUnitPhotoEvap").addEventListener("click", () => $("#addPhotoInputEvap").click());
  $("#addPhotoInputEvap").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingAddPhotoEvap = file;
    const prev = $("#addPhotoPreviewEvap");
    prev.src = URL.createObjectURL(file);
    prev.hidden = false;
    $("#addPhotoStatusEvap").textContent = "📷 התמונה תישמר עם המזגן";
  });

  // side menu
  $("#menuBtn").addEventListener("click", () => { $("#sideMenu").hidden = false; });
  $("#sideMenu").addEventListener("click", (e) => { if (e.target.dataset.close !== undefined) closeSideMenu(); });
  $("#menuProjects").addEventListener("click", () => { closeSideMenu(); switchView("projects"); });
  $("#menuVehicles").addEventListener("click", () => { closeSideMenu(); switchView("vehicles"); });
  $("#menuExport").addEventListener("click", () => { closeSideMenu(); openExportForm(); });
  $("#menuVacations").addEventListener("click", () => { closeSideMenu(); switchView("vacations"); });
  $("#menuName").addEventListener("click", () => { closeSideMenu(); openNameForm(); });
  $("#menuRecover").addEventListener("click", () => {
    closeSideMenu();
    if (!currentProjectId) { toast("בחר קודם פרויקט", true); return; }
    openRecoveryScreen();
  });
  $("#menuAbout").addEventListener("click", () => { closeSideMenu(); openAbout(); });

  // team updates (home widget + full messages view)
  $("#teamAdd").addEventListener("click", openUpdateForm);
  $("#btnNewMessage").addEventListener("click", openUpdateForm);

  // vehicle inventory tabs
  $$("#vehTabs .seg").forEach((s) => s.addEventListener("click", () => { vehicleSel = s.dataset.owner; renderVehicles(); }));

  // vacations
  $("#btnNewVacation").addEventListener("click", () => openVacationForm());

  // complaints
  $("#btnNewComplaint").addEventListener("click", () => openComplaintForm());
  $$("#view-complaints .cmpl-filter .seg").forEach((s) => s.addEventListener("click", () => {
    $$("#view-complaints .cmpl-filter .seg").forEach((x) => x.classList.toggle("is-active", x === s));
    renderComplaints();
  }));

  // tasks
  $("#btnNewTask").addEventListener("click", () => openTaskForm());
  $$(".task-filter .seg").forEach((s) => s.addEventListener("click", () => {
    $$(".task-filter .seg").forEach((x) => x.classList.toggle("is-active", x === s));
    renderTasks();
  }));

  // contacts
  $("#btnNewContact").addEventListener("click", () => openContactForm());

  // media (plans / gallery / warranty)
  $$("[data-media-add]").forEach((b) => b.addEventListener("click", () => addMediaPhoto(b.dataset.mediaAdd)));

  // modal close
  $("#modal").addEventListener("click", (e) => { if (e.target.dataset.close !== undefined) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
}

function switchView(name) {
  // views that need project data force the picker if none is open yet
  if (PROJECT_SCOPED_VIEWS.has(name) && !currentProjectId) name = "projects";
  $$(".view").forEach((v) => v.classList.toggle("is-active", v.id === `view-${name}`));
  $$(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.view === name));
  stopScan();
  if (name === "projects") renderProjects();
  if (name === "home") renderHome();
  if (name === "equipment") renderEquipment();
  if (name === "complaints") renderComplaints();
  if (name === "vacations") renderVacations();
  if (name === "vehicles") renderVehicles();
  if (name === "calendar") renderCalendar();
  if (name === "dash") renderDashboard();
  if (name === "tasks") renderTasks();
  if (name === "contacts") renderContacts();
  if (name === "crew") renderCrew();
  if (name === "plans") renderMedia("plan");
  if (name === "gallery") renderMedia("gallery");
  if (name === "warranty") renderMedia("warranty");
  if (name === "messages") renderMessages();
  // leaving equipment resets bulk selection
  if (name !== "equipment" && selectMode) exitSelectMode();
  // record for the Back button (unless we're restoring via Back)
  if (!suppressPush && viewStack[viewStack.length - 1] !== name) viewStack.push(name);
}

// ===================================================================
//  Hardware / browser Back button — navigate within the app, don't exit
// ===================================================================
function closeTopOverlay() {
  if (!$("#scanOverlay").hidden) { stopScan(); $("#scanOverlay").hidden = true; return true; }
  const pv = document.querySelector(".photo-viewer"); if (pv) { pv.remove(); return true; }
  if (!$("#sideMenu").hidden) { closeSideMenu(); return true; }
  if (!$("#modal").hidden) { closeModal(); return true; }
  return false;
}

function initBackHandler() {
  history.replaceState({ ac: true }, "");
  history.pushState({ ac: true }, "");   // buffer so Back stays inside the app
  window.addEventListener("popstate", () => {
    // 1) if something is open on top, Back just closes it
    if (closeTopOverlay()) { history.pushState({ ac: true }, ""); return; }
    // 2) otherwise step back one view
    if (viewStack.length > 1) {
      viewStack.pop();
      suppressPush = true;
      switchView(viewStack[viewStack.length - 1]);
      suppressPush = false;
    }
    // 3) always keep a buffer so we never fall out of the app
    history.pushState({ ac: true }, "");
  });
}

// ===================================================================
//  Projects (job sites) — the top-level entity
// ===================================================================
function renderProjects() {
  const box = $("#projectsGrid"); if (!box) return;
  if (!PROJECTS.length) {
    box.innerHTML = emptyHTML("🗂️", "אין עדיין פרויקטים", 'הוסף פרויקט חדש עם הכפתור "➕ פרויקט חדש"');
    return;
  }
  box.innerHTML = PROJECTS.map((p) => {
    const cover = p.cover
      ? `<img class="proj-card__img" src="${esc(p.cover)}" alt="">`
      : `<div class="proj-card__img proj-card__img--empty">🗂️</div>`;
    return `
      <div class="proj-card ${p.id === currentProjectId ? "is-current" : ""}" data-id="${esc(p.id)}">
        ${cover}
        <div class="proj-card__body">
          <div class="proj-card__name">${esc(p.name)}</div>
          ${p.client ? `<div class="proj-card__meta">👤 ${esc(p.client)}</div>` : ""}
          ${p.address ? `<div class="proj-card__meta">📍 ${esc(p.address)}</div>` : ""}
        </div>
        <button class="proj-edit-btn" data-edit="${esc(p.id)}" title="עריכת פרויקט">✏️</button>
      </div>`;
  }).join("");

  $$(".proj-card", box).forEach((c) => c.addEventListener("click", (e) => {
    if (e.target.closest(".proj-edit-btn")) return;
    openProject(c.dataset.id);
  }));
  $$(".proj-edit-btn", box).forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    openProjectForm(btn.dataset.edit);
  }));
}

function openProjectForm(id) {
  const p = id ? PROJECTS.find((x) => x.id === id) || {} : {};
  clearModalSubs();
  const modal = $("#modal");
  modal.dataset.barcode = ""; modal.dataset.parts = "";
  $("#modalPanel").innerHTML = `
    <div class="detail__head">
      <div class="detail__barcode">🗂️ ${id ? "עריכת פרויקט" : "פרויקט חדש"}</div>
      <button class="detail__close" data-close>×</button>
    </div>
    <form class="form" id="projEntityForm">
      <label>שם הפרויקט<input name="name" value="${esc(p.name || "")}" required placeholder="לדוגמה: בניין רוטשילד 12"></label>
      <label>לקוח<input name="client" value="${esc(p.client || "")}" placeholder="שם הלקוח (אופציונלי)"></label>
      <label>כתובת<input name="address" value="${esc(p.address || "")}" placeholder="כתובת האתר (אופציונלי)"></label>
      <label>הערות<textarea name="notes" rows="2">${esc(p.notes || "")}</textarea></label>
      <div class="detail__actions">
        <button type="submit" class="btn btn--primary">💾 שמור</button>
        ${id ? `<button type="button" class="btn btn--danger" id="projEntityDelete">🗑️ מחק פרויקט</button>`
             : `<button type="button" class="btn btn--ghost" data-close>ביטול</button>`}
      </div>
    </form>`;
  modal.hidden = false;

  $("#projEntityForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const data = { name: f.name.value, client: f.client.value, address: f.address.value, notes: f.notes.value };
    if (!data.name.trim()) return;
    try {
      if (id) { await updateProject(id, data); toast("💾 הפרויקט עודכן"); closeModal(); }
      else { const newId = await addProject(data); toast("✅ הפרויקט נוצר"); closeModal(); openProject(newId); }
    } catch (err) { console.error(err); toast("שגיאה בשמירה", true); }
  });
  if (id) $("#projEntityDelete").addEventListener("click", async () => {
    if (!confirm(`למחוק את הפרויקט "${p.name}"? פעולה זו תמחק את כל הציוד, אנשי הקשר, המסמכים והנתונים שבו — ואינה הפיכה.`)) return;
    try {
      await deleteProject(id);
      if (currentProjectId === id) {
        currentProjectId = null;
        localStorage.removeItem("ac_current_project");
        stopProjectRealtime();
      }
      toast("🗑️ הפרויקט נמחק"); closeModal(); switchView("projects");
    } catch (err) { console.error(err); toast("שגיאה במחיקה", true); }
  });
}

// ===================================================================
//  Home (per-project landing screen)
// ===================================================================
function renderHome() {
  renderUpcoming();
  renderVacationWeek();
  renderUpdates();
  const box = $("#homeGrid"); if (!box) return;
  box.innerHTML = HOME_SECTIONS.map((c) => `
    <div class="sect-card" data-view="${c.view}">
      <div class="sect-card__icon">${c.icon}</div>
      <div class="sect-card__label">${esc(c.label)}</div>
    </div>`).join("");
  $$(".sect-card", box).forEach((el) => el.addEventListener("click", () => {
    if (el.dataset.view === "parts") openPartsModal();
    else switchView(el.dataset.view);
  }));
}

// ===================================================================
//  Equipment (installed AC units) — search + bulk select
// ===================================================================
function currentEquipmentUnits() {
  const term = $("#search").value.trim().toLowerCase();
  return term ? UNITS.filter((u) => unitMatches(u, term)) : UNITS;
}

function unitMatches(u, term) {
  const textHit = [u.barcode, u.building, u.type, u.location, u.notes, u.lastService, u.oldSku]
    .some((f) => String(f ?? "").toLowerCase().includes(term));
  if (textHit) return true;
  // barcode match ignoring leading zeros / spaces / dashes (scanned asset labels)
  const td = digitsNoZero(term);
  if (td) {
    const bd = digitsNoZero(u.barcode);
    if (bd && bd.includes(td)) return true;
  }
  return false;
}

function renderEquipment() {
  const items = currentEquipmentUnits();
  const term = $("#search").value.trim();
  $("#listCount").textContent = items.length;
  const box = $("#equipmentResults");
  box.innerHTML = items.length
    ? items.map((u) => cardHTML(u, selectMode)).join("")
    : emptyHTML("📭", term ? "לא נמצאו תוצאות" : "אין עדיין ציוד", term ? `אין פריט שמתאים ל־"${esc(term)}"` : 'הוסף מזגן עם כרטיסיית "➕ הוספה"');
  wireCards(box);
  updateBulkCount();
}

// ===================================================================
//  Card rendering
// ===================================================================
function cardHTML(u, selecting = false) {
  const tags = [u.type, u.building].filter(Boolean)
    .map((t) => `<span class="chip">${esc(t)}</span>`).join("");
  const isSel = selecting && selected.has(u.id);
  return `
    <div class="card ${isSel ? "is-selected" : ""}" data-barcode="${esc(u.id)}">
      ${selecting
        ? `<span class="card__check">${isSel ? "✓" : ""}</span>`
        : `<div class="card__icon">❄️</div>`}
      <div class="card__body">
        <div class="card__head">
          <span class="card__barcode">${esc(u.barcode)}</span>
          <span class="status-chip ${st(u.status).cls}">${st(u.status).icon} ${st(u.status).label}</span>
        </div>
        ${u.building ? `<div class="card__row"><b>🏢</b> ${esc(u.building)}${u.area ? ` · ${esc(u.area)}` : ""}</div>` : ""}
        ${u.location ? `<div class="card__row"><b>📍</b> ${esc(u.location)}</div>` : ""}
        ${u.lastService ? `<div class="card__row"><b>🔧</b> ${esc(u.lastService)}</div>` : ""}
        ${u.notes ? `<div class="card__row"><b>📝</b> ${esc(u.notes)}</div>` : ""}
        ${tags ? `<div class="card__tags">${tags}</div>` : ""}
      </div>
      ${selecting ? "" : `<span class="card__chev">‹</span>`}
    </div>`;
}

function wireCards(root) {
  const selecting = selectMode && root.id === "equipmentResults";
  $$(".card", root).forEach((c) => c.addEventListener("click", () => {
    if (selecting) toggleSelect(c.dataset.barcode, c);
    else openDetail(c.dataset.barcode);
  }));
}

// ---- Bulk selection ----
function toggleSelectMode() { selectMode ? exitSelectMode() : enterSelectMode(); }
function enterSelectMode() {
  selectMode = true; selected.clear();
  $("#btnSelect").textContent = "ביטול";
  $("#bulkBar").hidden = false;
  renderEquipment();
}
function exitSelectMode() {
  selectMode = false; selected.clear();
  $("#btnSelect").textContent = "בחירה";
  $("#bulkBar").hidden = true;
  const all = $("#bulkAll"); if (all) all.checked = false;
  renderEquipment();
}
function toggleSelect(barcode, cardEl) {
  if (selected.has(barcode)) selected.delete(barcode); else selected.add(barcode);
  cardEl.classList.toggle("is-selected", selected.has(barcode));
  const chk = cardEl.querySelector(".card__check");
  if (chk) chk.textContent = selected.has(barcode) ? "✓" : "";
  updateBulkCount();
}
function selectAll(checked) {
  selected.clear();
  if (checked) currentEquipmentUnits().forEach((u) => selected.add(u.id));
  renderEquipment();
}
function updateBulkCount() {
  const el = $("#bulkCount"); if (el) el.textContent = `${selected.size} נבחרו`;
}
async function bulkNotePrompt() {
  if (!selected.size) return toast("לא נבחר ציוד", true);
  const note = prompt(`הוספת הערה ל-${selected.size} פריטים:`);
  if (!note || !note.trim()) return;
  try { await bulkAppendNote(currentProjectId, [...selected], note); toast(`✅ עודכנו ${selected.size} פריטים`); exitSelectMode(); }
  catch (e) { console.error(e); toast("שגיאה בעדכון", true); }
}
async function bulkMaintPrompt() {
  if (!selected.size) return toast("לא נבחר ציוד", true);
  const desc = prompt(`רשומת טיפול ל-${selected.size} פריטים — מה בוצע?`);
  if (!desc || !desc.trim()) return;
  try {
    await bulkAddService(currentProjectId, [...selected], { date: new Date().toISOString().slice(0, 10), description: desc, technician: "" });
    toast(`✅ נוסף טיפול ל-${selected.size} פריטים`); exitSelectMode();
  } catch (e) { console.error(e); toast("שגיאה בשמירה", true); }
}

// ===================================================================
//  Complaints / service requests view
// ===================================================================
function renderComplaints() {
  const box = $("#complaintsList"); if (!box) return;
  const filt = $("#view-complaints .cmpl-filter .seg.is-active")?.dataset.cf || "open";
  let list = COMPLAINTS;
  if (filt === "open") list = list.filter((c) => c.status !== "done");
  else if (filt === "done") list = list.filter((c) => c.status === "done");
  box.innerHTML = list.length
    ? list.map(complaintHTML).join("")
    : emptyHTML("📣", "אין פניות", "הוסף פנייה חדשה עם הכפתור ➕ פנייה");
  $$(".cmpl", box).forEach((c) => c.addEventListener("click", () => openComplaintForm(c.dataset.id)));
}

function complaintHTML(c) {
  const done = c.status === "done";
  const meta = [
    c.barcode ? `<span>❄️ ${esc(c.barcode)}</span>` : "",
    c.phone ? `<span>📞 ${esc(c.phone)}</span>` : "",
  ].filter(Boolean).join("");
  return `
    <div class="card cmpl ${done ? "is-done" : ""}" data-id="${esc(c.id)}">
      <div class="card__body">
        <div class="card__head">
          <span class="cmpl__customer">${esc(c.customer || "לקוח")}</span>
          <span class="chip ${done ? "chip--done" : "chip--warn"}">${done ? "✓ טופל" : "פתוח"}</span>
        </div>
        ${c.description ? `<div class="cmpl__desc">${esc(c.description)}</div>` : ""}
        ${meta ? `<div class="cmpl__meta">${meta}</div>` : ""}
      </div>
    </div>`;
}

function openComplaintForm(id) {
  const c = id ? COMPLAINTS.find((x) => x.id === id) || {} : {};
  clearModalSubs();
  const modal = $("#modal");
  modal.dataset.barcode = "";
  $("#modalPanel").innerHTML = `
    <div class="detail__head">
      <div class="detail__barcode">📣 ${id ? "עריכת פנייה" : "פנייה חדשה"}</div>
      <button class="detail__close" data-close>×</button>
    </div>
    <form class="form" id="cmplForm">
      <label>שם הלקוח<input name="customer" value="${esc(c.customer || "")}" placeholder="שם"></label>
      <label>טלפון<input name="phone" inputmode="tel" value="${esc(c.phone || "")}" placeholder="מספר טלפון"></label>
      <label>ברקוד מזגן (אופציונלי)<input name="barcode" value="${esc(c.barcode || "")}" placeholder="ברקוד"></label>
      <label>תיאור התקלה / הפנייה<textarea name="description" rows="3" required placeholder="מה הלקוח דיווח?">${esc(c.description || "")}</textarea></label>
      <label class="chk"><input type="checkbox" name="done" ${c.status === "done" ? "checked" : ""}> סומן כטופל</label>
      <div class="detail__actions">
        <button type="submit" class="btn btn--primary">💾 שמור</button>
        ${id ? `<button type="button" class="btn btn--danger" id="cmplDelete">🗑️ מחק</button>`
             : `<button type="button" class="btn btn--ghost" data-close>ביטול</button>`}
      </div>
    </form>`;
  modal.hidden = false;

  $("#cmplForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const data = {
      customer: f.customer.value, phone: f.phone.value,
      barcode: cleanBarcode(f.barcode.value),
      description: f.description.value, status: f.done.checked ? "done" : "open",
    };
    if (!data.description.trim()) return;
    try {
      if (id) await updateComplaint(currentProjectId, id, data); else await addComplaint(currentProjectId, data);
      toast("💾 הפנייה נשמרה"); closeModal();
    } catch (err) { console.error(err); toast("שגיאה בשמירה", true); }
  });
  if (id) $("#cmplDelete").addEventListener("click", async () => {
    if (!confirm("למחוק את הפנייה?")) return;
    try { await deleteComplaint(currentProjectId, id); toast("🗑️ נמחק"); closeModal(); }
    catch (err) { console.error(err); toast("שגיאה במחיקה", true); }
  });
}

// ===================================================================
//  Contacts
// ===================================================================
function renderContacts() {
  const box = $("#contactsList"); if (!box) return;
  box.innerHTML = CONTACTS.length
    ? CONTACTS.map(contactHTML).join("")
    : emptyHTML("👤", "אין אנשי קשר", "הוסף איש קשר עם הכפתור ➕ איש קשר");
  $$(".contact", box).forEach((c) => c.addEventListener("click", () => openContactForm(c.dataset.id)));
}

function contactHTML(c) {
  const meta = [c.role, c.phone ? `📞 ${c.phone}` : ""].filter(Boolean).map(esc).join(" · ");
  return `
    <div class="card cmpl contact" data-id="${esc(c.id)}">
      <div class="card__body">
        <div class="card__head"><span class="cmpl__customer">${esc(c.name || "איש קשר")}</span></div>
        ${meta ? `<div class="cmpl__meta">${meta}</div>` : ""}
        ${c.notes ? `<div class="cmpl__desc">${esc(c.notes)}</div>` : ""}
      </div>
    </div>`;
}

function openContactForm(id) {
  const c = id ? CONTACTS.find((x) => x.id === id) || {} : {};
  clearModalSubs();
  const modal = $("#modal");
  modal.dataset.barcode = ""; modal.dataset.parts = "";
  $("#modalPanel").innerHTML = `
    <div class="detail__head">
      <div class="detail__barcode">👤 ${id ? "עריכת איש קשר" : "איש קשר חדש"}</div>
      <button class="detail__close" data-close>×</button>
    </div>
    <form class="form" id="contactForm">
      <label>שם<input name="name" value="${esc(c.name || "")}" required placeholder="שם מלא"></label>
      <label>תפקיד<input name="role" value="${esc(c.role || "")}" placeholder="לדוגמה: מנהל עבודה, קבלן ראשי"></label>
      <label>טלפון<input name="phone" inputmode="tel" value="${esc(c.phone || "")}" placeholder="מספר טלפון"></label>
      <label>הערות<textarea name="notes" rows="2">${esc(c.notes || "")}</textarea></label>
      <div class="detail__actions">
        <button type="submit" class="btn btn--primary">💾 שמור</button>
        ${id ? `<button type="button" class="btn btn--danger" id="contactDelete">🗑️ מחק</button>`
             : `<button type="button" class="btn btn--ghost" data-close>ביטול</button>`}
      </div>
    </form>`;
  modal.hidden = false;
  $("#contactForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const data = { name: f.name.value, role: f.role.value, phone: f.phone.value, notes: f.notes.value };
    if (!data.name.trim()) return;
    try {
      if (id) await updateContact(currentProjectId, id, data); else await addContact(currentProjectId, data);
      toast("💾 נשמר"); closeModal();
    } catch (err) { console.error(err); toast("שגיאה בשמירה", true); }
  });
  if (id) $("#contactDelete").addEventListener("click", async () => {
    if (!confirm("למחוק את איש הקשר?")) return;
    try { await deleteContact(currentProjectId, id); toast("🗑️ נמחק"); closeModal(); }
    catch (err) { console.error(err); toast("שגיאה במחיקה", true); }
  });
}

// ===================================================================
//  Project crew (workers on this project)
// ===================================================================
function renderCrew() {
  const box = $("#crewBody"); if (!box) return;
  box.innerHTML = `
    <form class="svc-form" id="crewForm" style="border-top:none;margin-top:8px;padding-top:0">
      <div class="row"><input name="name" placeholder="שם העובד" required><input name="role" placeholder="תפקיד (אופציונלי)"></div>
      <button class="btn btn--primary" type="submit">➕ הוסף לצוות</button>
    </form>
    <div class="veh-list">
      ${CREW.length ? CREW.map(crewRow).join("") : `<p class="tl-empty">עדיין לא נוספו אנשי צוות.</p>`}
    </div>`;
  $("#crewForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!f.name.value.trim()) return;
    try { await addCrewMember(currentProjectId, { name: f.name.value, role: f.role.value }); f.reset(); }
    catch (err) { console.error(err); toast("שגיאה", true); }
  });
  $$(".veh-item", box).forEach((el) => {
    el.querySelector(".veh-del").addEventListener("click", async () => {
      try { await deleteCrewMember(currentProjectId, el.dataset.id); } catch (e) { console.error(e); toast("שגיאה", true); }
    });
  });
}
function crewRow(c) {
  return `
    <div class="veh-item" data-id="${esc(c.id)}">
      <span class="veh-name">${esc(c.name)}${c.role ? ` · ${esc(c.role)}` : ""}</span>
      <button class="veh-del" title="מחק">🗑️</button>
    </div>`;
}

// ===================================================================
//  Tasks (open / closed)
// ===================================================================
function renderTasks() {
  const box = $("#tasksList"); if (!box) return;
  const filt = $(".task-filter .seg.is-active")?.dataset.tf || "open";
  let list = TASKS;
  if (filt === "open") list = list.filter((t) => !t.done);
  else if (filt === "done") list = list.filter((t) => t.done);
  box.innerHTML = list.length
    ? list.map(taskHTML).join("")
    : emptyHTML("✅", "אין משימות", "הוסף משימה עם הכפתור ➕ משימה");
  $$(".task-row", box).forEach((row) => {
    const id = row.dataset.id;
    const t = TASKS.find((x) => x.id === id);
    row.querySelector("[data-toggle]").addEventListener("click", async (e) => {
      e.stopPropagation();
      try { await updateTask(currentProjectId, id, { done: !t.done }); } catch (err) { console.error(err); toast("שגיאה", true); }
    });
    row.querySelector("[data-del]").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("למחוק את המשימה?")) return;
      try { await deleteTask(currentProjectId, id); } catch (err) { console.error(err); toast("שגיאה", true); }
    });
    row.addEventListener("click", (e) => { if (e.target.closest("[data-toggle],[data-del]")) return; openTaskForm(id); });
  });
}
function taskHTML(t) {
  const meta = [t.assignee, t.dueDate ? `📅 ${fmtDMY(t.dueDate)}` : ""].filter(Boolean).map(esc).join(" · ");
  return `
    <div class="task-row ${t.done ? "is-done" : ""}" data-id="${esc(t.id)}">
      <button class="part-check" data-toggle>${t.done ? "✅" : "⬜"}</button>
      <div class="part-row__body"><b>${esc(t.title)}</b>${meta ? `<div class="part-row__bld">${meta}</div>` : ""}</div>
      <button class="part-del" data-del>🗑️</button>
    </div>`;
}
function openTaskForm(id) {
  const t = id ? TASKS.find((x) => x.id === id) || {} : {};
  clearModalSubs();
  const modal = $("#modal");
  modal.dataset.barcode = ""; modal.dataset.parts = "";
  $("#modalPanel").innerHTML = `
    <div class="detail__head">
      <div class="detail__barcode">✅ ${id ? "עריכת משימה" : "משימה חדשה"}</div>
      <button class="detail__close" data-close>×</button>
    </div>
    <form class="form" id="taskForm">
      <label>כותרת<input name="title" value="${esc(t.title || "")}" required placeholder="מה צריך לעשות?"></label>
      <label>אחראי<input name="assignee" value="${esc(t.assignee || "")}" placeholder="שם (אופציונלי)"></label>
      <label>תאריך יעד<input type="date" name="dueDate" value="${esc(t.dueDate || "")}"></label>
      <label class="chk"><input type="checkbox" name="done" ${t.done ? "checked" : ""}> סומן כהושלם</label>
      <div class="detail__actions">
        <button type="submit" class="btn btn--primary">💾 שמור</button>
        ${id ? `<button type="button" class="btn btn--danger" id="taskDelete">🗑️ מחק</button>`
             : `<button type="button" class="btn btn--ghost" data-close>ביטול</button>`}
      </div>
    </form>`;
  modal.hidden = false;
  $("#taskForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const data = { title: f.title.value, assignee: f.assignee.value, dueDate: f.dueDate.value, done: f.done.checked };
    if (!data.title.trim()) return;
    try {
      if (id) await updateTask(currentProjectId, id, data); else await addTask(currentProjectId, data);
      toast("💾 נשמר"); closeModal();
    } catch (err) { console.error(err); toast("שגיאה בשמירה", true); }
  });
  if (id) $("#taskDelete").addEventListener("click", async () => {
    if (!confirm("למחוק את המשימה?")) return;
    try { await deleteTask(currentProjectId, id); toast("🗑️ נמחק"); closeModal(); }
    catch (err) { console.error(err); toast("שגיאה במחיקה", true); }
  });
}

// ===================================================================
//  Media (plans / photo gallery / warranty) — images only, one shared
//  implementation reused by all three sections via a category filter.
// ===================================================================
function renderMedia(category) {
  const box = $(`#mediaGrid-${category}`); if (!box) return;
  const list = MEDIA[category] || [];
  box.innerHTML = list.length
    ? list.map((m) => `
        <div class="photo-thumb">
          <img src="${esc(m.url)}" alt="">
          ${m.label ? `<span class="photo-thumb__label">${esc(m.label)}</span>` : ""}
          <button class="photo-del" data-del="${esc(m.id)}" title="מחק">✕</button>
        </div>`).join("")
    : emptyHTML("🖼️", "אין עדיין תמונות", 'הוסף תמונה עם הכפתור "➕ תמונה"');
  $$(".photo-thumb img", box).forEach((img) => img.addEventListener("click", () => openPhotoViewer(img.src)));
  $$(".photo-del", box).forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("למחוק את התמונה?")) return;
    try { await deleteMedia(currentProjectId, b.dataset.del); } catch (e) { console.error(e); toast("שגיאה", true); }
  }));
}
async function addMediaPhoto(category) {
  const files = await pickImages();
  if (!files.length) return;
  toast("מעלה תמונות…");
  try {
    for (const f of files) await addMedia(currentProjectId, category, await compressImage(f));
    toast(`✅ נוספו ${files.length} תמונות`);
  } catch (err) { console.error(err); toast("שגיאה בהעלאת תמונה", true); }
}

// ===================================================================
//  Team messages (full history — same data as the Home widget)
// ===================================================================
function renderMessages() {
  const box = $("#messagesList"); if (!box) return;
  box.innerHTML = UPDATES.length
    ? UPDATES.map((u) => `
        <div class="team__item" data-id="${esc(u.id)}">
          <button class="team__x" title="הסר">✕</button>
          <div class="team__body">
            <div class="team__text">${esc(u.text)}</div>
            <div class="team__meta">👤 ${esc(u.author || "צוות")} · ${esc(fmtTime(u.createdAt))}</div>
          </div>
        </div>`).join("")
    : `<p class="team__empty">אין עדכונים.</p>`;
  $$(".team__x", box).forEach((b) => b.addEventListener("click", async () => {
    const id = b.closest(".team__item").dataset.id;
    try { await deleteUpdate(currentProjectId, id); } catch (e) { console.error(e); toast("שגיאה בהסרה", true); }
  }));
}

// ===================================================================
//  Images (compress + pick)
// ===================================================================
function pickImage() { return pickFiles(false).then((a) => a[0] || null); }
function pickImages() { return pickFiles(true); }
function pickFiles(multiple) {
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*"; inp.multiple = multiple;
    inp.onchange = () => resolve([...(inp.files || [])]);
    inp.click();
  });
}
function compressImage(file, max = 1200, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const img = new Image();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > max) { height = Math.round(height * max / width); width = max; }
      else if (height >= width && height > max) { width = Math.round(width * max / height); height = max; }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    reader.readAsDataURL(file);
  });
}
function openPhotoViewer(src) {
  const o = document.createElement("div");
  o.className = "photo-viewer";
  o.innerHTML = `<img src="${src}" alt=""><button class="photo-viewer__close">×</button>`;
  o.addEventListener("click", () => o.remove());
  document.body.appendChild(o);
}

function emptyHTML(icon, title, sub) {
  return `<div class="empty"><span>${icon}</span><b>${esc(title)}</b><br>${esc(sub)}</div>`;
}

// ===================================================================
//  Detail / edit modal + service history
// ===================================================================
function openDetail(barcode) {
  const u = UNITS.find((x) => x.id === barcode);
  if (!u) return;
  clearModalSubs();
  const modal = $("#modal");
  modal.dataset.barcode = barcode;
  modal.dataset.parts = "";
  $("#modalPanel").innerHTML = detailHTML(u);
  modal.hidden = false;
  wireDetail(u);

  // live service history
  currentServiceUnsub = watchServices(currentProjectId, barcode,
    (list) => renderTimeline(list),
    (err)  => console.error(err));
  // live photos
  currentPhotoUnsub = watchPhotos(currentProjectId, barcode,
    (list) => renderPhotos(barcode, list),
    (err)  => console.error(err));
}

function detailHTML(u) {
  const field = (label, val) => val
    ? `<div class="detail__field"><span>${label}</span>${esc(val)}</div>` : "";
  return `
    <div class="detail__head">
      <div>
        <div class="detail__barcode">❄️ ${esc(u.barcode)}</div>
      </div>
      <button class="detail__close" data-close>×</button>
    </div>

    <div class="status-picker" id="statusPicker">
      ${STATUS_ORDER.map((k) => `
        <button class="status-opt ${st(k).cls} ${u.status === k ? "is-active" : ""}" data-status="${k}">
          ${st(k).icon}<span>${st(k).label}</span>
        </button>`).join("")}
    </div>

    <div class="detail__grid" id="detailFields">
      ${field("🏢 מבנה", u.building)}
      ${field("🧊 סוג", u.type)}
      ${field("📍 מיקום", u.location)}
      ${field("🏗️ קומה / אזור", u.area)}
      ${field("🔖 מק\"ט ישן", u.oldSku)}
      ${field("📝 הערות", u.notes)}
    </div>

    <div class="detail__actions">
      <button class="btn btn--ghost btn--sm" id="btnEdit">✏️ ערוך פרטים</button>
      <button class="btn btn--danger btn--sm" id="btnDelete">🗑️ מחק</button>
    </div>

    <div class="photos">
      <h3>📷 תמונות המזגן</h3>
      <div class="photo-grid" id="photoGrid"><p class="tl-empty">טוען…</p></div>
      <button class="btn btn--ghost btn--sm" id="btnAddPhoto" type="button">➕ הוסף תמונה</button>
    </div>

    <div class="history">
      <h3>🔧 היסטוריית טיפולים</h3>
      <div class="timeline" id="timeline"><p class="tl-empty">טוען…</p></div>

      <form class="svc-form" id="svcForm">
        <div class="row">
          <input type="date" name="date" value="${new Date().toISOString().slice(0,10)}">
          <input name="technician" placeholder="טכנאי (אופציונלי)">
        </div>
        <textarea name="description" rows="2" placeholder="מה בוצע? (התקנה, שטיפה, החלפת פילטר, תיקון גז...)" required></textarea>
        <button class="btn btn--primary" type="submit">➕ הוסף טיפול</button>
      </form>
    </div>`;
}

function wireDetail(u) {
  $("#svcForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const desc = f.description.value.trim();
    if (!desc) return;
    try {
      await addService(currentProjectId, u.barcode, {
        date: f.date.value,
        description: desc,
        technician: f.technician.value,
      });
      f.description.value = "";
      f.technician.value = "";
      toast("✅ הטיפול נשמר");
    } catch (err) { console.error(err); toast("שגיאה בשמירה", true); }
  });

  $$("#statusPicker .status-opt").forEach((b) => b.addEventListener("click", async () => {
    const status = b.dataset.status;
    $$("#statusPicker .status-opt").forEach((x) => x.classList.toggle("is-active", x === b));
    try { await updateUnit(currentProjectId, u.barcode, { status }); u.status = status; toast(`✔️ ${st(status).label}`); }
    catch (err) { console.error(err); toast("שגיאה בעדכון סטטוס", true); }
  }));

  $("#btnEdit").addEventListener("click", () => openEdit(u));
  $("#btnDelete").addEventListener("click", async () => {
    if (!confirm(`למחוק את המזגן ${u.barcode}? פעולה זו אינה הפיכה.`)) return;
    try { await deleteUnit(currentProjectId, u.barcode); toast("🗑️ נמחק"); closeModal(); }
    catch (err) { console.error(err); toast("שגיאה במחיקה", true); }
  });

  $("#btnAddPhoto").addEventListener("click", async () => {
    const files = await pickImages();
    if (!files.length) return;
    toast("מעלה תמונות…");
    try {
      for (const f of files) await addPhoto(currentProjectId, u.barcode, await compressImage(f));
      toast(`✅ נוספו ${files.length} תמונות`);
    } catch (err) { console.error(err); toast("שגיאה בהעלאת תמונה", true); }
  });
}

function renderPhotos(barcode, list) {
  const box = $("#photoGrid"); if (!box) return;
  box.innerHTML = list.length
    ? list.map((p) => `
        <div class="photo-thumb">
          <img src="${esc(p.url)}" alt="">
          ${p.label ? `<span class="photo-thumb__label">${esc(p.label)}</span>` : ""}
          <button class="photo-del" data-del="${esc(p.id)}" title="מחק">✕</button>
        </div>`).join("")
    : `<p class="tl-empty">אין תמונות עדיין.</p>`;
  $$(".photo-thumb img", box).forEach((img) =>
    img.addEventListener("click", () => openPhotoViewer(img.src)));
  $$(".photo-del", box).forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("למחוק את התמונה?")) return;
    try { await deletePhoto(currentProjectId, barcode, b.dataset.del); }
    catch (err) { console.error(err); toast("שגיאה במחיקה", true); }
  }));
}

function refreshDetailFields(u) {
  const box = $("#detailFields");
  if (!box) return;
  const field = (label, val) => val
    ? `<div class="detail__field"><span>${label}</span>${esc(val)}</div>` : "";
  box.innerHTML =
    field("🏢 מבנה", u.building) + field("🧊 סוג", u.type) +
    field("📍 מיקום", u.location) + field("🏗️ קומה / אזור", u.area) +
    field("🔖 מק\"ט ישן", u.oldSku) + field("📝 הערות", u.notes);
}

function renderTimeline(list) {
  currentServiceList = list;
  const box = $("#timeline");
  if (!box) return;
  box.innerHTML = list.length
    ? list.map(tlItemHTML).join("")
    : `<p class="tl-empty">אין טיפולים רשומים עדיין.</p>`;
  wireTimeline(box);
}

function tlItemHTML(s) {
  return `
    <div class="tl-item" data-id="${esc(s.id)}">
      <div class="tl-item__top">
        <div class="tl-item__date">📅 ${esc(s.date)}</div>
        <div class="tl-item__btns">
          <button class="tl-btn tl-edit" title="ערוך">✏️</button>
          <button class="tl-btn tl-del" title="מחק">🗑️</button>
        </div>
      </div>
      <p class="tl-item__desc">${esc(s.description)}</p>
      ${s.technician ? `<div class="tl-item__tech">👷 ${esc(s.technician)}</div>` : ""}
    </div>`;
}

function wireTimeline(box) {
  const barcode = $("#modal").dataset.barcode;
  $$(".tl-del", box).forEach((b) => b.addEventListener("click", async () => {
    const id = b.closest(".tl-item").dataset.id;
    if (!confirm("למחוק את רשומת הטיפול הזו?")) return;
    try { await deleteService(currentProjectId, barcode, id); toast("🗑️ הטיפול נמחק"); }
    catch (err) { console.error(err); toast("שגיאה במחיקה", true); }
  }));
  $$(".tl-edit", box).forEach((b) => b.addEventListener("click", () => {
    const item = b.closest(".tl-item");
    const s = currentServiceList.find((x) => x.id === item.dataset.id);
    if (s) openServiceEdit(item, barcode, s);
  }));
}

function openServiceEdit(item, barcode, s) {
  item.innerHTML = `
    <form class="tl-edit-form">
      <div class="row">
        <input type="date" name="date" value="${esc(s.date)}">
        <input name="technician" value="${esc(s.technician || "")}" placeholder="טכנאי">
      </div>
      <textarea name="description" rows="2" required>${esc(s.description || "")}</textarea>
      <div class="tl-edit-actions">
        <button class="btn btn--primary btn--sm" type="submit">💾 שמור</button>
        <button class="btn btn--ghost btn--sm" type="button" data-cancel>ביטול</button>
      </div>
    </form>`;
  const form = item.querySelector("form");
  form.querySelector("[data-cancel]").addEventListener("click", () => renderTimeline(currentServiceList));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const desc = form.description.value.trim();
    if (!desc) return;
    try {
      await updateService(currentProjectId, barcode, s.id, {
        date: form.date.value,
        description: desc,
        technician: form.technician.value.trim(),
      });
      toast("💾 הטיפול עודכן");
    } catch (err) { console.error(err); toast("שגיאה בעדכון", true); }
  });
}

function openEdit(u) {
  $("#modalPanel").innerHTML = `
    <div class="detail__head">
      <div class="detail__barcode">✏️ עריכה — ${esc(u.barcode)}</div>
      <button class="detail__close" data-close>×</button>
    </div>
    <form class="form" id="editForm">
      <label>מבנה<input name="building" value="${esc(u.building)}"></label>
      <label>סוג<input name="type" value="${esc(u.type)}"></label>
      <label>מיקום<input name="location" value="${esc(u.location)}"></label>
      <label>קומה / אזור<input name="area" value="${esc(u.area || "")}" placeholder="קומה 1 / גג / אגף..."></label>
      <label>מק"ט ישן<input name="oldSku" value="${esc(u.oldSku)}"></label>
      <label>הערות<textarea name="notes" rows="2">${esc(u.notes)}</textarea></label>
      <div class="detail__actions">
        <button type="submit" class="btn btn--primary">💾 שמור</button>
        <button type="button" class="btn btn--ghost" id="btnCancelEdit">ביטול</button>
      </div>
    </form>`;
  $("#btnCancelEdit").addEventListener("click", () => openDetail(u.barcode));
  $("#editForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await updateUnit(currentProjectId, u.barcode, {
        building: f.building.value.trim(),
        type: f.type.value.trim(),
        location: f.location.value.trim(),
        area: f.area.value.trim(),
        oldSku: f.oldSku.value.trim(),
        notes: f.notes.value.trim(),
      });
      toast("💾 נשמר");
      openDetail(u.barcode);
    } catch (err) { console.error(err); toast("שגיאה בשמירה", true); }
  });
}

function clearModalSubs() {
  if (currentServiceUnsub) { currentServiceUnsub(); currentServiceUnsub = null; }
  if (currentPhotoUnsub) { currentPhotoUnsub(); currentPhotoUnsub = null; }
}

function closeModal() {
  const m = $("#modal");
  m.hidden = true;
  m.dataset.barcode = "";
  m.dataset.parts = "";
  clearModalSubs();
}

// ===================================================================
//  Add unit (installed equipment)
// ===================================================================
async function onAddSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const msg = $("#addMsg");
  const barcode = cleanBarcode(f.barcode.value);
  const unit = {
    barcode, building: f.building.value,
    type: f.type.value, location: f.location.value,
    area: f.area.value, oldSku: f.oldSku.value, notes: f.notes.value,
  };
  if (!barcode) { msg.textContent = "צריך ברקוד"; msg.className = "form-msg is-err"; return; }

  const dup = UNITS.find((u) => u.id === barcode);
  if (dup && !confirm(`ברקוד ${barcode} כבר קיים. לעדכן את הפרטים הקיימים?`)) return;

  try {
    await saveUnit(currentProjectId, unit);
    // attach the captured photos (compressed, straight to the cloud DB)
    if (pendingAddPhotoLabel) {
      try { await addPhoto(currentProjectId, barcode, await compressImage(pendingAddPhotoLabel), "פתקית מודל"); }
      catch (photoErr) { console.error(photoErr); toast("המזגן נשמר, אך העלאת תמונת הפתקית נכשלה", true); }
    }
    if (pendingAddPhotoEvap) {
      try { await addPhoto(currentProjectId, barcode, await compressImage(pendingAddPhotoEvap), "מאייד"); }
      catch (photoErr) { console.error(photoErr); toast("המזגן נשמר, אך העלאת תמונת המאייד נכשלה", true); }
    }
    f.reset();
    pendingAddPhotoLabel = null;
    pendingAddPhotoEvap = null;
    $("#addPhotoPreviewLabel").hidden = true;
    $("#addPhotoPreviewLabel").src = "";
    $("#addPhotoStatusLabel").textContent = "";
    $("#addPhotoPreviewEvap").hidden = true;
    $("#addPhotoPreviewEvap").src = "";
    $("#addPhotoStatusEvap").textContent = "";
    msg.textContent = "✅ נשמר בהצלחה!";
    msg.className = "form-msg is-ok";
    toast("✅ המזגן נוסף");
    setTimeout(() => (msg.textContent = ""), 2500);
    switchView("equipment");
  } catch (err) {
    console.error(err);
    msg.textContent = "❌ שגיאה בשמירה: " + err.message;
    msg.className = "form-msg is-err";
  }
}

// ===================================================================
//  Calendar view (month grid + scheduled visits + workdays)
// ===================================================================
const HE_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const HE_WD = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];
function pad2(n) { return String(n).padStart(2, "0"); }
let calState = null;

function renderCalendar() {
  const box = $("#calendarBody"); if (!box) return;
  if (!calState) { const d = new Date(); calState = { y: d.getFullYear(), m: d.getMonth() }; }
  const { y, m } = calState;
  const firstDow = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const worked = new Set(WORKDAYS.map((w) => w.date));
  const sched = new Set(VISITS.map((v) => v.date).filter(Boolean));
  const vacs = VACATIONS.filter((v) => v.status === "approved");
  const onVacation = (iso) => vacs.some((v) => iso >= v.from && iso <= v.to);
  const today = todayISO();
  let cells = "";
  for (let i = 0; i < firstDow; i++) cells += `<div class="cal-cell cal-cell--empty"></div>`;
  for (let d = 1; d <= days; d++) {
    const iso = `${y}-${pad2(m + 1)}-${pad2(d)}`;
    cells += `<button class="cal-cell ${worked.has(iso) ? "is-worked" : ""} ${onVacation(iso) ? "has-vac" : ""} ${iso === today ? "is-today" : ""}" data-iso="${iso}">
      <span class="cal-num">${d}</span>${sched.has(iso) ? `<span class="cal-dot"></span>` : ""}
    </button>`;
  }
  box.innerHTML = `
    <div class="cal-head">
      <button class="cal-nav" id="calPrev">›</button>
      <div class="cal-title">${HE_MONTHS[m]} ${y}</div>
      <button class="cal-nav" id="calNext">‹</button>
    </div>
    <div class="cal-grid cal-wd">${HE_WD.map((w) => `<div class="cal-wdh">${w}</div>`).join("")}</div>
    <div class="cal-grid" id="calGrid">${cells}</div>
    <div class="cal-legend"><span><i class="lg-worked"></i> יום עבודה</span><span><i class="lg-sched"></i> עבודה מתוכננת</span><span><i class="lg-vac"></i> חופשה</span></div>
    <p class="cal-tip">טיפ: הקש על יום כדי לסמן/להסיר יום עבודה.</p>

    <div class="panel">
      <div class="section-head"><h3>🗓️ עבודות מתוכננות</h3><button class="btn btn--primary btn--sm" id="calAddVisit">➕ עבודה</button></div>
      <div id="calVisits">${visitsListHTML()}</div>
    </div>

    <div class="panel">
      <div class="section-head"><h3>📆 יומן עבודה (ימי ביצוע בפועל)</h3><button class="btn btn--primary btn--sm" id="calAddWorkday">➕ יום עבודה</button></div>
      ${workdaysPanelHTML()}
    </div>`;

  $("#calPrev").addEventListener("click", () => { if (--calState.m < 0) { calState.m = 11; calState.y--; } renderCalendar(); });
  $("#calNext").addEventListener("click", () => { if (++calState.m > 11) { calState.m = 0; calState.y++; } renderCalendar(); });
  $$("#calGrid .cal-cell[data-iso]").forEach((c) => c.addEventListener("click", () => toggleCalendarDay(c.dataset.iso)));
  $("#calAddVisit").addEventListener("click", () => openVisitForm());
  $$("#calVisits .visit-row").forEach((r) => r.addEventListener("click", () => openVisitForm(r.dataset.id)));
  $("#calAddWorkday").addEventListener("click", openWorkdayForm);
  $$("#calendarBody .wd-del").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("למחוק יום עבודה זה?")) return;
    try { await deleteWorkday(currentProjectId, b.closest(".wd-item").dataset.id); } catch (e) { console.error(e); toast("שגיאה", true); }
  }));
}

async function toggleCalendarDay(iso) {
  const existing = WORKDAYS.filter((w) => w.date === iso);
  try {
    if (existing.length) {
      if (!confirm(`להסיר יום עבודה (${fmtDMY(iso)})?`)) return;
      for (const w of existing) await deleteWorkday(currentProjectId, w.id);
      toast("יום עבודה הוסר");
    } else {
      await addWorkday(currentProjectId, { date: iso });
      toast("✔️ יום עבודה נוסף");
    }
  } catch (e) { console.error(e); toast("שגיאה", true); }
}

// standalone recovery screen (opened from the side menu)
function openRecoveryScreen() {
  clearModalSubs();
  const modal = $("#modal");
  modal.dataset.barcode = ""; modal.dataset.parts = "";
  $("#modalPanel").innerHTML = `
    <div class="detail__head"><div class="detail__barcode">🛟 שחזור ציוד</div><button class="detail__close" data-close>×</button></div>
    <p class="about__muted" style="margin:0 0 12px">אם הוספת ציוד במכשיר זה שלא סונכרן לענן — כאן אפשר לשחזר אותו.</p>
    <div id="recoverDiag"><p class="tl-empty">לחץ "בדוק מכשיר זה".</p></div>
    <button class="btn btn--primary" id="recoverCheck" style="margin-top:12px">בדוק מכשיר זה</button>`;
  modal.hidden = false;
  $("#recoverCheck").addEventListener("click", runRecoveryDiag);
}

// ===================================================================
//  Vehicle inventory (per worker: יותם / אלון / גיא) — staff-level
// ===================================================================
const VEH_QUICK = ["גז R410A", "גז R32", "קבלים", "פילטרים", "סרט בידוד", "צינור נחושת", "ברגים", "כבל חשמל", "נצרות", "אזיקונים", "סיליקון", "אחר"];

function renderVehicles() {
  const box = $("#vehicleBody"); if (!box) return;
  $$("#vehTabs .seg").forEach((s) => s.classList.toggle("is-active", s.dataset.owner === vehicleSel));
  const items = VEHICLE_ITEMS.filter((i) => i.owner === vehicleSel);
  const missing = items.filter((i) => i.missing).length;
  box.innerHTML = `
    <div class="veh-summary">
      <span>${items.length} פריטים</span>
      <span class="veh-missing">${missing} חסרים</span>
    </div>
    <div class="parts-quick">
      ${VEH_QUICK.map((it) => `<button class="chip part-quick" data-item="${esc(it)}">➕ ${esc(it)}</button>`).join("")}
    </div>
    <form class="svc-form" id="vehForm" style="border-top:none;margin-top:8px;padding-top:0">
      <div class="row"><input name="item" placeholder="פריט נוסף" required></div>
      <button class="btn btn--primary" type="submit">➕ הוסף פריט</button>
    </form>
    <div class="veh-list">
      ${items.length ? items.map(vehRow).join("") : `<p class="tl-empty">אין פריטים לרכב של ${esc(vehicleSel)}. הוסף מהרשימה למעלה.</p>`}
    </div>`;

  $$(".part-quick", box).forEach((b) => b.addEventListener("click", async () => {
    try { await addVehicleItem({ owner: vehicleSel, item: b.dataset.item }); toast("➕ נוסף"); }
    catch (e) { console.error(e); toast("שגיאה", true); }
  }));
  $("#vehForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = e.target.item.value.trim(); if (!v) return;
    try { await addVehicleItem({ owner: vehicleSel, item: v }); e.target.reset(); }
    catch (err) { console.error(err); toast("שגיאה", true); }
  });
  $$(".veh-item", box).forEach((el) => {
    const id = el.dataset.id;
    const it = VEHICLE_ITEMS.find((x) => x.id === id);
    el.querySelector(".veh-toggle").addEventListener("click", async () => {
      try { await updateVehicleItem(id, { missing: !it.missing }); } catch (e) { console.error(e); toast("שגיאה", true); }
    });
    el.querySelector(".veh-del").addEventListener("click", async () => {
      try { await deleteVehicleItem(id); } catch (e) { console.error(e); toast("שגיאה", true); }
    });
  });
}

function vehRow(i) {
  return `
    <div class="veh-item ${i.missing ? "is-missing" : ""}" data-id="${esc(i.id)}">
      <button class="veh-toggle">${i.missing ? "⭕ חסר" : "✅ יש"}</button>
      <span class="veh-name">${esc(i.item)}</span>
      <button class="veh-del" title="מחק">🗑️</button>
    </div>`;
}

// ===================================================================
//  Excel export (SheetJS) — download or share (email/WhatsApp) on mobile
// ===================================================================
const EXPORT_SETS = [
  { key: "units", sheet: "ציוד מותקן", rows: () => UNITS.map((u) => ({
      "ברקוד": u.barcode, "מבנה": u.building || "", "קומה/אזור": u.area || "", "סוג": u.type || "",
      "מיקום": u.location || "", "סטטוס": (STATUS[u.status] || STATUS.not_started).label, "הערות": u.notes || "",
      "מק\"ט ישן": u.oldSku || "", "טיפול אחרון": u.lastService || "" })) },
  { key: "contacts", sheet: "אנשי קשר", rows: () => CONTACTS.map((c) => ({ "שם": c.name, "תפקיד": c.role || "", "טלפון": c.phone || "", "הערות": c.notes || "" })) },
  { key: "crew", sheet: "צוות הפרויקט", rows: () => CREW.map((c) => ({ "שם": c.name, "תפקיד": c.role || "" })) },
  { key: "tasks", sheet: "משימות", rows: () => TASKS.map((t) => ({ "כותרת": t.title, "אחראי": t.assignee || "", "תאריך יעד": t.dueDate || "", "סטטוס": t.done ? "הושלם" : "פתוח" })) },
  { key: "vehicles", sheet: "מלאי רכבים", rows: () => VEHICLE_ITEMS.map((i) => ({ "עובד": i.owner, "פריט": i.item, "סטטוס": i.missing ? "חסר" : "יש" })) },
  { key: "parts", sheet: "חוסרים", rows: () => PARTS.map((p) => ({ "פריט": p.item, "הערה": p.note || "", "סטטוס": p.done ? "סופק" : "חסר" })) },
  { key: "complaints", sheet: "תקלות", rows: () => COMPLAINTS.map((c) => ({ "לקוח": c.customer || "", "טלפון": c.phone || "", "ברקוד": c.barcode || "", "תיאור": c.description || "", "סטטוס": c.status === "done" ? "טופל" : "פתוח" })) },
  { key: "vacations", sheet: "חופשות", rows: () => VACATIONS.map((v) => ({ "עובד": v.name, "מתאריך": v.from, "עד": v.to, "סטטוס": v.status, "הערה": v.note || "" })) },
  { key: "workdays", sheet: "יומן עבודה", rows: () => WORKDAYS.map((w) => ({ "תאריך": w.date, "הערה": w.note || "" })) },
  { key: "visits", sheet: "עבודות מתוכננות", rows: () => VISITS.map((v) => ({ "כותרת": v.title || "", "תאריך": v.date || "", "שעה": v.time || "", "מיקום": v.location || "", "עובדים": v.workers || "", "הערות": v.notes || "" })) },
];

// choose-what-to-export picker
function openExportForm() {
  clearModalSubs();
  const modal = $("#modal");
  modal.dataset.barcode = ""; modal.dataset.parts = "";
  const sets = EXPORT_SETS.map((s) => ({ ...s, n: s.rows().length }));
  $("#modalPanel").innerHTML = `
    <div class="detail__head"><div class="detail__barcode">📊 ייצוא לאקסל</div><button class="detail__close" data-close>×</button></div>
    <p class="about__muted" style="margin:0 0 12px">בחר מה לייצא:</p>
    <div class="export-list">
      ${sets.map((s) => `
        <label class="export-row ${s.n ? "" : "is-empty"}">
          <input type="checkbox" value="${s.key}" ${s.n ? "checked" : "disabled"}>
          <span class="export-name">${esc(s.sheet)}</span>
          <span class="export-count">${s.n}</span>
        </label>`).join("")}
    </div>
    <div class="detail__actions" style="margin-top:16px">
      <button class="btn btn--primary" id="exportGo">📤 ייצא</button>
      <button type="button" class="btn btn--ghost" data-close>ביטול</button>
    </div>`;
  modal.hidden = false;
  $("#exportGo").addEventListener("click", async () => {
    const keys = $$("#modalPanel .export-row input:checked").map((c) => c.value);
    if (!keys.length) { toast("לא נבחר דבר לייצוא", true); return; }
    closeModal();
    await exportExcel(keys);
  });
}

async function exportExcel(keys) {
  if (typeof XLSX === "undefined") { toast("הייצוא אינו זמין (נדרש חיבור לאינטרנט)", true); return; }
  const wb = XLSX.utils.book_new();
  EXPORT_SETS.filter((s) => keys.includes(s.key)).forEach((s) => {
    const rows = s.rows();
    if (rows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), s.sheet);
  });
  if (!wb.SheetNames.length) { toast("אין נתונים לייצוא", true); return; }

  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const fname = `gp-mizugim-${todayISO()}.xlsx`;
  const file = new File([blob], fname, { type: blob.type });

  // On mobile, offer the native share sheet (email / WhatsApp) with the file attached.
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "דוח ג.פ מיזוגים" }); return; }
    catch (err) { if (err && err.name === "AbortError") return; /* else fall through to download */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast("📊 הקובץ יוצא");
}

// ===================================================================
//  Vacations (request + approval by גיא) — staff-level
// ===================================================================
const VAC_STATUS = {
  pending:  { label: "⏳ ממתין לאישור גיא", cls: "chip--warn" },
  approved: { label: "✓ מאושר", cls: "chip--done" },
  rejected: { label: "✕ נדחה", cls: "chip--warn" },
};

function renderVacations() {
  const box = $("#vacationsList"); if (!box) return;
  if (!VACATIONS.length) {
    box.innerHTML = emptyHTML("🏖️", "אין בקשות חופשה", "הגש בקשה עם הכפתור ➕ בקשה");
    return;
  }
  box.innerHTML = VACATIONS.map(vacItemHTML).join("");
  wireVacations(box);
}

function vacItemHTML(v) {
  const s = VAC_STATUS[v.status] || VAC_STATUS.pending;
  const canApprove = v.status === "pending" && isGuy();
  return `
    <div class="card vac ${v.status === "rejected" ? "is-done" : ""}" data-id="${esc(v.id)}">
      <div class="card__body">
        <div class="card__head">
          <span class="vac__name">🏖️ ${esc(v.name || "עובד")}</span>
          <span class="chip ${s.cls}">${s.label}</span>
        </div>
        <div class="vac__dates">📅 ${fmtDMY(v.from)}${v.to && v.to !== v.from ? ` – ${fmtDMY(v.to)}` : ""}</div>
        ${v.note ? `<div class="vac__note">${esc(v.note)}</div>` : ""}
        ${v.decidedBy ? `<div class="vac__by">טופל ע"י ${esc(v.decidedBy)}</div>` : ""}
        <div class="vac__actions">
          ${canApprove ? `<button class="btn btn--primary btn--sm vac-approve">✓ אשר</button><button class="btn btn--danger btn--sm vac-reject">✕ דחה</button>` : ""}
          <button class="btn btn--ghost btn--sm vac-del">🗑️ מחק</button>
        </div>
      </div>
    </div>`;
}

function wireVacations(box) {
  $$(".vac", box).forEach((el) => {
    const id = el.dataset.id;
    el.querySelector(".vac-approve")?.addEventListener("click", async () => {
      try { await updateVacation(id, { status: "approved", decidedBy: "גיא" }); toast("✓ החופשה אושרה"); }
      catch (e) { console.error(e); toast("שגיאה", true); }
    });
    el.querySelector(".vac-reject")?.addEventListener("click", async () => {
      try { await updateVacation(id, { status: "rejected", decidedBy: "גיא" }); toast("הבקשה נדחתה"); }
      catch (e) { console.error(e); toast("שגיאה", true); }
    });
    el.querySelector(".vac-del")?.addEventListener("click", async () => {
      if (!confirm("למחוק את הבקשה?")) return;
      try { await deleteVacation(id); toast("נמחק"); } catch (e) { console.error(e); toast("שגיאה", true); }
    });
  });
}

function openVacationForm() {
  clearModalSubs();
  const modal = $("#modal");
  modal.dataset.barcode = ""; modal.dataset.parts = "";
  const name = localStorage.getItem("ac_username") || "";
  $("#modalPanel").innerHTML = `
    <div class="detail__head"><div class="detail__barcode">🏖️ בקשת חופשה</div><button class="detail__close" data-close>×</button></div>
    <form class="form" id="vacForm">
      <label>שם העובד<input name="name" value="${esc(name)}" required placeholder="שם"></label>
      <div class="row2">
        <label>מתאריך<input type="date" name="from" value="${todayISO()}" required></label>
        <label>עד תאריך<input type="date" name="to" value="${todayISO()}" required></label>
      </div>
      <label>סיבה / הערה<textarea name="note" rows="2" placeholder="אופציונלי"></textarea></label>
      <div class="detail__actions">
        <button type="submit" class="btn btn--primary">📨 שלח לאישור</button>
        <button type="button" class="btn btn--ghost" data-close>ביטול</button>
      </div>
    </form>
    <p class="about__muted" style="margin-top:10px">הבקשה תישלח לאישור גיא. לאחר אישור היא תופיע ביומן ובדף הבית.</p>`;
  modal.hidden = false;
  $("#vacForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!f.name.value.trim()) return;
    let from = f.from.value, to = f.to.value;
    if (to && from && to < from) [from, to] = [to, from];
    localStorage.setItem("ac_username", f.name.value.trim());
    try { await addVacation({ name: f.name.value, from, to, note: f.note.value }); toast("📨 הבקשה נשלחה לאישור גיא"); closeModal(); }
    catch (err) { console.error(err); toast("שגיאה בשליחה", true); }
  });
}

// Home: "this week vacation" bullet — approved vacations overlapping this week
function thisWeekRange() {
  const d = new Date();
  const start = new Date(d); start.setDate(d.getDate() - d.getDay());   // Sunday
  const end = new Date(start); end.setDate(start.getDate() + 6);        // Saturday
  const iso = (x) => `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
  return { start: iso(start), end: iso(end) };
}
function renderVacationWeek() {
  const el = $("#vacWeek"); if (!el) return;
  const { start, end } = thisWeekRange();
  const list = VACATIONS.filter((v) => v.status === "approved" && v.from <= end && v.to >= start);
  el.innerHTML = list.length
    ? `<div class="vac-week">
        <div class="vac-week__title">🏖️ חופשות השבוע</div>
        <ul>${list.map((v) => `<li>${esc(v.name)} — ${fmtDMY(v.from)}${v.to !== v.from ? `–${fmtDMY(v.to)}` : ""}</li>`).join("")}</ul>
      </div>`
    : "";
}

function renderDashboard() {
  const box = $("#dashStats");
  if (!box) return;
  const total = UNITS.length;
  const gc = statusCounts(UNITS);
  const today = todayISO();
  const todayWorkers = [...new Set(VISITS.filter((v) => v.date === today).map((v) => v.workers).filter(Boolean))];
  const openTasks = TASKS.filter((t) => !t.done).length;
  const openParts = PARTS.filter((p) => !p.done).length;

  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="stat__num">${total}</div><div class="stat__label">ציוד מותקן סה״כ</div></div>
      <div class="stat"><div class="stat__num st-done">${gc.completed}</div><div class="stat__label">הושלמו</div></div>
      <div class="stat"><div class="stat__num st-prog">${gc.in_progress}</div><div class="stat__label">בתהליך</div></div>
      <div class="stat"><div class="stat__num st-wait">${gc.waiting_part + gc.issue}</div><div class="stat__label">ממתין / תקלה</div></div>
      <div class="stat"><div class="stat__num">${openTasks}</div><div class="stat__label">משימות פתוחות</div></div>
      <div class="stat"><div class="stat__num">${openParts}</div><div class="stat__label">חוסרים</div></div>
    </div>

    ${todayWorkers.length ? `<div class="panel"><h3>👷 עובדים היום</h3><div class="chips-row">${todayWorkers.map((w) => `<span class="chip chip--accent">${esc(w)}</span>`).join("")}</div></div>` : ""}`;
}

function statusCounts(list) {
  const c = { not_started: 0, in_progress: 0, completed: 0, waiting_part: 0, issue: 0 };
  list.forEach((u) => { c[STATUS[u.status] ? u.status : "not_started"]++; });
  return c;
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function tomorrowISO() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); }

function fmtDMY(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).split("-");
  return `${d}/${m}/${y}`;
}

function workdaysPanelHTML() {
  const dates = [...new Set(WORKDAYS.map((w) => w.date).filter(Boolean))].sort();
  const count = dates.length;
  const span = count ? `${fmtDMY(dates[0])} – ${fmtDMY(dates[count - 1])}` : "";
  const list = WORKDAYS.length
    ? WORKDAYS.map((w) => `
        <div class="wd-item" data-id="${esc(w.id)}">
          <span class="wd-date">📅 ${fmtDMY(w.date)}</span>
          ${w.note ? `<span class="wd-note">${esc(w.note)}</span>` : ""}
          <button class="wd-del" title="מחק">✕</button>
        </div>`).join("")
    : `<p class="tl-empty">עדיין לא נרשמו ימי עבודה.</p>`;
  return `
    <div class="wd-summary">
      <div class="wd-count">${count}</div>
      <div class="wd-label">ימי עבודה${span ? `<br><span class="wd-span">${span}</span>` : ""}</div>
    </div>
    <div class="wd-list">${list}</div>`;
}

function openWorkdayForm() {
  clearModalSubs();
  const modal = $("#modal");
  modal.dataset.barcode = ""; modal.dataset.parts = "";
  $("#modalPanel").innerHTML = `
    <div class="detail__head">
      <div class="detail__barcode">🗓️ יום עבודה</div>
      <button class="detail__close" data-close>×</button>
    </div>
    <form class="form" id="wdForm">
      <label>תאריך<input type="date" name="date" value="${todayISO()}" required></label>
      <label>הערה (אופציונלי)<input name="note" placeholder="מי עבד / מה נעשה"></label>
      <div class="detail__actions">
        <button type="submit" class="btn btn--primary">💾 שמור</button>
        <button type="button" class="btn btn--ghost" data-close>ביטול</button>
      </div>
    </form>`;
  modal.hidden = false;
  $("#wdForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await addWorkday(currentProjectId, { date: f.date.value, note: f.note.value }); toast("💾 יום עבודה נשמר"); closeModal(); }
    catch (err) { console.error(err); toast("שגיאה בשמירה", true); }
  });
}

function visitsListHTML() {
  const today = todayISO();
  const upcoming = VISITS.filter((v) => !v.date || v.date >= today);
  if (!upcoming.length) return `<p class="tl-empty">אין עבודות מתוכננות.</p>`;
  return upcoming.map((v) => `
      <div class="visit-row" data-id="${esc(v.id)}">
        <div class="visit-row__main"><b>${esc(v.title || "עבודה")}</b> <span class="chip">${esc(v.date || "")}${v.time ? ` ${esc(v.time)}` : ""}</span></div>
        <div class="visit-row__meta">${[v.location, v.workers ? `👷 ${v.workers}` : ""].filter(Boolean).map(esc).join(" · ")}</div>
      </div>`).join("");
}

// ---- Upcoming Work card (home) ----
function renderUpcoming() {
  const el = $("#upcomingCard"); if (!el) return;
  const today = todayISO();
  const upcoming = VISITS.filter((v) => v.date && v.date >= today)
    .sort((a, b) => String(a.date + (a.time || "")).localeCompare(String(b.date + (b.time || ""))));
  if (!upcoming.length) { el.innerHTML = `<div class="upcoming__empty">🗓️ לא נקבעה עבודה.</div>`; return; }
  const v = upcoming[0];
  const dlabel = v.date === today ? "היום" : (v.date === tomorrowISO() ? "מחר" : v.date);
  el.innerHTML = `
    <div class="upcoming__card" data-id="${esc(v.id)}">
      <div class="upcoming__top">
        <span class="upcoming__tag">🗓️ עבודה קרובה</span>
        <span class="chip chip--accent">${dlabel}${v.time ? ` · ${esc(v.time)}` : ""}</span>
      </div>
      <div class="upcoming__title">${esc(v.title || "עבודה")}</div>
      ${v.location ? `<div class="upcoming__row">📍 ${esc(v.location)}</div>` : ""}
      ${v.workers ? `<div class="upcoming__row">👷 ${esc(v.workers)}</div>` : ""}
    </div>`;
  el.querySelector(".upcoming__card").addEventListener("click", () => openVisitForm(v.id));
}

// ---- Side menu screens ----
function closeSideMenu() { $("#sideMenu").hidden = true; }

function openNameForm() {
  clearModalSubs();
  const modal = $("#modal");
  modal.dataset.barcode = ""; modal.dataset.parts = "";
  const name = localStorage.getItem("ac_username") || "";
  $("#modalPanel").innerHTML = `
    <div class="detail__head">
      <div class="detail__barcode">👤 השם שלי</div>
      <button class="detail__close" data-close>×</button>
    </div>
    <form class="form" id="nameForm">
      <label>השם שלך (יופיע ליד עדכונים ופעולות)<input name="name" value="${esc(name)}" placeholder="שם" required></label>
      <div class="detail__actions">
        <button type="submit" class="btn btn--primary">💾 שמור</button>
        <button type="button" class="btn btn--ghost" data-close>ביטול</button>
      </div>
    </form>`;
  modal.hidden = false;
  $("#nameForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = e.target.name.value.trim();
    if (v) localStorage.setItem("ac_username", v);
    toast("💾 השם נשמר"); closeModal();
  });
}

function openAbout() {
  clearModalSubs();
  const modal = $("#modal");
  modal.dataset.barcode = ""; modal.dataset.parts = "";
  const p = PROJECTS.find((x) => x.id === currentProjectId);
  $("#modalPanel").innerHTML = `
    <div class="detail__head">
      <div class="detail__barcode">ℹ️ אודות</div>
      <button class="detail__close" data-close>×</button>
    </div>
    <div class="about">
      <p><b>🗂️ ג.פ מיזוגים בע"מ</b> — ניהול פרויקטי מיזוג אוויר</p>
      <p>פרויקטים במערכת: <b>${PROJECTS.length}</b></p>
      ${p ? `<p>פרויקט נוכחי: <b>${esc(p.name)}</b> · ציוד מותקן: <b>${UNITS.length}</b></p>` : ""}
      <p class="about__muted">${isConfigured ? "מחובר לענן · סנכרון בזמן אמת לכל המכשירים" : "עובד מקומית במכשיר זה (ללא Firebase מוגדר)"}</p>
    </div>`;
  modal.hidden = false;
}

// ---- Team updates widget (Home) ----
function renderUpdates() {
  const box = $("#teamList"); if (!box) return;
  const list = UPDATES.slice(0, 3);
  box.innerHTML = list.length
    ? list.map((u) => `
        <div class="team__item" data-id="${esc(u.id)}">
          <button class="team__x" title="הסר">✕</button>
          <div class="team__body">
            <div class="team__text">${esc(u.text)}</div>
            <div class="team__meta">👤 ${esc(u.author || "צוות")} · ${esc(fmtTime(u.createdAt))}</div>
          </div>
        </div>`).join("")
    : `<p class="team__empty">אין עדכונים.</p>`;
  $$(".team__x", box).forEach((b) => b.addEventListener("click", async () => {
    const id = b.closest(".team__item").dataset.id;
    try { await deleteUpdate(currentProjectId, id); } catch (e) { console.error(e); toast("שגיאה בהסרה", true); }
  }));
}

function openUpdateForm() {
  clearModalSubs();
  const modal = $("#modal");
  modal.dataset.barcode = ""; modal.dataset.parts = "";
  const name = localStorage.getItem("ac_username") || "";
  $("#modalPanel").innerHTML = `
    <div class="detail__head">
      <div class="detail__barcode">💬 עדכון חדש</div>
      <button class="detail__close" data-close>×</button>
    </div>
    <form class="form" id="updForm">
      <label>השם שלך<input name="author" value="${esc(name)}" placeholder="שם" required></label>
      <label>העדכון<textarea name="text" rows="3" required placeholder="לדוגמה: חסרים 6 מטר צנרת"></textarea></label>
      <div class="detail__actions">
        <button type="submit" class="btn btn--primary">💬 פרסם</button>
        <button type="button" class="btn btn--ghost" data-close>ביטול</button>
      </div>
    </form>`;
  modal.hidden = false;
  $("#updForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const author = f.author.value.trim();
    const text = f.text.value.trim();
    if (!text) return;
    if (author) localStorage.setItem("ac_username", author);
    try { await addUpdate(currentProjectId, { text, author }); toast("💬 העדכון פורסם"); closeModal(); }
    catch (err) { console.error(err); toast("שגיאה בפרסום", true); }
  });
}

/** Compact Hebrew relative time; handles number (local) and Firestore Timestamp. */
function fmtTime(ts) {
  let ms;
  if (!ts) return "עכשיו";
  if (typeof ts === "number") ms = ts;
  else if (ts.toMillis) ms = ts.toMillis();
  else if (ts.seconds) ms = ts.seconds * 1000;
  else return "עכשיו";
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "עכשיו";
  if (m < 60) return `לפני ${m} ד׳`;
  const h = Math.floor(m / 60);
  if (h < 24) return `לפני ${h} ש׳`;
  const d = new Date(ms);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

// ---- Missing parts modal ----
function openPartsModal() {
  clearModalSubs();
  const modal = $("#modal");
  modal.dataset.barcode = "";
  modal.dataset.parts = "1";
  $("#modalPanel").innerHTML = `
    <div class="detail__head">
      <div class="detail__barcode">🧰 חוסרים</div>
      <button class="detail__close" data-close>×</button>
    </div>
    <div class="parts-quick">
      ${PART_ITEMS.map((it) => `<button class="chip part-quick" data-item="${esc(it)}">➕ ${esc(it)}</button>`).join("")}
    </div>
    <form class="svc-form" id="partForm" style="border-top:none;margin-top:8px;padding-top:0">
      <div class="row"><input name="item" placeholder="פריט חסר" required><input name="note" placeholder="הערה"></div>
      <button class="btn btn--primary" type="submit">➕ הוסף חוסר</button>
    </form>
    <div class="parts-list" id="partsList"></div>`;
  modal.hidden = false;

  $$(".part-quick").forEach((b) => b.addEventListener("click", async () => {
    try { await addPart(currentProjectId, { item: b.dataset.item }); toast("➕ נוסף"); }
    catch (e) { console.error(e); toast("שגיאה", true); }
  }));
  $("#partForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!f.item.value.trim()) return;
    try { await addPart(currentProjectId, { item: f.item.value, note: f.note.value }); f.reset(); toast("➕ נוסף"); }
    catch (err) { console.error(err); toast("שגיאה", true); }
  });
  refreshPartsModal();
}

function refreshPartsModal() {
  const modal = $("#modal");
  if (modal.hidden || modal.dataset.parts !== "1") return;
  const box = $("#partsList"); if (!box) return;
  box.innerHTML = PARTS.length
    ? PARTS.map((p) => `
        <div class="part-row ${p.done ? "is-done" : ""}" data-id="${esc(p.id)}">
          <button class="part-check" data-toggle>${p.done ? "✅" : "⬜"}</button>
          <div class="part-row__body"><b>${esc(p.item)}</b>${p.note ? ` · ${esc(p.note)}` : ""}</div>
          <button class="part-del" data-del>🗑️</button>
        </div>`).join("")
    : `<p class="tl-empty">אין חוסרים רשומים.</p>`;
  $$(".part-row", box).forEach((row) => {
    const id = row.dataset.id;
    const p = PARTS.find((x) => x.id === id);
    row.querySelector("[data-toggle]").addEventListener("click", async () => {
      try { await updatePart(currentProjectId, id, { done: !p.done }); } catch (e) { console.error(e); toast("שגיאה", true); }
    });
    row.querySelector("[data-del]").addEventListener("click", async () => {
      try { await deletePart(currentProjectId, id); } catch (e) { console.error(e); toast("שגיאה", true); }
    });
  });
}

// ---- Scheduled visit form ----
function openVisitForm(id) {
  const v = id ? VISITS.find((x) => x.id === id) || {} : {};
  clearModalSubs();
  const modal = $("#modal");
  modal.dataset.barcode = ""; modal.dataset.parts = "";
  $("#modalPanel").innerHTML = `
    <div class="detail__head">
      <div class="detail__barcode">🗓️ ${id ? "עריכת עבודה" : "עבודה חדשה"}</div>
      <button class="detail__close" data-close>×</button>
    </div>
    <form class="form" id="visitForm">
      <label>כותרת העבודה<input name="title" value="${esc(v.title || "")}" required placeholder="לדוגמה: התקנת מזגנים קומה 2"></label>
      <div class="row2">
        <label>תאריך<input type="date" name="date" value="${esc(v.date || todayISO())}"></label>
        <label>שעה<input type="time" name="time" value="${esc(v.time || "")}"></label>
      </div>
      <label>מיקום<input name="location" value="${esc(v.location || "")}" placeholder="כתובת / אזור"></label>
      <label>עובדים<input name="workers" value="${esc(v.workers || "")}" placeholder="שמות העובדים"></label>
      <label>הערות<textarea name="notes" rows="2">${esc(v.notes || "")}</textarea></label>
      <div class="detail__actions">
        <button type="submit" class="btn btn--primary">💾 שמור</button>
        ${id ? `<button type="button" class="btn btn--danger" id="visitDelete">🗑️ מחק</button>`
             : `<button type="button" class="btn btn--ghost" data-close>ביטול</button>`}
      </div>
    </form>`;
  modal.hidden = false;
  $("#visitForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const data = { title: f.title.value, date: f.date.value, time: f.time.value, location: f.location.value, workers: f.workers.value, notes: f.notes.value };
    if (!data.title.trim()) return;
    try { if (id) await updateVisit(currentProjectId, id, data); else await addVisit(currentProjectId, data); toast("💾 נשמר"); closeModal(); }
    catch (err) { console.error(err); toast("שגיאה בשמירה", true); }
  });
  if (id) $("#visitDelete").addEventListener("click", async () => {
    if (!confirm("למחוק את העבודה?")) return;
    try { await deleteVisit(currentProjectId, id); toast("🗑️ נמחק"); closeModal(); }
    catch (err) { console.error(err); toast("שגיאה במחיקה", true); }
  });
}

// ===================================================================
//  Datalists (autocomplete for the add form)
// ===================================================================
function populateDatalists() {
  fillDatalist("buildings", UNITS.map((u) => u.building));
  fillDatalist("types", UNITS.map((u) => u.type));
}
function fillDatalist(id, values) {
  const el = document.getElementById(id);
  if (!el) return;
  const uniq = [...new Set(values.filter(Boolean))].sort();
  el.innerHTML = uniq.map((v) => `<option value="${esc(v)}">`).join("");
}

// ===================================================================
//  Helpers
// ===================================================================
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

let toastTimer;
function toast(text, isErr = false) {
  const el = $("#toast");
  el.textContent = text;
  el.className = "toast" + (isErr ? " is-err" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}
