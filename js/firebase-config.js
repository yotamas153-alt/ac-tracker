// ===================================================================
//  Firebase configuration — ac-tracker
//  Live project. These web keys are safe to ship publicly (access is
//  controlled by Firestore security rules, not by hiding the apiKey).
// ===================================================================

export const firebaseConfig = {
  apiKey:            "AIzaSyCCoUEZP44iZjQlF3OWDKh6wtO00-VtQPA",
  authDomain:        "ac-tracker-7c2d5.firebaseapp.com",
  projectId:         "ac-tracker-7c2d5",
  storageBucket:     "ac-tracker-7c2d5.firebasestorage.app",
  messagingSenderId: "516217405996",
  appId:             "1:516217405996:web:c967c6c2dcbc633ca7c789",
};

// The app runs against Firebase when a real apiKey is present.
export const isConfigured = !firebaseConfig.apiKey.startsWith("PASTE_");
