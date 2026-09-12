'use strict';
const { PaymentProvider } = require('./base');
const { verifyHmac, assertNoRawCardData } = require('../security');

class HttpAcquirerProvider extends PaymentProvider {
  constructor(name, providerConfig, appConfig) {
    super(name);
    this.providerConfig = providerConfig;
    this.appConfig = appConfig;
  }
  capabilities() {
    return {
      methods: ['pix', 'debit_card', 'credit_card'], refunds: true, cancellation: true, webhooks: true,
      configured: Boolean(this.providerConfig.bridgeUrl && this.providerConfig.bridgeToken),
      integrationMode: 'bridge'
    };
  }
  ensureConfigured() {
    if (!this.capabilities().configured) {
      const err = new Error(`${this.name} bridge is not configured`);
      err.code = 'PROVIDER_NOT_CONFIGURED'; err.status = 503; throw err;
    }
  }
  async request(path, payload) {
    this.ensureConfigured();
    assertNoRawCardData(payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.appConfig.httpTimeoutMs);
    try {
      const response = await fetch(`${this.providerConfig.bridgeUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.providerConfig.bridgeToken}`, 'idempotency-key': String(payload.payment_id || payload.refund_id || '') },
        body: JSON.stringify(payload), signal: controller.signal
      });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
      if (!response.ok) {
        const err = new Error(`${this.name} bridge returned HTTP ${response.status}`);
        err.code = 'PROVIDER_HTTP_ERROR'; err.status = 502; err.providerData = data; throw err;
      }
      assertNoRawCardData(data);
      return data;
    } finally { clearTimeout(timer); }
  }
  async createPayment(intent) {
    const data = await this.request('/v1/payments', {
      payment_id: intent.id, source_module: intent.source_module, source_reference: intent.source_reference,
      amount_cents: intent.amount_cents, currency: intent.currency, method: intent.method,
      installments: intent.installments, merchant_id: intent.merchant_id, metadata: intent.metadata || {}
    });
    return { status: String(data.status || 'PENDING').toUpperCase(), externalId: data.external_id, nextAction: data.next_action || null, providerData: data };
  }
  async cancelPayment(intent) {
    const data = await this.request(`/v1/payments/${encodeURIComponent(intent.external_id)}/cancel`, { payment_id: intent.id });
    return { status: String(data.status || 'CANCELED').toUpperCase(), externalId: data.external_id || intent.external_id, providerData: data };
  }
  async refundPayment(intent, refund) {
    const data = await this.request(`/v1/payments/${encodeURIComponent(intent.external_id)}/refunds`, {
      payment_id: intent.id, refund_id: refund.id, amount_cents: refund.amountCents, reason: refund.reason || null
    });
    return { status: String(data.status || 'PENDING').toUpperCase(), externalId: data.external_id, providerData: data };
  }
  verifyWebhook({ rawBody, headers }) {
    return verifyHmac(this.providerConfig.webhookSecret, rawBody, headers['x-webhook-signature']);
  }
  normalizeWebhook(body) {
    if (!body || !body.event_id || !body.external_id || !body.status) {
      const err = new Error('Invalid normalized acquirer webhook'); err.code = 'INVALID_WEBHOOK'; err.status = 422; throw err;
    }
    return {
      providerEventId: String(body.event_id),
      paymentId: body.payment_id ? String(body.payment_id) : null,
      externalId: String(body.external_id),
      status: String(body.status).toUpperCase(),
      details: body.details || {}
    };
  }
}

module.exports = { HttpAcquirerProvider };
