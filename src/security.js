'use strict';
const crypto = require('crypto');

const FORBIDDEN_CARD_KEYS = new Set([
  'pan', 'cardnumber', 'card_number', 'card-number', 'cvv', 'cvc', 'cvv2', 'cvc2',
  'securitycode', 'security_code', 'track1', 'track2', 'trackdata', 'track_data',
  'magstripe', 'magneticstripe', 'rawcard', 'raw_card',
  'pin', 'pinblock', 'pin_block', 'encryptedpin', 'encrypted_pin'
]);

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/\s+/g, '').trim();
}

function findForbiddenCardField(value, path = '$') {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findForbiddenCardField(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CARD_KEYS.has(normalizeKey(key))) return `${path}.${key}`;
    const found = findForbiddenCardField(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function assertNoRawCardData(value) {
  const path = findForbiddenCardField(value);
  if (path) {
    const err = new Error(`Raw card data is not accepted (${path})`);
    err.code = 'RAW_CARD_DATA_FORBIDDEN';
    err.status = 422;
    throw err;
  }
}

function safeEqual(expected, provided) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(provided || ''));
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireApiKey(config) {
  return (req, res, next) => {
    if (!config.apiKey) return res.status(503).json({ error: 'PAYMENT_API_KEY_NOT_CONFIGURED' });
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const provided = req.headers['x-api-key'] || bearer;
    if (!safeEqual(config.apiKey, provided)) return res.status(401).json({ error: 'UNAUTHORIZED' });
    next();
  };
}

function hmacHex(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody || Buffer.alloc(0)).digest('hex');
}

function verifyHmac(secret, rawBody, signature) {
  if (!secret) return false;
  const clean = String(signature || '').replace(/^sha256=/i, '');
  return safeEqual(hmacHex(secret, rawBody), clean);
}

function sanitizeForStorage(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeForStorage);
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CARD_KEYS.has(normalizeKey(key))) out[key] = '[REDACTED]';
    else out[key] = sanitizeForStorage(child);
  }
  return out;
}

function requestHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

module.exports = {
  assertNoRawCardData,
  findForbiddenCardField,
  requireApiKey,
  verifyHmac,
  hmacHex,
  sanitizeForStorage,
  requestHash
};
