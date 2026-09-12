# Rollout TEF

1. Manter `PAYMENT_PROVIDER_DEBIT/CREDIT=mock`.
2. Subir `tef_agent` com `TEF_DRIVER=mock`.
3. Rodar testes de concorrência/recovery.
4. Instalar SDK oficial e homologar PPC930.
5. Testar driver real com `TEF_REAL_PAYMENTS_ENABLED=false` em health/discovery.
6. Habilitar pagamento real apenas em ambiente de homologação.
7. Testar queda após autorização e recovery.
8. Só então promover SHAs e trocar providers de produção.
