'use strict';

class PaymentProvider {
  constructor(name) { this.name = name; }
  capabilities() { return { methods: [], refunds: false, cancellation: false, webhooks: false, configured: true }; }
  async createPayment() { throw new Error('NOT_IMPLEMENTED'); }
  async cancelPayment() { const err = new Error('Cancellation not supported'); err.code = 'CANCELLATION_NOT_SUPPORTED'; err.status = 422; throw err; }
  async refundPayment() { const err = new Error('Refund not supported'); err.code = 'REFUND_NOT_SUPPORTED'; err.status = 422; throw err; }
  verifyWebhook() { return false; }
  normalizeWebhook() { const err = new Error('Webhook not supported'); err.code = 'WEBHOOK_NOT_SUPPORTED'; err.status = 422; throw err; }
}

module.exports = { PaymentProvider };
