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
  watchServices, addService, seedFromLegacy,
} = store;

// ---- Local state ---------------------------------------------------
let UNITS = [];                 // live mirror of the "units" collection
let currentServiceUnsub = null; // active service-log subscription

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ===================================================================
//  Boot
// ===================================================================
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW:", e));
}

initDb();
startRealtime();
wireUI();
if (!isConfigured) initLocalMode();

/** Local (no-Firebase) mode: show a note and auto-import sample data once. */
async function initLocalMode() {
  const note = document.createElement("div");
  note.className = "local-note";
  note.innerHTML = `💾 מצב מקומי — הנתונים נשמרים במכשיר הזה בלבד. ` +
    `לסנכרון ענן בין מכשירים ראה <code>README.md</code>.`;
  $("#app").prepend(note);

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
  setSync(isConfigured ? "···" : "מצב מקומי 💾", isConfigured ? "" : "is-offline");
  watchUnits(
    (units) => { UNITS = units; onUnitsChanged(); if (isConfigured) setSync("מחובר ✓", "is-online"); },
    (err)   => { console.error(err); setSync("שגיאת חיבור", "is-error"); toast("שגיאת חיבור למסד הנתונים", true); }
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
    startScan("reader", (code) => { $("#search").value = code; runSearch(); }));

  // list filter
  $("#listFilter").addEventListener("input", debounce(renderList, 120));

  // add form
  $("#addForm").addEventListener("submit", onAddSubmit);
  $("#btnScanAdd").addEventListener("click", () =>
    startScan("reader", (code) => { $('#addForm [name=barcode]').value = code; }));

  // modal close
  $("#modal").addEventListener("click", (e) => { if (e.target.dataset.close !== undefined) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
}

function switchView(name) {
  $$(".view").forEach((v) => v.classList.toggle("is-active", v.id === `view-${name}`));
  $$(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.view === name));
  stopScan("reader");
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
  return [u.barcode, u.building, u.type, u.location, u.notes, u.lastService, u.oldSku]
    .some((f) => String(f ?? "").toLowerCase().includes(term));
}

// ===================================================================
//  All-units list
// ===================================================================
function renderList() {
  const term = $("#listFilter").value.trim().toLowerCase();
  const box = $("#listResults");
  const items = term ? UNITS.filter((u) => unitMatches(u, term)) : UNITS;
  $("#listCount").textContent = items.length;
  box.innerHTML = items.length
    ? items.map(cardHTML).join("")
    : emptyHTML("📭", "אין מזגנים עדיין", "הוסף מזגן ראשון מלשונית ➕ הוספה");
  wireCards(box);
}

// ===================================================================
//  Card rendering
// ===================================================================
function cardHTML(u) {
  const tags = [u.type, u.building].filter(Boolean)
    .map((t) => `<span class="chip">${esc(t)}</span>`).join("");
  return `
    <div class="card" data-barcode="${esc(u.id)}">
      <div class="card__icon">❄️</div>
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
      <span class="card__chev">‹</span>
    </div>`;
}

function wireCards(root) {
  $$(".card", root).forEach((c) =>
    c.addEventListener("click", () => openDetail(c.dataset.barcode)));
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
  const modal = $("#modal");
  modal.dataset.barcode = barcode;
  $("#modalPanel").innerHTML = detailHTML(u);
  modal.hidden = false;
  wireDetail(u);

  // live service history
  if (currentServiceUnsub) currentServiceUnsub();
  currentServiceUnsub = watchServices(barcode,
    (list) => renderTimeline(list),
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
  const box = $("#timeline");
  if (!box) return;
  box.innerHTML = list.length
    ? list.map((s) => `
        <div class="tl-item">
          <div class="tl-item__date">📅 ${esc(s.date)}</div>
          <p class="tl-item__desc">${esc(s.description)}</p>
          ${s.technician ? `<div class="tl-item__tech">👷 ${esc(s.technician)}</div>` : ""}
        </div>`).join("")
    : `<p class="tl-empty">אין טיפולים רשומים עדיין.</p>`;
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

function closeModal() {
  const m = $("#modal");
  m.hidden = true;
  m.dataset.barcode = "";
  if (currentServiceUnsub) { currentServiceUnsub(); currentServiceUnsub = null; }
}

// ===================================================================
//  Add unit
// ===================================================================
async function onAddSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const msg = $("#addMsg");
  const unit = {
    barcode: f.barcode.value, building: f.building.value,
    type: f.type.value, location: f.location.value,
    oldSku: f.oldSku.value, notes: f.notes.value,
  };
  if (!unit.barcode.trim()) { msg.textContent = "צריך ברקוד"; msg.className = "form-msg is-err"; return; }

  const dup = UNITS.find((u) => u.id === unit.barcode.trim());
  if (dup && !confirm(`ברקוד ${unit.barcode} כבר קיים. לעדכן את הפרטים הקיימים?`)) return;

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
