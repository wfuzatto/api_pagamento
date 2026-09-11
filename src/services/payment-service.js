'use strict';
const crypto = require('crypto');
const { assertNoRawCardData, sanitizeForStorage, requestHash } = require('../security');

const METHODS = new Set(['cash', 'pix', 'debit_card', 'credit_card']);
const PROVIDER_STATUSES = new Set(['PENDING','ACTION_REQUIRED','APPROVED','DECLINED','CANCELED','EXPIRED','ERROR']);
const WEBHOOK_STATUSES = new Set(['PENDING','ACTION_REQUIRED','APPROVED','DECLINED','CANCELED','EXPIRED','ERROR','REFUNDED','PARTIALLY_REFUNDED']);

function normalizeMethod(input) {
  const key = String(input || '').trim().toUpperCase();
  const map = { CASH:'cash', DINHEIRO:'cash', PIX:'pix', DEBIT:'debit_card', DEBIT_CARD:'debit_card', DEBITO:'debit_card', CREDIT:'credit_card', CREDIT_CARD:'credit_card', CREDITO:'credit_card' };
  const method = map[key] || String(input || '').toLowerCase();
  if (!METHODS.has(method)) { const err = new Error('Invalid payment method'); err.code='INVALID_PAYMENT_METHOD'; err.status=422; throw err; }
  return method;
}
function normalizeStatus(status, allowed = PROVIDER_STATUSES) {
  const value = String(status || '').toUpperCase();
  if (!allowed.has(value)) { const err = new Error(`Invalid provider status: ${value}`); err.code='INVALID_PROVIDER_STATUS'; err.status=502; throw err; }
  return value;
}
function parseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}
function serializePayment(row) {
  if (!row) return null;
  return {
    id: row.id, source_module: row.source_module, source_reference: row.source_reference, merchant_id: row.merchant_id,
    method: row.method, provider: row.provider, amount_cents: Number(row.amount_cents), currency: row.currency,
    installments: Number(row.installments), status: row.status, external_id: row.external_id,
    next_action: parseJson(row.next_action_json), metadata: parseJson(row.metadata_json),
    approved_at: row.approved_at, canceled_at: row.canceled_at, created_at: row.created_at, updated_at: row.updated_at
  };
}

function createPaymentService({ db, config, providers, outbox }) {
  async function getById(id) {
    const rows = await db.query('SELECT * FROM payment_intents WHERE id=? LIMIT 1', [id]);
    return rows[0] || null;
  }
  async function getByExternal(provider, externalId) {
    const rows = await db.query('SELECT * FROM payment_intents WHERE provider=? AND external_id=? LIMIT 1', [provider, externalId]);
    return rows[0] || null;
  }
  async function listEvents(id) {
    return db.query('SELECT id,provider,provider_event_id,event_type,from_status,to_status,payload_json,created_at FROM payment_events WHERE payment_id=? ORDER BY id ASC', [id]);
  }
  async function recordStatusChange(paymentId, fromStatus, toStatus, eventType, provider, payload = {}, providerEventId = null) {
    const safePayload = sanitizeForStorage(payload);
    await db.transaction(async conn => {
      const updates = ['status=?', 'provider_data_json=?'];
      const params = [toStatus, JSON.stringify(safePayload)];
      if (toStatus === 'APPROVED') updates.push('approved_at=COALESCE(approved_at,CURRENT_TIMESTAMP(3))');
      if (toStatus === 'CANCELED') updates.push('canceled_at=COALESCE(canceled_at,CURRENT_TIMESTAMP(3))');
      params.push(paymentId);
      await conn.execute(`UPDATE payment_intents SET ${updates.join(',')} WHERE id=?`, params);
      await conn.execute('INSERT INTO payment_events (payment_id,provider,provider_event_id,event_type,from_status,to_status,payload_json) VALUES (?,?,?,?,?,?,?)', [paymentId, provider, providerEventId, eventType, fromStatus, toStatus, JSON.stringify(safePayload)]);
      const [rows] = await conn.execute('SELECT * FROM payment_intents WHERE id=?', [paymentId]);
      await outbox.enqueue(conn, `payment.${toStatus.toLowerCase()}`, paymentId, serializePayment(rows[0]));
    });
  }

  async function createPayment(input, idempotencyKey) {
    assertNoRawCardData(input);
    const method = normalizeMethod(input.method);
    const amountCents = Number(input.amount_cents);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) { const err = new Error('amount_cents must be a positive integer'); err.code='INVALID_AMOUNT'; err.status=422; throw err; }
    const sourceModule = String(input.source_module || '').trim();
    const sourceReference = String(input.source_reference || '').trim();
    if (!sourceModule || !sourceReference) { const err = new Error('source_module and source_reference are required'); err.code='INVALID_SOURCE'; err.status=422; throw err; }
    if (!idempotencyKey || String(idempotencyKey).length > 128) { const err = new Error('Idempotency-Key header is required'); err.code='IDEMPOTENCY_KEY_REQUIRED'; err.status=400; throw err; }
    const installments = method === 'credit_card' ? Number(input.installments || 1) : 1;
    if (!Number.isInteger(installments) || installments < 1 || installments > 24) { const err = new Error('installments must be between 1 and 24'); err.code='INVALID_INSTALLMENTS'; err.status=422; throw err; }
    const providerName = String(input.provider || config.providers[method] || '').toLowerCase();
    const provider = providers.get(providerName);
    if (!provider.capabilities().methods.includes(method)) { const err = new Error(`${providerName} does not support ${method}`); err.code='METHOD_NOT_SUPPORTED_BY_PROVIDER'; err.status=422; throw err; }

    const normalizedRequest = {
      source_module: sourceModule, source_reference: sourceReference, merchant_id: String(input.merchant_id || 'default'),
      method, provider: providerName, amount_cents: amountCents, currency: String(input.currency || 'BRL').toUpperCase(),
      installments, metadata: sanitizeForStorage(input.metadata || {})
    };
    if (normalizedRequest.currency !== 'BRL') { const err = new Error('Only BRL is enabled in this deployment'); err.code='CURRENCY_NOT_SUPPORTED'; err.status=422; throw err; }
    const hash = requestHash(normalizedRequest);
    const existing = await db.query('SELECT * FROM payment_intents WHERE source_module=? AND idempotency_key=? LIMIT 1', [sourceModule, String(idempotencyKey)]);
    if (existing[0]) {
      if (existing[0].request_hash !== hash) { const err = new Error('Idempotency key reused with different payload'); err.code='IDEMPOTENCY_CONFLICT'; err.status=409; throw err; }
      return { payment: serializePayment(existing[0]), idempotent_replay: true };
    }

    const id = crypto.randomUUID();
    try {
      await db.transaction(async conn => {
        await conn.execute(`INSERT INTO payment_intents (id,source_module,source_reference,merchant_id,idempotency_key,request_hash,method,provider,amount_cents,currency,installments,status,metadata_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, sourceModule, sourceReference, normalizedRequest.merchant_id, String(idempotencyKey), hash, method, providerName, amountCents, normalizedRequest.currency, installments, 'CREATED', JSON.stringify(normalizedRequest.metadata)]);
        await conn.execute('INSERT INTO payment_events (payment_id,provider,event_type,from_status,to_status,payload_json) VALUES (?,?,?,?,?,?)', [id, providerName, 'payment.created', null, 'CREATED', JSON.stringify(normalizedRequest)]);
        await outbox.enqueue(conn, 'payment.created', id, { id, ...normalizedRequest, status: 'CREATED' });
      });
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        const rows = await db.query('SELECT * FROM payment_intents WHERE source_module=? AND idempotency_key=? LIMIT 1', [sourceModule, String(idempotencyKey)]);
        if (rows[0] && rows[0].request_hash === hash) return { payment: serializePayment(rows[0]), idempotent_replay: true };
      }
      throw err;
    }

    const row = await getById(id);
    try {
      const result = await provider.createPayment({ ...row, metadata: normalizedRequest.metadata });
      const status = normalizeStatus(result.status);
      const safeProviderData = sanitizeForStorage(result.providerData || {});
      await db.transaction(async conn => {
        await conn.execute('UPDATE payment_intents SET status=?, external_id=?, next_action_json=?, provider_data_json=?, approved_at=IF(?="APPROVED",CURRENT_TIMESTAMP(3),approved_at) WHERE id=?', [status, result.externalId || null, result.nextAction ? JSON.stringify(result.nextAction) : null, JSON.stringify(safeProviderData), status, id]);
        await conn.execute('INSERT INTO payment_events (payment_id,provider,event_type,from_status,to_status,payload_json) VALUES (?,?,?,?,?,?)', [id, providerName, 'provider.create.result', 'CREATED', status, JSON.stringify(safeProviderData)]);
        const [rows] = await conn.execute('SELECT * FROM payment_intents WHERE id=?', [id]);
        await outbox.enqueue(conn, `payment.${status.toLowerCase()}`, id, serializePayment(rows[0]));
      });
    } catch (err) {
      await recordStatusChange(id, 'CREATED', 'ERROR', 'provider.create.error', providerName, { code: err.code || 'PROVIDER_ERROR', message: err.message, provider_data: sanitizeForStorage(err.providerData || null) });
      throw err;
    }
    return { payment: serializePayment(await getById(id)), idempotent_replay: false };
  }

  async function getPayment(id) {
    const row = await getById(id);
    if (!row) { const err = new Error('Payment not found'); err.code='PAYMENT_NOT_FOUND'; err.status=404; throw err; }
    const refunds = await db.query('SELECT id,amount_cents,status,external_id,reason,created_at,updated_at FROM refunds WHERE payment_id=? ORDER BY created_at ASC', [id]);
    return { ...serializePayment(row), refunds: refunds.map(r => ({ ...r, amount_cents: Number(r.amount_cents) })) };
  }

  async function cancelPayment(id) {
    const row = await getById(id);
    if (!row) { const err = new Error('Payment not found'); err.code='PAYMENT_NOT_FOUND'; err.status=404; throw err; }
    if (!['CREATED','PENDING','ACTION_REQUIRED','ERROR'].includes(row.status)) { const err = new Error(`Cannot cancel payment in ${row.status}`); err.code='INVALID_PAYMENT_STATE'; err.status=409; throw err; }
    const result = await providers.get(row.provider).cancelPayment(row);
    const status = normalizeStatus(result.status);
    await recordStatusChange(id, row.status, status, 'payment.cancel', row.provider, result.providerData || {});
    return getPayment(id);
  }

  async function confirmCash(id, body) {
    assertNoRawCardData(body);
    const row = await getById(id);
    if (!row) { const err = new Error('Payment not found'); err.code='PAYMENT_NOT_FOUND'; err.status=404; throw err; }
    if (row.method !== 'cash' || row.provider !== 'cash') { const err = new Error('Payment is not cash'); err.code='NOT_CASH_PAYMENT'; err.status=422; throw err; }
    if (row.status === 'APPROVED') return getPayment(id);
    if (row.status !== 'PENDING') { const err = new Error(`Cannot confirm cash in ${row.status}`); err.code='INVALID_PAYMENT_STATE'; err.status=409; throw err; }
    const tendered = Number(body.tendered_cents || row.amount_cents);
    if (!Number.isSafeInteger(tendered) || tendered < Number(row.amount_cents)) { const err = new Error('tendered_cents is smaller than payment amount'); err.code='INSUFFICIENT_CASH'; err.status=422; throw err; }
    const change = tendered - Number(row.amount_cents);
    const movementId = crypto.randomUUID();
    const details = sanitizeForStorage({ tendered_cents: tendered, change_cents: change, register_id: body.register_id || null, shift_id: body.shift_id || null, operator_id: body.operator_id || null });
    await db.transaction(async conn => {
      await conn.execute('UPDATE payment_intents SET status="APPROVED", approved_at=CURRENT_TIMESTAMP(3), provider_data_json=? WHERE id=?', [JSON.stringify(details), id]);
      await conn.execute('INSERT INTO payment_events (payment_id,provider,event_type,from_status,to_status,payload_json) VALUES (?,?,?,?,?,?)', [id, 'cash', 'cash.confirmed', row.status, 'APPROVED', JSON.stringify(details)]);
      await conn.execute('INSERT INTO cash_movements (id,payment_id,merchant_id,register_id,shift_id,operator_id,movement_type,amount_cents,metadata_json) VALUES (?,?,?,?,?,?,?,?,?)', [movementId, id, row.merchant_id, body.register_id || null, body.shift_id || null, body.operator_id || null, 'SALE', Number(row.amount_cents), JSON.stringify(details)]);
      const [rows] = await conn.execute('SELECT * FROM payment_intents WHERE id=?', [id]);
      await outbox.enqueue(conn, 'payment.approved', id, serializePayment(rows[0]));
    });
    return getPayment(id);
  }

  async function refundPayment(id, body, idempotencyKey) {
    assertNoRawCardData(body);
    const row = await getById(id);
    if (!row) { const err = new Error('Payment not found'); err.code='PAYMENT_NOT_FOUND'; err.status=404; throw err; }
    if (!['APPROVED','PARTIALLY_REFUNDED'].includes(row.status)) { const err = new Error(`Cannot refund payment in ${row.status}`); err.code='INVALID_PAYMENT_STATE'; err.status=409; throw err; }
    if (!idempotencyKey) { const err = new Error('Idempotency-Key header is required'); err.code='IDEMPOTENCY_KEY_REQUIRED'; err.status=400; throw err; }
    const existing = await db.query('SELECT * FROM refunds WHERE payment_id=? AND idempotency_key=? LIMIT 1', [id, String(idempotencyKey)]);
    if (existing[0]) return { refund: existing[0], payment: await getPayment(id), idempotent_replay: true };
    const approvedRefunds = await db.query('SELECT COALESCE(SUM(amount_cents),0) AS total FROM refunds WHERE payment_id=? AND status="APPROVED"', [id]);
    const refundable = Number(row.amount_cents) - Number(approvedRefunds[0].total || 0);
    const amountCents = body.amount_cents == null ? refundable : Number(body.amount_cents);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > refundable) { const err = new Error('Invalid refund amount'); err.code='INVALID_REFUND_AMOUNT'; err.status=422; throw err; }
    const refund = { id: crypto.randomUUID(), amountCents, reason: body.reason ? String(body.reason).slice(0,255) : null };
    await db.query('INSERT INTO refunds (id,payment_id,idempotency_key,amount_cents,status,reason) VALUES (?,?,?,?,?,?)', [refund.id, id, String(idempotencyKey), amountCents, 'PENDING', refund.reason]);
    const result = await providers.get(row.provider).refundPayment(row, refund);
    const refundStatus = String(result.status || 'PENDING').toUpperCase();
    if (!['PENDING','APPROVED','DECLINED','ERROR'].includes(refundStatus)) { const err = new Error('Invalid refund provider status'); err.code='INVALID_PROVIDER_STATUS'; err.status=502; throw err; }
    await db.query('UPDATE refunds SET status=?, external_id=?, provider_data_json=? WHERE id=?', [refundStatus, result.externalId || null, JSON.stringify(sanitizeForStorage(result.providerData || {})), refund.id]);
    if (refundStatus === 'APPROVED') {
      const totalRefunded = Number(approvedRefunds[0].total || 0) + amountCents;
      const paymentStatus = totalRefunded >= Number(row.amount_cents) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      await recordStatusChange(id, row.status, paymentStatus, 'payment.refund.approved', row.provider, { refund_id: refund.id, amount_cents: amountCents });
      if (row.method === 'cash') {
        await db.query('INSERT INTO cash_movements (id,payment_id,merchant_id,movement_type,amount_cents,metadata_json) VALUES (?,?,?,?,?,?)', [crypto.randomUUID(), id, row.merchant_id, 'REFUND', -amountCents, JSON.stringify({ refund_id: refund.id })]);
      }
    }
    const [refundRow] = await db.query('SELECT id,payment_id,amount_cents,status,external_id,reason,created_at,updated_at FROM refunds WHERE id=?', [refund.id]);
    return { refund: { ...refundRow, amount_cents: Number(refundRow.amount_cents) }, payment: await getPayment(id), idempotent_replay: false };
  }

  async function handleWebhook(providerName, body, rawBody, headers) {
    assertNoRawCardData(body);
    const provider = providers.get(providerName);
    if (!provider.capabilities().webhooks) { const err = new Error('Provider has no webhooks'); err.code='WEBHOOK_NOT_SUPPORTED'; err.status=404; throw err; }
    if (!provider.verifyWebhook({ rawBody, headers })) { const err = new Error('Invalid webhook signature'); err.code='INVALID_WEBHOOK_SIGNATURE'; err.status=401; throw err; }
    const event = provider.normalizeWebhook(body);
    const status = normalizeStatus(event.status, WEBHOOK_STATUSES);
    try {
      await db.query('INSERT INTO webhook_receipts (provider,provider_event_id,external_id,payload_json) VALUES (?,?,?,?)', [providerName, event.providerEventId, event.externalId, JSON.stringify(sanitizeForStorage(body))]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return { duplicate: true };
      throw err;
    }
    const row = await getByExternal(providerName, event.externalId);
    if (!row) {
      await db.query('UPDATE webhook_receipts SET processed_at=CURRENT_TIMESTAMP(3) WHERE provider=? AND provider_event_id=?', [providerName, event.providerEventId]);
      const err = new Error('Payment for webhook not found'); err.code='WEBHOOK_PAYMENT_NOT_FOUND'; err.status=404; throw err;
    }
    if (row.status !== status) await recordStatusChange(row.id, row.status, status, 'provider.webhook', providerName, event.details || {}, event.providerEventId);
    await db.query('UPDATE webhook_receipts SET processed_at=CURRENT_TIMESTAMP(3) WHERE provider=? AND provider_event_id=?', [providerName, event.providerEventId]);
    return { duplicate: false, payment: await getPayment(row.id) };
  }

  return { createPayment, getPayment, listEvents, cancelPayment, confirmCash, refundPayment, handleWebhook, serializePayment, normalizeMethod };
}

module.exports = { createPaymentService, normalizeMethod, serializePayment };
