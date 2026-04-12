import { initializeApp, getApp, getApps } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

function envValue(key: string, fallback: string): string {
  const value = String(import.meta.env[key] ?? "").trim();
  return value || fallback;
}

const firebaseConfig = {
  apiKey: envValue("VITE_FIREBASE_API_KEY", "AIzaSyCDjo_xeECHZQR1UpIb6zzwUgikG_5HKyA"),
  authDomain: envValue("VITE_FIREBASE_AUTH_DOMAIN", "stocking-eafe1.firebaseapp.com"),
  projectId: envValue("VITE_FIREBASE_PROJECT_ID", "stocking-eafe1"),
  storageBucket: envValue("VITE_FIREBASE_STORAGE_BUCKET", "stocking-eafe1.appspot.com"),
  messagingSenderId: envValue("VITE_FIREBASE_MESSAGING_SENDER_ID", "94634932524"),
  appId: envValue("VITE_FIREBASE_APP_ID", "1:94634932524:web:b030bb9f9234121265d489"),
  measurementId: envValue("VITE_FIREBASE_MEASUREMENT_ID", "G-0MG1DBR1P3"),
};

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const firebaseAuth = getAuth(app);
export const firestoreDb = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
export const firebaseCollectionPrefix = envValue("VITE_FIREBASE_COLLECTION_PREFIX", "prod-");
export const firebaseDatabaseCollection = `${firebaseCollectionPrefix}database`;
