'use strict';
const { MockProvider } = require('./mock');
const { CashProvider } = require('./cash');
const { HttpAcquirerProvider } = require('./http-acquirer');
const { TefProvider } = require('./tef');

function createProviders(config) {
  const providers = new Map();
  providers.set('mock', new MockProvider(config));
  providers.set('cash', new CashProvider());
  providers.set('tef', new TefProvider(config));
  for (const name of ['getnet', 'rede', 'pagbank']) providers.set(name, new HttpAcquirerProvider(name, config.acquirers[name], config));

  function get(name) {
    const provider = providers.get(String(name || '').toLowerCase());
    if (!provider) { const err = new Error(`Unknown provider: ${name}`); err.code = 'UNKNOWN_PROVIDER'; err.status = 422; throw err; }
    return provider;
  }
  function list() { return [...providers.values()].map(p => ({ name: p.name, ...p.capabilities() })); }
  return { get, list };
}

module.exports = { createProviders };
