-- =====================================================================
-- Pix com a conta Asaas de cada restaurante.
-- * Chaves ficam no Vault (criptografadas). Nenhum usuário consegue lê-las;
--   só as Edge Functions (service_role) via funções privadas.
-- * O dinheiro cai direto na conta do restaurante: a plataforma não segura valores.
-- * CPF do pagador NÃO é guardado aqui: vai só para o Asaas. Guardamos apenas
--   um hash para reaproveitar o cadastro do pagador no Asaas.
-- =====================================================================
create extension if not exists pg_net;

-- Pix só aparece na loja quando a conta de pagamento está ativa
alter table public.stores add column if not exists pix_enabled boolean not null default false;
grant select (pix_enabled) on public.stores to anon, authenticated;

create table public.store_payment_accounts (
  store_id               uuid primary key references public.stores(id) on delete cascade,
  provider               text not null default 'asaas' check (provider in ('asaas')),
  environment            text not null check (environment in ('sandbox','production')),
  api_key_secret_id      uuid not null,            -- vault.secrets.id
  webhook_token_secret_id uuid not null,           -- vault.secrets.id
  provider_webhook_id    text,
  account_name           text,                     -- nome da conta no Asaas (para o dono conferir)
  key_hint               text not null,            -- só os 4 últimos caracteres da chave
  status                 text not null default 'active' check (status in ('active','disabled')),
  connected_by           uuid references auth.users(id) on delete set null,
  connected_at           timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
alter table public.store_payment_accounts enable row level security;
-- dono/gerente vê só o status (as colunas de segredo são apenas IDs do cofre, sem valor)
grant select (store_id, provider, environment, account_name, key_hint, status, connected_at, updated_at)
  on public.store_payment_accounts to authenticated;
create policy payment_accounts_read on public.store_payment_accounts for select to authenticated
  using (private.is_store_member(store_id, array['owner','manager']::public.member_role[]));
create trigger set_updated_at before update on public.store_payment_accounts
  for each row execute function public.tg_set_updated_at();
create trigger audit after insert or update or delete on public.store_payment_accounts
  for each row execute function public.tg_audit();

-- Cadastro do pagador no Asaas, reaproveitado por hash do CPF (sem guardar o CPF)
create table public.payment_customers (
  store_id              uuid not null references public.stores(id) on delete cascade,
  cpf_hash              text not null,
  provider_customer_id  text not null,
  created_at            timestamptz not null default now(),
  primary key (store_id, cpf_hash)
);
alter table public.payment_customers enable row level security;  -- sem policy: só backend

alter table public.payments add column if not exists provider_canceled_at timestamptz;
alter table public.payments add column if not exists provider_cancel_error text;

-- Pedido com Pix só se a loja tiver conta de pagamento ativa
create or replace function public.tg_check_pix_enabled()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.payment_method = 'pix'
     and not exists (select 1 from public.stores s where s.id = new.store_id and s.pix_enabled) then
    raise exception 'Pix indisponível nesta loja no momento.';
  end if;
  return new;
end; $$;
create trigger check_pix before insert on public.orders
  for each row execute function public.tg_check_pix_enabled();
revoke all on function public.tg_check_pix_enabled() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Funções de backend (service_role)

-- Salva/atualiza a conta de pagamento (chamada pela Edge Function de conexão,
-- depois de validar a chave no Asaas e registrar o webhook)
create or replace function public.save_payment_account(
  p_store_id uuid, p_environment text, p_api_key text, p_webhook_token text,
  p_provider_webhook_id text, p_account_name text, p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_acc public.store_payment_accounts; v_key uuid; v_tok uuid;
begin
  if p_environment not in ('sandbox','production') then raise exception 'Ambiente inválido'; end if;
  select * into v_acc from public.store_payment_accounts where store_id = p_store_id for update;
  if v_acc.store_id is null then
    v_key := vault.create_secret(p_api_key, 'asaas_key_' || p_store_id, 'Chave Asaas da loja');
    v_tok := vault.create_secret(p_webhook_token, 'asaas_webhook_' || p_store_id, 'Token do webhook Asaas da loja');
    insert into public.store_payment_accounts(store_id, environment, api_key_secret_id, webhook_token_secret_id,
      provider_webhook_id, account_name, key_hint, status, connected_by)
    values (p_store_id, p_environment, v_key, v_tok, p_provider_webhook_id, left(p_account_name, 120),
      right(p_api_key, 4), 'active', p_user_id);
  else
    perform vault.update_secret(v_acc.api_key_secret_id, p_api_key);
    perform vault.update_secret(v_acc.webhook_token_secret_id, p_webhook_token);
    update public.store_payment_accounts
       set environment = p_environment, provider_webhook_id = p_provider_webhook_id,
           account_name = left(p_account_name, 120), key_hint = right(p_api_key, 4),
           status = 'active', connected_by = p_user_id, connected_at = now()
     where store_id = p_store_id;
  end if;
  update public.stores set pix_enabled = true where id = p_store_id;
end;
$$;

-- Lê as credenciais (só Edge Functions)
create or replace function public.get_payment_credentials(p_store_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'environment', a.environment,
    'status', a.status,
    'provider_webhook_id', a.provider_webhook_id,
    'api_key', (select decrypted_secret from vault.decrypted_secrets where id = a.api_key_secret_id),
    'webhook_token', (select decrypted_secret from vault.decrypted_secrets where id = a.webhook_token_secret_id))
  from public.store_payment_accounts a
  where a.store_id = p_store_id;
$$;

-- Desconectar (dono): desliga o Pix e apaga as chaves do cofre
create or replace function public.disconnect_payment_account(p_store_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_acc public.store_payment_accounts;
begin
  if not private.is_store_member(p_store_id, array['owner']::public.member_role[]) then
    raise exception 'Somente o dono pode desconectar a conta de pagamento.';
  end if;
  select * into v_acc from public.store_payment_accounts where store_id = p_store_id for update;
  if v_acc.store_id is null then return; end if;
  update public.stores set pix_enabled = false where id = p_store_id;
  delete from public.store_payment_accounts where store_id = p_store_id;
  delete from vault.secrets where id in (v_acc.api_key_secret_id, v_acc.webhook_token_secret_id);
end;
$$;

-- Confirmação do webhook amarrada à loja (defesa extra: o pagamento tem que ser desta loja)
create or replace function public.confirm_store_payment(p_store_id uuid, p_provider text, p_event_id text,
  p_provider_payment_id text, p_paid_amount_cents integer, p_payload jsonb)
returns text
language plpgsql security definer set search_path = ''
as $$
declare v_store uuid;
begin
  select store_id into v_store from public.payments
   where provider = p_provider and provider_payment_id = p_provider_payment_id;
  if v_store is null then return 'payment_not_found'; end if;
  if v_store <> p_store_id then return 'store_mismatch'; end if;
  return public.confirm_payment(p_provider, p_event_id, p_provider_payment_id, p_paid_amount_cents, p_payload);
end;
$$;

-- Cobranças vencidas que ainda precisam ser canceladas no Asaas
create or replace function public.payments_to_cancel(p_limit integer default 50)
returns table(payment_id uuid, store_id uuid, provider text, provider_payment_id text)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.store_id, p.provider, p.provider_payment_id
    from public.payments p
   where p.status = 'expired' and p.provider_canceled_at is null and p.provider <> 'mock'
     and (p.provider_cancel_error is null or p.updated_at < now() - interval '10 minutes')
   order by p.updated_at
   limit p_limit;
$$;

create or replace function public.mark_payment_canceled(p_payment_id uuid, p_error text)
returns void
language sql security definer set search_path = ''
as $$
  update public.payments
     set provider_canceled_at = case when p_error is null then now() else provider_canceled_at end,
         provider_cancel_error = left(p_error, 300)
   where id = p_payment_id;
$$;

-- Cadastro do pagador (cache por hash do CPF)
create or replace function public.get_payment_customer(p_store_id uuid, p_cpf_hash text)
returns text language sql stable security definer set search_path = '' as $$
  select provider_customer_id from public.payment_customers where store_id = p_store_id and cpf_hash = p_cpf_hash;
$$;
create or replace function public.save_payment_customer(p_store_id uuid, p_cpf_hash text, p_provider_customer_id text)
returns void language sql security definer set search_path = '' as $$
  insert into public.payment_customers(store_id, cpf_hash, provider_customer_id)
  values (p_store_id, p_cpf_hash, p_provider_customer_id)
  on conflict (store_id, cpf_hash) do update set provider_customer_id = excluded.provider_customer_id;
$$;

-- Segredo do agendador (pg_cron → Edge Function de manutenção)
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'cron_maintenance_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_maintenance_secret', 'Autentica o pg_cron na Edge Function payment-maintenance');
  end if;
end $$;

create or replace function public.verify_cron_secret(p_secret text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select decrypted_secret = p_secret from vault.decrypted_secrets where name = 'cron_maintenance_secret'), false);
$$;

-- Permissões
revoke all on function public.save_payment_account(uuid, text, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.get_payment_credentials(uuid)                                    from public, anon, authenticated;
revoke all on function public.confirm_store_payment(uuid, text, text, text, integer, jsonb)    from public, anon, authenticated;
revoke all on function public.payments_to_cancel(integer)                                      from public, anon, authenticated;
revoke all on function public.mark_payment_canceled(uuid, text)                                from public, anon, authenticated;
revoke all on function public.get_payment_customer(uuid, text)                                 from public, anon, authenticated;
revoke all on function public.save_payment_customer(uuid, text, text)                          from public, anon, authenticated;
revoke all on function public.verify_cron_secret(text)                                         from public, anon, authenticated;
revoke all on function public.disconnect_payment_account(uuid)                                 from public, anon;
grant execute on function public.save_payment_account(uuid, text, text, text, text, text, uuid),
  public.get_payment_credentials(uuid), public.confirm_store_payment(uuid, text, text, text, integer, jsonb),
  public.payments_to_cancel(integer), public.mark_payment_canceled(uuid, text),
  public.get_payment_customer(uuid, text), public.save_payment_customer(uuid, text, text),
  public.verify_cron_secret(text) to service_role;
grant execute on function public.disconnect_payment_account(uuid) to authenticated;

-- A confirmação agora sempre passa por confirm_store_payment (amarrada à loja)
revoke execute on function public.confirm_payment(text, text, text, integer, jsonb) from service_role;

-- Agendamento: chama a manutenção de pagamentos a cada minuto
select cron.schedule('manutencao-pagamentos', '* * * * *', $cron$
  select net.http_post(
    url := 'https://tjhuayoppfvdyzfbfpew.supabase.co/functions/v1/payment-maintenance',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_maintenance_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000);
$cron$);
