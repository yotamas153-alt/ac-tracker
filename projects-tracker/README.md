# 🗂️ AC Tracker — פרויקטים

A sibling app to [AC Tracker](../README.md), for when the work isn't one big
site but **many small, independent projects** running in parallel. Each
project (job site) gets its own buildings, AC units, complaints, missing
parts and scheduled visits — completely separate from every other project.
Staff-level things that aren't tied to one site (vacations, van inventory)
stay shared across all of them.

Same tech as the original: mobile-first, barcode scanning, real-time cloud
database, per-unit service history, offline support, installable PWA.
Hosted free on **GitHub Pages**, powered by **Firebase Firestore** (also
free tier).

---

## ✨ What's included

| Feature | Details |
|---|---|
| 🗂️ Projects | Create/switch between job sites; each one's data is fully separate |
| 🔍 Search | Live search across barcode / building / type / location / notes, within the open project |
| 📷 Barcode scan | Camera scan fills the search box or the add form |
| ➕ / ✏️ / 🗑️ | Add, edit and delete units — saved to the cloud instantly |
| 🔧 Service history | Every visit logged per unit (date + what was done + technician) |
| 📡 Real-time sync | Changes appear live on every device, no refresh |
| 📴 Offline | Works with no signal in the field, syncs when back online |
| 📊 Dashboard | Totals + breakdown by building and type, per project |
| 🏖️ / 🚚 Staff tools | Vacations and vehicle inventory are shared across every project |
| 📱 Installable | "Add to Home Screen" — runs like a native app |

---

## 🗂️ How projects work

The **Projects** screen is the landing page. Pick a project to open it —
the tabs (search, buildings, add, calendar, dashboard) then all show only
that project's data. Use the project name in the header (or the side menu's
"🗂️ פרויקטים") to switch to a different project at any time. Deleting a
project deletes everything inside it (buildings, units, complaints, missing
parts, scheduled visits, workday log) — that action can't be undone.

Vacations and the per-worker vehicle inventory are **not** part of any
project — they're the same list everywhere, since they're about staff, not
a job site.

---

## 🚀 One-time setup (≈5 minutes)

This app needs its **own** Firebase project — separate from the original
AC Tracker's — so the two apps' data never mix.

### 1. Create a Firebase project + database
1. Go to <https://console.firebase.google.com> → **Add project** (any name, e.g. `ac-tracker-projects`). You can disable Google Analytics.
2. In the left menu: **Build → Firestore Database → Create database**.
   - Choose a location close to you.
   - Start in **Test mode** for now (we'll set the rule below).
3. Go to **Project settings** (⚙️ top-left) → scroll to **Your apps** → click the web icon **`</>`** → register an app (any nickname). **Do not** enable Hosting.
4. Firebase shows a `firebaseConfig = { ... }` block. Keep it open for the next step.

### 2. Paste your config
Open **`js/firebase-config.js`** and replace the placeholder values with the ones
from step 3 (apiKey, authDomain, projectId, etc.). Save.

### 3. Set the database access rule (you chose "open / no login")
In Firestore → **Rules** tab, paste this and **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
```

> ⚠️ **Note:** `if true` means anyone with your site link can read/edit the data.
> That's fine for personal use. When you want to lock it down later, we can switch
> to a simple login — ask and it's ~15 minutes of work.

---

## ▶️ Run it

### On GitHub Pages (recommended)
This folder lives alongside the original app in the same repo. Once pushed,
open `https://<your-user>.github.io/ac-tracker/projects-tracker/`.
Camera scanning needs HTTPS — GitHub Pages provides it automatically.

### Locally (for testing)
ES modules don't work from `file://`. Start a tiny local server first:

```bash
# from inside the projects-tracker folder
python -m http.server 8080
# then open http://localhost:8080
```

Until Firebase is configured, the app runs fully offline on this device's
local storage — create a project and try it out with zero setup.

---

## 🗂️ Project structure

```
projects-tracker/
├── index.html            # app shell (RTL, tabs, modal, projects picker)
├── manifest.json         # PWA manifest (installable)
├── sw.js                 # service worker (offline app shell)
├── css/
│   └── style.css         # dark, mobile-first theme
└── js/
    ├── firebase-config.js  # 👉 paste YOUR Firebase keys here
    ├── db.js               # Firestore data layer (all reads/writes)
    ├── local-store.js       # localStorage fallback (zero-setup mode)
    ├── scanner.js          # camera barcode scanning
    └── app.js              # UI controller (views, search, dashboard)
```

## 🔐 Data model (Firestore)

Everything that belongs to one job site is a subcollection under that
project's document. Vacations and vehicle inventory are staff-level and
stay top-level.

```
projects (collection)
  {projectId} (document)
    name, client, address, notes, cover, createdAt
    units (subcollection)
      {barcode} (document)      ← barcode is the document id
        barcode, building, type, location, notes
        lastService, lastServiceDate, createdAt, updatedAt
        services (subcollection)  — date, description, technician, createdAt
        photos (subcollection)    — url, label, createdAt
    buildings (subcollection)   — name, cover, updatedAt
    complaints (subcollection)  — customer, phone, building, barcode, description, status
    parts (subcollection)       — building, item, note, done, createdAt
    visits (subcollection)      — building, date, time, location, workers, notes
    updates (subcollection)     — text, author, createdAt
    workdays (subcollection)    — date, note, createdAt

vacations (collection)      — name, from, to, note, status, decidedBy   (staff-level)
vehicle_items (collection)  — owner, item, missing, createdAt           (staff-level)
```
