import { auth } from '../config/firestore.js';

export async function requireAuth(req, res, next) {
  const authorization = req.get('authorization');
  const match = authorization?.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({ error: 'A Firebase ID token is required' });
  }

  try {
    req.user = await auth.verifyIdToken(match[1]);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired Firebase ID token' });
  }
}
