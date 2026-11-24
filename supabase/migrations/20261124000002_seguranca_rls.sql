-- =====================================================================
-- Segurança: permissões, RLS, auditoria
-- Princípio: tudo FECHADO por padrão; abrimos só o mínimo necessário.
-- =====================================================================

-- 1) Fecha tudo: anon/authenticated não têm nenhum privilégio nas tabelas
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- 2) Liga RLS em TODAS as tabelas
alter table public.profiles             enable row level security;
alter table public.stores               enable row level security;
alter table public.store_members        enable row level security;
alter table public.categories           enable row level security;
alter table public.products             enable row level security;
alter table public.product_costs        enable row level security;
alter table public.product_addons       enable row level security;
alter table public.coupons              enable row level security;
alter table public.customers            enable row level security;
alter table public.orders               enable row level security;
alter table public.order_items          enable row level security;
alter table public.order_status_history enable row level security;
alter table public.payments             enable row level security;
alter table public.payment_events       enable row level security;  -- sem policy = só backend
alter table public.audit_log            enable row level security;
alter table public.rate_limits          enable row level security;  -- sem policy = só backend

-- 3) Helpers
create or replace function public.is_store_member(p_store uuid, p_roles public.member_role[] default null)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.store_members m
    where m.store_id = p_store
      and m.user_id = (select auth.uid())
      and (p_roles is null or m.role = any(p_roles))
  );
$$;
revoke all on function public.is_store_member(uuid, public.member_role[]) from public, anon;
grant execute on function public.is_store_member(uuid, public.member_role[]) to authenticated;

create or replace function public.is_store_public(p_store uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.stores s where s.id = p_store and s.status = 'active');
$$;
revoke all on function public.is_store_public(uuid) from public;
grant execute on function public.is_store_public(uuid) to anon, authenticated;

-- 4) Privilégios de tabela (o RLS filtra as linhas por cima disso)
-- Cardápio público (qualquer visitante lê)
grant select (id, slug, name, logo_url, address, whatsapp, status, is_open, high_demand,
              delivery_fee_cents, min_order_cents, prep_minutes)
  on public.stores to anon, authenticated;
grant select on public.categories, public.products, public.product_addons to anon, authenticated;

-- Painel (usuário logado e membro da loja)
grant update (name, logo_url, address, whatsapp, is_open, high_demand,
              delivery_fee_cents, min_order_cents, prep_minutes)
  on public.stores to authenticated;
grant select, insert, update, delete on public.categories, public.products,
  public.product_addons, public.product_costs, public.coupons to authenticated;
grant select on public.store_members to authenticated;
grant select, update (name, marketing_opt_in) on public.customers to authenticated;
grant select on public.orders, public.order_items, public.order_status_history,
  public.payments, public.audit_log to authenticated;
grant select, update (full_name) on public.profiles to authenticated;
-- NOTA: pedidos e pagamentos NÃO têm insert/update pelo app.
-- Só mudam via funções (create_order, update_order_status, confirm_payment).

-- 5) Policies ---------------------------------------------------------
-- profiles
create policy profiles_self_select on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_self_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- stores
create policy stores_public_read on public.stores for select to anon, authenticated
  using (status = 'active');
create policy stores_member_read on public.stores for select to authenticated
  using (public.is_store_member(id));
create policy stores_admin_update on public.stores for update to authenticated
  using (public.is_store_member(id, array['owner','manager']::public.member_role[]))
  with check (public.is_store_member(id, array['owner','manager']::public.member_role[]));

-- store_members
create policy members_read on public.store_members for select to authenticated
  using (user_id = (select auth.uid()) or public.is_store_member(store_id, array['owner']::public.member_role[]));

-- cardápio: leitura pública, escrita owner/manager
create policy categories_read on public.categories for select to anon, authenticated
  using (public.is_store_public(store_id));
create policy categories_write on public.categories for all to authenticated
  using (public.is_store_member(store_id, array['owner','manager']::public.member_role[]))
  with check (public.is_store_member(store_id, array['owner','manager']::public.member_role[]));

create policy products_read on public.products for select to anon, authenticated
  using (public.is_store_public(store_id));
create policy products_write on public.products for all to authenticated
  using (public.is_store_member(store_id, array['owner','manager']::public.member_role[]))
  with check (public.is_store_member(store_id, array['owner','manager']::public.member_role[]));

create policy addons_read on public.product_addons for select to anon, authenticated
  using (public.is_store_public(store_id));
create policy addons_write on public.product_addons for all to authenticated
  using (public.is_store_member(store_id, array['owner','manager']::public.member_role[]))
  with check (public.is_store_member(store_id, array['owner','manager']::public.member_role[]));

create policy costs_all on public.product_costs for all to authenticated
  using (public.is_store_member(store_id, array['owner','manager']::public.member_role[]))
  with check (public.is_store_member(store_id, array['owner','manager']::public.member_role[]));

-- cupons: nunca públicos (evita "caça" de códigos); validados no create_order
create policy coupons_read on public.coupons for select to authenticated
  using (public.is_store_member(store_id));
create policy coupons_write on public.coupons for insert to authenticated
  with check (public.is_store_member(store_id, array['owner','manager']::public.member_role[]));
create policy coupons_update on public.coupons for update to authenticated
  using (public.is_store_member(store_id, array['owner','manager']::public.member_role[]))
  with check (public.is_store_member(store_id, array['owner','manager']::public.member_role[]));
create policy coupons_delete on public.coupons for delete to authenticated
  using (public.is_store_member(store_id, array['owner','manager']::public.member_role[]));

-- clientes (dado pessoal: só a equipe da loja)
create policy customers_read on public.customers for select to authenticated
  using (public.is_store_member(store_id));
create policy customers_update on public.customers for update to authenticated
  using (public.is_store_member(store_id, array['owner','manager']::public.member_role[]))
  with check (public.is_store_member(store_id, array['owner','manager']::public.member_role[]));

-- pedidos e afins: somente leitura para a equipe
create policy orders_read  on public.orders for select to authenticated using (public.is_store_member(store_id));
create policy items_read   on public.order_items for select to authenticated using (public.is_store_member(store_id));
create policy history_read on public.order_status_history for select to authenticated using (public.is_store_member(store_id));
create policy payments_read on public.payments for select to authenticated
  using (public.is_store_member(store_id, array['owner','manager']::public.member_role[]));
create policy audit_read on public.audit_log for select to authenticated
  using (store_id is not null and public.is_store_member(store_id, array['owner']::public.member_role[]));

-- 6) Triggers -------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end; $$;

create trigger set_updated_at before update on public.stores   for each row execute function public.tg_set_updated_at();
create trigger set_updated_at before update on public.products for each row execute function public.tg_set_updated_at();
create trigger set_updated_at before update on public.orders   for each row execute function public.tg_set_updated_at();
create trigger set_updated_at before update on public.payments for each row execute function public.tg_set_updated_at();
create trigger set_updated_at before update on public.product_costs for each row execute function public.tg_set_updated_at();

-- store_id de product_costs / addons tem que bater com o do produto (impede "injetar" em outra loja)
create or replace function public.tg_check_product_store()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.products p where p.id = new.product_id and p.store_id = new.store_id) then
    raise exception 'Produto não pertence a esta loja';
  end if;
  return new;
end; $$;
create trigger check_store before insert or update on public.product_costs  for each row execute function public.tg_check_product_store();
create trigger check_store before insert or update on public.product_addons for each row execute function public.tg_check_product_store();

create or replace function public.tg_check_category_store()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.category_id is not null and not exists
     (select 1 from public.categories c where c.id = new.category_id and c.store_id = new.store_id) then
    raise exception 'Categoria não pertence a esta loja';
  end if;
  return new;
end; $$;
create trigger check_category before insert or update on public.products for each row execute function public.tg_check_category_store();

-- Ninguém troca um registro de loja (store_id é imutável)
create or replace function public.tg_lock_store_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.store_id <> old.store_id then raise exception 'store_id não pode ser alterado'; end if;
  return new;
end; $$;
create trigger lock_store before update on public.categories     for each row execute function public.tg_lock_store_id();
create trigger lock_store before update on public.products       for each row execute function public.tg_lock_store_id();
create trigger lock_store before update on public.product_addons for each row execute function public.tg_lock_store_id();
create trigger lock_store before update on public.product_costs  for each row execute function public.tg_lock_store_id();
create trigger lock_store before update on public.coupons        for each row execute function public.tg_lock_store_id();
create trigger lock_store before update on public.customers      for each row execute function public.tg_lock_store_id();

-- Auditoria genérica
create or replace function public.tg_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_store uuid;
begin
  v_store := coalesce((v_new->>'store_id')::uuid, (v_old->>'store_id')::uuid,
                      case when tg_table_name = 'stores' then coalesce((v_new->>'id')::uuid,(v_old->>'id')::uuid) end);
  insert into public.audit_log(store_id, actor_id, action, entity, entity_id, old_data, new_data)
  values (v_store, (select auth.uid()), lower(tg_op), tg_table_name,
          coalesce(v_new->>'id', v_old->>'id', v_new->>'product_id', v_old->>'product_id'), v_old, v_new);
  return coalesce(new, old);
end; $$;

create trigger audit after insert or update or delete on public.stores         for each row execute function public.tg_audit();
create trigger audit after insert or update or delete on public.store_members  for each row execute function public.tg_audit();
create trigger audit after insert or update or delete on public.products       for each row execute function public.tg_audit();
create trigger audit after insert or update or delete on public.product_costs  for each row execute function public.tg_audit();
create trigger audit after insert or update or delete on public.coupons        for each row execute function public.tg_audit();
create trigger audit after update or delete on public.customers                for each row execute function public.tg_audit();
create trigger audit after update on public.payments                           for each row execute function public.tg_audit();

-- Perfil criado automaticamente no cadastro
create or replace function public.tg_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, full_name)
  values (new.id, left(coalesce(new.raw_user_meta_data->>'full_name', ''), 120))
  on conflict (id) do nothing;
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.tg_new_user();

-- Trigger functions não devem ser chamáveis diretamente
revoke all on function public.tg_set_updated_at(), public.tg_check_product_store(), public.tg_check_category_store(),
  public.tg_lock_store_id(), public.tg_audit(), public.tg_new_user() from public, anon, authenticated;
