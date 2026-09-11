'use strict';
const config = require('./config');
const { createDb } = require('./db');
const { createProviders } = require('./providers');
const { createOutboxService } = require('./services/outbox-service');
const { createPaymentService } = require('./services/payment-service');
const { createReconciliationService } = require('./services/reconciliation-service');
const { createApp } = require('./app');

async function main() {
  const db = createDb(config);
  await db.initSchema();
  const providers = createProviders(config);
  const outbox = createOutboxService({ db, config });
  const paymentService = createPaymentService({ db, config, providers, outbox });
  const reconciliationService = createReconciliationService({ db });
  const app = createApp({ config, db, providers, paymentService, reconciliationService });
  const server = app.listen(config.port, '0.0.0.0', () => console.log(`[api_pagamento] listening on :${config.port}`));
  outbox.start();

  const shutdown = signal => {
    console.log(`[api_pagamento] ${signal}, shutting down`);
    outbox.stop();
    server.close(async () => { await db.pool.end(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => { console.error('[api_pagamento] fatal', err); process.exit(1); });
