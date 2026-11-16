import { Router } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firestore.js';
import { requireAuth } from '../middleware/require-auth.js';
import { HttpError } from '../utils/http-error.js';
import { pageSize, requiredString, safeDocumentId } from '../utils/validation.js';
import { createPaymentSession, fetchQrPayments } from '../services/payment-gateway.js';

const router = Router();
const allowedAddressFields = new Set([
  'recipientName', 'fullName', 'phoneNumber', 'line1', 'addressLine1', 'line2', 'addressLine2',
  'city', 'state', 'postalCode', 'countryCode', 'country'
]);

function normalizeCountryCode(value) {
  const country = requiredString(value, 'country/countryCode', 100).trim();
  if (/^[A-Za-z]{2}$/.test(country)) return country.toUpperCase();
  const normalized = country.toLowerCase();
  const knownCodes = new Map([
    ['india', 'IN'],
    ['united states', 'US'], ['united states of america', 'US'], ['usa', 'US'],
    ['united kingdom', 'GB'], ['uk', 'GB'],
    ['canada', 'CA'], ['australia', 'AU']
  ]);
  const code = knownCodes.get(normalized);
  if (!code) throw new HttpError(400, 'country must be a 2-letter country code or a supported country name');
  return code;
}

router.get('/categories', async (_req, res, next) => {
  try {
    const snapshot = await db.collection('categories').where('active', '==', true).orderBy('sortOrder').orderBy('name').get();
    res.json({ categories: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (error) { next(error); }
});

router.get('/cart', requireAuth, async (req, res, next) => {
  try {
    const ref = db.collection('users').doc(req.user.uid).collection('carts').doc('current');
    const snapshot = await ref.get();
    res.json({ cart: snapshot.exists ? snapshot.data() : { items: [] } });
  } catch (error) { next(error); }
});

router.put('/cart', requireAuth, async (req, res, next) => {
  try {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length > 50) throw new HttpError(400, 'items must be an array with at most 50 entries');
    const normalized = [];
    const seen = new Set();
    for (const item of items) {
      const productId = safeDocumentId(item?.productId, 'productId');
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) throw new HttpError(400, 'quantity must be an integer between 1 and 99');
      if (seen.has(productId)) throw new HttpError(400, 'Each product can appear only once in the cart');
      seen.add(productId);
      normalized.push({ productId, quantity: item.quantity });
    }
    const userRef = db.collection('users').doc(req.user.uid);
    const cartRef = userRef.collection('carts').doc('current');
    await db.runTransaction(async (transaction) => {
      const userSnapshot = await transaction.get(userRef);
      const now = FieldValue.serverTimestamp();
      if (!userSnapshot.exists) transaction.set(userRef, { status: 'active', createdAt: now, updatedAt: now });
      transaction.set(cartRef, { items: normalized, updatedAt: now });
    });
    res.json({ cart: { items: normalized } });
  } catch (error) { next(error); }
});

router.post('/cart', requireAuth, async (req, res, next) => {
  try {
    const productId = safeDocumentId(req.body?.productId, 'productId');
    const quantity = req.body?.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new HttpError(400, 'quantity must be an integer between 1 and 99');

    const productRef = db.collection('products').doc(productId);
    const userRef = db.collection('users').doc(req.user.uid);
    const cartRef = userRef.collection('carts').doc('current');
    let savedItems;
    await db.runTransaction(async (transaction) => {
      const [productSnapshot, cartSnapshot, userSnapshot] = await Promise.all([
        transaction.get(productRef),
        transaction.get(cartRef),
        transaction.get(userRef)
      ]);
      if (!productSnapshot.exists || productSnapshot.data().active !== true) throw new HttpError(404, 'Product not found');

      const product = productSnapshot.data();
      const items = cartSnapshot.data()?.items ?? [];
      const existingItem = items.find((item) => item.productId === productId);
      const updatedQuantity = (existingItem?.quantity ?? 0) + quantity;
      const available = (product.stockOnHand ?? 0) - (product.stockReserved ?? 0);
      if (updatedQuantity > 99) throw new HttpError(400, 'Cart quantity cannot exceed 99 per product');
      if (updatedQuantity > available) throw new HttpError(409, 'Requested quantity exceeds available stock');

      if (existingItem) existingItem.quantity = updatedQuantity;
      else {
        if (items.length >= 50) throw new HttpError(400, 'Cart cannot contain more than 50 products');
        items.push({ productId, quantity: updatedQuantity });
      }
      savedItems = items;
      if (!userSnapshot.exists) transaction.set(userRef, { status: 'active', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      transaction.set(cartRef, { items, updatedAt: FieldValue.serverTimestamp() });
    });

    res.status(200).json({ cart: { items: savedItems } });
  } catch (error) { next(error); }
});

router.post('/checkout', requireAuth, async (req, res, next) => {
  try {
    const shippingAddress = req.body?.shippingAddress;
    if (!shippingAddress || typeof shippingAddress !== 'object' || Array.isArray(shippingAddress)) throw new HttpError(400, 'shippingAddress is required');
    if (Object.keys(shippingAddress).some((key) => !allowedAddressFields.has(key))) throw new HttpError(400, 'Unsupported shipping address field');
    const address = {
      recipientName: requiredString(shippingAddress.recipientName ?? shippingAddress.fullName, 'fullName', 150),
      phoneNumber: requiredString(shippingAddress.phoneNumber, 'phoneNumber', 32),
      line1: requiredString(shippingAddress.line1 ?? shippingAddress.addressLine1, 'addressLine1', 200),
      line2: (shippingAddress.line2 ?? shippingAddress.addressLine2) == null ? '' : requiredString(shippingAddress.line2 ?? shippingAddress.addressLine2, 'addressLine2', 200),
      city: requiredString(shippingAddress.city, 'city', 100),
      state: requiredString(shippingAddress.state, 'state', 100),
      postalCode: requiredString(shippingAddress.postalCode, 'postalCode', 20),
      countryCode: normalizeCountryCode(shippingAddress.countryCode ?? shippingAddress.country)
    };
    const idempotencyKey = req.get('idempotency-key');
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 100) throw new HttpError(400, 'Idempotency-Key header (8–100 characters) is required');
    const cartSnapshot = await db.collection('users').doc(req.user.uid).collection('carts').doc('current').get();
    const cartItems = cartSnapshot.data()?.items ?? [];
    if (!cartItems.length) throw new HttpError(400, 'Cart is empty');
    const productRefs = cartItems.map(({ productId }) => db.collection('products').doc(productId));
    const snapshots = await Promise.all(productRefs.map((ref) => ref.get()));
    const items = snapshots.map((snapshot, index) => {
      if (!snapshot.exists || snapshot.data().active !== true) throw new HttpError(409, 'A cart item is unavailable');
      const product = snapshot.data();
      const quantity = cartItems[index].quantity;
      if ((product.stockOnHand ?? 0) - (product.stockReserved ?? 0) < quantity) throw new HttpError(409, `Insufficient stock for ${product.name}`);
      const unitPriceMinor = product.priceMinor;
      if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0) throw new HttpError(409, `Invalid price for ${product.name}`);
      return { productId: snapshot.id, sku: product.sku, name: product.name, imageUrl: product.imageUrls?.[0] ?? null, unitPriceMinor, quantity, lineTotalMinor: unitPriceMinor * quantity, currency: product.currency ?? 'INR' };
    });
    const currencies = new Set(items.map((item) => item.currency));
    if (currencies.size !== 1) throw new HttpError(409, 'Cart products must use the same currency');
    const subtotalMinor = items.reduce((sum, item) => sum + item.lineTotalMinor, 0);
    if (!Number.isSafeInteger(subtotalMinor)) throw new HttpError(400, 'Cart total is too large');
    const userRef = db.collection('users').doc(req.user.uid);
    const cartRef = userRef.collection('carts').doc('current');
    const requestId = createHash('sha256').update(`${req.user.uid}:${idempotencyKey}`).digest('hex');
    const requestRef = db.collection('checkoutRequests').doc(requestId);
    const orderRef = db.collection('orders').doc();
    const paymentRef = db.collection('payments').doc();

    const reservation = await db.runTransaction(async (transaction) => {
      const existingRequest = await transaction.get(requestRef);
      if (existingRequest.exists) return { existing: existingRequest.data() };
      const liveCart = await transaction.get(cartRef);
      const liveItems = liveCart.data()?.items ?? [];
      if (JSON.stringify(liveItems) !== JSON.stringify(cartItems)) throw new HttpError(409, 'Cart changed during checkout; retry with a new idempotency key');
      const liveProducts = await Promise.all(productRefs.map((ref) => transaction.get(ref)));
      const now = FieldValue.serverTimestamp();
      liveProducts.forEach((productSnapshot, index) => {
        if (!productSnapshot.exists || productSnapshot.data().active !== true) throw new HttpError(409, 'A cart item is unavailable');
        const product = productSnapshot.data();
        if ((product.stockOnHand ?? 0) - (product.stockReserved ?? 0) < cartItems[index].quantity) throw new HttpError(409, `Insufficient stock for ${product.name}`);
      });
      liveProducts.forEach((productSnapshot, index) => {
        transaction.update(productSnapshot.ref, {
          stockReserved: (productSnapshot.data().stockReserved ?? 0) + cartItems[index].quantity,
          updatedAt: now
        });
      });
      transaction.set(orderRef, {
        userId: req.user.uid,
        status: 'pending_payment',
        paymentStatus: 'pending',
        items,
        amounts: { subtotalMinor, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: subtotalMinor, currency: items[0].currency },
        shippingAddress: address,
        trackingNumber: null,
        createdAt: now,
        updatedAt: now
      });
      transaction.set(paymentRef, {
        orderId: orderRef.id,
        userId: req.user.uid,
        provider: 'razorpay',
        checkoutRequestId: requestId,
        status: 'creating',
        amountMinor: subtotalMinor,
        currency: items[0].currency,
        createdAt: now,
        updatedAt: now
      });
      transaction.set(requestRef, { userId: req.user.uid, orderId: orderRef.id, paymentId: paymentRef.id, status: 'creating', createdAt: now });
      return { existing: null };
    });

    if (reservation.existing) {
      if (reservation.existing.status !== 'ready') throw new HttpError(409, 'This checkout attempt is already being processed or failed; use a new Idempotency-Key');
      const priorPayment = await db.collection('payments').doc(reservation.existing.paymentId).get();
      const priorOrder = await db.collection('orders').doc(reservation.existing.orderId).get();
      return res.status(200).json({ orderId: priorOrder.id, payment: priorPayment.data() });
    }

    try {
      const qr = await createPaymentSession({ orderId: orderRef.id, amountMinor: subtotalMinor, currency: items[0].currency, userId: req.user.uid });
      const qrRef = db.collection('razorpayQrCodes').doc(qr.id);
      await db.runTransaction(async (transaction) => {
        transaction.update(paymentRef, { status: 'pending', razorpayQrCodeId: qr.id, qrImageUrl: qr.imageUrl, qrStatus: qr.status, expiresAt: new Date(qr.closeBy * 1000), updatedAt: FieldValue.serverTimestamp() });
        transaction.set(qrRef, { orderId: orderRef.id, paymentId: paymentRef.id, userId: req.user.uid, amountMinor: subtotalMinor, currency: items[0].currency, createdAt: FieldValue.serverTimestamp() });
        transaction.update(requestRef, { status: 'ready', updatedAt: FieldValue.serverTimestamp() });
      });
      res.status(201).json({
        orderId: orderRef.id,
        status: 'pending_payment',
        amountMinor: subtotalMinor,
        currency: items[0].currency,
        payment: { id: paymentRef.id, provider: 'razorpay', status: 'pending', qrCodeId: qr.id, qrImageUrl: qr.imageUrl, expiresAt: new Date(qr.closeBy * 1000).toISOString() }
      });
    } catch (error) {
      await db.runTransaction(async (transaction) => {
        const products = await Promise.all(productRefs.map((ref) => transaction.get(ref)));
        for (let index = 0; index < products.length; index += 1) {
          const product = products[index];
          if (product.exists) transaction.update(product.ref, { stockReserved: Math.max(0, (product.data().stockReserved ?? 0) - cartItems[index].quantity), updatedAt: FieldValue.serverTimestamp() });
        }
        transaction.update(orderRef, { status: 'cancelled', paymentStatus: 'failed', updatedAt: FieldValue.serverTimestamp() });
        transaction.update(paymentRef, { status: 'failed', updatedAt: FieldValue.serverTimestamp() });
        transaction.update(requestRef, { status: 'failed', updatedAt: FieldValue.serverTimestamp() });
      });
      throw error;
    }
  } catch (error) { next(error); }
});

router.get('/orders', requireAuth, async (req, res, next) => {
  try {
    const limit = pageSize(req.query.limit);
    let query = db.collection('orders').where('userId', '==', req.user.uid).orderBy('createdAt', 'desc');
    if (req.query.cursor) {
      const cursor = await db.collection('orders').doc(safeDocumentId(String(req.query.cursor), 'cursor')).get();
      if (!cursor.exists || cursor.data().userId !== req.user.uid) throw new HttpError(400, 'Invalid cursor');
      query = query.startAfter(cursor);
    }
    const snapshot = await query.limit(limit + 1).get();
    const hasMore = snapshot.docs.length > limit;
    const docs = snapshot.docs.slice(0, limit);
    res.json({ orders: docs.map((doc) => ({ id: doc.id, ...doc.data() })), nextCursor: hasMore ? docs.at(-1).id : null });
  } catch (error) { next(error); }
});

router.post('/payments/razorpay/webhook', async (req, res, next) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret || secret.startsWith('replace-with-')) throw new HttpError(503, 'Razorpay webhook secret is not configured');
    const signature = req.get('x-razorpay-signature');
    if (!signature || !Buffer.isBuffer(req.rawBody)) throw new HttpError(400, 'Missing webhook signature or raw request body');
    const expected = createHmac('sha256', secret).update(req.rawBody).digest();
    let supplied;
    try { supplied = Buffer.from(signature, 'hex'); } catch { supplied = Buffer.alloc(0); }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpError(401, 'Invalid Razorpay webhook signature');

    if (req.body?.event !== 'qr_code.credited') return res.status(200).json({ received: true });
    const qrCodeId = req.body?.payload?.qr_code?.entity?.id;
    if (!qrCodeId) throw new HttpError(400, 'QR code ID is missing from webhook payload');
    const eventId = req.get('x-razorpay-event-id') ?? createHash('sha256').update(req.rawBody).digest('hex');
    const qrSnapshot = await db.collection('razorpayQrCodes').doc(safeDocumentId(qrCodeId, 'qrCodeId')).get();
    if (!qrSnapshot.exists) return res.status(200).json({ received: true, ignored: true });
    const mapping = qrSnapshot.data();
    const paymentList = await fetchQrPayments(qrCodeId);
    const captured = (paymentList.items ?? []).find((item) => item.status === 'captured' && item.amount === mapping.amountMinor && item.currency === mapping.currency);
    if (!captured) throw new HttpError(503, 'Captured payment is not visible yet; Razorpay may retry this webhook');

    const paymentRef = db.collection('payments').doc(mapping.paymentId);
    const orderRef = db.collection('orders').doc(mapping.orderId);
    const cartRef = db.collection('users').doc(mapping.userId).collection('carts').doc('current');
    const eventRef = db.collection('razorpayWebhookEvents').doc(safeDocumentId(eventId, 'eventId'));
    await db.runTransaction(async (transaction) => {
      const [eventSnapshot, paymentSnapshot, orderSnapshot] = await Promise.all([
        transaction.get(eventRef), transaction.get(paymentRef), transaction.get(orderRef)
      ]);
      if (eventSnapshot.exists || paymentSnapshot.data()?.status === 'succeeded') return;
      if (!paymentSnapshot.exists || !orderSnapshot.exists) throw new HttpError(404, 'Payment or order record not found');
      const order = orderSnapshot.data();
      const productRefs = order.items.map((item) => db.collection('products').doc(item.productId));
      const products = await Promise.all(productRefs.map((ref) => transaction.get(ref)));
      const checkoutRequestRef = db.collection('checkoutRequests').doc(paymentSnapshot.data().checkoutRequestId);
      await transaction.get(checkoutRequestRef);
      transaction.set(eventRef, { event: req.body.event, qrCodeId, paymentId: captured.id, receivedAt: FieldValue.serverTimestamp() });
      products.forEach((product, index) => {
        if (!product.exists) throw new HttpError(409, 'Ordered product record no longer exists');
        const quantity = order.items[index].quantity;
        transaction.update(productRefs[index], {
          stockReserved: Math.max(0, (product.data().stockReserved ?? 0) - quantity),
          stockOnHand: Math.max(0, (product.data().stockOnHand ?? 0) - quantity),
          updatedAt: FieldValue.serverTimestamp()
        });
      });
      transaction.update(paymentRef, { status: 'succeeded', razorpayPaymentId: captured.id, paidAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      transaction.update(orderRef, { status: 'confirmed', paymentStatus: 'succeeded', updatedAt: FieldValue.serverTimestamp() });
      transaction.update(checkoutRequestRef, { status: 'paid', updatedAt: FieldValue.serverTimestamp() });
      transaction.set(cartRef, { items: [], updatedAt: FieldValue.serverTimestamp() });
    });
    res.status(200).json({ received: true });
  } catch (error) { next(error); }
});

router.get('/orders/:id', requireAuth, async (req, res, next) => {
  try {
    const id = safeDocumentId(req.params.id);
    const snapshot = await db.collection('orders').doc(id).get();
    if (!snapshot.exists || snapshot.data().userId !== req.user.uid) throw new HttpError(404, 'Order not found');
    res.json({ id, ...snapshot.data() });
  } catch (error) { next(error); }
});

export default router;
