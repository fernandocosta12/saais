# Pedido Direto

Delivery próprio para restaurantes, sem comissão por pedido: cardápio digital, Pix, painel de pedidos, cupons, base de clientes e relatórios de lucro.

- **Arquitetura e segurança:** [docs/ARQUITETURA.md](docs/ARQUITETURA.md)
- **Protótipo navegável:** abra `prototipo/index.html` no navegador
- **Banco:** Supabase `pedido-direto` (região São Paulo); migrações em `supabase/migrations`

## Rodando o backend

```bash
npm i -g supabase
supabase link --project-ref tjhuayoppfvdyzfbfpew
supabase db push                       # aplica migrações (já aplicadas no projeto)
supabase secrets set --env-file .env   # secrets das Edge Functions
supabase functions deploy create-order payment-webhook
```

## Regras de ouro
1. Nada de segredo no frontend nem no Git (`.env` está no `.gitignore`).
2. Toda tabela nova: `store_id` + RLS + policies + `get_advisors`.
3. Dinheiro em centavos inteiros. Preço sempre recalculado no banco.
4. Pagamento só é confirmado pelo webhook do gateway.
