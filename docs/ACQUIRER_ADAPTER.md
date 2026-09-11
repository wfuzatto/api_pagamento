# Contrato de adaptador/adquirente

O `api_pagamento` mantém o contrato interno estável e delega particularidades de Getnet, Rede, PagBank ou outro adquirente a um adaptador/bridge. Isso permite trocar SDK, TEF, POS ou API sem alterar `totem_food`, hotelaria ou outros módulos.

## Regra de segurança

O bridge **não deve enviar PAN, CVV, track1/track2 ou dados crus de cartão** ao `api_pagamento`. Use token/transaction id/NSU/TID fornecidos pelo SDK/TEF/adquirente.

## POST /v1/payments

Entrada normalizada:

```json
{
  "payment_id": "uuid",
  "source_module": "totem_food",
  "source_reference": "ORDER-123",
  "amount_cents": 4590,
  "currency": "BRL",
  "method": "pix|debit_card|credit_card",
  "installments": 1,
  "merchant_id": "vale-mantiqueira",
  "metadata": {}
}
```

Resposta:

```json
{
  "status": "PENDING|ACTION_REQUIRED|APPROVED|DECLINED|ERROR",
  "external_id": "id-no-adquirente",
  "next_action": {
    "type": "PIX_QR_CODE|TERMINAL|WAIT_PROVIDER"
  }
}
```

## Cancelamento

`POST /v1/payments/{external_id}/cancel`

## Estorno

`POST /v1/payments/{external_id}/refunds`

```json
{"refund_id":"uuid","amount_cents":4590,"reason":"opcional"}
```

## Webhook bridge -> api_pagamento

`POST /api/v1/webhooks/{getnet|rede|pagbank}` com `X-Webhook-Signature: sha256=<HMAC-SHA256(raw-body)>`.

```json
{
  "event_id": "evento-unico-do-provider",
  "external_id": "id-no-adquirente",
  "status": "APPROVED",
  "details": {"nsu":"...","tid":"..."}
}
```
