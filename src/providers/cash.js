'use strict';
const { PaymentProvider } = require('./base');

class CashProvider extends PaymentProvider {
  constructor() { super('cash'); }
  capabilities() { return { methods: ['cash'], refunds: true, cancellation: true, webhooks: false, configured: true, manualConfirmation: true }; }
  async createPayment(intent) {
    return {
      status: 'PENDING', externalId: `CASH-${intent.id}`,
      nextAction: { type: 'CASH_CONFIRMATION', message: 'Aguardando confirmacao de recebimento do dinheiro' }
    };
  }
  async cancelPayment(intent) { return { status: 'CANCELED', externalId: intent.external_id }; }
  async refundPayment(intent, refund) { return { status: 'APPROVED', externalId: `CASH-REFUND-${refund.id}`, providerData: { manual_cash_refund: true } }; }
}

module.exports = { CashProvider };
