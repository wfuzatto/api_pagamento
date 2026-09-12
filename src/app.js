'use strict';
const express = require('express');
const helmet = require('helmet');
const { requireApiKey, assertNoRawCardData } = require('./security');

function createApp({ config, db, providers, paymentService, reconciliationService }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); } }));

  app.get('/', (_req,res) => res.json({ service:'api_pagamento', version:'0.2.0-tef', status:'ok', docs:'/docs/openapi.yaml' }));
  app.get('/health', async (_req,res) => {
    try { await db.ping(); res.json({ status:'ok', service:'api_pagamento', database:'ok', time:new Date().toISOString() }); }
    catch (err) { res.status(503).json({ status:'error', service:'api_pagamento', database:'error' }); }
  });
  app.get('/docs/openapi.yaml', (_req,res) => res.sendFile('openapi.yaml', { root: require('path').join(__dirname,'..','docs') }));

  app.post('/api/v1/webhooks/:provider', async (req,res,next) => {
    try { const result=await paymentService.handleWebhook(String(req.params.provider).toLowerCase(),req.body,req.rawBody,req.headers); res.status(result.duplicate?200:202).json(result); }
    catch(err){ next(err); }
  });

  const auth = requireApiKey(config);
  app.use('/api/v1', auth);

  app.get('/api/v1/providers', (_req,res) => res.json({ providers:providers.list(), defaults:config.providers }));
  app.post('/api/v1/payment-intents', async(req,res,next)=>{ try{ assertNoRawCardData(req.body); const result=await paymentService.createPayment(req.body,req.headers['idempotency-key']); res.status(result.idempotent_replay?200:201).json(result); }catch(err){next(err);} });
  app.get('/api/v1/payment-intents/:id', async(req,res,next)=>{ try{res.json(await paymentService.getPayment(req.params.id));}catch(err){next(err);} });
  app.get('/api/v1/payment-intents/:id/events', async(req,res,next)=>{ try{ const payment=await paymentService.getPayment(req.params.id); res.json({payment_id:payment.id,events:await paymentService.listEvents(req.params.id)}); }catch(err){next(err);} });
  app.post('/api/v1/payment-intents/:id/confirm', async(req,res,next)=>{ try{res.json(await paymentService.confirmPayment(req.params.id));}catch(err){next(err);} });
  app.post('/api/v1/payment-intents/:id/cancel', async(req,res,next)=>{ try{res.json(await paymentService.cancelPayment(req.params.id));}catch(err){next(err);} });
  app.post('/api/v1/payment-intents/:id/cash/confirm', async(req,res,next)=>{ try{res.json(await paymentService.confirmCash(req.params.id,req.body||{}));}catch(err){next(err);} });
  app.post('/api/v1/payment-intents/:id/refunds', async(req,res,next)=>{ try{res.status(201).json(await paymentService.refundPayment(req.params.id,req.body||{},req.headers['idempotency-key']));}catch(err){next(err);} });

  app.get('/api/v1/reconciliation/transactions', async(req,res,next)=>{ try{res.json({transactions:await reconciliationService.listTransactions(req.query)});}catch(err){next(err);} });
  app.get('/api/v1/reconciliation/summary', async(req,res,next)=>{ try{res.json(await reconciliationService.summary(req.query));}catch(err){next(err);} });
  app.post('/api/v1/reconciliation/settlements/import', async(req,res,next)=>{ try{res.status(202).json(await reconciliationService.importSettlements(req.body||{}));}catch(err){next(err);} });
  app.get('/api/v1/reconciliation/cash', async(req,res,next)=>{ try{res.json(await reconciliationService.cashSummary(req.query));}catch(err){next(err);} });
  app.post('/api/v1/cash/movements', async(req,res,next)=>{ try{res.status(201).json(await reconciliationService.addCashMovement(req.body||{}));}catch(err){next(err);} });

  app.use((req,res)=>res.status(404).json({error:'NOT_FOUND',path:req.path}));
  app.use((err,req,res,_next)=>{
    const status = Number(err.status || 500);
    if (status >= 500) console.error('[api_pagamento]', err);
    res.status(status).json({ error:err.code || 'INTERNAL_ERROR', message:status>=500?'Internal payment service error':err.message, request_id:req.headers['x-request-id'] || null });
  });
  return app;
}

module.exports = { createApp };
