# api_pagamento

Gateway central de pagamentos do ecossistema do Grupo Vale da Mantiqueira. O serviço é independente dos módulos consumidores e expõe um contrato único para `totem_food`, hotelaria, totens e futuros sistemas.

## Objetivos

- dinheiro, PIX, débito e crédito;
- provedores/adquirentes plugáveis (`Getnet`, `Rede`, `PagBank` e outros);
- idempotência para impedir cobrança duplicada;
- webhooks assinados e deduplicados;
- estorno total/parcial;
- conciliação de liquidações e taxas;
- movimentos de caixa para dinheiro;
- outbox persistente para o backoffice;
- nenhum armazenamento de PAN/CVV/trilha de cartão.

## Fluxo

```text
Modulo consumidor
  -> api_pagamento
       -> cash / mock / adaptador Getnet / Rede / PagBank
       <- webhook/status
       -> MySQL api_pagamento
       -> outbox -> backoffice (opcional)
```

O método (`cash`, `pix`, `debit_card`, `credit_card`) e o provedor (`cash`, `mock`, `getnet`, `rede`, `pagbank`) são independentes. Isso permite trocar a adquirente por configuração.

## Endpoints principais

- `GET /health`
- `GET /api/v1/providers`
- `POST /api/v1/payment-intents`
- `GET /api/v1/payment-intents/:id`
- `GET /api/v1/payment-intents/:id/events`
- `POST /api/v1/payment-intents/:id/cancel`
- `POST /api/v1/payment-intents/:id/cash/confirm`
- `POST /api/v1/payment-intents/:id/refunds`
- `POST /api/v1/webhooks/:provider`
- `GET /api/v1/reconciliation/transactions`
- `GET /api/v1/reconciliation/summary`
- `POST /api/v1/reconciliation/settlements/import`
- `GET /api/v1/reconciliation/cash`
- `POST /api/v1/cash/movements`

Todas as rotas `/api/v1/*`, exceto webhooks, exigem `X-Api-Key`. Criações de pagamento e estornos exigem `Idempotency-Key`.

## Exemplo

```bash
curl -X POST http://127.0.0.1:3090/api/v1/payment-intents \
  -H 'Content-Type: application/json' \
  -H 'X-Api-Key: CHANGE_ME' \
  -H 'Idempotency-Key: order-123-attempt-1' \
  -d '{
    "source_module":"totem_food",
    "source_reference":"ORDER-123",
    "merchant_id":"vale-mantiqueira",
    "method":"PIX",
    "amount_cents":4590
  }'
```

## Adquirentes

`mock` e `cash` funcionam sem integração externa. `getnet`, `rede` e `pagbank` já possuem slots de configuração e usam o contrato de bridge em `docs/ACQUIRER_ADAPTER.md`. Ao homologar uma adquirente, implementamos o bridge/SDK específico sem alterar os módulos consumidores.

## Banco

O serviço cria suas tabelas no schema configurado em `DB_NAME` no startup. Em produção use schema e usuário próprios (`api_pagamento` / `payment_app`).

## Backoffice

Se `BACKOFFICE_WEBHOOK_URL` estiver configurada, todos os eventos relevantes são enviados por outbox com retry e `X-Webhook-Signature` HMAC-SHA256. Se o backoffice estiver indisponível, os eventos permanecem no banco até nova tentativa. O backoffice também pode consultar os endpoints de conciliação.
