'use strict';
const crypto = require('crypto');
const { sanitizeForStorage } = require('../security');

function createReconciliationService({ db }) {
  async function listTransactions(filters) {
    const where = ['1=1']; const params = [];
    if (filters.from) { where.push('created_at >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('created_at < ?'); params.push(filters.to); }
    if (filters.provider) { where.push('provider = ?'); params.push(filters.provider); }
    if (filters.merchant_id) { where.push('merchant_id = ?'); params.push(filters.merchant_id); }
    if (filters.status) { where.push('status = ?'); params.push(String(filters.status).toUpperCase()); }
    const limit = Math.min(1000, Math.max(1, Number(filters.limit || 200)));
    const rows = await db.query(`SELECT id,source_module,source_reference,merchant_id,method,provider,amount_cents,currency,installments,status,external_id,approved_at,created_at,updated_at FROM payment_intents WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit}`, params);
    return rows.map(r => ({ ...r, amount_cents: Number(r.amount_cents), installments: Number(r.installments) }));
  }

  async function importSettlements(body) {
    const provider = String(body.provider || '').toLowerCase();
    const batchId = String(body.batch_id || '').trim();
    if (!provider || !batchId || !Array.isArray(body.items) || body.items.length === 0) { const err = new Error('provider, batch_id and items are required'); err.code='INVALID_SETTLEMENT_BATCH'; err.status=422; throw err; }
    if (body.items.length > 5000) { const err = new Error('Settlement batch too large'); err.code='SETTLEMENT_BATCH_TOO_LARGE'; err.status=413; throw err; }
    const results = [];
    for (const item of body.items) {
      const recordId = String(item.provider_record_id || crypto.randomUUID());
      const externalId = item.external_id ? String(item.external_id) : null;
      const gross = Number(item.gross_amount_cents);
      const fee = Number(item.fee_amount_cents || 0);
      const net = Number(item.net_amount_cents);
      if (![gross,fee,net].every(Number.isSafeInteger)) { results.push({ provider_record_id: recordId, status: 'INVALID' }); continue; }
      const payments = externalId ? await db.query('SELECT id,amount_cents FROM payment_intents WHERE provider=? AND external_id=? LIMIT 1', [provider, externalId]) : [];
      let matchStatus = 'UNMATCHED'; let paymentId = null;
      if (payments[0]) { paymentId = payments[0].id; matchStatus = Number(payments[0].amount_cents) === gross ? 'MATCHED' : 'MISMATCH'; }
      try {
        await db.query(`INSERT INTO reconciliation_records (provider,batch_id,provider_record_id,external_id,payment_id,gross_amount_cents,fee_amount_cents,net_amount_cents,settled_at,match_status,details_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [provider,batchId,recordId,externalId,paymentId,gross,fee,net,item.settled_at || null,matchStatus,JSON.stringify(sanitizeForStorage(item.details || {}))]);
      } catch (err) { if (err.code !== 'ER_DUP_ENTRY') throw err; }
      results.push({ provider_record_id: recordId, payment_id: paymentId, status: matchStatus });
    }
    return { provider, batch_id: batchId, processed: results.length, results };
  }

  async function summary(filters) {
    const where = ['1=1']; const params = [];
    if (filters.from) { where.push('created_at >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('created_at < ?'); params.push(filters.to); }
    if (filters.provider) { where.push('provider = ?'); params.push(filters.provider); }
    const payments = await db.query(`SELECT provider,method,status,COUNT(*) AS qty,COALESCE(SUM(amount_cents),0) AS amount_cents FROM payment_intents WHERE ${where.join(' AND ')} GROUP BY provider,method,status ORDER BY provider,method,status`, params);
    const reconciliation = await db.query(`SELECT provider,match_status,COUNT(*) AS qty,COALESCE(SUM(gross_amount_cents),0) AS gross_amount_cents,COALESCE(SUM(fee_amount_cents),0) AS fee_amount_cents,COALESCE(SUM(net_amount_cents),0) AS net_amount_cents FROM reconciliation_records WHERE ${where.join(' AND ')} GROUP BY provider,match_status ORDER BY provider,match_status`, params);
    return {
      payments: payments.map(r => ({ ...r, qty:Number(r.qty), amount_cents:Number(r.amount_cents) })),
      reconciliation: reconciliation.map(r => ({ ...r, qty:Number(r.qty), gross_amount_cents:Number(r.gross_amount_cents), fee_amount_cents:Number(r.fee_amount_cents), net_amount_cents:Number(r.net_amount_cents) }))
    };
  }

  async function cashSummary(filters) {
    const where = ['1=1']; const params=[];
    if (filters.merchant_id) { where.push('merchant_id=?'); params.push(filters.merchant_id); }
    if (filters.shift_id) { where.push('shift_id=?'); params.push(filters.shift_id); }
    if (filters.register_id) { where.push('register_id=?'); params.push(filters.register_id); }
    if (filters.from) { where.push('created_at>=?'); params.push(filters.from); }
    if (filters.to) { where.push('created_at<?'); params.push(filters.to); }
    const totals = await db.query(`SELECT movement_type,COUNT(*) qty,COALESCE(SUM(amount_cents),0) amount_cents FROM cash_movements WHERE ${where.join(' AND ')} GROUP BY movement_type`, params);
    const movements = await db.query(`SELECT id,payment_id,merchant_id,register_id,shift_id,operator_id,movement_type,amount_cents,metadata_json,created_at FROM cash_movements WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 1000`, params);
    return { totals: totals.map(r=>({...r,qty:Number(r.qty),amount_cents:Number(r.amount_cents)})), movements: movements.map(r=>({...r,amount_cents:Number(r.amount_cents)})) };
  }

  async function addCashMovement(body) {
    const allowed = new Set(['OPENING','DEPOSIT','WITHDRAWAL','CLOSING','ADJUSTMENT']);
    const movementType = String(body.movement_type || '').toUpperCase();
    if (!allowed.has(movementType)) { const err=new Error('Invalid cash movement type'); err.code='INVALID_CASH_MOVEMENT'; err.status=422; throw err; }
    const amount = Number(body.amount_cents);
    if (!Number.isSafeInteger(amount)) { const err=new Error('amount_cents must be integer'); err.code='INVALID_AMOUNT'; err.status=422; throw err; }
    const id=crypto.randomUUID();
    await db.query('INSERT INTO cash_movements (id,merchant_id,register_id,shift_id,operator_id,movement_type,amount_cents,metadata_json) VALUES (?,?,?,?,?,?,?,?)', [id,String(body.merchant_id||'default'),body.register_id||null,body.shift_id||null,body.operator_id||null,movementType,amount,JSON.stringify(sanitizeForStorage(body.metadata||{}))]);
    return { id, movement_type:movementType, amount_cents:amount };
  }

  return { listTransactions, importSettlements, summary, cashSummary, addCashMovement };
}

module.exports = { createReconciliationService };
