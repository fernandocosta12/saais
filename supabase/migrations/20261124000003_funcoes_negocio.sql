-- =====================================================================
-- Regras de negócio no banco.
-- O cliente (navegador) NUNCA manda preço, total, desconto ou status de
-- pagamento. Ele manda só: produto, quantidade, adicionais, cupom.
-- Tudo é recalculado aqui a partir do banco.
-- =====================================================================

-- Auditoria de lojas sem "ruído" do contador de pedidos
drop trigger audit on public.stores;
create trigger audit after insert or delete on public.stores for each row execute function public.tg_audit();
create trigger audit_update after update on public.stores for each row
  when ((to_jsonb(old) - 'order_seq' - 'updated_at') is distinct from (to_jsonb(new) - 'order_seq' - 'updated_at'))
  execute function public.tg_audit();

-- ---------------------------------------------------------------------
-- Cálculo do pedido (uso interno)
create or replace function public._price_order(p_store_id uuid, p_payload jsonb, p_lock_coupon boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_store     public.stores;
  v_mode      text := p_payload->>'mode';
  v_items     jsonb := p_payload->'items';
  v_item      jsonb;
  v_prod      public.products;
  v_qty       integer;
  v_addon_ids uuid[];
  v_addons    jsonb;
  v_addon_sum integer;
  v_addon_cnt integer;
  v_cost      integer;
  v_unit      integer;
  v_lines     jsonb := '[]'::jsonb;
  v_subtotal  integer := 0;
  v_fee       integer := 0;
  v_discount  integer := 0;
  v_code      text := upper(trim(coalesce(p_payload->>'coupon_code', '')));
  v_coupon    public.coupons;
begin
  select * into v_store from public.stores where id = p_store_id;
  if v_mode is null or v_mode not in ('delivery','pickup') then
    raise exception 'Escolha entrega ou retirada.';
  end if;
  if v_items is null or jsonb_typeof(v_items) <> 'array'
     or jsonb_array_length(v_items) = 0 or jsonb_array_length(v_items) > 30 then
    raise exception 'A sacola está vazia ou tem itens demais.';
  end if;

  for v_item in select * from jsonb_array_elements(v_items) loop
    begin
      v_qty := (v_item->>'quantity')::integer;
      select * into v_prod from public.products
        where id = (v_item->>'product_id')::uuid and store_id = p_store_id;
      select coalesce(array_agg(distinct x::uuid), '{}') into v_addon_ids
        from jsonb_array_elements_text(coalesce(v_item->'addon_ids', '[]'::jsonb)) x;
    exception when others then
      raise exception 'Item inválido na sacola.';
    end;

    if v_qty is null or v_qty < 1 or v_qty > 50 then
      raise exception 'Quantidade inválida.';
    end if;
    if v_prod.id is null or not v_prod.is_available then
      raise exception 'Um dos itens não está mais disponível. Atualize a sacola.';
    end if;
    if cardinality(v_addon_ids) > 15 then
      raise exception 'Adicionais demais em um item.';
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'price_cents', a.price_cents) order by a.position), '[]'::jsonb),
           coalesce(sum(a.price_cents), 0), count(*)
      into v_addons, v_addon_sum, v_addon_cnt
      from public.product_addons a
     where a.id = any(v_addon_ids) and a.product_id = v_prod.id and a.is_available;
    if v_addon_cnt <> cardinality(v_addon_ids) then
      raise exception 'Um adicional escolhido não está disponível.';
    end if;

    select coalesce(c.cost_cents, 0) into v_cost from public.product_costs c where c.product_id = v_prod.id;
    v_unit := v_prod.price_cents + v_addon_sum;
    v_subtotal := v_subtotal + v_unit * v_qty;
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_prod.id, 'product_name', v_prod.name, 'quantity', v_qty,
      'unit_price_cents', v_unit, 'unit_cost_cents', coalesce(v_cost, 0) + 0,
      'addons', v_addons, 'notes', nullif(left(trim(coalesce(v_item->>'notes', '')), 200), ''),
      'line_total_cents', v_unit * v_qty);
  end loop;

  v_fee := case when v_mode = 'delivery' then v_store.delivery_fee_cents else 0 end;

  if v_subtotal < v_store.min_order_cents then
    raise exception 'Pedido mínimo não atingido.';
  end if;

  if v_code <> '' then
    if p_lock_coupon then
      select * into v_coupon from public.coupons where store_id = p_store_id and code = v_code for update;
    else
      select * into v_coupon from public.coupons where store_id = p_store_id and code = v_code;
    end if;
    if v_coupon.id is null or not v_coupon.is_active
       or (v_coupon.starts_at is not null and now() < v_coupon.starts_at)
       or (v_coupon.ends_at   is not null and now() > v_coupon.ends_at)
       or (v_coupon.max_uses  is not null and v_coupon.uses_count >= v_coupon.max_uses) then
      raise exception 'Cupom inválido ou expirado.';
    end if;
    if v_subtotal < v_coupon.min_order_cents then
      raise exception 'Este cupom exige um valor mínimo de pedido.';
    end if;
    if v_coupon.type = 'percent' then
      v_discount := floor(v_subtotal * v_coupon.value / 100.0);
    elsif v_coupon.type = 'fixed' then
      v_discount := least(v_coupon.value, v_subtotal);
    else
      if v_mode <> 'delivery' then raise exception 'Cupom de frete grátis vale só para entrega.'; end if;
      v_fee := 0;
    end if;
  end if;

  return jsonb_build_object(
    'items', v_lines, 'subtotal_cents', v_subtotal, 'discount_cents', v_discount,
    'delivery_fee_cents', v_fee, 'total_cents', v_subtotal - v_discount + v_fee,
    'coupon_id', v_coupon.id, 'coupon_code', v_coupon.code);
end;
$$;

-- ---------------------------------------------------------------------
-- Prévia de valores (sacola / cupom) — chamada pela Edge Function
create or replace function public.quote_order(p_store_slug text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_store public.stores;
begin
  select * into v_store from public.stores where slug = p_store_slug and status = 'active';
  if v_store.id is null then raise exception 'Loja não encontrada.'; end if;
  return public._price_order(v_store.id, p_payload, false);
end;
$$;

-- ---------------------------------------------------------------------
-- Criação do pedido — chamada SOMENTE pela Edge Function (service_role)
create or replace function public.create_order(p_store_slug text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_store     public.stores;
  v_price     jsonb;
  v_name      text := trim(coalesce(p_payload#>>'{customer,name}', ''));
  v_phone     text := regexp_replace(coalesce(p_payload#>>'{customer,phone}', ''), '\D', '', 'g');
  v_address   text := nullif(trim(coalesce(p_payload#>>'{customer,address}', '')), '');
  v_optin     boolean := coalesce((p_payload#>>'{customer,marketing_opt_in}')::boolean, false);
  v_mode      public.order_mode;
  v_method    public.payment_method;
  v_change    integer;
  v_customer  uuid;
  v_number    integer;
  v_order     public.orders;
  v_status    public.order_status;
  v_pstatus   public.payment_status;
  v_line      jsonb;
begin
  -- trava a linha da loja: serializa a numeração dos pedidos
  select * into v_store from public.stores where slug = p_store_slug and status = 'active' for update;
  if v_store.id is null then raise exception 'Loja não encontrada.'; end if;
  if not v_store.is_open then raise exception 'A loja está fechada no momento.'; end if;

  begin
    v_mode   := (p_payload->>'mode')::public.order_mode;
    v_method := (p_payload->>'payment_method')::public.payment_method;
  exception when others then
    raise exception 'Forma de entrega ou pagamento inválida.';
  end;
  if v_mode is null or v_method is null then raise exception 'Forma de entrega ou pagamento inválida.'; end if;

  if char_length(v_name) < 2 or char_length(v_name) > 80 then raise exception 'Informe seu nome.'; end if;
  if v_phone !~ '^[0-9]{10,13}$' then raise exception 'Informe um WhatsApp válido com DDD.'; end if;
  if v_mode = 'delivery' and (v_address is null or char_length(v_address) < 8 or char_length(v_address) > 300) then
    raise exception 'Informe o endereço completo.';
  end if;
  if v_mode = 'pickup' then v_address := null; end if;

  v_price := public._price_order(v_store.id, p_payload, true);

  begin
    v_change := nullif(p_payload->>'change_for_cents', '')::integer;
  exception when others then v_change := null; end;
  if v_method <> 'cash' then v_change := null; end if;
  if v_change is not null and v_change < (v_price->>'total_cents')::integer then
    raise exception 'O valor para troco é menor que o total.';
  end if;

  if v_price->>'coupon_id' is not null then
    update public.coupons set uses_count = uses_count + 1 where id = (v_price->>'coupon_id')::uuid;
  end if;

  insert into public.customers(store_id, name, phone, marketing_opt_in)
  values (v_store.id, v_name, v_phone, v_optin)
  on conflict (store_id, phone) do update
    set name = excluded.name,
        marketing_opt_in = public.customers.marketing_opt_in or excluded.marketing_opt_in,
        anonymized_at = null
  returning id into v_customer;

  update public.stores set order_seq = order_seq + 1 where id = v_store.id returning order_seq into v_number;

  if v_method in ('pix','card_online') then
    v_status := 'awaiting_payment'; v_pstatus := 'pending';
  else
    v_status := 'pending'; v_pstatus := 'not_applicable';
  end if;

  insert into public.orders(store_id, number, customer_id, customer_name, customer_phone, delivery_address,
    mode, status, payment_method, payment_status, coupon_id, coupon_code,
    subtotal_cents, discount_cents, delivery_fee_cents, total_cents, change_for_cents, notes)
  values (v_store.id, v_number, v_customer, v_name, v_phone, v_address,
    v_mode, v_status, v_method, v_pstatus, (v_price->>'coupon_id')::uuid, v_price->>'coupon_code',
    (v_price->>'subtotal_cents')::integer, (v_price->>'discount_cents')::integer,
    (v_price->>'delivery_fee_cents')::integer, (v_price->>'total_cents')::integer,
    v_change, nullif(left(trim(coalesce(p_payload->>'notes', '')), 300), ''))
  returning * into v_order;

  for v_line in select * from jsonb_array_elements(v_price->'items') loop
    insert into public.order_items(order_id, store_id, product_id, product_name, unit_price_cents,
      unit_cost_cents, quantity, addons, notes, line_total_cents)
    values (v_order.id, v_store.id, (v_line->>'product_id')::uuid, v_line->>'product_name',
      (v_line->>'unit_price_cents')::integer, (v_line->>'unit_cost_cents')::integer,
      (v_line->>'quantity')::integer, v_line->'addons', v_line->>'notes',
      (v_line->>'line_total_cents')::integer);
  end loop;

  insert into public.order_status_history(order_id, store_id, from_status, to_status)
  values (v_order.id, v_store.id, null, v_status);

  return jsonb_build_object('order_id', v_order.id, 'number', v_order.number,
    'public_token', v_order.public_token, 'status', v_order.status,
    'payment_method', v_order.payment_method, 'total_cents', v_order.total_cents);
end;
$$;

-- ---------------------------------------------------------------------
-- Registra a cobrança criada no gateway (service_role)
create or replace function public.register_payment(p_order_id uuid, p_provider text, p_provider_payment_id text,
  p_amount_cents integer, p_pix_copy_paste text, p_expires_at timestamptz)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_order public.orders; v_id uuid;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null or v_order.status <> 'awaiting_payment' then
    raise exception 'Pedido não está aguardando pagamento.';
  end if;
  if p_amount_cents <> v_order.total_cents then
    raise exception 'Valor da cobrança diferente do total do pedido.';
  end if;
  insert into public.payments(order_id, store_id, provider, provider_payment_id, method, amount_cents,
                              pix_copy_paste, expires_at)
  values (v_order.id, v_order.store_id, p_provider, p_provider_payment_id, v_order.payment_method,
          p_amount_cents, p_pix_copy_paste, p_expires_at)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Confirmação de pagamento vinda do webhook (service_role). Idempotente.
create or replace function public.confirm_payment(p_provider text, p_event_id text, p_provider_payment_id text,
  p_paid_amount_cents integer, p_payload jsonb)
returns text
language plpgsql security definer set search_path = ''
as $$
declare v_event bigint; v_pay public.payments; v_order public.orders;
begin
  insert into public.payment_events(provider, event_id, payload)
  values (p_provider, p_event_id, coalesce(p_payload, '{}'::jsonb))
  on conflict (provider, event_id) do nothing
  returning id into v_event;
  if v_event is null then return 'duplicate_event'; end if;

  select * into v_pay from public.payments
   where provider = p_provider and provider_payment_id = p_provider_payment_id for update;
  if v_pay.id is null then return 'payment_not_found'; end if;
  if v_pay.status = 'paid' then
    update public.payment_events set processed_at = now() where id = v_event;
    return 'already_paid';
  end if;
  if p_paid_amount_cents <> v_pay.amount_cents then
    insert into public.audit_log(store_id, action, entity, entity_id, new_data)
    values (v_pay.store_id, 'amount_mismatch', 'payments', v_pay.id::text,
            jsonb_build_object('expected', v_pay.amount_cents, 'received', p_paid_amount_cents));
    return 'amount_mismatch';
  end if;

  update public.payments set status = 'paid', paid_at = now() where id = v_pay.id;

  select * into v_order from public.orders where id = v_pay.order_id for update;
  if v_order.status = 'awaiting_payment' then
    update public.orders set payment_status = 'paid', status = 'pending' where id = v_order.id;
    insert into public.order_status_history(order_id, store_id, from_status, to_status)
    values (v_order.id, v_order.store_id, 'awaiting_payment', 'pending');
  else
    -- pago depois de expirado/cancelado: dinheiro entrou, precisa estornar
    update public.orders set payment_status = 'paid', refund_required = true where id = v_order.id;
  end if;

  update public.payment_events set processed_at = now() where id = v_event;
  return 'paid';
end;
$$;

-- ---------------------------------------------------------------------
-- Devolve o uso do cupom quando o pedido não se concretiza
create or replace function public._release_coupon(p_coupon_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.coupons set uses_count = greatest(uses_count - 1, 0) where id = p_coupon_id;
$$;

-- ---------------------------------------------------------------------
-- Mudança de status pelo painel (máquina de estados)
create or replace function public.update_order_status(p_order_id uuid, p_to public.order_status)
returns public.order_status
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.orders;
  v_ok    boolean := false;
  v_admin boolean;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null or not public.is_store_member(v_order.store_id) then
    raise exception 'Pedido não encontrado.';
  end if;
  v_admin := public.is_store_member(v_order.store_id, array['owner','manager']::public.member_role[]);

  v_ok := case v_order.status
    when 'pending'          then p_to in ('preparing','rejected')
    when 'preparing'        then p_to = 'ready' or (p_to = 'canceled' and v_admin)
    when 'ready'            then (p_to = 'out_for_delivery' and v_order.mode = 'delivery')
                                 or (p_to = 'completed' and v_order.mode = 'pickup')
                                 or (p_to = 'canceled' and v_admin)
    when 'out_for_delivery' then p_to = 'completed' or (p_to = 'canceled' and v_admin)
    when 'awaiting_payment' then p_to = 'canceled' and v_admin
    else false
  end;
  if not v_ok then
    raise exception 'Mudança de status não permitida (% → %).', v_order.status, p_to;
  end if;

  update public.orders set status = p_to,
    refund_required = refund_required or (p_to in ('rejected','canceled') and payment_status = 'paid'),
    payment_status = case when p_to = 'canceled' and payment_status = 'pending' then 'expired'::public.payment_status else payment_status end
  where id = v_order.id;

  if p_to in ('rejected','canceled') and v_order.coupon_id is not null then
    perform public._release_coupon(v_order.coupon_id);
  end if;

  if p_to = 'completed' and v_order.customer_id is not null then
    update public.customers
       set orders_count = orders_count + 1,
           total_spent_cents = total_spent_cents + v_order.total_cents,
           last_order_at = greatest(coalesce(last_order_at, v_order.created_at), v_order.created_at)
     where id = v_order.customer_id;
  end if;

  insert into public.order_status_history(order_id, store_id, from_status, to_status, changed_by)
  values (v_order.id, v_order.store_id, v_order.status, p_to, (select auth.uid()));
  return p_to;
end;
$$;

-- ---------------------------------------------------------------------
-- Cancela Pix não pago após o prazo (rodar a cada minuto via pg_cron)
create or replace function public.expire_pending_payments(p_minutes integer default 30)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare v_order public.orders; v_n integer := 0;
begin
  for v_order in
    select * from public.orders
     where status = 'awaiting_payment' and created_at < now() - make_interval(mins => p_minutes)
     for update skip locked
  loop
    update public.orders set status = 'canceled', payment_status = 'expired' where id = v_order.id;
    update public.payments set status = 'expired' where order_id = v_order.id and status = 'pending';
    if v_order.coupon_id is not null then perform public._release_coupon(v_order.coupon_id); end if;
    insert into public.order_status_history(order_id, store_id, from_status, to_status)
    values (v_order.id, v_order.store_id, 'awaiting_payment', 'canceled');
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- Acompanhamento público do pedido (link com token secreto).
-- Não expõe telefone nem endereço.
create or replace function public.get_order_tracking(p_token uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'number', o.number, 'status', o.status, 'mode', o.mode,
    'payment_method', o.payment_method, 'payment_status', o.payment_status,
    'subtotal_cents', o.subtotal_cents, 'discount_cents', o.discount_cents,
    'delivery_fee_cents', o.delivery_fee_cents, 'total_cents', o.total_cents,
    'created_at', o.created_at,
    'store', jsonb_build_object('name', s.name, 'slug', s.slug, 'prep_minutes', s.prep_minutes + case when s.high_demand then 20 else 0 end),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', i.product_name, 'quantity', i.quantity,
                 'addons', (select coalesce(jsonb_agg(a->>'name'), '[]'::jsonb) from jsonb_array_elements(i.addons) a),
                 'line_total_cents', i.line_total_cents)), '[]'::jsonb)
              from public.order_items i where i.order_id = o.id),
    'pix_copy_paste', (select p.pix_copy_paste from public.payments p
                        where p.order_id = o.id and p.status = 'pending' and o.status = 'awaiting_payment'
                        order by p.created_at desc limit 1))
  from public.orders o join public.stores s on s.id = o.store_id
  where o.public_token = p_token;
$$;

-- ---------------------------------------------------------------------
-- Cadastro de loja (o usuário vira dono)
create or replace function public.create_store(p_name text, p_slug text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_id uuid;
begin
  if v_uid is null then raise exception 'Faça login.'; end if;
  if (select count(*) from public.store_members where user_id = v_uid and role = 'owner') >= 3 then
    raise exception 'Limite de lojas atingido.';
  end if;
  insert into public.stores(name, slug) values (trim(p_name), lower(trim(p_slug))) returning id into v_id;
  insert into public.store_members(store_id, user_id, role) values (v_id, v_uid, 'owner');
  return v_id;
exception when unique_violation then
  raise exception 'Esse endereço de loja já está em uso.';
end;
$$;

-- ---------------------------------------------------------------------
-- LGPD: anonimizar cliente a pedido do titular (somente dono)
create or replace function public.anonymize_customer(p_customer_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_c public.customers;
begin
  select * into v_c from public.customers where id = p_customer_id for update;
  if v_c.id is null or not public.is_store_member(v_c.store_id, array['owner']::public.member_role[]) then
    raise exception 'Cliente não encontrado.';
  end if;
  update public.customers set name = 'Cliente removido', phone = 'anon-' || replace(v_c.id::text, '-', ''),
         marketing_opt_in = false, anonymized_at = now() where id = v_c.id;
  update public.orders set customer_name = 'Cliente removido', customer_phone = 'anonimizado',
         delivery_address = case when mode = 'delivery' then '[removido]' end
   where customer_id = v_c.id;
end;
$$;

-- ---------------------------------------------------------------------
-- Relatório de vendas (owner/manager)
create or replace function public.sales_report(p_store_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v jsonb;
begin
  if not public.is_store_member(p_store_id, array['owner','manager']::public.member_role[]) then
    raise exception 'Sem permissão.';
  end if;
  with o as (
    select * from public.orders
     where store_id = p_store_id and created_at >= p_from and created_at < p_to
       and status not in ('awaiting_payment','rejected','canceled')
  ), i as (
    select i.* from public.order_items i join o on o.id = i.order_id
  )
  select jsonb_build_object(
    'orders', (select count(*) from o),
    'revenue_cents', (select coalesce(sum(total_cents), 0) from o),
    'avg_ticket_cents', (select coalesce(round(avg(total_cents)), 0) from o),
    'discount_cents', (select coalesce(sum(discount_cents), 0) from o),
    'cogs_cents', (select coalesce(sum(unit_cost_cents * quantity), 0) from i),
    'gross_profit_cents', (select coalesce(sum(subtotal_cents - discount_cents), 0) from o)
                         - (select coalesce(sum(unit_cost_cents * quantity), 0) from i),
    'by_payment', (select coalesce(jsonb_object_agg(payment_method, total), '{}'::jsonb)
                     from (select payment_method, sum(total_cents) total from o group by 1) t),
    'top_products', (select coalesce(jsonb_agg(t order by t.qty desc), '[]'::jsonb) from
                      (select product_name as name, sum(quantity) qty, sum(line_total_cents) revenue_cents
                         from i group by 1 order by 2 desc limit 10) t),
    'rejected_or_canceled', (select count(*) from public.orders
                              where store_id = p_store_id and created_at >= p_from and created_at < p_to
                                and status in ('rejected','canceled'))
  ) into v;
  return v;
end;
$$;

-- ---------------------------------------------------------------------
-- Anti-spam: limite de chamadas por chave (IP/telefone)
create or replace function public.check_rate_limit(p_key text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_start timestamptz; v_hits integer;
begin
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits(key, window_start, hits) values (p_key, v_start, 1)
  on conflict (key, window_start) do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;
  return v_hits <= p_max;
end;
$$;

-- ---------------------------------------------------------------------
-- Permissões das funções
revoke all on function public._price_order(uuid, jsonb, boolean)            from public, anon, authenticated;
revoke all on function public._release_coupon(uuid)                         from public, anon, authenticated;
revoke all on function public.quote_order(text, jsonb)                      from public, anon, authenticated;
revoke all on function public.create_order(text, jsonb)                     from public, anon, authenticated;
revoke all on function public.register_payment(uuid, text, text, integer, text, timestamptz) from public, anon, authenticated;
revoke all on function public.confirm_payment(text, text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.expire_pending_payments(integer)              from public, anon, authenticated;
revoke all on function public.check_rate_limit(text, integer, integer)      from public, anon, authenticated;
revoke all on function public.get_order_tracking(uuid)                      from public;
revoke all on function public.update_order_status(uuid, public.order_status) from public, anon;
revoke all on function public.create_store(text, text)                      from public, anon;
revoke all on function public.anonymize_customer(uuid)                      from public, anon;
revoke all on function public.sales_report(uuid, timestamptz, timestamptz)  from public, anon;

grant execute on function public.quote_order(text, jsonb), public.create_order(text, jsonb),
  public.register_payment(uuid, text, text, integer, text, timestamptz),
  public.confirm_payment(text, text, text, integer, jsonb),
  public.expire_pending_payments(integer), public.check_rate_limit(text, integer, integer)
  to service_role;
grant execute on function public.get_order_tracking(uuid) to anon, authenticated;
grant execute on function public.update_order_status(uuid, public.order_status),
  public.create_store(text, text), public.anonymize_customer(uuid),
  public.sales_report(uuid, timestamptz, timestamptz) to authenticated;
