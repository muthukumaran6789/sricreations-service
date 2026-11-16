import { applicationDefault, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const isEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const firebaseApp = getApps().length
  ? getApp()
  : initializeApp({
      ...(projectId ? { projectId } : {}),
      ...(!isEmulator ? { credential: applicationDefault() } : {})
    });

export const db = getFirestore(firebaseApp);
export const auth = getAuth(firebaseApp);
