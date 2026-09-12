'use strict';
const mysql = require('mysql2/promise');

function createDb(config) {
  const pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.name,
    waitForConnections: true,
    connectionLimit: config.db.poolSize,
    queueLimit: 0,
    decimalNumbers: true,
    timezone: 'Z',
    charset: 'utf8mb4'
  });

  async function query(sql, params = []) {
    const [rows] = await pool.execute(sql, params);
    return rows;
  }

  async function transaction(fn) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async function initSchema() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS payment_intents (
        id CHAR(36) PRIMARY KEY,
        source_module VARCHAR(64) NOT NULL,
        source_reference VARCHAR(128) NOT NULL,
        merchant_id VARCHAR(64) NOT NULL DEFAULT 'default',
        idempotency_key VARCHAR(128) NOT NULL,
        request_hash CHAR(64) NOT NULL,
        method VARCHAR(32) NOT NULL,
        provider VARCHAR(32) NOT NULL,
        amount_cents BIGINT UNSIGNED NOT NULL,
        currency CHAR(3) NOT NULL DEFAULT 'BRL',
        installments INT UNSIGNED NOT NULL DEFAULT 1,
        status VARCHAR(32) NOT NULL,
        external_id VARCHAR(160) NULL,
        next_action_json JSON NULL,
        metadata_json JSON NULL,
        provider_data_json JSON NULL,
        approved_at DATETIME(3) NULL,
        canceled_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_payment_idempotency (source_module, idempotency_key),
        KEY ix_payment_source_ref (source_module, source_reference),
        KEY ix_payment_external (provider, external_id),
        KEY ix_payment_status_created (status, created_at),
        KEY ix_payment_merchant_created (merchant_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
      `CREATE TABLE IF NOT EXISTS payment_events (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        payment_id CHAR(36) NOT NULL,
        provider VARCHAR(32) NOT NULL,
        provider_event_id VARCHAR(160) NULL,
        event_type VARCHAR(64) NOT NULL,
        from_status VARCHAR(32) NULL,
        to_status VARCHAR(32) NULL,
        payload_json JSON NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_provider_event (provider, provider_event_id),
        KEY ix_events_payment (payment_id, id),
        CONSTRAINT fk_events_payment FOREIGN KEY (payment_id) REFERENCES payment_intents(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
      `CREATE TABLE IF NOT EXISTS payment_jobs (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        payment_id CHAR(36) NOT NULL,
        job_type VARCHAR(32) NOT NULL,
        resource_key VARCHAR(190) NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'READY',
        attempts INT UNSIGNED NOT NULL DEFAULT 0,
        max_attempts INT UNSIGNED NOT NULL DEFAULT 12,
        run_after DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        locked_by VARCHAR(80) NULL,
        locked_at DATETIME(3) NULL,
        last_error VARCHAR(500) NULL,
        payload_json JSON NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_payment_job (payment_id, job_type),
        KEY ix_payment_jobs_ready (status, run_after, id),
        KEY ix_payment_jobs_resource (resource_key, status),
        CONSTRAINT fk_jobs_payment FOREIGN KEY (payment_id) REFERENCES payment_intents(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
      `CREATE TABLE IF NOT EXISTS refunds (
        id CHAR(36) PRIMARY KEY,
        payment_id CHAR(36) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        amount_cents BIGINT UNSIGNED NOT NULL,
        status VARCHAR(32) NOT NULL,
        external_id VARCHAR(160) NULL,
        reason VARCHAR(255) NULL,
        provider_data_json JSON NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_refund_idempotency (payment_id, idempotency_key),
        KEY ix_refunds_payment (payment_id),
        CONSTRAINT fk_refunds_payment FOREIGN KEY (payment_id) REFERENCES payment_intents(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
      `CREATE TABLE IF NOT EXISTS webhook_receipts (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        provider VARCHAR(32) NOT NULL,
        provider_event_id VARCHAR(160) NOT NULL,
        external_id VARCHAR(160) NULL,
        payload_json JSON NULL,
        processed_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_webhook_event (provider, provider_event_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
      `CREATE TABLE IF NOT EXISTS reconciliation_records (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        provider VARCHAR(32) NOT NULL,
        batch_id VARCHAR(128) NOT NULL,
        provider_record_id VARCHAR(160) NOT NULL,
        external_id VARCHAR(160) NULL,
        payment_id CHAR(36) NULL,
        gross_amount_cents BIGINT NOT NULL,
        fee_amount_cents BIGINT NOT NULL DEFAULT 0,
        net_amount_cents BIGINT NOT NULL,
        settled_at DATETIME(3) NULL,
        match_status VARCHAR(32) NOT NULL,
        details_json JSON NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_recon_provider_record (provider, provider_record_id),
        KEY ix_recon_batch (provider, batch_id),
        KEY ix_recon_payment (payment_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
      `CREATE TABLE IF NOT EXISTS cash_movements (
        id CHAR(36) PRIMARY KEY,
        payment_id CHAR(36) NULL,
        merchant_id VARCHAR(64) NOT NULL DEFAULT 'default',
        register_id VARCHAR(64) NULL,
        shift_id VARCHAR(64) NULL,
        operator_id VARCHAR(64) NULL,
        movement_type VARCHAR(32) NOT NULL,
        amount_cents BIGINT NOT NULL,
        metadata_json JSON NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY ix_cash_shift (merchant_id, shift_id, created_at),
        KEY ix_cash_payment (payment_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
      `CREATE TABLE IF NOT EXISTS outbox_events (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        event_id CHAR(36) NOT NULL,
        event_type VARCHAR(80) NOT NULL,
        aggregate_id CHAR(36) NOT NULL,
        payload_json JSON NOT NULL,
        attempts INT UNSIGNED NOT NULL DEFAULT 0,
        next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        delivered_at DATETIME(3) NULL,
        last_error VARCHAR(500) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_outbox_event_id (event_id),
        KEY ix_outbox_pending (delivered_at, next_attempt_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
    ];
    for (const sql of statements) await query(sql);
  }

  async function ping() {
    await query('SELECT 1 AS ok');
    return true;
  }

  return { pool, query, transaction, initSchema, ping };
}

module.exports = { createDb };
