// ===================================================================
//  app.js — UI controller
// ===================================================================
import { isConfigured } from "./firebase-config.js";
import { startScan, stopScan } from "./scanner.js";

// Pick the data backend: cloud (Firebase) if configured, else local device
// storage — so the app is fully usable with zero setup.
const store = isConfigured ? await import("./db.js") : await import("./local-store.js");
const {
  initDb, watchUnits, saveUnit, updateUnit, deleteUnit,
  watchServices, addService, updateService, deleteService, seedFromLegacy,
  watchPhotos, addPhoto, deletePhoto,
  watchComplaints, addComplaint, updateComplaint, deleteComplaint,
  watchBuildings, saveBuilding, deleteBuilding,
  watchParts, addPart, updatePart, deletePart,
  watchProjects, addProject, updateProject, deleteProject,
  watchUpdates, addUpdate, deleteUpdate,
  watchWorkdays, addWorkday, deleteWorkday,
  watchVacations, addVacation, updateVacation, deleteVacation,
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

// ---- Local state ---------------------------------------------------
let UNITS = [];                 // live mirror of the "units" collection
let COMPLAINTS = [];            // live mirror of complaints
let BUILDINGS = {};             // { name: {name, cover} } from buildings collection
let PARTS = [];                 // live mirror of missing parts
let PROJECTS = [];              // live mirror of scheduled projects
let UPDATES = [];               // live mirror of team updates
let WORKDAYS = [];              // live mirror of project workdays
let VACATIONS = [];             // live mirror of vacation requests
let currentServiceUnsub = null; // active service-log subscription
let currentServiceList = [];    // latest service entries for the open unit
let currentPhotoUnsub = null;   // active photo subscription
let listContext = { building: null };  // which building the list is showing (null = all)
let selectMode = false;
let pendingAddPhoto = null;     // camera capture waiting to upload with a new unit
const selected = new Set();     // barcodes selected for bulk actions

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
startRealtime();
wireUI();
updateGreeting();
setInterval(updateGreeting, 60000);           // keep it current
document.addEventListener("visibilitychange", () => { if (!document.hidden) updateGreeting(); });
if (!isConfigured) initLocalMode();
// In cloud mode, detect units that were saved only on THIS device (from the
// earlier local-only period) and offer to upload them so nothing is lost.
if (isConfigured) setTimeout(checkLocalRecovery, 3500);

let recoveryChecked = false;
function checkLocalRecovery() {
  if (recoveryChecked) return;
  recoveryChecked = true;
  if (!UNITS.length) { recoveryChecked = false; return setTimeout(checkLocalRecovery, 2000); }
  let lu;
  try { lu = JSON.parse(localStorage.getItem("ac_units") || "{}"); } catch { return; }
  const cloudIds = new Set(UNITS.map((u) => u.id));
  const missing = Object.keys(lu).filter((bc) => !cloudIds.has(bc));
  if (missing.length) showRecoveryBanner(missing.length);
}

function showRecoveryBanner(n) {
  let el = document.getElementById("recoverBanner");
  if (!el) { el = document.createElement("div"); el.id = "recoverBanner"; el.className = "recover-banner"; $("#app").prepend(el); }
  el.innerHTML = `⚠️ נמצאו <b>${n}</b> מזגנים שנוספו במכשיר זה ולא סונכרנו לענן.
    <button class="btn btn--primary btn--sm" id="recoverBtn">☁️ שחזר לענן</button>`;
  $("#recoverBtn").addEventListener("click", async () => {
    const btn = $("#recoverBtn"); btn.disabled = true; btn.textContent = "משחזר…";
    try {
      const c = await recoverLocal();
      el.innerHTML = `✅ שוחזרו ${c} מזגנים לענן. הנתונים סונכרנו לכל המכשירים.`;
      setTimeout(() => el.remove(), 6000);
    } catch (e) { console.error(e); btn.disabled = false; btn.textContent = "נסה שוב"; toast("שגיאה בשחזור", true); }
  });
}

/** Upload any units in THIS device's local storage that are missing from the
 *  cloud (plus their maintenance history and photos). Never overwrites cloud data. */
async function recoverLocal() {
  const lu = JSON.parse(localStorage.getItem("ac_units") || "{}");
  const ls = JSON.parse(localStorage.getItem("ac_services") || "{}");
  const lp = JSON.parse(localStorage.getItem("ac_photos") || "{}");
  const cloudIds = new Set(UNITS.map((u) => u.id));
  let n = 0;
  for (const bc in lu) {
    if (cloudIds.has(bc)) continue;                 // already in cloud — skip, never clobber
    try {
      await saveUnit(lu[bc]);
      for (const s of (ls[bc] || [])) await addService(bc, { date: s.date, description: s.description, technician: s.technician });
      for (const p of (lp[bc] || [])) await addPhoto(bc, p.url);
      n++;
    } catch (e) { console.error("recover failed for", bc, e); }
  }
  console.log("recovered", n, "units to cloud");
  return n;
}
window.recoverLocal = recoverLocal;

/** On-demand diagnostic: show which units exist only on THIS device, and offer restore. */
async function runRecoveryDiag() {
  const box = document.getElementById("recoverDiag");
  if (!box) return;
  let lu = {};
  try { lu = JSON.parse(localStorage.getItem("ac_units") || "{}"); } catch {}
  const localCount = Object.keys(lu).length;
  const cloudIds = new Set(UNITS.map((u) => u.id));
  const missing = Object.keys(lu).filter((bc) => !cloudIds.has(bc)).sort();
  if (!localCount) {
    box.innerHTML = `<p class="tl-empty">אין נתונים מקומיים במכשיר זה. נסה במכשיר אחר שבו הוספת מזגנים.</p>`;
    return;
  }
  if (!missing.length) {
    box.innerHTML = `<p class="tl-empty">במכשיר זה יש ${localCount} מזגנים מקומיים — כולם כבר בענן. אין מה לשחזר כאן.</p>`;
    return;
  }
  box.innerHTML = `
    <p style="font-weight:600;margin:0 0 8px">נמצאו <b>${missing.length}</b> מזגנים שקיימים רק במכשיר זה:</p>
    <p style="color:var(--muted);font-size:13px;margin:0 0 12px">${missing.join(", ")}</p>
    <button class="btn btn--primary" id="doRecover">☁️ שחזר ${missing.length} מזגנים לענן</button>`;
  document.getElementById("doRecover").addEventListener("click", async () => {
    const b = document.getElementById("doRecover");
    b.disabled = true; b.textContent = "משחזר…";
    try {
      const c = await recoverLocal();
      box.innerHTML = `<p class="form-msg is-ok">✅ שוחזרו ${c} מזגנים לענן. הם יופיעו כעת אצל כולם.</p>`;
    } catch (e) { console.error(e); b.disabled = false; b.textContent = "נסה שוב"; }
  });
}
window.runRecoveryDiag = runRecoveryDiag;

/** Time-of-day greeting for ג.פ מיזוגים, based on the device's local clock. */
function updateGreeting() {
  const el = $("#greeting");
  if (!el) return;
  const h = new Date().getHours();
  let text, icon;
  if (h >= 5 && h < 12)       { text = "בוקר טוב";     icon = "🌅"; }
  else if (h >= 12 && h < 18) { text = "צהריים טובים"; icon = "☀️"; }
  else                        { text = "ערב טוב";      icon = "🌙"; }
  el.innerHTML = `<span class="greeting__icon">${icon}</span> ${text} לחברת <b>ג.פ מיזוגים</b>`;
}

/** Local (no-Firebase) mode: auto-import sample data once. */
async function initLocalMode() {
  if (!localStorage.getItem("ac_seeded")) {
    try {
      const res = await fetch("data.json");
      if (res.ok) await seedFromLegacy(await res.json());
    } catch (e) { console.warn("seed skipped:", e); }
    localStorage.setItem("ac_seeded", "1");
  }
}

// ===================================================================
//  Real-time data
// ===================================================================
function startRealtime() {
  // No "local mode" indicator anywhere — hide the badge unless cloud-synced.
  $("#syncStatus").hidden = !isConfigured;
  setSync("···", "");
  watchUnits(
    (units) => { UNITS = units; onUnitsChanged(); if (isConfigured) setSync("מחובר ✓", "is-online"); },
    (err)   => { console.error(err); setSync("שגיאת חיבור", "is-error"); toast("שגיאת חיבור למסד הנתונים", true); }
  );
  watchComplaints(
    (list) => { COMPLAINTS = list; if ($("#view-complaints").classList.contains("is-active")) renderComplaints(); },
    (err) => console.error(err)
  );
  watchBuildings(
    (list) => { BUILDINGS = Object.fromEntries(list.map((b) => [b.name, b])); onUnitsChanged(); },
    (err) => console.error(err)
  );
  watchParts(
    (list) => { PARTS = list; if ($("#view-dash").classList.contains("is-active")) renderDashboard(); refreshPartsModal(); },
    (err) => console.error(err)
  );
  watchProjects(
    (list) => {
      PROJECTS = list; renderUpcoming();
      if ($("#view-calendar").classList.contains("is-active")) renderCalendar();
      if ($("#view-dash").classList.contains("is-active")) renderDashboard();
    },
    (err) => console.error(err)
  );
  watchUpdates(
    (list) => { UPDATES = list; renderUpdates(); },
    (err) => console.error(err)
  );
  watchWorkdays(
    (list) => { WORKDAYS = list; if ($("#view-calendar").classList.contains("is-active")) renderCalendar(); },
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
  if (isConfigured) {
    window.addEventListener("online",  () => setSync("מחובר ✓", "is-online"));
    window.addEventListener("offline", () => setSync("לא מקוון — נשמר מקומית", "is-offline"));
  }
}

function onUnitsChanged() {
  populateDatalists();
  renderList();
  renderDashboard();
  if ($("#view-buildings").classList.contains("is-active")) renderBuildings();
  renderUpcoming();
  // if a search is showing, refresh it live
  if ($("#search").value.trim()) runSearch();
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

  // search
  $("#search").addEventListener("input", debounce(runSearch, 120));
  $("#btnScan").addEventListener("click", () =>
    startScan((code) => { $("#search").value = code; runSearch(); }));

  // list filter
  $("#listFilter").addEventListener("input", debounce(renderList, 120));
  $("#listBack").addEventListener("click", () => switchView("buildings"));
  $("#btnSelect").addEventListener("click", toggleSelectMode);
  $("#btnParts").addEventListener("click", () => openPartsModal(listContext.building));
  $("#bulkAll").addEventListener("change", (e) => selectAll(e.target.checked));
  $("#bulkNote").addEventListener("click", bulkNotePrompt);
  $("#bulkMaint").addEventListener("click", bulkMaintPrompt);

  // add form
  $("#addForm").addEventListener("submit", onAddSubmit);
  $("#btnScanAdd").addEventListener("click", () =>
    startScan((code) => { $('#addForm [name=barcode]').value = cleanBarcode(code); }));
  // camera capture for a new unit (in-app; not saved to the device gallery)
  $("#btnAddUnitPhoto").addEventListener("click", () => $("#addPhotoInput").click());
  $("#addPhotoInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingAddPhoto = file;
    const prev = $("#addPhotoPreview");
    prev.src = URL.createObjectURL(file);
    prev.hidden = false;
    $("#addPhotoStatus").textContent = "📷 התמונה תישמר עם המזגן";
  });

  // side menu
  $("#menuBtn").addEventListener("click", () => { $("#sideMenu").hidden = false; });
  $("#sideMenu").addEventListener("click", (e) => { if (e.target.dataset.close !== undefined) closeSideMenu(); });
  $("#menuVacations").addEventListener("click", () => { closeSideMenu(); switchView("vacations"); });
  $("#menuComplaints").addEventListener("click", () => { closeSideMenu(); switchView("complaints"); });
  $("#menuParts").addEventListener("click", () => { closeSideMenu(); openPartsModal(null); });
  $("#menuName").addEventListener("click", () => { closeSideMenu(); openNameForm(); });
  $("#menuRecover").addEventListener("click", () => { closeSideMenu(); openRecoveryScreen(); });
  $("#menuAbout").addEventListener("click", () => { closeSideMenu(); openAbout(); });

  // team updates
  $("#teamAdd").addEventListener("click", openUpdateForm);

  // vacations
  $("#btnNewVacation").addEventListener("click", () => openVacationForm());

  // complaints
  $("#btnNewComplaint").addEventListener("click", () => openComplaintForm());
  $$(".cmpl-filter .seg").forEach((s) => s.addEventListener("click", () => {
    $$(".cmpl-filter .seg").forEach((x) => x.classList.toggle("is-active", x === s));
    renderComplaints();
  }));

  // modal close
  $("#modal").addEventListener("click", (e) => { if (e.target.dataset.close !== undefined) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
}

function switchView(name) {
  $$(".view").forEach((v) => v.classList.toggle("is-active", v.id === `view-${name}`));
  // the units list is reached from Buildings, so keep that tab highlighted there
  const tabName = name === "list" ? "buildings" : name;
  $$(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.view === tabName));
  stopScan();
  if (name === "buildings") renderBuildings();
  if (name === "complaints") renderComplaints();
  if (name === "vacations") renderVacations();
  if (name === "calendar") renderCalendar();
  if (name === "dash") renderDashboard();
  if (name === "list") renderList();
  // leaving the list resets bulk selection
  if (name !== "list" && selectMode) exitSelectMode();
}

// ===================================================================
//  Search
// ===================================================================
function runSearch() {
  const term = $("#search").value.trim().toLowerCase();
  const box = $("#searchResults");
  if (!term) { box.innerHTML = ""; return; }
  const matches = UNITS.filter((u) => unitMatches(u, term));
  box.innerHTML = matches.length
    ? matches.map(cardHTML).join("")
    : emptyHTML("❌", "לא נמצאו תוצאות", `אין מזגן שמתאים ל־"${esc(term)}"`);
  wireCards(box);
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

// ===================================================================
//  Units list (all, or drilled into one building) + bulk select
// ===================================================================
function currentListUnits() {
  const term = $("#listFilter").value.trim().toLowerCase();
  let items = UNITS;
  if (listContext.building) items = items.filter((u) => (u.building || "ללא") === listContext.building);
  if (term) items = items.filter((u) => unitMatches(u, term));
  return items;
}

function renderList() {
  const items = currentListUnits();
  $("#listTitle").textContent = listContext.building ? `🏢 ${listContext.building}` : "כל המזגנים";
  $("#listBack").hidden = false;
  $("#listCount").textContent = items.length;
  const box = $("#listResults");
  box.innerHTML = items.length
    ? items.map((u) => cardHTML(u, selectMode)).join("")
    : emptyHTML("📭", "אין מזגנים", "לא נמצאו מזגנים כאן");
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
  const selecting = selectMode && root.id === "listResults";
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
  renderList();
}
function exitSelectMode() {
  selectMode = false; selected.clear();
  $("#btnSelect").textContent = "בחירה";
  $("#bulkBar").hidden = true;
  const all = $("#bulkAll"); if (all) all.checked = false;
  renderList();
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
  if (checked) currentListUnits().forEach((u) => selected.add(u.id));
  renderList();
}
function updateBulkCount() {
  const el = $("#bulkCount"); if (el) el.textContent = `${selected.size} נבחרו`;
}
async function bulkNotePrompt() {
  if (!selected.size) return toast("לא נבחרו מזגנים", true);
  const note = prompt(`הוספת הערה ל-${selected.size} מזגנים:`);
  if (!note || !note.trim()) return;
  try { await bulkAppendNote([...selected], note); toast(`✅ עודכנו ${selected.size} מזגנים`); exitSelectMode(); }
  catch (e) { console.error(e); toast("שגיאה בעדכון", true); }
}
async function bulkMaintPrompt() {
  if (!selected.size) return toast("לא נבחרו מזגנים", true);
  const desc = prompt(`רשומת טיפול ל-${selected.size} מזגנים — מה בוצע?`);
  if (!desc || !desc.trim()) return;
  try {
    await bulkAddService([...selected], { date: new Date().toISOString().slice(0, 10), description: desc, technician: "" });
    toast(`✅ נוסף טיפול ל-${selected.size} מזגנים`); exitSelectMode();
  } catch (e) { console.error(e); toast("שגיאה בשמירה", true); }
}

// ===================================================================
//  Buildings view
// ===================================================================
function renderBuildings() {
  const box = $("#buildingsGrid"); if (!box) return;
  const counts = countBy(UNITS, "building");
  const names = Object.keys(counts).sort((a, b) => a.localeCompare(b, "he"));
  const allCard = `
    <div class="bld-card bld-card--all" data-building="__all__">
      <div class="bld-card__img bld-card__img--all">❄️</div>
      <div class="bld-card__body">
        <div class="bld-card__name">כל המזגנים</div>
        <div class="bld-card__count">${UNITS.length} מזגנים</div>
      </div>
    </div>`;
  box.innerHTML = allCard + names.map((name) => {
    const b = BUILDINGS[name];
    const cover = b?.cover
      ? `<img class="bld-card__img" src="${esc(b.cover)}" alt="">`
      : `<div class="bld-card__img bld-card__img--empty">🏢</div>`;
    return `
      <div class="bld-card" data-building="${esc(name)}">
        ${cover}
        <div class="bld-card__body">
          <div class="bld-card__name">${esc(name)}</div>
          <div class="bld-card__count">${counts[name]} מזגנים</div>
        </div>
        <button class="bld-cover-btn" data-cover="${esc(name)}" title="תמונת מבנה">📷</button>
      </div>`;
  }).join("");

  $$(".bld-card", box).forEach((c) => c.addEventListener("click", (e) => {
    if (e.target.closest(".bld-cover-btn")) return;
    const b = c.dataset.building;
    openBuilding(b === "__all__" ? null : b);
  }));
  $$(".bld-cover-btn", box).forEach((btn) => btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const file = await pickImage();
    if (!file) return;
    toast("מעלה תמונה…");
    try { await saveBuilding(btn.dataset.cover, { cover: await compressImage(file) }); toast("📷 תמונת המבנה עודכנה"); }
    catch (err) { console.error(err); toast("שגיאה בהעלאת תמונה", true); }
  }));
}

function openBuilding(name) {
  listContext.building = name;
  $("#listFilter").value = "";
  if (selectMode) exitSelectMode();
  switchView("list");
}

// ===================================================================
//  Complaints / service requests view
// ===================================================================
function renderComplaints() {
  const box = $("#complaintsList"); if (!box) return;
  const filt = $(".cmpl-filter .seg.is-active")?.dataset.cf || "open";
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
    c.building ? `<span>🏢 ${esc(c.building)}</span>` : "",
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
      <label>מבנה<input name="building" list="buildings" value="${esc(c.building || "")}" placeholder="מבנה קשור"></label>
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
      building: f.building.value, barcode: cleanBarcode(f.barcode.value),
      description: f.description.value, status: f.done.checked ? "done" : "open",
    };
    if (!data.description.trim()) return;
    try {
      if (id) await updateComplaint(id, data); else await addComplaint(data);
      toast("💾 הפנייה נשמרה"); closeModal();
    } catch (err) { console.error(err); toast("שגיאה בשמירה", true); }
  });
  if (id) $("#cmplDelete").addEventListener("click", async () => {
    if (!confirm("למחוק את הפנייה?")) return;
    try { await deleteComplaint(id); toast("🗑️ נמחק"); closeModal(); }
    catch (err) { console.error(err); toast("שגיאה במחיקה", true); }
  });
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
  currentServiceUnsub = watchServices(barcode,
    (list) => renderTimeline(list),
    (err)  => console.error(err));
  // live photos
  currentPhotoUnsub = watchPhotos(barcode,
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
        <textarea name="description" rows="2" placeholder="מה בוצע? (שטיפה, החלפת פילטר, תיקון גז...)" required></textarea>
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
      await addService(u.barcode, {
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
    try { await updateUnit(u.barcode, { status }); u.status = status; toast(`✔️ ${st(status).label}`); }
    catch (err) { console.error(err); toast("שגיאה בעדכון סטטוס", true); }
  }));

  $("#btnEdit").addEventListener("click", () => openEdit(u));
  $("#btnDelete").addEventListener("click", async () => {
    if (!confirm(`למחוק את המזגן ${u.barcode}? פעולה זו אינה הפיכה.`)) return;
    try { await deleteUnit(u.barcode); toast("🗑️ נמחק"); closeModal(); }
    catch (err) { console.error(err); toast("שגיאה במחיקה", true); }
  });

  $("#btnAddPhoto").addEventListener("click", async () => {
    const files = await pickImages();
    if (!files.length) return;
    toast("מעלה תמונות…");
    try {
      for (const f of files) await addPhoto(u.barcode, await compressImage(f));
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
          <button class="photo-del" data-del="${esc(p.id)}" title="מחק">✕</button>
        </div>`).join("")
    : `<p class="tl-empty">אין תמונות עדיין.</p>`;
  $$(".photo-thumb img", box).forEach((img) =>
    img.addEventListener("click", () => openPhotoViewer(img.src)));
  $$(".photo-del", box).forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("למחוק את התמונה?")) return;
    try { await deletePhoto(barcode, b.dataset.del); }
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
    try { await deleteService(barcode, id); toast("🗑️ הטיפול נמחק"); }
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
      await updateService(barcode, s.id, {
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
      await updateUnit(u.barcode, {
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
  partsModalBuilding = null;
  clearModalSubs();
}

// ===================================================================
//  Add unit
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
    await saveUnit(unit);
    // attach the captured photo (compressed, straight to the cloud DB)
    if (pendingAddPhoto) {
      try { await addPhoto(barcode, await compressImage(pendingAddPhoto)); }
      catch (photoErr) { console.error(photoErr); toast("המזגן נשמר, אך העלאת התמונה נכשלה", true); }
    }
    f.reset();
    pendingAddPhoto = null;
    $("#addPhotoPreview").hidden = true;
    $("#addPhotoPreview").src = "";
    $("#addPhotoStatus").textContent = "";
    msg.textContent = "✅ נשמר בהצלחה!";
    msg.className = "form-msg is-ok";
    toast("✅ המזגן נוסף");
    setTimeout(() => (msg.textContent = ""), 2500);
    switchView("list");
  } catch (err) {
    console.error(err);
    msg.textContent = "❌ שגיאה בשמירה: " + err.message;
    msg.className = "form-msg is-err";
  }
}

// ===================================================================
//  Dashboard
// ===================================================================
// ===================================================================
//  Calendar view (month grid + schedule + workdays)
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
  const sched = new Set(PROJECTS.map((p) => p.date).filter(Boolean));
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
      <div class="section-head"><h3>🗓️ עבודות מתוכננות</h3><button class="btn btn--primary btn--sm" id="calAddProject">➕ עבודה</button></div>
      <div id="calProjects">${projectsListHTML()}</div>
    </div>

    <div class="panel">
      <div class="section-head"><h3>📆 ימי עבודה בפרויקט</h3><button class="btn btn--primary btn--sm" id="calAddWorkday">➕ יום עבודה</button></div>
      ${workdaysPanelHTML()}
    </div>`;

  $("#calPrev").addEventListener("click", () => { if (--calState.m < 0) { calState.m = 11; calState.y--; } renderCalendar(); });
  $("#calNext").addEventListener("click", () => { if (++calState.m > 11) { calState.m = 0; calState.y++; } renderCalendar(); });
  $$("#calGrid .cal-cell[data-iso]").forEach((c) => c.addEventListener("click", () => toggleCalendarDay(c.dataset.iso)));
  $("#calAddProject").addEventListener("click", () => openProjectForm());
  $$("#calProjects .proj-row").forEach((r) => r.addEventListener("click", () => openProjectForm(r.dataset.id)));
  $("#calAddWorkday").addEventListener("click", openWorkdayForm);
  $$("#calendarBody .wd-del").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("למחוק יום עבודה זה?")) return;
    try { await deleteWorkday(b.closest(".wd-item").dataset.id); } catch (e) { console.error(e); toast("שגיאה", true); }
  }));
}

async function toggleCalendarDay(iso) {
  const existing = WORKDAYS.filter((w) => w.date === iso);
  try {
    if (existing.length) {
      if (!confirm(`להסיר יום עבודה (${fmtDMY(iso)})?`)) return;
      for (const w of existing) await deleteWorkday(w.id);
      toast("יום עבודה הוסר");
    } else {
      await addWorkday({ date: iso });
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
    <div class="detail__head"><div class="detail__barcode">🛟 שחזור מזגנים</div><button class="detail__close" data-close>×</button></div>
    <p class="about__muted" style="margin:0 0 12px">אם הוספת מזגנים במכשיר זה שלא סונכרנו לענן — כאן אפשר לשחזר אותם.</p>
    <div id="recoverDiag"><p class="tl-empty">לחץ "בדוק מכשיר זה".</p></div>
    <button class="btn btn--primary" id="recoverCheck" style="margin-top:12px">בדוק מכשיר זה</button>`;
  modal.hidden = false;
  $("#recoverCheck").addEventListener("click", runRecoveryDiag);
}

// ===================================================================
//  Vacations (request + approval by גיא)
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
  const buildings = [...new Set(UNITS.map((u) => u.building || "ללא"))].sort((a, b) => a.localeCompare(b, "he"));
  const today = todayISO();
  const todayWorkers = [...new Set(PROJECTS.filter((p) => p.date === today).map((p) => p.workers).filter(Boolean))];

  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="stat__num">${total}</div><div class="stat__label">מזגנים סה״כ</div></div>
      <div class="stat"><div class="stat__num st-done">${gc.completed}</div><div class="stat__label">הושלמו</div></div>
      <div class="stat"><div class="stat__num st-prog">${gc.in_progress}</div><div class="stat__label">בתהליך</div></div>
      <div class="stat"><div class="stat__num st-wait">${gc.waiting_part + gc.issue}</div><div class="stat__label">ממתין / תקלה</div></div>
    </div>

    ${todayWorkers.length ? `<div class="panel"><h3>👷 עובדים היום</h3><div class="chips-row">${todayWorkers.map((w) => `<span class="chip chip--accent">${esc(w)}</span>`).join("")}</div></div>` : ""}

    <div class="panel">
      <h3>🏢 סטטוס לפי מבנה</h3>
      <div class="site-cards">${buildings.map(siteCardHTML).join("")}</div>
    </div>`;

  $$(".site-card").forEach((c) => c.addEventListener("click", () => openBuilding(c.dataset.building === "ללא" ? "ללא" : c.dataset.building)));
}

function statusCounts(list) {
  const c = { not_started: 0, in_progress: 0, completed: 0, waiting_part: 0, issue: 0 };
  list.forEach((u) => { c[STATUS[u.status] ? u.status : "not_started"]++; });
  return c;
}
function buildingUnits(name) { return UNITS.filter((u) => (u.building || "ללא") === name); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function tomorrowISO() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); }

function siteCardHTML(name) {
  const list = buildingUnits(name);
  const c = statusCounts(list);
  const pct = list.length ? Math.round(c.completed / list.length * 100) : 0;
  const missing = PARTS.filter((p) => !p.done && (p.building || "") === name).length;
  const areas = [...new Set(list.map((u) => u.area).filter(Boolean))].sort((a, b) => a.localeCompare(b, "he"));
  const areaRows = areas.map((a) => {
    const al = list.filter((u) => u.area === a);
    const ac = al.filter((u) => u.status === "completed").length;
    return `<div class="area-row"><span>${esc(a)}</span><span>${ac}/${al.length}</span></div>
      <div class="bar"><i style="width:${al.length ? ac / al.length * 100 : 0}%"></i></div>`;
  }).join("");
  return `
    <div class="site-card" data-building="${esc(name)}">
      <div class="site-card__head"><b>${esc(name)}</b><span class="chip">${c.completed}/${list.length}</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="site-stats">
        <span class="st-done">✅ ${c.completed}</span>
        <span class="st-prog">🔧 ${c.in_progress}</span>
        <span class="st-not">⚪ ${c.not_started}</span>
        <span class="st-wait">📦 ${c.waiting_part}</span>
        <span class="st-issue">⚠️ ${c.issue}</span>
        ${missing ? `<span class="st-miss">🧰 ${missing} חוסרים</span>` : ""}
      </div>
      ${areaRows ? `<div class="area-block">${areaRows}</div>` : ""}
    </div>`;
}

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
    try { await addWorkday({ date: f.date.value, note: f.note.value }); toast("💾 יום עבודה נשמר"); closeModal(); }
    catch (err) { console.error(err); toast("שגיאה בשמירה", true); }
  });
}

function projectsListHTML() {
  const today = todayISO();
  const upcoming = PROJECTS.filter((p) => !p.date || p.date >= today);
  if (!upcoming.length) return `<p class="tl-empty">אין עבודות מתוכננות.</p>`;
  return upcoming.map((p) => {
    const list = buildingUnits(p.building);
    const c = statusCounts(list);
    return `
      <div class="proj-row" data-id="${esc(p.id)}">
        <div class="proj-row__main"><b>${esc(p.building || "עבודה")}</b> <span class="chip">${esc(p.date || "")}${p.time ? ` ${esc(p.time)}` : ""}</span></div>
        <div class="proj-row__meta">${p.workers ? `👷 ${esc(p.workers)}` : ""}${list.length ? ` · ✅ ${c.completed}/${list.length}` : ""}</div>
      </div>`;
  }).join("");
}

// ---- Upcoming Work card (home) ----
function renderUpcoming() {
  const el = $("#upcomingCard"); if (!el) return;
  const today = todayISO();
  const upcoming = PROJECTS.filter((p) => p.date && p.date >= today)
    .sort((a, b) => String(a.date + (a.time || "")).localeCompare(String(b.date + (b.time || ""))));
  if (!upcoming.length) { el.innerHTML = `<div class="upcoming__empty">🗓️ לא נקבעה עבודה.</div>`; return; }
  const p = upcoming[0];
  const list = buildingUnits(p.building);
  const c = statusCounts(list);
  const pct = list.length ? Math.round(c.completed / list.length * 100) : 0;
  const dlabel = p.date === today ? "היום" : (p.date === tomorrowISO() ? "מחר" : p.date);
  el.innerHTML = `
    <div class="upcoming__card" data-id="${esc(p.id)}">
      <div class="upcoming__top">
        <span class="upcoming__tag">🗓️ עבודה קרובה</span>
        <span class="chip chip--accent">${dlabel}${p.time ? ` · ${esc(p.time)}` : ""}</span>
      </div>
      <div class="upcoming__title">🏢 ${esc(p.building || "עבודה")}</div>
      ${p.location ? `<div class="upcoming__row">📍 ${esc(p.location)}</div>` : ""}
      ${p.workers ? `<div class="upcoming__row">👷 ${esc(p.workers)}</div>` : ""}
      ${list.length ? `<div class="upcoming__row">📊 ${c.completed}/${list.length} הושלמו</div><div class="bar"><i style="width:${pct}%"></i></div>` : ""}
    </div>`;
  el.querySelector(".upcoming__card").addEventListener("click", () => openProjectForm(p.id));
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
  $("#modalPanel").innerHTML = `
    <div class="detail__head">
      <div class="detail__barcode">ℹ️ אודות</div>
      <button class="detail__close" data-close>×</button>
    </div>
    <div class="about">
      <p><b>❄️ AC Tracker</b> — ניהול מזגנים</p>
      <p>לחברת <b>ג.פ מיזוגים</b></p>
      <p>סה״כ מזגנים במערכת: <b>${UNITS.length}</b></p>
      <p class="about__muted">מחובר לענן · סנכרון בזמן אמת לכל המכשירים</p>
    </div>`;
  modal.hidden = false;
}

// ---- Team updates widget ----
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
    try { await deleteUpdate(id); } catch (e) { console.error(e); toast("שגיאה בהסרה", true); }
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
    try { await addUpdate({ text, author }); toast("💬 העדכון פורסם"); closeModal(); }
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
let partsModalBuilding = null;
function openPartsModal(building) {
  partsModalBuilding = building || null;
  clearModalSubs();
  const modal = $("#modal");
  modal.dataset.barcode = "";
  modal.dataset.parts = "1";
  $("#modalPanel").innerHTML = `
    <div class="detail__head">
      <div class="detail__barcode">🧰 חוסרים${building ? ` — ${esc(building)}` : ""}</div>
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
    try { await addPart({ building: partsModalBuilding || "", item: b.dataset.item }); toast("➕ נוסף"); }
    catch (e) { console.error(e); toast("שגיאה", true); }
  }));
  $("#partForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!f.item.value.trim()) return;
    try { await addPart({ building: partsModalBuilding || "", item: f.item.value, note: f.note.value }); f.reset(); toast("➕ נוסף"); }
    catch (err) { console.error(err); toast("שגיאה", true); }
  });
  refreshPartsModal();
}

function refreshPartsModal() {
  const modal = $("#modal");
  if (modal.hidden || modal.dataset.parts !== "1") return;
  const box = $("#partsList"); if (!box) return;
  const b = partsModalBuilding;
  const list = PARTS.filter((p) => (b ? p.building === b : true));
  box.innerHTML = list.length
    ? list.map((p) => `
        <div class="part-row ${p.done ? "is-done" : ""}" data-id="${esc(p.id)}">
          <button class="part-check" data-toggle>${p.done ? "✅" : "⬜"}</button>
          <div class="part-row__body"><b>${esc(p.item)}</b>${p.note ? ` · ${esc(p.note)}` : ""}${(!b && p.building) ? `<div class="part-row__bld">🏢 ${esc(p.building)}</div>` : ""}</div>
          <button class="part-del" data-del>🗑️</button>
        </div>`).join("")
    : `<p class="tl-empty">אין חוסרים רשומים.</p>`;
  $$(".part-row", box).forEach((row) => {
    const id = row.dataset.id;
    const p = PARTS.find((x) => x.id === id);
    row.querySelector("[data-toggle]").addEventListener("click", async () => {
      try { await updatePart(id, { done: !p.done }); } catch (e) { console.error(e); toast("שגיאה", true); }
    });
    row.querySelector("[data-del]").addEventListener("click", async () => {
      try { await deletePart(id); } catch (e) { console.error(e); toast("שגיאה", true); }
    });
  });
}

// ---- Scheduled project form ----
function openProjectForm(id) {
  const p = id ? PROJECTS.find((x) => x.id === id) || {} : {};
  clearModalSubs();
  const modal = $("#modal");
  modal.dataset.barcode = ""; modal.dataset.parts = "";
  $("#modalPanel").innerHTML = `
    <div class="detail__head">
      <div class="detail__barcode">🗓️ ${id ? "עריכת עבודה" : "עבודה חדשה"}</div>
      <button class="detail__close" data-close>×</button>
    </div>
    <form class="form" id="projForm">
      <label>מבנה / פרויקט<input name="building" list="buildings" value="${esc(p.building || "")}" required placeholder="שם המבנה"></label>
      <div class="row2">
        <label>תאריך<input type="date" name="date" value="${esc(p.date || todayISO())}"></label>
        <label>שעה<input type="time" name="time" value="${esc(p.time || "")}"></label>
      </div>
      <label>מיקום<input name="location" value="${esc(p.location || "")}" placeholder="כתובת / אזור"></label>
      <label>עובדים<input name="workers" value="${esc(p.workers || "")}" placeholder="שמות העובדים"></label>
      <label>הערות<textarea name="notes" rows="2">${esc(p.notes || "")}</textarea></label>
      <div class="detail__actions">
        <button type="submit" class="btn btn--primary">💾 שמור</button>
        ${id ? `<button type="button" class="btn btn--danger" id="projDelete">🗑️ מחק</button>`
             : `<button type="button" class="btn btn--ghost" data-close>ביטול</button>`}
      </div>
    </form>`;
  modal.hidden = false;
  $("#projForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const data = { building: f.building.value, date: f.date.value, time: f.time.value, location: f.location.value, workers: f.workers.value, notes: f.notes.value };
    if (!data.building.trim()) return;
    try { if (id) await updateProject(id, data); else await addProject(data); toast("💾 נשמר"); closeModal(); }
    catch (err) { console.error(err); toast("שגיאה בשמירה", true); }
  });
  if (id) $("#projDelete").addEventListener("click", async () => {
    if (!confirm("למחוק את העבודה?")) return;
    try { await deleteProject(id); toast("🗑️ נמחק"); closeModal(); }
    catch (err) { console.error(err); toast("שגיאה במחיקה", true); }
  });
}

function barPanel(title, counts, total) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return "";
  return `
    <div class="panel">
      <h3>${title}</h3>
      ${rows.map(([name, n]) => `
        <div class="bar-row">
          <span>${esc(name)}</span><span>${n}</span>
        </div>
        <div class="bar"><i style="width:${total ? (n / total * 100) : 0}%"></i></div>
      `).join("")}
    </div>`;
}

function countBy(arr, key) {
  return arr.reduce((acc, x) => {
    const k = (x[key] || "").trim() || "ללא";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
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

// ===================================================================
//  One-time data migration helper
//  Run  seedLegacy()  from the browser console to import your old
//  data.json into Firestore (safe: skips existing barcodes).
// ===================================================================
window.seedLegacy = async function () {
  try {
    const res = await fetch("data.json");
    const records = await res.json();
    const added = await seedFromLegacy(records);
    toast(`✅ יובאו ${added} מזגנים`);
    console.log(`Seeded ${added} units from data.json`);
  } catch (err) { console.error(err); toast("שגיאה בייבוא", true); }
};
