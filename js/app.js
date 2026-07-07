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
  bulkAddService, bulkAppendNote,
} = store;

// ---- Local state ---------------------------------------------------
let UNITS = [];                 // live mirror of the "units" collection
let COMPLAINTS = [];            // live mirror of complaints
let BUILDINGS = {};             // { name: {name, cover} } from buildings collection
let currentServiceUnsub = null; // active service-log subscription
let currentServiceList = [];    // latest service entries for the open unit
let currentPhotoUnsub = null;   // active photo subscription
let listContext = { building: null };  // which building the list is showing (null = all)
let selectMode = false;
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
  $("#bulkAll").addEventListener("change", (e) => selectAll(e.target.checked));
  $("#bulkNote").addEventListener("click", bulkNotePrompt);
  $("#bulkMaint").addEventListener("click", bulkMaintPrompt);

  // add form
  $("#addForm").addEventListener("submit", onAddSubmit);
  $("#btnScanAdd").addEventListener("click", () =>
    startScan((code) => { $('#addForm [name=barcode]').value = cleanBarcode(code); }));

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
          ${u.location ? `<span class="chip chip--accent">📍 ${esc(u.location)}</span>` : ""}
        </div>
        ${u.building ? `<div class="card__row"><b>🏢</b> ${esc(u.building)}</div>` : ""}
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

    <div class="detail__grid" id="detailFields">
      ${field("🏢 מבנה", u.building)}
      ${field("🧊 סוג", u.type)}
      ${field("📍 מיקום", u.location)}
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
    field("📍 מיקום", u.location) + field("🔖 מק\"ט ישן", u.oldSku) +
    field("📝 הערות", u.notes);
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
    oldSku: f.oldSku.value, notes: f.notes.value,
  };
  if (!barcode) { msg.textContent = "צריך ברקוד"; msg.className = "form-msg is-err"; return; }

  const dup = UNITS.find((u) => u.id === barcode);
  if (dup && !confirm(`ברקוד ${barcode} כבר קיים. לעדכן את הפרטים הקיימים?`)) return;

  try {
    await saveUnit(unit);
    f.reset();
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
function renderDashboard() {
  const box = $("#dashStats");
  if (!box) return;
  const total = UNITS.length;
  const buildings = countBy(UNITS, "building");
  const types = countBy(UNITS, "type");
  const withHistory = UNITS.filter((u) => u.lastService).length;

  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="stat__num">${total}</div><div class="stat__label">מזגנים סה״כ</div></div>
      <div class="stat"><div class="stat__num">${Object.keys(buildings).length}</div><div class="stat__label">מבנים</div></div>
      <div class="stat"><div class="stat__num">${withHistory}</div><div class="stat__label">טופלו</div></div>
      <div class="stat"><div class="stat__num">${Object.keys(types).length}</div><div class="stat__label">סוגים</div></div>
    </div>
    ${barPanel("🏢 מזגנים לפי מבנה", buildings, total)}
    ${barPanel("🧊 מזגנים לפי סוג", types, total)}`;
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
