# 🗂️ ג.פ מיזוגים בע"מ

A sibling app to [AC Tracker](../README.md), for when the work isn't one big
site but **many small, independent projects** running in parallel. Each
project (job site) is organized into a fixed set of sections instead of a
building hierarchy: installed equipment (AC units, with the original app's
full status + service-history tracking), execution plans, contacts, a photo
gallery, a work log, warranty photos, the project's crew, tasks, team
messages, complaints and missing parts. Staff-level things that aren't tied
to one site (vacations, van inventory) stay shared across every project.

Same tech as the original: mobile-first, barcode scanning, real-time cloud
database, per-unit service history, offline support, installable PWA.
Hosted free on **GitHub Pages**, powered by **Firebase Firestore** (also
free tier).

---

## ✨ What's included

Per project:

| Section | Details |
|---|---|
| ❄️ ציוד ההתקנה | Installed AC units — barcode scan, status workflow, full service history, photos |
| 📐 תוכניות לביצוע | Execution-plan photos |
| 👤 אנשי קשר | Project contacts (name, role, phone, notes) |
| 🖼️ גלריית תמונות | General project photo gallery |
| 📄 אחריות מזגנים | Warranty photos |
| 👷 צוות הפרויקט | Roster of who worked on this project |
| 📅 יומן עבודה | Work log (actual dates worked) + scheduled upcoming visits |
| 💬 הודעות צוות | Team messages |
| 📣 תקלות ופניות | Customer complaints / service requests |
| 🧰 חוסרים | Missing parts/equipment checklist |
| 📊 דוח | Status totals, open tasks, missing parts, today's workers |

Shared across every project (staff-level, not site-level): 🏖️ vacation
requests (with approval) and 🚚 per-worker vehicle inventory.

Plans, the photo gallery and warranty photos are **images only** — the same
camera-capture / compress / upload flow the app already uses for unit
photos (no PDF support, no external file storage).

---

## 🗂️ How projects work

The **Projects** screen is the landing page. Pick a project to open it — it
lands on that project's **Home** screen (upcoming visit, team messages,
this-week vacations, and a grid linking to every section above). Use the
project name in the header (or the side menu's "🗂️ פרויקטים") to switch to
a different project at any time. Deleting a project deletes everything
inside it — that action can't be undone.

---

## 🚀 One-time setup (≈5 minutes)

This app needs its **own** Firebase project — separate from the original
AC Tracker's — so the two apps' data never mix.

### 1. Create a Firebase project + database
1. Go to <https://console.firebase.google.com> → **Add project** (any name, e.g. `gp-mizugim`). You can disable Google Analytics.
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
    └── app.js              # UI controller (views, sections, dashboard)
```

## 🔐 Data model (Firestore)

Everything that belongs to one job site is a subcollection under that
project's document. Vacations and vehicle inventory are staff-level and
stay top-level.

```
projects (collection)
  {projectId} (document)
    name, client, address, notes, cover, createdAt
    units (subcollection)       ← installed AC equipment, barcode is the document id
      {barcode} (document)
        barcode, building, type, location, notes
        lastService, lastServiceDate, status, createdAt, updatedAt
        services (subcollection)  — date, description, technician, createdAt
        photos (subcollection)    — url, label, createdAt
    contacts (subcollection)    — name, role, phone, notes, createdAt
    crew (subcollection)        — name, role, phone, createdAt
    tasks (subcollection)       — title, assignee, dueDate, done, createdAt
    media (subcollection)       — category (plan|gallery|warranty), url, label, createdAt
    complaints (subcollection)  — customer, phone, barcode, description, status
    parts (subcollection)       — item, note, done, createdAt
    visits (subcollection)      — title, date, time, location, workers, notes
    updates (subcollection)     — text, author, createdAt
    workdays (subcollection)    — date, note, createdAt

vacations (collection)      — name, from, to, note, status, decidedBy   (staff-level)
vehicle_items (collection)  — owner, item, missing, createdAt           (staff-level)
```
