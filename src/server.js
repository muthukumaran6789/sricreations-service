import 'dotenv/config';
import app from './app.js';
import { expireStaleRazorpayCheckouts } from './services/payment-gateway.js';

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
  console.log(`Sri Creations API listening on port ${port}`);
});

async function cleanExpiredCheckouts() {
  try {
    await expireStaleRazorpayCheckouts();
  } catch (error) {
    console.error('Failed to clean expired checkouts:', error.message);
  }
}

void cleanExpiredCheckouts();
const checkoutCleanupTimer = setInterval(cleanExpiredCheckouts, 60_000);
checkoutCleanupTimer.unref();

function shutDown(signal) {
  console.log(`${signal} received; closing HTTP server`);
  clearInterval(checkoutCleanupTimer);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutDown('SIGINT'));
process.on('SIGTERM', () => shutDown('SIGTERM'));
