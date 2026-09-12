'use strict';
const crypto = require('crypto');
const { sanitizeForStorage } = require('../security');

function createPaymentJobService({ db, config, providers, outbox }) {
  let timer = null;
  let running = 0;
  let paymentService = null;
  const workerId = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const paymentFinalStates = new Set(['APPROVED','DECLINED','CANCELED','EXPIRED','ERROR','REFUNDED']);

  function terminalIdFrom(metadata = {}) {
    return String(metadata.terminal_id || metadata.pinpad_id || metadata.device_id || '').trim();
  }

  function resourceKey(payment, metadata = {}) {
    const terminalId = terminalIdFrom(metadata);
    if (!terminalId) return null;
    return `${payment.merchant_id || 'default'}:${payment.provider}:${terminalId}`.slice(0, 190);
  }

  async function enqueueAuthorize(conn, payment, metadata = {}) {
    await conn.execute(
      `INSERT INTO payment_jobs (payment_id,job_type,resource_key,status,attempts,max_attempts,run_after,payload_json)
       VALUES (?,?,?,?,0,?,CURRENT_TIMESTAMP(3),?)`,
      [payment.id, 'AUTHORIZE', resourceKey(payment, metadata), 'READY', config.jobs.maxAttempts, JSON.stringify({ metadata: sanitizeForStorage(metadata) })]
    );
  }

  async function acquireTefTerminal(payment, metadata) {
    if (payment.provider !== 'tef') return;
    const terminalId = terminalIdFrom(metadata);
    if (!terminalId) {
      const err = new Error('terminal_id is required for TEF');
      err.code = 'TEF_TERMINAL_REQUIRED'; err.status = 422;
      throw err;
    }
    await db.transaction(async conn => {
      await conn.execute(
        `INSERT INTO payment_terminals (terminal_id,provider,status,metadata_json)
         VALUES (?,'tef','READY',?)
         ON DUPLICATE KEY UPDATE provider='tef', metadata_json=VALUES(metadata_json)`,
        [terminalId, JSON.stringify(sanitizeForStorage({ merchant_id:payment.merchant_id || null }))]
      );
      const [rows] = await conn.execute('SELECT * FROM payment_terminals WHERE terminal_id=? FOR UPDATE', [terminalId]);
      const terminal = rows[0];
      if (terminal?.active_payment_id && terminal.active_payment_id !== payment.id) {
        const [activeRows] = await conn.execute('SELECT status FROM payment_intents WHERE id=? LIMIT 1', [terminal.active_payment_id]);
        const activeStatus = String(activeRows[0]?.status || 'UNKNOWN');
        if (!paymentFinalStates.has(activeStatus)) {
          const err = new Error(`TEF terminal busy: ${terminalId}`);
          err.code = 'TEF_TERMINAL_BUSY'; err.status = 409; err.retryable = true;
          throw err;
        }
      }
      await conn.execute(
        `UPDATE payment_terminals
         SET status='BUSY',active_payment_id=?,heartbeat_at=CURRENT_TIMESTAMP(3),lease_until=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 10 MINUTE)
         WHERE terminal_id=?`,
        [payment.id, terminalId]
      );
    });
  }

  async function reflectTefTerminal(payment, metadata, result) {
    if (payment.provider !== 'tef') return;
    const terminalId = terminalIdFrom(metadata);
    if (!terminalId) return;
    const status = String(result?.status || 'UNKNOWN').toUpperCase();
    if (paymentFinalStates.has(status)) {
      await db.query(
        `UPDATE payment_terminals SET status='READY',active_payment_id=NULL,heartbeat_at=CURRENT_TIMESTAMP(3),lease_until=NULL
         WHERE terminal_id=? AND active_payment_id=?`, [terminalId, payment.id]
      );
    } else {
      await db.query(
        `UPDATE payment_terminals SET status=?,heartbeat_at=CURRENT_TIMESTAMP(3),lease_until=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 10 MINUTE)
         WHERE terminal_id=? AND active_payment_id=?`, [status, terminalId, payment.id]
      );
    }
  }

  async function markDone(jobId) {
    await db.query('UPDATE payment_jobs SET status="DONE",locked_by=NULL,locked_at=NULL,last_error=NULL WHERE id=?', [jobId]);
  }

  async function reschedule(job, error) {
    const attempts = Number(job.attempts || 0);
    const exhausted = attempts >= Number(job.max_attempts || config.jobs.maxAttempts);
    if (exhausted) {
      await db.query('UPDATE payment_jobs SET status="FAILED",locked_by=NULL,locked_at=NULL,last_error=? WHERE id=?', [String(error.message || error).slice(0, 500), job.id]);
      if (paymentService) await paymentService.markProcessingFailure(job.payment_id, error, true);
      return;
    }
    const delaySeconds = Math.min(config.jobs.maxBackoffSeconds, Math.max(2, 2 ** Math.min(attempts, 9)));
    await db.query(
      'UPDATE payment_jobs SET status="READY",run_after=DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND),locked_by=NULL,locked_at=NULL,last_error=? WHERE id=?',
      [delaySeconds, String(error.message || error).slice(0, 500), job.id]
    );
    if (paymentService) await paymentService.markProcessingFailure(job.payment_id, error, false);
  }

  async function claimOne() {
    return db.transaction(async conn => {
      const [rows] = await conn.execute(
        `SELECT * FROM payment_jobs
         WHERE status='READY' AND run_after<=CURRENT_TIMESTAMP(3)
         ORDER BY id ASC
         LIMIT 1 FOR UPDATE SKIP LOCKED`
      );
      const job = rows[0];
      if (!job) return null;
      await conn.execute(
        `UPDATE payment_jobs SET status='PROCESSING',attempts=attempts+1,locked_by=?,locked_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
        [workerId, job.id]
      );
      job.status = 'PROCESSING';
      job.attempts = Number(job.attempts || 0) + 1;
      job.locked_by = workerId;
      return job;
    });
  }

  async function withResourceLock(resource, fn) {
    if (!resource) return fn();
    const conn = await db.pool.getConnection();
    const lockName = `pay:${resource}`.slice(0, 64);
    try {
      const [rows] = await conn.execute('SELECT GET_LOCK(?,0) AS acquired', [lockName]);
      if (!Number(rows[0]?.acquired)) {
        const err = new Error(`Payment resource busy: ${resource}`);
        err.code = 'PAYMENT_RESOURCE_BUSY';
        err.retryable = true;
        throw err;
      }
      return await fn();
    } finally {
      try { await conn.execute('SELECT RELEASE_LOCK(?)', [lockName]); } catch (_) {}
      conn.release();
    }
  }

  async function processJob(job) {
    const rows = await db.query('SELECT * FROM payment_intents WHERE id=? LIMIT 1', [job.payment_id]);
    const payment = rows[0];
    if (!payment) return markDone(job.id);
    if (paymentFinalStates.has(String(payment.status))) return markDone(job.id);

    const payload = typeof job.payload_json === 'string' ? JSON.parse(job.payload_json || '{}') : (job.payload_json || {});
    const metadata = payload.metadata || {};
    try {
      await withResourceLock(job.resource_key, async () => {
        await acquireTefTerminal(payment, metadata);
        const provider = providers.get(payment.provider);
        const result = await provider.createPayment({ ...payment, metadata });
        await paymentService.applyProviderCreateResult(payment.id, result);
        await reflectTefTerminal(payment, metadata, result);
      });
      await markDone(job.id);
    } catch (error) {
      await reschedule(job, error);
    }
  }

  async function pump() {
    while (running < config.jobs.concurrency) {
      const job = await claimOne();
      if (!job) break;
      running += 1;
      processJob(job)
        .catch(err => console.error('[payment-jobs]', err))
        .finally(() => { running -= 1; setImmediate(() => pump().catch(err => console.error('[payment-jobs]', err))); });
    }
  }

  async function recoverStale() {
    await db.query(
      `UPDATE payment_jobs
       SET status='READY',locked_by=NULL,locked_at=NULL,run_after=CURRENT_TIMESTAMP(3),last_error='Recovered stale worker lock'
       WHERE status='PROCESSING' AND locked_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND)`,
      [config.jobs.staleSeconds]
    );
  }

  function bindPaymentService(service) { paymentService = service; }
  function start() {
    if (timer) return;
    recoverStale().then(() => pump()).catch(err => console.error('[payment-jobs]', err));
    timer = setInterval(() => pump().catch(err => console.error('[payment-jobs]', err)), config.jobs.pollMs);
    timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { enqueueAuthorize, bindPaymentService, start, stop, pump, recoverStale };
}

module.exports = { createPaymentJobService };
