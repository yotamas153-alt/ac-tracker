// ===================================================================
//  auth.js — Firebase Authentication (cloud mode only)
//  Gates the app behind a login screen so only accounts the admin
//  created in the Firebase console can read/write the data.
// ===================================================================
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

let auth = null;

function ensureAuth() {
  if (!auth) {
    const app = getApps()[0] || initializeApp(firebaseConfig);
    auth = getAuth(app);
  }
  return auth;
}

/** Subscribe to sign-in state. Calls onUser(user) or onUser(null) whenever it changes. */
export function initAuth(onUser) {
  return onAuthStateChanged(ensureAuth(), onUser);
}

/** Sign in with email + password. Throws on bad credentials. */
export async function login(email, password) {
  await signInWithEmailAndPassword(ensureAuth(), email, password);
}

export async function logout() {
  await signOut(ensureAuth());
}
