'use strict';
const crypto = require('crypto');
const { PaymentProvider } = require('./base');
const { verifyHmac } = require('../security');

class MockProvider extends PaymentProvider {
  constructor(config) { super('mock'); this.config = config; }
  capabilities() {
    return { methods: ['pix', 'debit_card', 'credit_card'], refunds: true, cancellation: true, webhooks: true, configured: true, simulation: true };
  }
  async createPayment(intent) {
    const externalId = `MOCK-${crypto.randomUUID()}`;
    if (this.config.mock.autoApprove) return { status: 'APPROVED', externalId, providerData: { simulated: true } };
    return {
      status: 'PENDING', externalId,
      nextAction: intent.method === 'pix'
        ? { type: 'PIX_QR_CODE', copy_paste: `000201-MOCK-${intent.id}`, expires_in_seconds: 900 }
        : { type: 'WAIT_PROVIDER', message: 'Aguardando evento de homologacao' },
      providerData: { simulated: true }
    };
  }
  async cancelPayment(intent) { return { status: 'CANCELED', externalId: intent.external_id, providerData: { simulated: true } }; }
  async refundPayment(intent, refund) { return { status: 'APPROVED', externalId: `MOCK-R-${crypto.randomUUID()}`, providerData: { simulated: true, amount_cents: refund.amountCents } }; }
  verifyWebhook({ rawBody, headers }) {
    return verifyHmac(this.config.mock.webhookSecret, rawBody, headers['x-webhook-signature']);
  }
  normalizeWebhook(body) {
    if (!body || !body.event_id || !body.external_id || !body.status) {
      const err = new Error('Invalid mock webhook'); err.code = 'INVALID_WEBHOOK'; err.status = 422; throw err;
    }
    return { providerEventId: String(body.event_id), externalId: String(body.external_id), status: String(body.status).toUpperCase(), details: body.details || {} };
  }
}

module.exports = { MockProvider };
