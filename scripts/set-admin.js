import 'dotenv/config';
import { auth } from '../src/config/firestore.js';

const uid = process.argv[2];

if (!uid) {
  console.error('Usage: npm run set-admin -- <firebase-auth-uid>');
  process.exit(1);
}

try {
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, {
    ...user.customClaims,
    admin: true
  });
  console.log(`Admin claim granted to Firebase user ${uid}.`);
  console.log('The user must refresh their Firebase ID token before the claim appears in tokens.');
} catch (error) {
  console.error(`Could not grant admin claim to ${uid}:`, error.message);
  process.exitCode = 1;
}
