import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

function envValue(key: string): string {
  const value = String(import.meta.env[key] ?? "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

const firebaseConfig = {
  apiKey: envValue("VITE_FIREBASE_API_KEY"),
  authDomain: envValue("VITE_FIREBASE_AUTH_DOMAIN"),
  projectId: envValue("VITE_FIREBASE_PROJECT_ID"),
  storageBucket: envValue("VITE_FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: envValue("VITE_FIREBASE_MESSAGING_SENDER_ID"),
  appId: envValue("VITE_FIREBASE_APP_ID"),
  measurementId: envValue("VITE_FIREBASE_MEASUREMENT_ID"),
};

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const firebaseAuth = getAuth(app);
export const firestoreDb = getFirestore(app);
export const firebaseStorage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();
export const firebaseCollectionPrefix = envValue(
  "VITE_FIREBASE_COLLECTION_PREFIX",
);
export const firebaseDatabaseCollection = `${firebaseCollectionPrefix}database`;
