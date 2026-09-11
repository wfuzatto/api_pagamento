'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createProviders}=require('../src/providers');const {normalizeMethod}=require('../src/services/payment-service');
const config={mock:{autoApprove:true,webhookSecret:'x'},acquirers:{getnet:{bridgeUrl:'',bridgeToken:'',webhookSecret:''},rede:{bridgeUrl:'',bridgeToken:'',webhookSecret:''},pagbank:{bridgeUrl:'',bridgeToken:'',webhookSecret:''}},httpTimeoutMs:1000};
test('normalizes legacy method names',()=>{assert.equal(normalizeMethod('PIX'),'pix');assert.equal(normalizeMethod('DEBIT'),'debit_card');assert.equal(normalizeMethod('CREDIT'),'credit_card');assert.equal(normalizeMethod('DINHEIRO'),'cash');});
test('provider registry exposes acquirers without pretending configured',()=>{const p=createProviders(config);const list=p.list();assert.equal(list.find(x=>x.name==='getnet').configured,false);assert.equal(list.find(x=>x.name==='mock').configured,true);});
