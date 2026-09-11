'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {assertNoRawCardData,findForbiddenCardField,verifyHmac,hmacHex}=require('../src/security');

test('rejects raw card data recursively',()=>{ assert.equal(findForbiddenCardField({payment:{card_number:'4111'}}),'$.payment.card_number'); assert.throws(()=>assertNoRawCardData({cvv:'123'}),/Raw card data/); });
test('accepts tokens and transaction ids',()=>{ assert.doesNotThrow(()=>assertNoRawCardData({card_token:'tok_123',nsu:'42'})); });
test('verifies hmac',()=>{ const raw=Buffer.from('{"a":1}'); const sig=hmacHex('secret',raw); assert.equal(verifyHmac('secret',raw,`sha256=${sig}`),true); assert.equal(verifyHmac('secret',raw,'bad'),false); });
