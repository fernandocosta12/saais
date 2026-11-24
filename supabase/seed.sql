-- Loja de demonstração (Brasa Burger) — use em desenvolvimento
do $$
declare s uuid; c_b uuid; c_p uuid; c_bb uuid; c_s uuid; p uuid;
begin
  insert into public.stores(slug, name, address, whatsapp, is_open, delivery_fee_cents, min_order_cents, prep_minutes)
  values ('brasa-burger', 'Brasa Burger', 'Rua das Flores, 120 — Centro', '11999990000', true, 600, 2000, 40)
  on conflict (slug) do nothing returning id into s;
  if s is null then return; end if;

  insert into public.categories(store_id, name, position) values (s, 'Burgers', 1) returning id into c_b;
  insert into public.categories(store_id, name, position) values (s, 'Porções', 2) returning id into c_p;
  insert into public.categories(store_id, name, position) values (s, 'Bebidas', 3) returning id into c_bb;
  insert into public.categories(store_id, name, position) values (s, 'Sobremesas', 4) returning id into c_s;

  insert into public.products(store_id, category_id, name, description, price_cents, position)
  values (s, c_b, 'Brasa Clássico', 'Blend 160g, queijo prato, alface, tomate e molho da casa.', 2990, 1) returning id into p;
  insert into public.product_costs(product_id, store_id, cost_cents) values (p, s, 1100);
  insert into public.product_addons(store_id, product_id, name, price_cents, position) values
    (s, p, 'Bacon', 400, 1), (s, p, 'Cheddar extra', 300, 2), (s, p, 'Ovo', 250, 3);

  insert into public.products(store_id, category_id, name, description, price_cents, position)
  values (s, c_b, 'Duplo Cheddar', 'Dois blends 120g, cheddar cremoso e cebola caramelizada.', 3690, 2) returning id into p;
  insert into public.product_costs(product_id, store_id, cost_cents) values (p, s, 1500);
  insert into public.product_addons(store_id, product_id, name, price_cents, position) values (s, p, 'Bacon', 400, 1);

  insert into public.products(store_id, category_id, name, description, price_cents, position)
  values (s, c_p, 'Batata Frita', 'Porção média, crocante.', 1690, 1) returning id into p;
  insert into public.product_costs(product_id, store_id, cost_cents) values (p, s, 450);

  insert into public.products(store_id, category_id, name, description, price_cents, position)
  values (s, c_bb, 'Refrigerante lata', '350ml', 650, 1) returning id into p;
  insert into public.product_costs(product_id, store_id, cost_cents) values (p, s, 280);

  insert into public.products(store_id, category_id, name, description, price_cents, position)
  values (s, c_s, 'Brownie com sorvete', 'Brownie quentinho com bola de creme.', 1790, 1) returning id into p;
  insert into public.product_costs(product_id, store_id, cost_cents) values (p, s, 500);

  insert into public.coupons(store_id, code, type, value, min_order_cents) values
    (s, 'BEMVINDO10', 'percent', 10, 3000),
    (s, 'FRETEGRATIS', 'free_delivery', 0, 5000),
    (s, 'VOLTA15', 'fixed', 1500, 6000);
end $$;
