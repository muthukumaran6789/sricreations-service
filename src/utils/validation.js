import { HttpError } from './http-error.js';

export function requireObject(value, message = 'Request body must be a JSON object') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, message);
  return value;
}

export function requiredString(value, field, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new HttpError(400, `${field} is required and must be at most ${maxLength} characters`);
  }
  return value.trim();
}

export function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function pageSize(value, fallback = 25, max = 100) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new HttpError(400, 'limit must be a positive integer');
  return Math.min(parsed, max);
}

export function safeDocumentId(value, field = 'id') {
  if (typeof value !== 'string' || !value || value.includes('/')) throw new HttpError(400, `Invalid ${field}`);
  return value;
}
