// ===================================================================
//  Firebase configuration — ג.פ מיזוגים בע"מ
//  Own Firebase project (gp-mizugim), separate from the original
//  ac-tracker's, so this app's data never mixes with the single-project
//  tracker's data. These web keys are safe to ship publicly (access is
//  controlled by Firestore security rules, not by hiding the apiKey).
// ===================================================================

export const firebaseConfig = {
  apiKey:            "AIzaSyCJHhoRKM_Kfkd4ScgdCm6KIn69TDcrrGQ",
  authDomain:        "gp-mizugim.firebaseapp.com",
  projectId:         "gp-mizugim",
  storageBucket:     "gp-mizugim.firebasestorage.app",
  messagingSenderId: "928548999961",
  appId:             "1:928548999961:web:8ed507eaf00251d4d46b88",
};

// The app runs against Firebase when a real apiKey is present.
// Until then it falls back to on-device storage (local-store.js) so the
// app is fully usable with zero setup.
export const isConfigured = !firebaseConfig.apiKey.startsWith("PASTE_");
