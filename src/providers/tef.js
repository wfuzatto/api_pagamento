'use strict';
const { PaymentProvider } = require('./base');

class TefProvider extends PaymentProvider {
  constructor(config) {
    super('tef');
    this.config = config;
  }

  capabilities() {
    return {
      methods: ['debit_card', 'credit_card'],
      refunds: true,
      cancellation: true,
      confirmation: true,
      webhooks: false,
      configured: Boolean(this.config?.tef?.agentUrl && this.config?.tef?.agentToken)
    };
  }

  async request(path, options = {}) {
    if (!this.capabilities().configured) {
      const err = new Error('TEF agent not configured');
      err.code = 'TEF_NOT_CONFIGURED';
      err.status = 503;
      throw err;
    }
    const controller = new AbortController();
    const timeout = Number(this.config.tef.timeoutMs || 5000);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${this.config.tef.agentUrl.replace(/\/$/, '')}${path}`, {
        method: options.method || 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.config.tef.agentToken}`,
          ...(options.body ? {'content-type':'application/json'} : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const err = new Error(data.message || data.error || `TEF agent HTTP ${response.status}`);
        err.code = data.error || 'TEF_AGENT_ERROR';
        err.status = response.status >= 400 && response.status < 500 ? response.status : 502;
        err.retryable = response.status >= 500;
        throw err;
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') {
        const timeoutErr = new Error('TEF agent timeout');
        timeoutErr.code = 'TEF_AGENT_TIMEOUT';
        timeoutErr.status = 504;
        timeoutErr.retryable = true;
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  normalizeTransaction(data) {
    const status = String(data.status || 'PENDING').toUpperCase();
    const nextAction = data.next_action || (['WAITING_TERMINAL','WAITING_CARD','CARD_READ','WAITING_PIN','PROCESSING','AUTHORIZED'].includes(status)
      ? { type:'TERMINAL', state: status, terminal_id: data.terminal_id || null }
      : null);
    const mappedStatus = status === 'AUTHORIZED' ? 'AUTHORIZED' :
      ['WAITING_TERMINAL','WAITING_CARD','CARD_READ','WAITING_PIN','PROCESSING'].includes(status) ? 'ACTION_REQUIRED' : status;
    return {
      status: mappedStatus,
      externalId: data.id || data.transaction_id || data.external_id || null,
      nextAction,
      providerData: {
        terminal_id: data.terminal_id || null,
        tef_status: status,
        authorization_code: data.authorization_code || null,
        nsu: data.nsu || null,
        network: data.network || null,
        brand: data.brand || null,
        receipt: data.receipt || null
      }
    };
  }

  async createPayment(intent) {
    const terminalId = String(intent.metadata?.terminal_id || intent.metadata?.pinpad_id || '').trim();
    if (!terminalId) {
      const err = new Error('terminal_id is required for TEF payments');
      err.code = 'TEF_TERMINAL_REQUIRED';
      err.status = 422;
      throw err;
    }
    const data = await this.request('/v1/transactions', {
      method:'POST',
      body:{
        payment_id:intent.id,
        terminal_id:terminalId,
        amount_cents:Number(intent.amount_cents),
        currency:intent.currency || 'BRL',
        method:intent.method,
        installments:Number(intent.installments || 1),
        metadata:{ source_module:intent.source_module, source_reference:intent.source_reference, merchant_id:intent.merchant_id }
      }
    });
    return this.normalizeTransaction(data);
  }

  async getTransaction(externalId) {
    return this.normalizeTransaction(await this.request(`/v1/transactions/${encodeURIComponent(externalId)}`));
  }

  async confirmPayment(intent) {
    const data = await this.request(`/v1/transactions/${encodeURIComponent(intent.external_id)}/confirm`, {method:'POST'});
    return this.normalizeTransaction(data);
  }

  async cancelPayment(intent) {
    if (!intent.external_id) return {status:'CANCELED', externalId:null};
    const data = await this.request(`/v1/transactions/${encodeURIComponent(intent.external_id)}/cancel`, {method:'POST'});
    return this.normalizeTransaction(data);
  }

  async refundPayment(intent, refund) {
    const data = await this.request(`/v1/transactions/${encodeURIComponent(intent.external_id)}/refund`, {
      method:'POST', body:{ refund_id:refund.id, amount_cents:refund.amountCents, reason:refund.reason || null }
    });
    const result = this.normalizeTransaction(data);
    return { ...result, externalId: data.refund_id || result.externalId };
  }
}

module.exports = { TefProvider };
