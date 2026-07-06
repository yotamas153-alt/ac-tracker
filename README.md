# ❄️ AC Tracker — ניהול מזגנים

A professional, mobile-first AC (air-conditioner) tracker with barcode scanning,
a real-time cloud database, per-unit service history, offline support, and an
installable phone app (PWA).

Hosted free on **GitHub Pages**, powered by **Firebase Firestore** (also free tier).

---

## ✨ What's included

| Feature | Details |
|---|---|
| 🔍 Search | Live search across barcode / building / type / location / notes |
| 📷 Barcode scan | Camera scan fills the search box or the add form |
| ➕ / ✏️ / 🗑️ | Add, edit and delete units — saved to the cloud instantly |
| 🔧 Service history | Every visit logged per unit (date + what was done + technician) |
| 📡 Real-time sync | Changes appear live on every device, no refresh |
| 📴 Offline | Works with no signal in the field, syncs when back online |
| 📊 Dashboard | Totals + breakdown by building and type |
| 📱 Installable | "Add to Home Screen" — runs like a native app |

---

## 🚀 One-time setup (≈5 minutes)

You only do steps 1–2 once. After that, editing data never touches the code again.

### 1. Create a Firebase project + database
1. Go to <https://console.firebase.google.com> → **Add project** (any name, e.g. `ac-tracker`). You can disable Google Analytics.
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
Push these files to your `ac-tracker` repo (see commands below), then open
`https://<your-user>.github.io/ac-tracker/`.
Camera scanning needs HTTPS — GitHub Pages provides it automatically.

### Locally (for testing)
ES modules don't work from `file://`. Start a tiny local server first:

```bash
# from inside the ac-tracker folder
python -m http.server 8080
# then open http://localhost:8080
```

---

## 📦 Import your old data (once)

Your existing two records are preserved in `data.json`. After the app is connected
to Firebase, open it in the browser, open the developer console (F12) and run:

```js
seedLegacy()
```

This imports every record from `data.json` into Firestore (safely skips barcodes
that already exist) and turns each "מה בוצע" into the first service-history entry.
You only need to do this once, then you can delete `data.json`.

---

## ⬆️ Push to GitHub

From inside this folder:

```bash
git init
git add .
git commit -m "Professional AC Tracker: Firebase DB, service history, PWA"
git branch -M main
git remote add origin https://github.com/<your-user>/ac-tracker.git
git push -u origin main --force   # only if replacing the existing repo
```

Then in the repo: **Settings → Pages → Deploy from branch → `main` / root**.

---

## 🗂️ Project structure

```
ac-tracker/
├── index.html            # app shell (RTL, tabs, modal)
├── manifest.json         # PWA manifest (installable)
├── sw.js                 # service worker (offline app shell)
├── data.json             # your legacy data (for one-time import)
├── css/
│   └── style.css         # dark, mobile-first theme
└── js/
    ├── firebase-config.js  # 👉 paste YOUR Firebase keys here
    ├── db.js               # Firestore data layer (all reads/writes)
    ├── scanner.js          # camera barcode scanning
    └── app.js              # UI controller (views, search, dashboard)
```

## 🔐 Data model (Firestore)

```
units (collection)
  {barcode} (document)      ← barcode is the document id
    barcode, building, type, location, notes
    lastService, lastServiceDate
    createdAt, updatedAt
    services (subcollection)
      {auto-id}
        date, description, technician, createdAt
```
