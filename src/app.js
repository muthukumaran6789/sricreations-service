import express from 'express';
import cors from 'cors';
import { readFileSync } from 'node:fs';
import swaggerUi from 'swagger-ui-express';
import productsRouter from './routes/products.js';
import authRouter from './routes/auth.js';
import adminRouter from './routes/admin.js';
import storeRouter from './routes/store.js';

const app = express();
const openapiPath = new URL('../openapi.json', import.meta.url);

function loadOpenApiSpec() {
  return JSON.parse(readFileSync(openapiPath, 'utf8'));
}

app.disable('x-powered-by');
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Client-Platform', 'Idempotency-Key', 'X-Razorpay-Signature', 'X-Razorpay-Event-Id']
}));
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); }
}));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/openapi.json', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(loadOpenApiSpec());
});
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(null, {
  explorer: true,
  swaggerOptions: { url: '/openapi.json' }
}));

app.use('/api/products', productsRouter);
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api', storeRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  if ((err.status ?? 500) >= 500) console.error(err);
  res.status(err.status ?? 500).json({ error: err.status ? err.message : 'Internal server error' });
});

export default app;
