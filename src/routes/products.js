import { Router } from 'express';
import { db } from '../config/firestore.js';
import { HttpError } from '../utils/http-error.js';
import { pageSize, safeDocumentId } from '../utils/validation.js';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const limit = pageSize(_req.query.limit, 50, 100);
    let query = db.collection('products').where('active', '==', true).orderBy('createdAt', 'desc');
    if (_req.query.categoryId) query = query.where('categoryId', '==', safeDocumentId(String(_req.query.categoryId), 'categoryId'));
    if (_req.query.cursor) {
      const cursor = await db.collection('products').doc(safeDocumentId(String(_req.query.cursor), 'cursor')).get();
      if (!cursor.exists) throw new HttpError(400, 'Invalid cursor');
      query = query.startAfter(cursor);
    }
    const snapshot = await query.limit(limit + 1).get();
    const hasMore = snapshot.docs.length > limit;
    const docs = snapshot.docs.slice(0, limit);
    const products = docs.map((document) => ({ id: document.id, ...document.data() }));
    res.json({ products, nextCursor: hasMore ? docs.at(-1).id : null });
  } catch (error) {
    next(error);
  }
});

export default router;
