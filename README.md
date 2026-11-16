# Sri Creations Service

Express API starter for the Sri Creations gift and fancy items store, using Google Firestore.

## Requirements

- Node.js 20 or newer
- A Google Cloud/Firebase project with Firestore enabled

## Run locally

1. Copy `.env.example` to `.env` and set `GOOGLE_CLOUD_PROJECT`.
2. Authenticate with Google Application Default Credentials (for example, run `gcloud auth application-default login`) or set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account key file path.
3. Install dependencies with `npm install`.
4. Start the API with `npm run dev` (or `npm start`).

For local Firestore Emulator use, set `FIRESTORE_EMULATOR_HOST` in `.env` and start the emulator separately.

CORS currently allows requests from any origin. Requests using cookies or other browser credentials are not enabled; API authentication uses Firebase bearer tokens.

## Endpoints

- `GET /health` — process health check
- `GET /api-docs` — interactive Swagger UI
- `GET /openapi.json` — OpenAPI 3.1 specification
- `GET /api/categories` — active catalog categories
- `GET /api/products?categoryId=&limit=&cursor=` — active products with cursor pagination
- `POST /api/auth/session` — verifies the Firebase ID token, synchronizes `users/{uid}`, and records a login event
- `GET /api/auth/me` — returns the signed-in user's profile
- `PATCH /api/auth/me` — updates the signed-in user's display name
- `GET/PUT /api/cart` — get or replace the signed-in user's cart
- `POST /api/cart` — add a product quantity to the signed-in user's cart, with active-product and available-stock checks
- `POST /api/checkout` — validates cart, stock, prices, and address; creates a Razorpay dynamic QR and pending order
- `POST /api/payments/razorpay/webhook` — verifies Razorpay signatures and confirms captured QR payments
- `GET /api/orders` and `GET /api/orders/:id` — the signed-in user's own orders
- `/api/admin/categories` — admin category list/create; `PATCH` and `DELETE /:id` update/archive
- `/api/admin/products` — admin product list/create; `PATCH` and `DELETE /:id` update/archive
- `POST /api/admin/products/:id/stock-adjustments` — transactional stock adjustment and audit record
- `/api/admin/orders` — admin order list/detail and fulfilment update

All `/api/admin/**` endpoints require a verified Firebase ID token whose custom claims include `admin: true`. `DELETE` on products/categories archives them by setting `active: false`; historical order snapshots are preserved. Product prices are stored as integer minor units (for example, INR ₹499.00 is `49900`).

## Firestore collections

- `categories/{categoryId}` — name, slug, description, image URL, active flag, and sort order.
- `products/{productId}` — category reference, SKU, image URLs, integer `priceMinor`, currency, `stockOnHand`, `stockReserved`, and active flag.
- `users/{uid}/carts/current` — product IDs and quantities only; the server resolves current prices during checkout.
- `orders/{orderId}` — user ID, order/payment statuses, item and shipping snapshots, amounts, tracking number, and timestamps.
- `payments/{paymentId}` — gateway payment references/status, amount, currency, and order/user IDs. No card credentials belong in Firestore.
- `inventoryMovements/{movementId}` — stock delta, reason, product ID, admin UID, and timestamp.

The checked-in [firestore.indexes.json](./firestore.indexes.json) contains the composite indexes used by catalog and order list queries. Configure Firebase CLI to deploy it with the Firestore indexes setting for your project.

Checkout reads server-side prices, reserves stock transactionally, creates a pending order/payment, and asks Razorpay for a fixed-amount single-use UPI QR that expires in ten minutes. It requires an `Idempotency-Key` header. A background cleanup releases reservations for expired payment attempts once per minute. Payment confirmation is based on the signed `qr_code.credited` webhook and the captured payment fetched from Razorpay, not a client callback.

Configure `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_CUSTOMER_ID`, and `RAZORPAY_WEBHOOK_SECRET` in `.env`. Replace the provided key secret placeholder before calling checkout. The key ID and customer ID provided for this project are in the ignored local `.env`; `.env.example` contains blank values. Enable QR Codes on the Razorpay account and configure the public webhook URL as `/api/payments/razorpay/webhook`, subscribing to `qr_code.credited` with the same webhook secret. Razorpay documents QR Codes as an account-activated feature and single-use QR expiry between two minutes and two hours. [Create QR Code](https://razorpay.com/docs/api/qr-codes/create) · [Fetch payments for a QR Code](https://razorpay.com/docs/api/qr-codes/gst/fetch-payments/)

## Authentication flow

The website and app should use the Firebase client SDK to sign in with Google or phone OTP. After sign-in, send the Firebase ID token to the API:

```http
POST /api/auth/session
Authorization: Bearer <firebase-id-token>
X-Client-Platform: web
```

Use `X-Client-Platform: app` in the mobile app. This header is self-reported analytics metadata, not an authentication mechanism. The API verifies the token and uses its Firebase UID as the Firestore document ID. Login events are stored at `users/{uid}/loginEvents/{eventId}` with the provider, platform, and server timestamp. Linking Google and phone credentials in the Firebase client SDK keeps both sign-in methods on the same UID.

For subsequent API calls, send the same bearer-token header. Refresh the ID token through the Firebase client SDK when needed. Sign-out should be performed with the client SDK; the API does not revoke refresh tokens on ordinary sign-out, since that would sign the user out on other devices too.

The Firebase Admin SDK bypasses Firestore Security Rules. Keep client access to `users` and `loginEvents` restricted if the clients also connect directly to Firestore.

## Grant admin access

Run the admin script with a Firebase Authentication UID. It uses the same Firebase Admin credentials configured for the service and preserves the user's other custom claims:

```sh
npm run set-admin -- <firebase-auth-uid>
```

The user must refresh their Firebase ID token (for example, sign out and back in, or force-refresh the token) before the new claim is available. `POST /api/auth/session` returns `claims.admin` from the verified ID token so the UI can display admin features. The API must still enforce admin authorization on every admin-only operation; hiding UI controls is not access control.
