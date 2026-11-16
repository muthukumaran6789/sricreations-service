import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firestore.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { HttpError } from '../utils/http-error.js';
import { pageSize, requiredString, safeDocumentId, slugify } from '../utils/validation.js';

const router = Router();
router.use(requireAuth, requireAdmin);

function parseCategory(body, partial = false) {
  const allowed = new Set(['name', 'slug', 'description', 'imageUrl', 'active', 'sortOrder']);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new HttpError(400, 'Unsupported category field');
  const result = {};
  if (!partial || 'name' in body) result.name = requiredString(body.name, 'name', 120);
  if (!partial || 'slug' in body || 'name' in body) result.slug = slugify(requiredString(body.slug ?? body.name, 'slug', 120));
  if (!partial || 'description' in body) result.description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!partial || 'imageUrl' in body) result.imageUrl = body.imageUrl == null ? null : requiredString(body.imageUrl, 'imageUrl', 2048);
  if (!partial || 'active' in body) result.active = body.active ?? true;
  if (!partial || 'sortOrder' in body) result.sortOrder = body.sortOrder ?? 0;
  if (typeof result.active !== 'boolean' || !Number.isInteger(result.sortOrder)) throw new HttpError(400, 'active must be boolean and sortOrder must be an integer');
  return result;
}

async function validateCategory(categoryId) {
  const snapshot = await db.collection('categories').doc(categoryId).get();
  if (!snapshot.exists || snapshot.data().active !== true) throw new HttpError(400, 'categoryId must refer to an active category');
}

function parseProduct(body, partial = false) {
  const allowed = new Set(['name', 'slug', 'description', 'categoryId', 'sku', 'imageUrls', 'priceMinor', 'currency', 'stockOnHand', 'active']);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new HttpError(400, 'Unsupported product field');
  const result = {};
  if (!partial || 'name' in body) result.name = requiredString(body.name, 'name', 200);
  if (!partial || 'slug' in body || 'name' in body) result.slug = slugify(requiredString(body.slug ?? body.name, 'slug', 200));
  if (!partial || 'description' in body) result.description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!partial || 'categoryId' in body) result.categoryId = safeDocumentId(requiredString(body.categoryId, 'categoryId', 150), 'categoryId');
  if (!partial || 'sku' in body) result.sku = requiredString(body.sku, 'sku', 100);
  if (!partial || 'imageUrls' in body) {
    result.imageUrls = body.imageUrls ?? [];
    if (!Array.isArray(result.imageUrls) || result.imageUrls.some((url) => typeof url !== 'string')) throw new HttpError(400, 'imageUrls must be an array of URLs');
  }
  if (!partial || 'priceMinor' in body) {
    result.priceMinor = body.priceMinor;
    if (!Number.isSafeInteger(result.priceMinor) || result.priceMinor < 0) throw new HttpError(400, 'priceMinor must be a non-negative integer');
  }
  if (!partial || 'currency' in body) {
    result.currency = requiredString(body.currency ?? 'INR', 'currency', 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(result.currency)) throw new HttpError(400, 'currency must be a 3-letter ISO code');
  }
  if (!partial || 'stockOnHand' in body) {
    result.stockOnHand = body.stockOnHand;
    if (!Number.isSafeInteger(result.stockOnHand) || result.stockOnHand < 0) throw new HttpError(400, 'stockOnHand must be a non-negative integer');
  }
  if (!partial || 'active' in body) result.active = body.active ?? true;
  if (result.active !== undefined && typeof result.active !== 'boolean') throw new HttpError(400, 'active must be boolean');
  return result;
}

async function fetchPage(collection, query, req, limit) {
  let cursor = null;
  if (req.query.cursor) {
    cursor = await collection.doc(safeDocumentId(String(req.query.cursor), 'cursor')).get();
    if (!cursor.exists) throw new HttpError(400, 'Invalid cursor');
    query = query.startAfter(cursor);
  }
  const snapshot = await query.limit(limit + 1).get();
  const hasMore = snapshot.docs.length > limit;
  const docs = snapshot.docs.slice(0, limit);
  return {
    items: docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    nextCursor: hasMore ? docs.at(-1).id : null
  };
}

router.get('/categories', async (req, res, next) => {
  try {
    const limit = pageSize(req.query.limit);
    const query = db.collection('categories').orderBy('sortOrder').orderBy('name');
    res.json(await fetchPage(db.collection('categories'), query, req, limit));
  } catch (error) { next(error); }
});

router.post('/categories', async (req, res, next) => {
  try {
    const data = parseCategory(req.body);
    const ref = db.collection('categories').doc();
    await ref.set({ ...data, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    res.status(201).json({ id: ref.id, ...data });
  } catch (error) { next(error); }
});

router.patch('/categories/:id', async (req, res, next) => {
  try {
    const ref = db.collection('categories').doc(safeDocumentId(req.params.id));
    if (!(await ref.get()).exists) throw new HttpError(404, 'Category not found');
    const data = parseCategory(req.body, true);
    if (!Object.keys(data).length) throw new HttpError(400, 'No category fields to update');
    await ref.update({ ...data, updatedAt: FieldValue.serverTimestamp() });
    res.json({ id: ref.id, ...(await ref.get()).data() });
  } catch (error) { next(error); }
});

router.delete('/categories/:id', async (req, res, next) => {
  try {
    const ref = db.collection('categories').doc(safeDocumentId(req.params.id));
    if (!(await ref.get()).exists) throw new HttpError(404, 'Category not found');
    await ref.update({ active: false, updatedAt: FieldValue.serverTimestamp() });
    res.status(204).end();
  } catch (error) { next(error); }
});

router.get('/products', async (req, res, next) => {
  try {
    const limit = pageSize(req.query.limit);
    let query = db.collection('products').orderBy('createdAt', 'desc');
    if (req.query.categoryId) query = db.collection('products').where('categoryId', '==', String(req.query.categoryId)).orderBy('createdAt', 'desc');
    if (req.query.active !== undefined) {
      if (!['true', 'false'].includes(String(req.query.active))) throw new HttpError(400, 'active must be true or false');
      query = query.where('active', '==', String(req.query.active) === 'true');
    }
    res.json(await fetchPage(db.collection('products'), query, req, limit));
  } catch (error) { next(error); }
});

router.post('/products', async (req, res, next) => {
  try {
    const data = parseProduct(req.body);
    await validateCategory(data.categoryId);
    const ref = db.collection('products').doc();
    const now = FieldValue.serverTimestamp();
    await ref.set({ ...data, stockReserved: 0, createdAt: now, updatedAt: now });
    res.status(201).json({ id: ref.id, ...data, stockReserved: 0 });
  } catch (error) { next(error); }
});

router.patch('/products/:id', async (req, res, next) => {
  try {
    if (Object.hasOwn(req.body ?? {}, 'stockOnHand')) throw new HttpError(400, 'Use the stock-adjustments endpoint to change stock');
    const ref = db.collection('products').doc(safeDocumentId(req.params.id));
    const existing = await ref.get();
    if (!existing.exists) throw new HttpError(404, 'Product not found');
    const data = parseProduct(req.body, true);
    if (!Object.keys(data).length) throw new HttpError(400, 'No product fields to update');
    if (data.categoryId) await validateCategory(data.categoryId);
    if (data.stockOnHand !== undefined && data.stockOnHand < (existing.data().stockReserved ?? 0)) throw new HttpError(409, 'stockOnHand cannot be lower than stockReserved');
    await ref.update({ ...data, updatedAt: FieldValue.serverTimestamp() });
    res.json({ id: ref.id, ...(await ref.get()).data() });
  } catch (error) { next(error); }
});

router.delete('/products/:id', async (req, res, next) => {
  try {
    const ref = db.collection('products').doc(safeDocumentId(req.params.id));
    if (!(await ref.get()).exists) throw new HttpError(404, 'Product not found');
    await ref.update({ active: false, updatedAt: FieldValue.serverTimestamp() });
    res.status(204).end();
  } catch (error) { next(error); }
});

router.post('/products/:id/stock-adjustments', async (req, res, next) => {
  try {
    const productId = safeDocumentId(req.params.id);
    const delta = req.body?.delta;
    const reason = requiredString(req.body?.reason, 'reason', 300);
    if (!Number.isSafeInteger(delta) || delta === 0) throw new HttpError(400, 'delta must be a non-zero integer');
    const productRef = db.collection('products').doc(productId);
    const movementRef = db.collection('inventoryMovements').doc();
    await db.runTransaction(async (transaction) => {
      const product = await transaction.get(productRef);
      if (!product.exists) throw new HttpError(404, 'Product not found');
      const current = product.data();
      const updated = (current.stockOnHand ?? 0) + delta;
      if (updated < (current.stockReserved ?? 0)) throw new HttpError(409, 'Adjustment would reduce stock below reserved quantity');
      transaction.update(productRef, { stockOnHand: updated, updatedAt: FieldValue.serverTimestamp() });
      transaction.set(movementRef, { productId, delta, reason, createdBy: req.user.uid, createdAt: FieldValue.serverTimestamp() });
    });
    res.status(201).json({ id: movementRef.id, productId, delta, reason });
  } catch (error) { next(error); }
});

router.get('/orders', async (req, res, next) => {
  try {
    const limit = pageSize(req.query.limit);
    let query = db.collection('orders').orderBy('createdAt', 'desc');
    if (req.query.status) query = db.collection('orders').where('status', '==', String(req.query.status)).orderBy('createdAt', 'desc');
    res.json(await fetchPage(db.collection('orders'), query, req, limit));
  } catch (error) { next(error); }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const id = safeDocumentId(req.params.id);
    const snapshot = await db.collection('orders').doc(id).get();
    if (!snapshot.exists) throw new HttpError(404, 'Order not found');
    res.json({ id, ...snapshot.data() });
  } catch (error) { next(error); }
});

router.patch('/orders/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    if (Object.keys(body).some((key) => !['status', 'trackingNumber'].includes(key))) throw new HttpError(400, 'Only status and trackingNumber can be updated');
    if (!Object.keys(body).length) throw new HttpError(400, 'Provide status or trackingNumber');
    const ref = db.collection('orders').doc(safeDocumentId(req.params.id));
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new HttpError(404, 'Order not found');
    const data = snapshot.data();
    const updates = {};
    if (body.status !== undefined) {
      const allowed = {
        pending_payment: ['confirmed', 'cancelled'], confirmed: ['processing', 'cancelled'],
        processing: ['shipped', 'cancelled'], shipped: ['delivered'], delivered: [], cancelled: []
      };
      if (!allowed[data.status]?.includes(body.status)) throw new HttpError(409, `Cannot change order status from ${data.status} to ${body.status}`);
      if (body.status === 'confirmed' && data.paymentStatus !== 'succeeded') throw new HttpError(409, 'Only successfully paid orders can be confirmed');
      if (body.status === 'shipped' && body.trackingNumber === undefined && !data.trackingNumber) throw new HttpError(400, 'trackingNumber is required before shipping');
      updates.status = body.status;
    }
    if (body.trackingNumber !== undefined) updates.trackingNumber = body.trackingNumber === null ? null : requiredString(body.trackingNumber, 'trackingNumber', 200);
    updates.updatedAt = FieldValue.serverTimestamp();
    await ref.update(updates);
    res.json({ id: ref.id, ...(await ref.get()).data() });
  } catch (error) { next(error); }
});

export default router;
