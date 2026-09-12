'use strict';
const crypto = require('crypto');
const { assertNoRawCardData, sanitizeForStorage, requestHash } = require('../security');

const METHODS = new Set(['cash', 'pix', 'debit_card', 'credit_card']);
const PROVIDER_STATUSES = new Set(['PENDING','ACTION_REQUIRED','AUTHORIZED','APPROVED','DECLINED','CANCELED','EXPIRED','ERROR','UNKNOWN']);
const WEBHOOK_STATUSES = new Set(['PENDING','ACTION_REQUIRED','AUTHORIZED','APPROVED','DECLINED','CANCELED','EXPIRED','ERROR','UNKNOWN','REFUNDED','PARTIALLY_REFUNDED']);
const TERMINAL_STATUSES = new Set(['APPROVED','DECLINED','CANCELED','EXPIRED','ERROR','REFUNDED']);

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
function canTransition(from, to) {
  if (!from || from === to) return true;
  const allowed = {
    CREATED: ['PENDING','ACTION_REQUIRED','AUTHORIZED','APPROVED','DECLINED','CANCELED','EXPIRED','ERROR','UNKNOWN'],
    PENDING: ['PENDING','ACTION_REQUIRED','AUTHORIZED','APPROVED','DECLINED','CANCELED','EXPIRED','ERROR','UNKNOWN'],
    UNKNOWN: ['UNKNOWN','PENDING','ACTION_REQUIRED','AUTHORIZED','APPROVED','DECLINED','CANCELED','EXPIRED','ERROR'],
    ACTION_REQUIRED: ['PENDING','ACTION_REQUIRED','AUTHORIZED','APPROVED','DECLINED','CANCELED','EXPIRED','ERROR','UNKNOWN'],
    AUTHORIZED: ['AUTHORIZED','APPROVED','CANCELED','ERROR','UNKNOWN'],
    ERROR: ['PENDING','UNKNOWN','CANCELED'],
    APPROVED: ['PARTIALLY_REFUNDED','REFUNDED'],
    PARTIALLY_REFUNDED: ['PARTIALLY_REFUNDED','REFUNDED']
  };
  return (allowed[from] || []).includes(to);
}

function createPaymentService({ db, config, providers, outbox, jobs }) {
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

  async function recordStatusChange(paymentId, toStatus, eventType, provider, payload = {}, providerEventId = null) {
    const safePayload = sanitizeForStorage(payload);
    return db.transaction(async conn => {
      const [rows] = await conn.execute('SELECT * FROM payment_intents WHERE id=? FOR UPDATE', [paymentId]);
      const current = rows[0];
      if (!current) { const err = new Error('Payment not found'); err.code='PAYMENT_NOT_FOUND'; err.status=404; throw err; }
      const fromStatus = String(current.status);
      if (!canTransition(fromStatus, toStatus)) {
        await conn.execute('INSERT INTO payment_events (payment_id,provider,provider_event_id,event_type,from_status,to_status,payload_json) VALUES (?,?,?,?,?,?,?)', [paymentId, provider, providerEventId, `${eventType}.ignored`, fromStatus, fromStatus, JSON.stringify({ ignored_target_status:toStatus, ...safePayload })]);
        return serializePayment(current);
      }
      const updates = ['status=?', 'provider_data_json=?'];
      const params = [toStatus, JSON.stringify(safePayload)];
      let nextAction;
      if (safePayload && Object.prototype.hasOwnProperty.call(safePayload, 'next_action')) nextAction = safePayload.next_action;
      else if (['APPROVED','DECLINED','CANCELED','EXPIRED','ERROR','REFUNDED'].includes(toStatus)) nextAction = null;
      if (nextAction !== undefined) {
        updates.push('next_action_json=?');
        params.push(nextAction === null ? null : JSON.stringify(nextAction));
      }
      if (toStatus === 'APPROVED') updates.push('approved_at=COALESCE(approved_at,CURRENT_TIMESTAMP(3))');
      if (toStatus === 'CANCELED') updates.push('canceled_at=COALESCE(canceled_at,CURRENT_TIMESTAMP(3))');
      params.push(paymentId);
      await conn.execute(`UPDATE payment_intents SET ${updates.join(',')} WHERE id=?`, params);
      await conn.execute('INSERT INTO payment_events (payment_id,provider,provider_event_id,event_type,from_status,to_status,payload_json) VALUES (?,?,?,?,?,?,?)', [paymentId, provider, providerEventId, eventType, fromStatus, toStatus, JSON.stringify(safePayload)]);
      const [fresh] = await conn.execute('SELECT * FROM payment_intents WHERE id=?', [paymentId]);
      if (fromStatus !== toStatus) await outbox.enqueue(conn, `payment.${toStatus.toLowerCase()}`, paymentId, serializePayment(fresh[0]));
      return serializePayment(fresh[0]);
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
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, sourceModule, sourceReference, normalizedRequest.merchant_id, String(idempotencyKey), hash, method, providerName, amountCents, normalizedRequest.currency, installments, 'PENDING', JSON.stringify(normalizedRequest.metadata)]);
        await conn.execute('INSERT INTO payment_events (payment_id,provider,event_type,from_status,to_status,payload_json) VALUES (?,?,?,?,?,?)', [id, providerName, 'payment.created', null, 'PENDING', JSON.stringify(normalizedRequest)]);
        await jobs.enqueueAuthorize(conn, { id, ...normalizedRequest }, normalizedRequest.metadata);
        await outbox.enqueue(conn, 'payment.pending', id, { id, ...normalizedRequest, status: 'PENDING' });
      });
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        const rows = await db.query('SELECT * FROM payment_intents WHERE source_module=? AND idempotency_key=? LIMIT 1', [sourceModule, String(idempotencyKey)]);
        if (rows[0] && rows[0].request_hash === hash) return { payment: serializePayment(rows[0]), idempotent_replay: true };
      }
      throw err;
    }
    setImmediate(() => jobs.pump().catch(err => console.error('[payment-jobs]', err)));
    return { payment: serializePayment(await getById(id)), idempotent_replay: false };
  }

  async function applyProviderCreateResult(id, result) {
    const status = normalizeStatus(result.status);
    const safeProviderData = sanitizeForStorage(result.providerData || {});
    return db.transaction(async conn => {
      const [rows] = await conn.execute('SELECT * FROM payment_intents WHERE id=? FOR UPDATE', [id]);
      const row = rows[0];
      if (!row) { const err = new Error('Payment not found'); err.code='PAYMENT_NOT_FOUND'; err.status=404; throw err; }
      if (TERMINAL_STATUSES.has(String(row.status)) && row.status !== 'ERROR') return serializePayment(row);
      const fromStatus = String(row.status);
      if (!canTransition(fromStatus, status)) return serializePayment(row);
      await conn.execute('UPDATE payment_intents SET status=?, external_id=COALESCE(?,external_id), next_action_json=?, provider_data_json=?, approved_at=IF(?="APPROVED",COALESCE(approved_at,CURRENT_TIMESTAMP(3)),approved_at) WHERE id=?', [status, result.externalId || null, result.nextAction ? JSON.stringify(result.nextAction) : null, JSON.stringify(safeProviderData), status, id]);
      await conn.execute('INSERT INTO payment_events (payment_id,provider,event_type,from_status,to_status,payload_json) VALUES (?,?,?,?,?,?)', [id, row.provider, 'provider.create.result', fromStatus, status, JSON.stringify(safeProviderData)]);
      const [fresh] = await conn.execute('SELECT * FROM payment_intents WHERE id=?', [id]);
      if (fromStatus !== status) await outbox.enqueue(conn, `payment.${status.toLowerCase()}`, id, serializePayment(fresh[0]));
      return serializePayment(fresh[0]);
    });
  }

  async function markProcessingFailure(id, error, exhausted) {
    const row = await getById(id);
    if (!row || TERMINAL_STATUSES.has(String(row.status))) return row ? serializePayment(row) : null;
    const target = exhausted ? 'ERROR' : 'UNKNOWN';
    return recordStatusChange(id, target, exhausted ? 'provider.processing.exhausted' : 'provider.processing.retry', row.provider, { code:error.code || 'PROVIDER_ERROR', message:String(error.message || error).slice(0,500) });
  }

  async function getPayment(id) {
    const row = await getById(id);
    if (!row) { const err = new Error('Payment not found'); err.code='PAYMENT_NOT_FOUND'; err.status=404; throw err; }
    const refunds = await db.query('SELECT id,amount_cents,status,external_id,reason,created_at,updated_at FROM refunds WHERE payment_id=? ORDER BY created_at ASC', [id]);
    return { ...serializePayment(row), refunds: refunds.map(r => ({ ...r, amount_cents: Number(r.amount_cents) })) };
  }

  async function confirmPayment(id) {
    const row = await getById(id);
    if (!row) { const err = new Error('Payment not found'); err.code='PAYMENT_NOT_FOUND'; err.status=404; throw err; }
    if (row.status === 'APPROVED') return getPayment(id);
    const provider = providers.get(row.provider);
    if (!provider.capabilities().confirmation) { const err = new Error(`${row.provider} does not require/support confirmation`); err.code='CONFIRMATION_NOT_SUPPORTED'; err.status=422; throw err; }
    if (row.status !== 'AUTHORIZED') { const err = new Error(`Cannot confirm payment in ${row.status}`); err.code='INVALID_PAYMENT_STATE'; err.status=409; throw err; }
    if (!row.external_id) { const err = new Error('Payment has no provider transaction id'); err.code='PROVIDER_TRANSACTION_MISSING'; err.status=409; throw err; }
    const result = await provider.confirmPayment(row);
    const status = normalizeStatus(result.status);
    if (status !== 'APPROVED') { const err = new Error(`Provider confirmation returned ${status}`); err.code='CONFIRMATION_FAILED'; err.status=502; throw err; }
    await recordStatusChange(id, status, 'payment.confirm', row.provider, { ...(result.providerData || {}), next_action: null });
    return getPayment(id);
  }

  async function cancelPayment(id) {
    const row = await getById(id);
    if (!row) { const err = new Error('Payment not found'); err.code='PAYMENT_NOT_FOUND'; err.status=404; throw err; }
    if (!['CREATED','PENDING','ACTION_REQUIRED','AUTHORIZED','UNKNOWN','ERROR'].includes(row.status)) { const err = new Error(`Cannot cancel payment in ${row.status}`); err.code='INVALID_PAYMENT_STATE'; err.status=409; throw err; }
    if (!row.external_id) {
      await db.transaction(async conn => {
        const [locked] = await conn.execute('SELECT * FROM payment_intents WHERE id=? FOR UPDATE', [id]);
        if (!locked[0]) return;
        await conn.execute('UPDATE payment_intents SET status="CANCELED",canceled_at=CURRENT_TIMESTAMP(3) WHERE id=?', [id]);
        await conn.execute('UPDATE payment_jobs SET status="DONE",last_error="Canceled before provider authorization" WHERE payment_id=? AND status IN ("READY","PROCESSING")', [id]);
        await conn.execute('INSERT INTO payment_events (payment_id,provider,event_type,from_status,to_status,payload_json) VALUES (?,?,?,?,?,?)', [id,row.provider,'payment.cancel.local',locked[0].status,'CANCELED','{}']);
        const [fresh] = await conn.execute('SELECT * FROM payment_intents WHERE id=?', [id]);
        await outbox.enqueue(conn,'payment.canceled',id,serializePayment(fresh[0]));
      });
      return getPayment(id);
    }
    const result = await providers.get(row.provider).cancelPayment(row);
    const status = normalizeStatus(result.status);
    await recordStatusChange(id, status, 'payment.cancel', row.provider, { ...(result.providerData || {}), next_action: null });
    return getPayment(id);
  }

  async function confirmCash(id, body) {
    assertNoRawCardData(body);
    const row = await getById(id);
    if (!row) { const err = new Error('Payment not found'); err.code='PAYMENT_NOT_FOUND'; err.status=404; throw err; }
    if (row.method !== 'cash' || row.provider !== 'cash') { const err = new Error('Payment is not cash'); err.code='NOT_CASH_PAYMENT'; err.status=422; throw err; }
    if (row.status === 'APPROVED') return getPayment(id);
    if (!['PENDING','UNKNOWN'].includes(row.status)) { const err = new Error(`Cannot confirm cash in ${row.status}`); err.code='INVALID_PAYMENT_STATE'; err.status=409; throw err; }
    const tendered = Number(body.tendered_cents || row.amount_cents);
    if (!Number.isSafeInteger(tendered) || tendered < Number(row.amount_cents)) { const err = new Error('tendered_cents is smaller than payment amount'); err.code='INSUFFICIENT_CASH'; err.status=422; throw err; }
    const change = tendered - Number(row.amount_cents);
    const movementId = crypto.randomUUID();
    const details = sanitizeForStorage({ tendered_cents: tendered, change_cents: change, register_id: body.register_id || null, shift_id: body.shift_id || null, operator_id: body.operator_id || null });
    await db.transaction(async conn => {
      const [locked] = await conn.execute('SELECT * FROM payment_intents WHERE id=? FOR UPDATE', [id]);
      if (locked[0]?.status === 'APPROVED') return;
      await conn.execute('UPDATE payment_intents SET status="APPROVED", approved_at=CURRENT_TIMESTAMP(3), provider_data_json=? WHERE id=?', [JSON.stringify(details), id]);
      await conn.execute('UPDATE payment_jobs SET status="DONE" WHERE payment_id=? AND job_type="AUTHORIZE"', [id]);
      await conn.execute('INSERT INTO payment_events (payment_id,provider,event_type,from_status,to_status,payload_json) VALUES (?,?,?,?,?,?)', [id, 'cash', 'cash.confirmed', locked[0]?.status || row.status, 'APPROVED', JSON.stringify(details)]);
      await conn.execute('INSERT INTO cash_movements (id,payment_id,merchant_id,register_id,shift_id,operator_id,movement_type,amount_cents,metadata_json) VALUES (?,?,?,?,?,?,?,?,?)', [movementId, id, row.merchant_id, body.register_id || null, body.shift_id || null, body.operator_id || null, 'SALE', Number(row.amount_cents), JSON.stringify(details)]);
      const [fresh] = await conn.execute('SELECT * FROM payment_intents WHERE id=?', [id]);
      await outbox.enqueue(conn, 'payment.approved', id, serializePayment(fresh[0]));
    });
    return getPayment(id);
  }

  async function refundPayment(id, body, idempotencyKey) {
    assertNoRawCardData(body);
    if (!idempotencyKey) { const err = new Error('Idempotency-Key header is required'); err.code='IDEMPOTENCY_KEY_REQUIRED'; err.status=400; throw err; }
    const existing = await db.query('SELECT * FROM refunds WHERE payment_id=? AND idempotency_key=? LIMIT 1', [id, String(idempotencyKey)]);
    if (existing[0]) return { refund: existing[0], payment: await getPayment(id), idempotent_replay: true };

    let paymentRow;
    let refund;
    await db.transaction(async conn => {
      const [rows] = await conn.execute('SELECT * FROM payment_intents WHERE id=? FOR UPDATE', [id]);
      paymentRow = rows[0];
      if (!paymentRow) { const err = new Error('Payment not found'); err.code='PAYMENT_NOT_FOUND'; err.status=404; throw err; }
      if (!['APPROVED','PARTIALLY_REFUNDED'].includes(paymentRow.status)) { const err = new Error(`Cannot refund payment in ${paymentRow.status}`); err.code='INVALID_PAYMENT_STATE'; err.status=409; throw err; }
      const [sums] = await conn.execute('SELECT COALESCE(SUM(amount_cents),0) AS total FROM refunds WHERE payment_id=? AND status IN ("PENDING","APPROVED")', [id]);
      const refundable = Number(paymentRow.amount_cents) - Number(sums[0].total || 0);
      const amountCents = body.amount_cents == null ? refundable : Number(body.amount_cents);
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > refundable) { const err = new Error('Invalid refund amount'); err.code='INVALID_REFUND_AMOUNT'; err.status=422; throw err; }
      refund = { id: crypto.randomUUID(), amountCents, reason: body.reason ? String(body.reason).slice(0,255) : null };
      await conn.execute('INSERT INTO refunds (id,payment_id,idempotency_key,amount_cents,status,reason) VALUES (?,?,?,?,?,?)', [refund.id, id, String(idempotencyKey), amountCents, 'PENDING', refund.reason]);
    });

    const result = await providers.get(paymentRow.provider).refundPayment(paymentRow, refund);
    const refundStatus = String(result.status || 'PENDING').toUpperCase();
    if (!['PENDING','APPROVED','DECLINED','ERROR'].includes(refundStatus)) { const err = new Error('Invalid refund provider status'); err.code='INVALID_PROVIDER_STATUS'; err.status=502; throw err; }
    await db.query('UPDATE refunds SET status=?, external_id=?, provider_data_json=? WHERE id=?', [refundStatus, result.externalId || null, JSON.stringify(sanitizeForStorage(result.providerData || {})), refund.id]);
    if (refundStatus === 'APPROVED') {
      const approvedRefunds = await db.query('SELECT COALESCE(SUM(amount_cents),0) AS total FROM refunds WHERE payment_id=? AND status="APPROVED"', [id]);
      const totalRefunded = Number(approvedRefunds[0].total || 0);
      const paymentStatus = totalRefunded >= Number(paymentRow.amount_cents) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      await recordStatusChange(id, paymentStatus, 'payment.refund.approved', paymentRow.provider, { refund_id: refund.id, amount_cents: refund.amountCents, next_action: null });
      if (paymentRow.method === 'cash') await db.query('INSERT INTO cash_movements (id,payment_id,merchant_id,movement_type,amount_cents,metadata_json) VALUES (?,?,?,?,?,?)', [crypto.randomUUID(), id, paymentRow.merchant_id, 'REFUND', -refund.amountCents, JSON.stringify({ refund_id: refund.id })]);
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
    const row = event.paymentId ? await getById(event.paymentId) : await getByExternal(providerName, event.externalId);
    if (!row) return { duplicate:false, unmatched:true, provider_event_id:event.providerEventId };
    if (event.externalId && !row.external_id) await db.query('UPDATE payment_intents SET external_id=? WHERE id=? AND external_id IS NULL', [event.externalId,row.id]);
    await recordStatusChange(row.id, status, 'provider.webhook', providerName, event.details || {}, event.providerEventId);
    await db.query('UPDATE webhook_receipts SET processed_at=CURRENT_TIMESTAMP(3) WHERE provider=? AND provider_event_id=?', [providerName, event.providerEventId]);
    return { duplicate: false, payment: await getPayment(row.id) };
  }

  return { createPayment, getPayment, listEvents, confirmPayment, cancelPayment, confirmCash, refundPayment, handleWebhook, serializePayment, normalizeMethod, applyProviderCreateResult, markProcessingFailure };
}

module.exports = { createPaymentService, normalizeMethod, serializePayment };
