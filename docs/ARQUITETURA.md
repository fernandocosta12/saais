# Pedido Direto — Arquitetura

Plataforma de delivery próprio para restaurantes: cardápio digital, pedido sem comissão, Pix, painel de pedidos, cupons, base de clientes e relatórios de lucro.

## 1. Visão geral

```
┌─────────────────────┐        ┌──────────────────────────────────────────────┐
│  Loja do cliente    │        │                 SUPABASE                     │
│  (site público)     │──lê───▶│  Postgres + RLS                              │
│  /loja/:slug        │ cardápio│   • cardápio (leitura pública)               │
│                     │        │   • pedidos/clientes (só equipe da loja)     │
│                     │──POST─▶│  Edge Function: create-order                 │
│                     │        │   • limite de requisições                    │
│                     │        │   • create_order() recalcula preços          │
│                     │        │   • gera Pix no gateway ──────────┐          │
│  Acompanhamento     │──RPC──▶│  get_order_tracking(token)        │          │
└─────────────────────┘        │                                   ▼          │
                               │                          ┌────────────────┐  │
┌─────────────────────┐        │  Edge Function:          │ Gateway (Asaas)│  │
│  Painel do          │        │  payment-webhook ◀───────│ webhook Pix    │  │
│  restaurante        │──auth─▶│   • valida token         └────────────────┘  │
│  (login)            │        │   • consulta o gateway                       │
│                     │──RPC──▶│   • confirm_payment() idempotente            │
│                     │        │  Realtime: novos pedidos no painel           │
└─────────────────────┘        └──────────────────────────────────────────────┘
```

| Camada | Tecnologia | Por quê |
|---|---|---|
| Banco, login, tempo real | Supabase (Postgres) — projeto `pedido-direto`, região São Paulo | RLS dá isolamento entre lojas no próprio banco |
| Regras de dinheiro | Funções SQL `security definer` | O navegador nunca define preço, total ou status de pagamento |
| Backend | Supabase Edge Functions (Deno) | Guardam os segredos do gateway; recebem o webhook |
| Pagamento | Asaas (sugestão) — trocável pela interface `PaymentProvider` | Pix com webhook, bom para PJ pequena no Brasil |
| Frontend | React + Vite (próxima etapa), hospedado na Vercel | O protótipo atual está em `prototipo/index.html` |

## 2. Modelo de dados

Multi-loja: toda tabela tem `store_id`. Dinheiro sempre em **centavos inteiros**.

| Tabela | O que guarda | Quem acessa |
|---|---|---|
| `stores` | Loja, taxa de entrega, pedido mínimo, aberta/pausada | Público lê dados básicos; dono/gerente edita |
| `store_members` | Quem trabalha em qual loja e com qual papel | O próprio usuário e o dono |
| `categories`, `products`, `product_addons` | Cardápio | Público lê; dono/gerente edita |
| `product_costs` | Custo de cada item (CMV) | **Só dono/gerente** — separado para nunca vazar no cardápio |
| `coupons` | Cupons com mínimo, limite de usos e validade | Só a equipe; o público nunca lista cupons |
| `customers` | Base de clientes por loja (nome, WhatsApp, opt-in de marketing) | Só a equipe da loja |
| `orders`, `order_items` | Pedido com "foto" do preço no momento da compra | Equipe lê; **ninguém edita direto** |
| `order_status_history` | Linha do tempo de cada pedido (quem mudou e quando) | Equipe lê |
| `payments` | Cobranças no gateway | Dono/gerente lê; só o backend escreve |
| `payment_events` | Cada webhook recebido (garante idempotência) | Só backend |
| `audit_log` | Alterações de preço, custo, cupom, equipe, loja e pagamentos | Dono lê |
| `rate_limits` | Contadores anti-spam | Só backend |

### Papéis
- **owner (dono):** tudo, incluindo equipe, auditoria e anonimização de cliente (LGPD).
- **manager (gerente):** cardápio, preços, cupons, pagamentos, cancelamentos, relatórios.
- **staff (funcionário):** vê pedidos e clientes, aceita/recusa e move pedidos na fila. Não altera preço nem cancela pedido já aceito.

### Fluxo do pedido (máquina de estados)

```
              (Pix)                       aceitar        pronto        saiu p/ entrega     entregue
  criar ─▶ awaiting_payment ─webhook─▶ pending ──▶ preparing ──▶ ready ──▶ out_for_delivery ──▶ completed
    │            │                        │                         │
    │ (dinheiro/ │ 30 min sem pagar       │ recusar                 └─▶ completed (retirada)
    │  cartão na │ ─▶ canceled            ▼
    │  entrega)  │                     rejected        canceled ← só gerente/dono, após aceito
    └──────────────────────────────▶ pending
```
Qualquer transição fora desse desenho é recusada pelo banco (`update_order_status`).

## 3. Segurança (dinheiro, loja real, dados pessoais)

### 3.1 Princípios
1. **Fechado por padrão.** Todas as permissões de `anon` e `authenticated` foram revogadas; só abrimos o necessário, coluna por coluna quando preciso.
2. **RLS em 100% das tabelas.** Um usuário de outra loja vê 0 linhas, mesmo logado.
3. **O navegador não é confiável.** Ele envia só *produto, quantidade, adicionais e cupom*. Preço, desconto, frete e total são recalculados no banco. Mandar `price_cents: 1` não tem efeito.
4. **Pagamento só é confirmado pelo servidor**, via webhook autenticado + consulta ao gateway. Nunca por um botão "já paguei".
5. **Segredos só no servidor.** Chave do gateway e `service_role` ficam nos secrets das Edge Functions. O frontend usa apenas a chave pública (publishable).

### 3.2 Proteções implementadas

| Risco | Proteção |
|---|---|
| Cliente altera o preço no navegador | `create_order` recalcula tudo a partir do banco |
| Adicional de outro produto / item esgotado | Validação item a item no `_price_order` |
| Cupom usado além do limite (pedidos simultâneos) | Linha do cupom travada (`FOR UPDATE`) durante o pedido |
| "Caça" de cupons | Tabela de cupons não é legível pelo público |
| Webhook falso dizendo que o Pix foi pago | Token do gateway + comparação em tempo constante + consulta ao gateway |
| Webhook repetido pagando duas vezes | `payment_events` com chave única (provider, event_id) |
| Valor pago diferente do pedido | `confirm_payment` recusa e registra alerta na auditoria |
| Pix pago depois de expirado | Pedido marcado com `refund_required = true` |
| Funcionário mexe no total do pedido | Tabela `orders` sem permissão de escrita; só via funções |
| Pular etapas / cancelar indevidamente | Máquina de estados + papéis no `update_order_status` |
| Usuário de uma loja acessa outra | RLS por `store_id` + `is_store_member()` + `store_id` imutável |
| Produto "injetado" em categoria de outra loja | Triggers `check_category` / `check_store` |
| Spam de pedidos falsos | Limite por IP (10 a cada 10 min) e por telefone (5 a cada 10 min) |
| Vazamento de dados pelo link de acompanhamento | Token aleatório (UUID v4) e resposta sem telefone/endereço |
| Erros internos expostos ao usuário | `publicError()` só repassa mensagens de negócio conhecidas |
| CORS aberto | Só domínios listados em `ALLOWED_ORIGINS` |
| Gateway de teste em produção | `getProvider()` bloqueia `mock` com `APP_ENV=production` |
| Funções auxiliares expostas na API | Movidas para o schema `private` (fora do `/rpc`) |

### 3.3 LGPD
- A base de clientes é **do restaurante** (controlador); a plataforma é operadora.
- Coleta mínima: nome, WhatsApp e endereço (só para entrega).
- `marketing_opt_in` separado: disparos de marketing só para quem consentiu.
- `anonymize_customer()` atende pedido de exclusão do titular sem quebrar relatórios financeiros.
- Pendências: política de privacidade e termos de uso, prazo de retenção, contrato de operador com os restaurantes.

### 3.4 Testes de segurança executados (24/11/2026)

| # | Cenário | Resultado |
|---|---|---|
| 1 | Cotação com adicional + cupom 10% | Valores corretos (R$ 67,80 − R$ 6,78 + R$ 6,00 = R$ 67,02) |
| 2 | Adicional de outro produto | Bloqueado |
| 3–5 | Abaixo do mínimo, quantidade negativa, frete grátis na retirada | Bloqueados |
| 6–7 | Pedido Pix; cobrança com valor diferente do pedido | Criado; cobrança errada bloqueada |
| 8–11 | Webhook com valor errado, correto, repetido, outro evento já pago | `amount_mismatch`, `paid`, `duplicate_event`, `already_paid` |
| 14 | Pedido com loja fechada | Bloqueado |
| A1–A9 | Visitante: lê cardápio; tenta ler custos, pedidos, cupons; chamar `create_order`/`confirm_payment`; alterar preço; token inventado | Só o cardápio é acessível; o resto é negado |
| B1–B4 | Usuário logado de outra loja | Vê 0 pedidos e 0 clientes; altera 0 preços; não muda status |
| C1–C7 | Funcionário: lê pedidos; edita total; pula etapa; aceita; cancela; altera preço; vê pagamentos | Só ler e aceitar são permitidos |

### 3.5 Checklist antes de ir para produção
- [ ] Ativar **proteção contra senhas vazadas** e **MFA** para donos (Auth → Settings)
- [ ] Confirmação de e-mail obrigatória no cadastro
- [ ] Configurar secrets das Edge Functions (`APP_ENV=production`, `ALLOWED_ORIGINS`, chaves do gateway)
- [ ] Agendar `expire_pending_payments()` a cada minuto (pg_cron)
- [ ] Ativar Realtime só na tabela `orders` (o RLS continua valendo)
- [ ] Backups: plano Pro (PITR) quando houver loja real
- [ ] Domínio próprio com HTTPS e cabeçalhos de segurança (CSP) no frontend
- [ ] Política de privacidade e termos de uso publicados
- [ ] Rodar `get_advisors` (segurança e performance) a cada migração
- [ ] Teste de ponta a ponta com o Pix do sandbox do gateway

## 4. Estrutura do repositório

```
pedido-direto/
├── docs/ARQUITETURA.md          ← este documento
├── prototipo/index.html         ← MVP navegável (dados locais)
├── supabase/
│   ├── config.toml
│   ├── migrations/              ← schema, RLS, regras de negócio (já aplicadas)
│   ├── seed.sql                 ← loja de demonstração "brasa-burger"
│   └── functions/
│       ├── _shared/             ← http (CORS, erros) e payments (gateway)
│       ├── create-order/        ← cotação e criação de pedido + Pix
│       └── payment-webhook/     ← confirmação de pagamento
├── .env.example
└── README.md
```

## 5. Roadmap

| Fase | Entrega | Status |
|---|---|---|
| 0 | Protótipo navegável | ✅ |
| 1 | Banco seguro + regras de pedido/pagamento | ✅ |
| 2 | Frontend React: loja pública + painel com login e tempo real | Próximo |
| 3 | Gateway real (sandbox Asaas) + deploy das Edge Functions | |
| 4 | CRM: disparos de recompra e reativação (WhatsApp API oficial + n8n) | |
| 5 | Atendente de IA no WhatsApp, motoboys, integrações (iFood, PDVs) | |
