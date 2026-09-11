'use strict';
const crypto = require('crypto');
const { hmacHex } = require('../security');

function createOutboxService({ db, config }) {
  let timer = null;
  let running = false;

  async function enqueue(connOrDb, eventType, aggregateId, payload) {
    const eventId = crypto.randomUUID();
    const sql = `INSERT INTO outbox_events (event_id,event_type,aggregate_id,payload_json) VALUES (?,?,?,?)`;
    const params = [eventId, eventType, aggregateId, JSON.stringify({ event_id: eventId, event_type: eventType, occurred_at: new Date().toISOString(), data: payload })];
    if (connOrDb.execute) await connOrDb.execute(sql, params); else await connOrDb.query(sql, params);
    return eventId;
  }

  async function deliverOne(row) {
    if (!config.backoffice.url) return false;
    const payload = typeof row.payload_json === 'string' ? row.payload_json : JSON.stringify(row.payload_json);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);
    try {
      const headers = { 'content-type': 'application/json', 'x-event-id': row.event_id };
      if (config.backoffice.secret) headers['x-webhook-signature'] = `sha256=${hmacHex(config.backoffice.secret, Buffer.from(payload))}`;
      const response = await fetch(config.backoffice.url, { method: 'POST', headers, body: payload, signal: controller.signal });
      if (!response.ok) throw new Error(`Backoffice HTTP ${response.status}`);
      await db.query('UPDATE outbox_events SET delivered_at=CURRENT_TIMESTAMP(3), last_error=NULL WHERE id=?', [row.id]);
      return true;
    } catch (err) {
      const attempts = Number(row.attempts) + 1;
      const delaySeconds = Math.min(3600, Math.max(5, 2 ** Math.min(attempts, 10)));
      await db.query('UPDATE outbox_events SET attempts=?, next_attempt_at=DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND), last_error=? WHERE id=?', [attempts, delaySeconds, String(err.message).slice(0, 500), row.id]);
      return false;
    } finally { clearTimeout(timeout); }
  }

  async function flush() {
    if (running || !config.backoffice.url) return;
    running = true;
    try {
      const rows = await db.query('SELECT * FROM outbox_events WHERE delivered_at IS NULL AND attempts < ? AND next_attempt_at <= CURRENT_TIMESTAMP(3) ORDER BY id ASC LIMIT 50', [config.outbox.maxAttempts]);
      for (const row of rows) await deliverOne(row);
    } finally { running = false; }
  }

  function start() { if (!timer) { timer = setInterval(() => flush().catch(err => console.error('[outbox]', err)), config.outbox.pollMs); timer.unref?.(); } }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { enqueue, flush, start, stop };
}

module.exports = { createOutboxService };
