# Contrato HTTP tef_agent

`POST /v1/transactions` recebe `payment_id`, `terminal_id`, `amount_cents`, `currency`, `method`, `installments` e metadata não sensível.

`GET /v1/transactions/:id` sincroniza o estado.

`POST /v1/transactions/:id/confirm` confirma uma autorização pendente.

`POST /v1/transactions/:id/cancel` cancela/não confirma antes da conclusão.

`POST /v1/transactions/:id/refund` executa estorno conforme o driver real.

Estados interativos do agente são representados no gateway por `ACTION_REQUIRED` + `next_action`. `AUTHORIZED` é um estado financeiro próprio e não equivale a `APPROVED`.
