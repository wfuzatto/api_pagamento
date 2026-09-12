'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { TefProvider, mapAgentStatus } = require('../src/providers/tef');

test('TEF provider maps interactive states and starts terminal transaction', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => ({
    ok: true,
    status: 202,
    json: async () => ({ session_id: 'session-1', terminal_id: 'TEF-01', status: 'QUEUED' })
  });
  try {
    const provider = new TefProvider({ tef: { agentUrl: 'http://agent:8766', agentToken: 'token', webhookSecret: 'secret', defaultTerminalId: 'TEF-01', timeoutMs: 1000 }, httpTimeoutMs: 1000 });
    const result = await provider.createPayment({ id: 'pay-1', amount_cents: 1500, method: 'credit_card', installments: 1, metadata: {} });
    assert.equal(result.status, 'ACTION_REQUIRED');
    assert.equal(result.externalId, 'session-1');
    assert.equal(result.nextAction.state, 'QUEUED');
    assert.equal(provider.capabilities().confirmation, true);
    assert.equal(mapAgentStatus('AUTHORIZED'), 'AUTHORIZED');
  } finally {
    global.fetch = originalFetch;
  }
});

test('TEF provider verifies signed callbacks and preserves authorized state', () => {
  const secret = 'webhook-secret';
  const provider = new TefProvider({ tef: { agentUrl: 'http://agent:8766', agentToken: 'token', webhookSecret: secret } });
  const body = { event_id: 'evt-1', payment_id: 'pay-1', external_id: 'session-1', terminal_id: 'TEF-01', status: 'AUTHORIZED', details: { nsu: '123' } };
  const raw = Buffer.from(JSON.stringify(body));
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(provider.verifyWebhook({ rawBody: raw, headers: { 'x-webhook-signature': `sha256=${signature}` } }), true);
  const event = provider.normalizeWebhook(body);
  assert.equal(event.status, 'AUTHORIZED');
  assert.equal(event.paymentId, 'pay-1');
  assert.equal(event.details.next_action.type, 'CONFIRM_PAYMENT');
});
