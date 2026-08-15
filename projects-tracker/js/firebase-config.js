// ===================================================================
//  Firebase configuration — AC Tracker: פרויקטים
//  This app needs its OWN Firebase project (separate from the original
//  ac-tracker's), so this multi-project app's data never mixes with the
//  single-project tracker's data. Follow the README's one-time setup,
//  then paste your config below. These web keys are safe to ship
//  publicly (access is controlled by Firestore security rules, not by
//  hiding the apiKey).
// ===================================================================

export const firebaseConfig = {
  apiKey:            "PASTE_API_KEY",
  authDomain:        "PASTE_PROJECT_ID.firebaseapp.com",
  projectId:         "PASTE_PROJECT_ID",
  storageBucket:     "PASTE_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "PASTE_SENDER_ID",
  appId:             "PASTE_APP_ID",
};

// The app runs against Firebase when a real apiKey is present.
// Until then it falls back to on-device storage (local-store.js) so the
// app is fully usable with zero setup.
export const isConfigured = !firebaseConfig.apiKey.startsWith("PASTE_");
