import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firestore.js';
import { HttpError } from '../utils/http-error.js';

function credentials() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret || keySecret.startsWith('replace-with-')) {
    throw new HttpError(503, 'Razorpay credentials are not configured');
  }
  return { keyId, keySecret };
}

async function razorpayRequest(path, { method = 'GET', body } = {}) {
  const { keyId, keySecret } = credentials();
  let response;
  try {
    response = await fetch(`https://api.razorpay.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new HttpError(502, 'Could not reach Razorpay');
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = result.error?.description ?? 'Razorpay rejected the request';
    throw new HttpError(response.status >= 400 && response.status < 500 ? 502 : 503, message);
  }
  return result;
}

export async function createPaymentSession({ orderId, amountMinor, currency, userId }) {
  if (currency !== 'INR') throw new HttpError(400, 'Razorpay QR checkout currently supports INR orders only');
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 100) throw new HttpError(400, 'Razorpay QR payments must be at least ₹1');
  const customerId = process.env.RAZORPAY_CUSTOMER_ID;
  if (!customerId) throw new HttpError(503, 'RAZORPAY_CUSTOMER_ID is not configured');

  const closeBy = Math.floor(Date.now() / 1000) + 10 * 60;
  const qrCode = await razorpayRequest('/payments/qr_codes', {
    method: 'POST',
    body: {
      type: 'upi_qr',
      name: `Sri Creations ${orderId}`.slice(0, 100),
      usage: 'single_use',
      fixed_amount: true,
      payment_amount: amountMinor,
      description: `Order ${orderId}`,
      customer_id: customerId,
      close_by: closeBy,
      notes: { order_id: orderId, user_id: userId }
    }
  });

  return {
    id: qrCode.id,
    imageUrl: qrCode.image_url,
    status: qrCode.status,
    amountMinor: qrCode.payment_amount,
    currency,
    closeBy: qrCode.close_by
  };
}

export async function fetchQrPayments(qrCodeId) {
  return razorpayRequest(`/payments/qr_codes/${encodeURIComponent(qrCodeId)}/payments?count=100`);
}

export async function expireStaleRazorpayCheckouts() {
  const expired = await db.collection('payments')
    .where('provider', '==', 'razorpay')
    .where('status', '==', 'pending')
    .where('expiresAt', '<=', new Date())
    .limit(50)
    .get();

  for (const paymentDoc of expired.docs) {
    const paymentRef = paymentDoc.ref;
    const paymentData = paymentDoc.data();
    const orderRef = db.collection('orders').doc(paymentData.orderId);
    const orderSnapshot = await orderRef.get();
    if (!orderSnapshot.exists) continue;
    const order = orderSnapshot.data();
    const productRefs = order.items.map((item) => db.collection('products').doc(item.productId));
    const checkoutRequestRef = db.collection('checkoutRequests').doc(paymentData.checkoutRequestId);

    await db.runTransaction(async (transaction) => {
      const [currentPayment, currentOrder, ...productsAndRequest] = await Promise.all([
        transaction.get(paymentRef),
        transaction.get(orderRef),
        ...productRefs.map((ref) => transaction.get(ref)),
        transaction.get(checkoutRequestRef)
      ]);
      if (!currentPayment.exists || currentPayment.data().status !== 'pending' || !currentOrder.exists) return;
      const productSnapshots = productsAndRequest.slice(0, productRefs.length);
      const requestSnapshot = productsAndRequest.at(-1);
      productSnapshots.forEach((product, index) => {
        if (!product.exists) return;
        const quantity = currentOrder.data().items[index].quantity;
        transaction.update(productRefs[index], {
          stockReserved: Math.max(0, (product.data().stockReserved ?? 0) - quantity),
          updatedAt: FieldValue.serverTimestamp()
        });
      });
      transaction.update(paymentRef, { status: 'expired', updatedAt: FieldValue.serverTimestamp() });
      transaction.update(orderRef, { status: 'cancelled', paymentStatus: 'expired', updatedAt: FieldValue.serverTimestamp() });
      if (requestSnapshot.exists) transaction.update(checkoutRequestRef, { status: 'expired', updatedAt: FieldValue.serverTimestamp() });
    });
  }
}
