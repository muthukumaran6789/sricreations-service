import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { auth, db } from '../config/firestore.js';
import { requireAuth } from '../middleware/require-auth.js';

const router = Router();
const allowedPlatforms = new Set(['web', 'app']);

router.post('/session', requireAuth, async (req, res, next) => {
  try {
    const { uid, email, email_verified: emailVerified, name, picture, firebase } = req.user;
    const provider = firebase?.sign_in_provider ?? 'unknown';
    const platformHeader = req.get('x-client-platform')?.toLowerCase();
    const platform = allowedPlatforms.has(platformHeader) ? platformHeader : 'unknown';
    const userRecord = await auth.getUser(uid);
    const providers = userRecord.providerData.map(({ providerId }) => providerId);
    const userRef = db.collection('users').doc(uid);
    const loginRef = userRef.collection('loginEvents').doc();

    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(userRef);
      transaction.set(userRef, {
        displayName: name ?? null,
        email: email ?? null,
        emailVerified: emailVerified ?? false,
        phoneNumber: userRecord.phoneNumber ?? null,
        photoURL: picture ?? null,
        providers,
        status: 'active',
        updatedAt: FieldValue.serverTimestamp(),
        lastLoginAt: FieldValue.serverTimestamp(),
        ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp() })
      }, { merge: true });
      transaction.set(loginRef, {
        provider,
        platform,
        signedInAt: FieldValue.serverTimestamp()
      });
    });

    const profile = (await userRef.get()).data();
    res.status(200).json({
      uid,
      profile,
      claims: { admin: req.user.admin === true }
    });
  } catch (error) {
    next(error);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const userRef = db.collection('users').doc(req.user.uid);
    const snapshot = await userRef.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Profile not found; sync your session first' });
    res.json({ uid: req.user.uid, profile: snapshot.data() });
  } catch (error) {
    next(error);
  }
});

router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const allowedFields = new Set(['displayName']);
    const entries = Object.entries(req.body ?? {});
    if (!entries.length || entries.some(([key, value]) => !allowedFields.has(key) || typeof value !== 'string' || value.trim().length > 100)) {
      return res.status(400).json({ error: 'Only displayName (up to 100 characters) can be updated' });
    }

    const userRef = db.collection('users').doc(req.user.uid);
    const updates = Object.fromEntries(entries.map(([key, value]) => [key, value.trim()]));
    updates.updatedAt = FieldValue.serverTimestamp();
    await userRef.set(updates, { merge: true });
    res.json({ uid: req.user.uid, profile: (await userRef.get()).data() });
  } catch (error) {
    next(error);
  }
});

export default router;
