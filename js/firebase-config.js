// ===================================================================
//  Firebase configuration
// -------------------------------------------------------------------
//  👉 REPLACE the placeholder values below with YOUR Firebase project
//     config. Full step-by-step instructions are in README.md.
//
//  Where to get it:
//    1. https://console.firebase.google.com  →  Add project
//    2. Build → Firestore Database → Create database (Production or Test)
//    3. Project settings (⚙️) → "Your apps" → Web app (</>) → register
//    4. Copy the firebaseConfig object and paste its values here.
// ===================================================================

export const firebaseConfig = {
  apiKey:            "PASTE_API_KEY_HERE",
  authDomain:        "PASTE_PROJECT.firebaseapp.com",
  projectId:         "PASTE_PROJECT_ID",
  storageBucket:     "PASTE_PROJECT.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId:             "PASTE_APP_ID",
};

// Leave this as-is. The app checks it to show a friendly setup message
// until you paste your real config above.
export const isConfigured = !firebaseConfig.apiKey.startsWith("PASTE_");
