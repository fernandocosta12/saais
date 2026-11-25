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
| Pagamento | Asaas, **na conta de cada restaurante** (chave no Vault) | O dinheiro cai direto no restaurante; a plataforma nunca segura valores |
| Frontend | HTML + JavaScript puro em `web/`, sem dependências nem build; hospedagem estática (Vercel) | Menos peças para quebrar ou atualizar; política de segurança (CSP) rígida |

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
- [ ] Configurar secrets das Edge Functions (`APP_ENV=production`, `ALLOWED_ORIGINS`)
- [x] Agendar `expire_pending_payments()` a cada minuto (pg_cron) — feito
- [x] Edge Functions publicadas (`create-order`, `payment-webhook`) — feito, em modo desenvolvimento
- [ ] Auth → URL Configuration: definir *Site URL* e *Redirect URLs* para o domínio do painel (links de confirmação de e-mail)
- [ ] SMTP próprio no Auth (o e-mail padrão do Supabase tem limite baixo de envios por hora)
- [ ] Backups: plano Pro (PITR) quando houver loja real
- [ ] Domínio próprio com HTTPS e cabeçalhos de segurança (CSP) no frontend
- [ ] Política de privacidade e termos de uso publicados
- [ ] Rodar `get_advisors` (segurança e performance) a cada migração
- [ ] Teste de ponta a ponta com uma conta sandbox do Asaas (conectar → pedido Pix → "Confirmar pagamento" no sandbox → pedido entra na fila)

## 4. Pagamento por Pix (conta Asaas de cada restaurante)

Decisões (25/11/2026): o dinheiro vai **direto para a conta Asaas do restaurante** (a plataforma não intermedia valores) e o **CPF do pagador é pedido só quando ele escolhe Pix** (exigência do Asaas para emitir a cobrança).

```
Dono no painel ──chave Asaas──▶ connect-payment-account ──valida chave──▶ Asaas do restaurante
                                     │  registra webhook (token aleatório de 64 caracteres)
                                     ▼
                         Vault (chave + token, criptografados) ──▶ stores.pix_enabled = true

Cliente escolhe Pix + CPF ──▶ create-order ──▶ create_order() no banco (sem CPF)
                                     │  cadastro do pagador no Asaas (cache por hash do CPF)
                                     ▼
                              cobrança Pix + QR Code ──▶ register_payment()

Asaas do restaurante ──webhook ?store=<id>──▶ payment-webhook
   valida token da loja (tempo constante) → consulta o pagamento no Asaas → confirm_store_payment()

pg_cron (1/min) ──segredo do Vault──▶ payment-maintenance ──▶ cancela no Asaas o Pix vencido
```

| Risco | Proteção |
|---|---|
| Vazamento da chave do Asaas | Fica só no Vault; tabela guarda apenas o ID do segredo e os 4 últimos caracteres. Nenhum papel de usuário lê; só as Edge Functions |
| Alguém liga o Pix sem conta | `pix_enabled` não é editável pelo painel; trigger `check_pix` recusa pedido Pix sem conta ativa |
| Webhook falso ou de outra loja | Token por loja + consulta ao Asaas com a chave da loja + `confirm_store_payment` exige que o pagamento seja daquela loja |
| Pagar um pedido já expirado (o QR do Asaas vale meses) | `payment-maintenance` apaga a cobrança no Asaas; se mesmo assim for paga, o pedido fica com `refund_required` |
| CPF exposto | Não é gravado no banco nem no navegador; só vai para o Asaas. Guardamos um hash (SHA-256 com o id da loja) para reaproveitar o cadastro do pagador |
| Asaas mandando e-mail/SMS ao cliente do restaurante | Pagador criado com `notificationDisabled: true` |
| Só o dono mexe na conta | Edge Function confere o papel `owner`; desconectar também é conferido no banco |

Testes (25/11/2026): 13 no banco (cofre, permissões, loja errada, desconexão apaga segredos), 5 contra as funções publicadas (webhook com token falso → 401, manutenção sem segredo → 401, conectar sem login → 401, Pix sem CPF e Pix sem conta → recusados), cliente Asaas testado com servidor simulado (cabeçalho `access_token`, corpo da cobrança, webhook), e 23 cenários de interface.

## 5. Frontend (`web/`)

| Página | Quem usa | O que faz |
|---|---|---|
| `loja.html?s=<slug>` | Cliente final (sem conta) | Cardápio, sacola, cupom, checkout. Totais vêm do servidor (`create-order` → `quote`) |
| `pedido.html?t=<token>` | Cliente final | Acompanhamento do pedido e código Pix; atualiza a cada 10 s |
| `painel.html` | Equipe do restaurante (login) | Pedidos (atualiza a cada 5 s, com aviso sonoro), cardápio, adicionais, custos, cupons, clientes, relatórios e configurações |
| `index.html` | — | Página inicial simples |

Decisões de segurança no frontend:
- **Sem `onclick` nem script inline**: tudo via `data-act` e arquivos `.js`, o que permite a CSP `script-src 'self'` (bloqueia script injetado).
- **Todo texto vindo do banco passa por `ui.esc()`** antes de ir para a tela. Testado com uma descrição contendo `<script>`.
- Links de imagem e logo só são aceitos se começarem com `https://`.
- O carrinho manda só `product_id`, quantidade, adicionais e observação. Nenhum preço sai do navegador.
- A tela esconde o que o papel não pode fazer, mas quem garante a regra é o banco.
- Cabeçalhos de segurança (CSP, HSTS, X-Frame-Options, nosniff) em `web/vercel.json`.

Testes de interface (24/11/2026, navegador real + servidor simulado, com a CSP ativa): 16 cenários OK, incluindo pedido com adicional e cupom (total R$ 67,02 vindo do servidor), carga do pedido sem preços, acompanhamento atualizando sozinho, bloqueio do pedido mínimo e da loja fechada, login com senha errada, aceite de pedido, chegada de pedido novo sem recarregar, cadastro de item com custo, cupom, taxa de entrega e pausa da loja. Nenhuma violação de CSP.

## 6. Estrutura do repositório

```
pedido-direto/
├── docs/ARQUITETURA.md          ← este documento
├── prototipo/index.html         ← MVP navegável (dados locais)
├── web/                         ← frontend real (loja, acompanhamento, painel)
├── supabase/
│   ├── config.toml
│   ├── migrations/              ← schema, RLS, regras de negócio (já aplicadas)
│   ├── seed.sql                 ← loja de demonstração "brasa-burger"
│   └── functions/
│       ├── _shared/             ← http (CORS, erros) e payments (gateway)
│       ├── create-order/        ← cotação e criação de pedido + Pix
│       ├── connect-payment-account/ ← dono conecta a conta Asaas
│       ├── payment-webhook/     ← confirmação de pagamento (por loja)
│       └── payment-maintenance/ ← cancela no Asaas o Pix vencido (pg_cron)
├── .env.example
└── README.md
```

## 7. Roadmap

| Fase | Entrega | Status |
|---|---|---|
| 0 | Protótipo navegável | ✅ |
| 1 | Banco seguro + regras de pedido/pagamento | ✅ |
| 2 | Frontend: loja pública, acompanhamento e painel com login | ✅ |
| 3 | Site publicado (saais-beta.vercel.app) + Pix real com a conta Asaas de cada restaurante | ✅ (falta o teste com uma conta sandbox real) |
| 4 | CRM: disparos de recompra e reativação (WhatsApp API oficial + n8n) | |
| 5 | Atendente de IA no WhatsApp, motoboys, integrações (iFood, PDVs) | |
