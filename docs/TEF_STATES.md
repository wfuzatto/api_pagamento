# Estados TEF

- `PENDING`: intent criado/fila.
- `ACTION_REQUIRED`: sessão física em andamento; `next_action.state` detalha WAITING_CARD/WAITING_PIN/PROCESSING.
- `AUTHORIZED`: adquirente autorizou; falta confirmação final da aplicação.
- `APPROVED`: TEF confirmado definitivamente.
- `DECLINED`: negado.
- `CANCELED`: cancelado/não confirmado.
- `UNKNOWN`: resultado ainda precisa ser reconciliado.
- `ERROR`: falha terminal do processamento.

Nenhum consumidor deve tratar `AUTHORIZED` como pedido pago.
