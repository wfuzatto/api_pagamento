'use strict';

function integer(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
function providerConfig(prefix) {
  return {
    bridgeUrl: process.env[`PAYMENT_${prefix}_BRIDGE_URL`] || '',
    bridgeToken: process.env[`PAYMENT_${prefix}_BRIDGE_TOKEN`] || '',
    webhookSecret: process.env[`PAYMENT_${prefix}_WEBHOOK_SECRET`] || ''
  };
}

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: integer(process.env.PORT, 3090),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: integer(process.env.DB_PORT, 3306),
    name: process.env.DB_NAME || 'api_pagamento',
    user: process.env.DB_USER || 'payment_app',
    password: process.env.DB_PASSWORD || '',
    poolSize: integer(process.env.DB_POOL_SIZE, 20)
  },
  apiKey: process.env.PAYMENT_API_KEY || '',
  providers: {
    cash: process.env.PAYMENT_PROVIDER_CASH || 'cash',
    pix: process.env.PAYMENT_PROVIDER_PIX || 'mock',
    debit_card: process.env.PAYMENT_PROVIDER_DEBIT || 'mock',
    credit_card: process.env.PAYMENT_PROVIDER_CREDIT || 'mock'
  },
  tef: {
    agentUrl: process.env.TEF_AGENT_URL || '',
    agentToken: process.env.TEF_AGENT_TOKEN || '',
    timeoutMs: Math.max(1000, integer(process.env.TEF_AGENT_TIMEOUT_MS, 5000))
  },
  mock: {
    autoApprove: bool(process.env.PAYMENT_MOCK_AUTO_APPROVE, true),
    webhookSecret: process.env.PAYMENT_MOCK_WEBHOOK_SECRET || ''
  },
  acquirers: {
    getnet: providerConfig('GETNET'),
    rede: providerConfig('REDE'),
    pagbank: providerConfig('PAGBANK')
  },
  jobs: {
    pollMs: integer(process.env.PAYMENT_JOB_POLL_MS, 250),
    concurrency: Math.max(1, integer(process.env.PAYMENT_JOB_CONCURRENCY, 8)),
    maxAttempts: Math.max(1, integer(process.env.PAYMENT_JOB_MAX_ATTEMPTS, 12)),
    staleSeconds: Math.max(30, integer(process.env.PAYMENT_JOB_STALE_SECONDS, 120)),
    maxBackoffSeconds: Math.max(10, integer(process.env.PAYMENT_JOB_MAX_BACKOFF_SECONDS, 300))
  },
  backoffice: {
    url: process.env.BACKOFFICE_WEBHOOK_URL || '',
    secret: process.env.BACKOFFICE_WEBHOOK_SECRET || ''
  },
  outbox: {
    pollMs: integer(process.env.OUTBOX_POLL_MS, 5000),
    maxAttempts: integer(process.env.OUTBOX_MAX_ATTEMPTS, 20)
  },
  httpTimeoutMs: integer(process.env.HTTP_TIMEOUT_MS, 15000)
};
