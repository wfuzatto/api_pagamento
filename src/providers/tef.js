'use strict';

const crypto = require('crypto');
const { PaymentProvider } = require('./base');
const { verifyHmac } = require('../security');

function mapAgentStatus(status) {
  const value = String(status || '').toUpperCase();
  if (['QUEUED','WAITING_CARD','CARD_READ','WAITING_PIN','PROCESSING'].includes(value)) return 'ACTION_REQUIRED';
  if (value === 'AUTHORIZED') return 'AUTHORIZED';
  if (value === 'APPROVED') return 'APPROVED';
  if (value === 'DECLINED') return 'DECLINED';
  if (value === 'CANCELED' || value === 'CANCELLED') return 'CANCELED';
  if (value === 'ERROR') return 'ERROR';
  if (value === 'REFUNDED') return 'REFUNDED';
  return 'UNKNOWN';
}

function nextActionFor(status, terminalId) {
  const value = String(status || '').toUpperCase();
  if (['QUEUED','WAITING_CARD','CARD_READ','WAITING_PIN','PROCESSING'].includes(value)) {
    return { type: 'TERMINAL', terminal_id: terminalId || null, state: value };
  }
  if (value === 'AUTHORIZED') return { type: 'CONFIRM_PAYMENT', terminal_id: terminalId || null, state: 'AUTHORIZED' };
  return null;
}

class TefProvider extends PaymentProvider {
  constructor(config) {
    super('tef');
    this.config = config;
    this.tef = config.tef || {};
  }

  capabilities() {
    return {
      methods: ['debit_card','credit_card'],
      refunds: true,
      cancellation: true,
      confirmation: true,
      webhooks: true,
      configured: Boolean(this.tef.agentUrl && this.tef.agentToken)
    };
  }

  async request(path, { method = 'GET', body = null } = {}) {
    if (!this.tef.agentUrl || !this.tef.agentToken) {
      const err = new Error('TEF agent not configured');
      err.code = 'TEF_NOT_CONFIGURED';
      err.status = 503;
      throw err;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.tef.timeoutMs || this.config.httpTimeoutMs || 15000);
    try {
      const headers = { accept: 'application/json', 'x-tef-token': this.tef.agentToken };
      if (body !== null) headers['content-type'] = 'application/json';
      const response = await fetch(`${this.tef.agentUrl.replace(/\/$/,'')}${path}`, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const err = new Error(data.message || data.error || `TEF agent HTTP ${response.status}`);
        err.code = data.error || 'TEF_AGENT_ERROR';
        err.status = response.status >= 500 ? 503 : response.status;
        err.retryable = response.status >= 500 || response.status === 409;
        throw err;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        const err = new Error('TEF agent timeout');
        err.code = 'TEF_AGENT_TIMEOUT';
        err.status = 503;
        err.retryable = true;
        throw err;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async createPayment(intent) {
    const terminalId = String(intent.metadata?.terminal_id || this.tef.defaultTerminalId || '').trim();
    if (!terminalId) {
      const err = new Error('terminal_id is required for TEF payments');
      err.code = 'TEF_TERMINAL_REQUIRED';
      err.status = 422;
      throw err;
    }
    const tx = await this.request('/v1/transactions', {
      method: 'POST',
      body: {
        payment_id: intent.id,
        terminal_id: terminalId,
        amount_cents: Number(intent.amount_cents),
        method: intent.method,
        installments: Number(intent.installments || 1)
      }
    });
    return {
      status: mapAgentStatus(tx.status),
      externalId: tx.session_id,
      nextAction: nextActionFor(tx.status, terminalId),
      providerData: { terminal_id: terminalId, tef_state: tx.status, session_id: tx.session_id }
    };
  }

  async confirmPayment(intent) {
    const tx = await this.request(`/v1/transactions/${encodeURIComponent(intent.external_id)}/confirm`, { method: 'POST', body: {} });
    return {
      status: mapAgentStatus(tx.status),
      externalId: tx.session_id || intent.external_id,
      providerData: { terminal_id: tx.terminal_id || null, tef_state: tx.status, nsu: tx.nsu || null, authorization_code: tx.authorization_code || null, receipt: tx.receipt || null }
    };
  }

  async cancelPayment(intent) {
    const tx = await this.request(`/v1/transactions/${encodeURIComponent(intent.external_id)}/cancel`, { method: 'POST', body: {} });
    return { status: mapAgentStatus(tx.status), externalId: tx.session_id || intent.external_id, providerData: { terminal_id: tx.terminal_id || null, tef_state: tx.status } };
  }

  async refundPayment(intent, refund) {
    const tx = await this.request(`/v1/transactions/${encodeURIComponent(intent.external_id)}/refund`, { method: 'POST', body: { amount_cents: refund.amountCents } });
    return {
      status: String(tx.status).toUpperCase() === 'REFUNDED' ? 'APPROVED' : mapAgentStatus(tx.status),
      externalId: `TEF-R-${refund.id}`,
      providerData: { terminal_id: tx.terminal_id || null, tef_state: tx.status, session_id: tx.session_id || intent.external_id }
    };
  }

  verifyWebhook({ rawBody, headers }) {
    return verifyHmac(this.tef.webhookSecret, rawBody, headers['x-webhook-signature']);
  }

  normalizeWebhook(body) {
    const terminalId = body.terminal_id || body.details?.terminal_id || null;
    const agentStatus = String(body.status || '').toUpperCase();
    return {
      providerEventId: String(body.event_id || crypto.randomUUID()),
      externalId: body.external_id ? String(body.external_id) : null,
      paymentId: body.payment_id ? String(body.payment_id) : null,
      status: mapAgentStatus(agentStatus),
      details: {
        ...(body.details || {}),
        terminal_id: terminalId,
        tef_state: agentStatus,
        next_action: nextActionFor(agentStatus, terminalId)
      }
    };
  }
}

module.exports = { TefProvider, mapAgentStatus, nextActionFor };
