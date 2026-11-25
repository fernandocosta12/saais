# Pedido Direto

Delivery próprio para restaurantes, sem comissão por pedido: cardápio digital, Pix, painel de pedidos, cupons, base de clientes e relatórios de lucro.

- **Arquitetura e segurança:** [docs/ARQUITETURA.md](docs/ARQUITETURA.md)
- **Frontend:** pasta `web/` (loja, acompanhamento e painel), já ligado ao Supabase
- **Protótipo antigo:** `prototipo/index.html`
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

## Publicando o site (Vercel, grátis)
1. Em vercel.com, **Add New → Project** e importe o repositório `saais`.
2. Em **Root Directory**, escolha `web`. Framework: **Other**. Sem comando de build.
3. Publique. Depois, no Supabase → Authentication → URL Configuration, coloque o endereço do site em *Site URL* e `https://SEU-SITE/painel.html` em *Redirect URLs*.

Para testar no computador sem publicar: `cd web && python3 -m http.server 8080` e abra `http://localhost:8080`.
