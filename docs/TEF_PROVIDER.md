# Provider TEF

O provider `tef` é usado exclusivamente para pagamentos presenciais por PIN pad através de um agente local (`tef_agent`).

Fluxo financeiro:

`PENDING -> ACTION_REQUIRED -> AUTHORIZED -> APPROVED`

`AUTHORIZED` significa que a transação foi autorizada pelo TEF/adquirente, porém ainda não foi confirmada definitivamente pela aplicação. O fechamento da venda/fiscal deve ocorrer antes de chamar `confirm`.

Em caso de falha após autorização, a aplicação deve cancelar/não confirmar a sessão TEF conforme o estado retornado pelo agente. O agente deve preservar transações ambíguas para recovery e nunca assumir `APPROVED` após reinício.

O gateway nunca aceita ou persiste PAN, CVV, PIN, track1/track2 ou trilha magnética. Somente identificadores e dados não sensíveis necessários para conciliação, como terminal, NSU, código de autorização, rede e bandeira.

Configuração prevista:

- `TEF_AGENT_URL`
- `TEF_AGENT_TOKEN`
- `TEF_AGENT_TIMEOUT_MS`
- `PAYMENT_PROVIDER_DEBIT=tef`
- `PAYMENT_PROVIDER_CREDIT=tef`

Os dois últimos valores só devem ser habilitados após homologação real.
