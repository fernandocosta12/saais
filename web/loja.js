// Loja pública: cardápio, sacola e finalização do pedido.
// Preços exibidos aqui são só informativos: o servidor recalcula tudo.
(function () {
  const { esc, money, toast } = ui;
  const $ = (s) => document.querySelector(s);
  const slug = (new URLSearchParams(location.search).get('s') || '').toLowerCase();
  const CART_KEY = 'pd_cart_' + slug;
  const LAST_KEY = 'pd_last_' + slug;
  const CUST_KEY = 'pd_customer';

  let store = null, cats = [], prods = [], addons = {};
  let cart = readLS(CART_KEY, []);
  const saved = readLS(CUST_KEY, {});
  const ck = { mode: 'delivery', pay: null, cpf: '', name: saved.name || '', phone: saved.phone || '', address: saved.address || '',
    change: '', coupon: '', notes: '', optin: false, quote: null, quoteErr: '', busy: false };
  let step = 'cart', pm = null;

  function readLS(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  const safeImg = (u) => api.isStoreImage(u) ? u : '';  // só fotos do nosso armazenamento
  const prodById = (id) => prods.find((p) => p.id === id);

  // ------------------------------------------------------------ carga
  async function load() {
    if (!/^[a-z0-9-]{3,40}$/.test(slug)) return fatal('Endereço de loja inválido.');
    try {
      const st = await api.select('stores', { slug: 'eq.' + slug, select: 'id,slug,name,logo_url,address,whatsapp,is_open,high_demand,delivery_fee_cents,min_order_cents,prep_minutes,pix_enabled' }, { auth: false });
      if (!st.length) return fatal('Loja não encontrada.');
      store = st[0];
      if (!ck.pay || (ck.pay === 'pix' && !store.pix_enabled)) ck.pay = store.pix_enabled ? 'pix' : 'card_on_delivery';
      document.title = store.name + ' — Cardápio';
      const [c, p, a] = await Promise.all([
        api.select('categories', { store_id: 'eq.' + store.id, is_active: 'eq.true', select: 'id,name,position', order: 'position,name' }, { auth: false }),
        api.select('products', { store_id: 'eq.' + store.id, select: 'id,category_id,name,description,price_cents,image_url,is_available,position', order: 'position,name' }, { auth: false }),
        api.select('product_addons', { store_id: 'eq.' + store.id, is_available: 'eq.true', select: 'id,product_id,name,price_cents,position', order: 'position,name' }, { auth: false })
      ]);
      cats = c; prods = p; addons = {};
      a.forEach((x) => { (addons[x.product_id] = addons[x.product_id] || []).push(x); });
      // remove da sacola itens que sumiram/esgotaram
      cart = cart.filter((i) => { const pr = prodById(i.pid); return pr && pr.is_available; });
      saveCart();
      render();
    } catch (e) { fatal(e.message); }
  }
  function fatal(msg) { $('#app').innerHTML = '<div class="center card" style="text-align:center"><h2>Ops!</h2><p class="muted">' + esc(msg) + '</p></div>'; }
  function saveCart() { writeLS(CART_KEY, cart); }

  // ------------------------------------------------------------ preços locais (prévia)
  function unitOf(i) {
    const p = prodById(i.pid); if (!p) return 0;
    const ad = (addons[p.id] || []).filter((a) => i.addon_ids.includes(a.id));
    return p.price_cents + ad.reduce((s, a) => s + a.price_cents, 0);
  }
  const cartCount = () => cart.reduce((s, i) => s + i.qty, 0);
  const cartSubtotal = () => cart.reduce((s, i) => s + unitOf(i) * i.qty, 0);
  const prep = () => store.prep_minutes + (store.high_demand ? 20 : 0);

  // ------------------------------------------------------------ render
  function render() {
    const last = readLS(LAST_KEY, null);
    const logo = safeImg(store.logo_url) ? '<img src="' + esc(store.logo_url) + '" alt="">' : esc(store.name.slice(0, 1));
    const groups = cats.map((c) => ({ c, items: prods.filter((p) => p.category_id === c.id) })).filter((g) => g.items.length);
    const loose = prods.filter((p) => !cats.some((c) => c.id === p.category_id));
    if (loose.length) groups.push({ c: { id: 'outros', name: 'Outros' }, items: loose });

    let h = '<div class="shop"><div class="hero"><div class="logo">' + logo + '</div><h1>' + esc(store.name) + '</h1>' +
      (store.address ? '<div class="small" style="opacity:.8;margin-top:4px">' + esc(store.address) + '</div>' : '') +
      '<div class="meta"><span>' + (store.is_open ? '🟢 Aberto agora' : '🔴 Fechado') + '</span>' +
      '<span>⏱ ' + prep() + '–' + (prep() + 15) + ' min</span>' +
      '<span>🛵 Entrega ' + (store.delivery_fee_cents ? money(store.delivery_fee_cents) : 'grátis') + '</span>' +
      (store.min_order_cents ? '<span>Pedido mín. ' + money(store.min_order_cents) + '</span>' : '') + '</div></div>';
    if (!store.is_open) h += '<div class="note red">A loja está fechada no momento. Você pode ver o cardápio, mas não é possível finalizar pedidos.</div>';
    else if (store.high_demand) h += '<div class="note warn">Estamos com alta demanda — o tempo de entrega pode ser maior.</div>';
    if (last && last.token && Date.now() - last.at < 6 * 3600 * 1000) {
      h += '<div class="track-banner"><span style="font-size:26px">🛵</span><div><b>Pedido #' + esc(last.number) + '</b><div class="small muted">Acompanhe o andamento</div></div>' +
        '<a class="btn sm" href="pedido.html?t=' + encodeURIComponent(last.token) + '">Acompanhar</a></div>';
    }
    h += '<div class="cats">' + groups.map((g) => '<button data-act="goCat" data-id="' + esc(g.c.id) + '">' + esc(g.c.name) + '</button>').join('') + '</div>';
    if (!groups.length) h += '<p class="center muted">O cardápio ainda está vazio.</p>';
    groups.forEach((g) => {
      h += '<h2 class="sec-title" id="cat-' + esc(g.c.id) + '">' + esc(g.c.name) + '</h2><div class="grid">';
      g.items.forEach((p) => {
        const img = safeImg(p.image_url) ? '<img src="' + esc(p.image_url) + '" alt="" loading="lazy">' : '🍽️';
        h += '<button class="prod ' + (p.is_available ? '' : 'off') + '" ' + (p.is_available ? 'data-act="openProduct" data-id="' + p.id + '"' : 'disabled') + '>' +
          '<div class="em">' + img + '</div><div><h3>' + esc(p.name) + '</h3>' + (p.description ? '<p>' + esc(p.description) + '</p>' : '') +
          '<span class="price">' + (p.is_available ? money(p.price_cents) : '<span class="pill">Esgotado</span>') + '</span></div></button>';
      });
      h += '</div>';
    });
    h += '<p class="small muted" style="text-align:center;margin:30px 16px">Pedido feito direto com o restaurante.</p></div>';
    const n = cartCount();
    if (n) h += '<button class="cartbar" data-act="openCart"><span>🛍️ Ver sacola · ' + n + ' ' + (n > 1 ? 'itens' : 'item') + '</span><span>' + money(cartSubtotal()) + '</span></button>';
    $('#app').innerHTML = h;
  }

  // ------------------------------------------------------------ modal
  function modal(html) { $('#modalRoot').innerHTML = '<div class="ov" data-act="ovClick"><div class="modal">' + html + '</div></div>'; }
  function closeModal() { $('#modalRoot').innerHTML = ''; }
  const mh = (t) => '<div class="mh"><h2 style="font-size:20px">' + t + '</h2><button class="x" data-act="close" aria-label="Fechar">×</button></div>';

  function drawProduct() {
    const p = pm.p, list = addons[p.id] || [];
    const unit = p.price_cents + list.filter((a) => pm.sel.has(a.id)).reduce((s, a) => s + a.price_cents, 0);
    const img = safeImg(p.image_url) ? '<img src="' + esc(p.image_url) + '" alt="" style="width:100%;max-height:220px;object-fit:cover;border-radius:14px">' : '';
    modal(mh(esc(p.name)) + img + (p.description ? '<p class="muted">' + esc(p.description) + '</p>' : '') +
      '<b style="font-size:18px">' + money(p.price_cents) + '</b>' +
      (list.length ? '<h3 style="margin-top:16px;font-size:15px">Adicionais</h3>' + list.map((a) =>
        '<label class="addon"><input type="checkbox" data-change="toggleAddon" data-id="' + a.id + '" ' + (pm.sel.has(a.id) ? 'checked' : '') + '><span>' + esc(a.name) + '</span><b>+ ' + money(a.price_cents) + '</b></label>').join('') : '') +
      '<label class="f">Alguma observação?</label><textarea id="pObs" maxlength="200" placeholder="Ex.: sem cebola">' + esc(pm.notes) + '</textarea>' +
      '<div class="row" style="margin-top:16px"><div class="qty"><button data-act="pmQty" data-d="-1">−</button><b>' + pm.qty + '</b><button data-act="pmQty" data-d="1">+</button></div>' +
      '<button class="btn" style="flex:1" data-act="addToCart">Adicionar · ' + money(unit * pm.qty) + '</button></div>');
  }
  const keepObs = () => { const e = $('#pObs'); if (e) pm.notes = e.value; };

  function addItem(pid, addonIds, qty, notes) {
    const key = pid + '|' + addonIds.slice().sort().join(',') + '|' + notes;
    const ex = cart.find((c) => c.key === key);
    if (ex) ex.qty = Math.min(50, ex.qty + qty);
    else cart.push({ key, pid, addon_ids: addonIds, qty, notes });
    saveCart();
  }

  // ------------------------------------------------------------ sacola / checkout
  function payload() {
    return {
      mode: ck.mode, payment_method: ck.pay, coupon_code: ck.coupon.trim(), notes: ck.notes,
      change_for_cents: ck.pay === 'cash' && ck.change ? ui.toCents(ck.change) : null,
      customer: { name: ck.name.trim(), phone: ui.digits(ck.phone), address: ck.mode === 'delivery' ? ck.address.trim() : '', marketing_opt_in: ck.optin, cpf: ck.pay === 'pix' ? ui.digits(ck.cpf) : undefined },
      items: cart.map((i) => ({ product_id: i.pid, quantity: i.qty, addon_ids: i.addon_ids, notes: i.notes }))
    };
  }
  async function refreshQuote() {
    ck.quoteErr = '';
    try {
      ck.quote = await api.fn('create-order', { store_slug: slug, action: 'quote', payload: payload() });
    } catch (e) {
      ck.quote = null; ck.quoteErr = e.message;
      if (ck.coupon && /upom/.test(e.message)) { /* erro de cupom: mantém o texto para o usuário corrigir */ }
    }
    if (step === 'dados' && document.getElementById('ckName')) {
      // preserva o que a pessoa digitou enquanto o total era calculado
      keepCk();
      const active = document.activeElement && document.activeElement.id;
      drawCart();
      const el = active && document.getElementById(active);
      if (el) { el.focus(); if (el.setSelectionRange && el.type !== 'email') { const n = el.value.length; try { el.setSelectionRange(n, n); } catch (e) {} } }
    }
  }

  function drawCart() {
    if (!cart.length) { closeModal(); render(); return; }
    if (step === 'cart') {
      const sub = cartSubtotal();
      const inCat = (re) => cart.some((i) => { const p = prodById(i.pid); const c = p && cats.find((x) => x.id === p.category_id); return c && re.test(c.name); });
      const sugg = prods.filter((p) => {
        if (!p.is_available) return false;
        const c = cats.find((x) => x.id === p.category_id); if (!c) return false;
        return (!inCat(/sobremesa|doce/i) && /sobremesa|doce/i.test(c.name)) || (!inCat(/bebida/i) && /bebida/i.test(c.name));
      }).slice(0, 3);
      modal(mh('Sua sacola') + cart.map((i, ix) => {
        const p = prodById(i.pid); const ad = (addons[i.pid] || []).filter((a) => i.addon_ids.includes(a.id));
        return '<div class="citem"><div class="d"><b>' + esc(p.name) + '</b>' +
          (ad.length ? '<div class="small muted">+ ' + esc(ad.map((a) => a.name).join(', ')) + '</div>' : '') +
          (i.notes ? '<div class="small muted">Obs.: ' + esc(i.notes) + '</div>' : '') +
          '<div class="small" style="margin-top:4px">' + money(unitOf(i) * i.qty) + '</div></div>' +
          '<div class="qty" style="align-self:center"><button data-act="cQty" data-ix="' + ix + '" data-d="-1">' + (i.qty === 1 ? '🗑' : '−') + '</button><b>' + i.qty + '</b><button data-act="cQty" data-ix="' + ix + '" data-d="1">+</button></div></div>';
      }).join('') +
        (sugg.length ? '<div class="upsell">✨ <b>Que tal completar o pedido?</b><div class="row">' + sugg.map((p) =>
          '<button class="btn sec sm" data-act="quickAdd" data-id="' + p.id + '">' + esc(p.name) + ' · ' + money(p.price_cents) + '</button>').join('') + '</div></div>' : '') +
        '<div style="margin-top:12px"><div class="line"><span>Subtotal</span><b>' + money(sub) + '</b></div></div>' +
        (sub < store.min_order_cents ? '<div class="err">Pedido mínimo de ' + money(store.min_order_cents) + '.</div>' : '') +
        '<button class="btn full" style="margin-top:14px" data-act="toCheckout" ' + (sub < store.min_order_cents || !store.is_open ? 'disabled' : '') + '>' + (store.is_open ? 'Continuar' : 'Loja fechada') + '</button>');
      return;
    }
    const q = ck.quote;
    modal(mh('Finalizar pedido') +
      '<div class="seg"><button class="' + (ck.mode === 'delivery' ? 'on' : '') + '" data-act="setCk" data-k="mode" data-v="delivery">🛵 Entrega</button><button class="' + (ck.mode === 'pickup' ? 'on' : '') + '" data-act="setCk" data-k="mode" data-v="pickup">🏪 Retirar</button></div>' +
      '<label class="f" for="ckName">Seu nome</label><input id="ckName" maxlength="80" autocomplete="name" value="' + esc(ck.name) + '">' +
      '<label class="f" for="ckPhone">WhatsApp</label><input id="ckPhone" inputmode="tel" autocomplete="tel" maxlength="20" value="' + esc(ck.phone) + '" placeholder="(11) 99999-9999">' +
      (ck.mode === 'delivery' ? '<label class="f" for="ckAddr">Endereço de entrega</label><textarea id="ckAddr" maxlength="300" autocomplete="street-address" placeholder="Rua, número, bairro, complemento">' + esc(ck.address) + '</textarea>'
        : '<p class="small muted">Retirada em: ' + esc(store.address || 'endereço da loja') + '</p>') +
      '<label class="f">Forma de pagamento</label><div class="seg">' +
      [['pix', 'Pix'], ['card_on_delivery', 'Cartão na entrega'], ['cash', 'Dinheiro']].filter(([v]) => v !== 'pix' || store.pix_enabled).map(([v, l]) =>
        '<button class="' + (ck.pay === v ? 'on' : '') + '" data-act="setCk" data-k="pay" data-v="' + v + '">' + l + '</button>').join('') + '</div>' +
      (ck.pay === 'pix' ? '<label class="f" for="ckCpf">CPF de quem vai pagar o Pix</label><input id="ckCpf" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="000.000.000-00" value="' + esc(ck.cpf) + '">' +
        '<p class="small muted" style="margin:4px 0 0">Exigido pelo banco para gerar o Pix. Não fica salvo no restaurante.</p>' : '') +
      (ck.pay === 'cash' ? '<label class="f" for="ckChange">Troco para quanto? (opcional)</label><input id="ckChange" inputmode="decimal" value="' + esc(ck.change) + '" placeholder="Ex.: 100">' : '') +
      '<label class="f" for="ckCoupon">Cupom de desconto</label><div class="row"><input id="ckCoupon" maxlength="20" style="text-transform:uppercase" value="' + esc(ck.coupon) + '"><button class="btn sec" data-act="applyCoupon">Aplicar</button></div>' +
      '<label class="f" for="ckNotes">Observação do pedido (opcional)</label><input id="ckNotes" maxlength="300" value="' + esc(ck.notes) + '">' +
      '<label class="chk"><input type="checkbox" id="ckOptin" ' + (ck.optin ? 'checked' : '') + '>Quero receber promoções desta loja pelo WhatsApp.</label>' +
      '<div style="margin-top:6px">' + (q ?
        '<div class="line"><span>Subtotal</span><span>' + money(q.subtotal_cents) + '</span></div>' +
        (q.discount_cents ? '<div class="line" style="color:var(--ok)"><span>Desconto' + (q.coupon_code ? ' (' + esc(q.coupon_code) + ')' : '') + '</span><span>− ' + money(q.discount_cents) + '</span></div>' : '') +
        '<div class="line"><span>Taxa de entrega</span><span>' + (q.delivery_fee_cents ? money(q.delivery_fee_cents) : 'Grátis') + '</span></div>' +
        '<div class="line tot"><span>Total</span><span>' + money(q.total_cents) + '</span></div>'
        : '<div class="small muted">' + (ck.quoteErr ? '' : 'Calculando total…') + '</div>') + '</div>' +
      '<div id="ckErr" class="err">' + esc(ck.quoteErr) + '</div>' +
      '<p class="small muted">Seus dados são usados só para entregar este pedido e ficam com o restaurante.</p>' +
      '<div class="row" style="margin-top:10px"><button class="btn sec" data-act="backCart">Voltar</button>' +
      '<button class="btn" style="flex:1" data-act="placeOrder" ' + (ck.busy || !q ? 'disabled' : '') + '>' + (ck.busy ? 'Enviando…' : 'Fazer pedido' + (q ? ' · ' + money(q.total_cents) : '')) + '</button></div>');
  }
  function keepCk() {
    const g = (id) => { const e = $('#' + id); return e ? (e.type === 'checkbox' ? e.checked : e.value) : null; };
    [['ckName', 'name'], ['ckPhone', 'phone'], ['ckCpf', 'cpf'], ['ckAddr', 'address'], ['ckChange', 'change'], ['ckCoupon', 'coupon'], ['ckNotes', 'notes'], ['ckOptin', 'optin']]
      .forEach(([id, k]) => { const v = g(id); if (v !== null) ck[k] = v; });
  }

  async function placeOrder() {
    keepCk();
    const err = (m) => { $('#ckErr').textContent = m; };
    if (ck.name.trim().length < 2) return err('Informe seu nome.');
    if (ui.digits(ck.phone).length < 10) return err('Informe um WhatsApp válido com DDD.');
    if (ck.mode === 'delivery' && ck.address.trim().length < 8) return err('Informe o endereço completo.');
    if (ck.pay === 'cash' && ck.change && !(ui.toCents(ck.change) > 0)) return err('Valor de troco inválido.');
    if (ck.pay === 'pix' && !ui.isCpf(ck.cpf)) return err('Informe um CPF válido para pagar com Pix.');
    ck.busy = true; drawCart();
    try {
      const r = await api.fn('create-order', { store_slug: slug, action: 'create', payload: payload() });
      writeLS(CUST_KEY, { name: ck.name.trim(), phone: ck.phone, address: ck.address.trim() });
      writeLS(LAST_KEY, { token: r.public_token, number: r.number, at: Date.now() });
      cart = []; saveCart(); ck.coupon = ''; ck.notes = ''; ck.change = ''; ck.cpf = ''; ck.quote = null; ck.busy = false;
      if (r.pix) showPix(r);
      else if (r.pix_error) { render(); modal(mh('Pedido #' + esc(r.number)) + '<div class="note red" style="margin:0">' + esc(r.pix_error) + '</div><p class="small muted">Esse pedido será cancelado automaticamente em 30 minutos se não for pago.</p><button class="btn full" data-act="close">Voltar ao cardápio</button>'); }
      else location.href = 'pedido.html?t=' + encodeURIComponent(r.public_token);
    } catch (e) {
      ck.busy = false; drawCart(); $('#ckErr').textContent = e.message;
      if (/disponível|Atualize/.test(e.message)) load();
    }
  }

  function showPix(r) {
    render();
    const qr = r.pix.qr_code_base64 && /^[A-Za-z0-9+/=]+$/.test(r.pix.qr_code_base64)
      ? '<img class="qrimg" alt="QR Code Pix" src="data:image/png;base64,' + r.pix.qr_code_base64 + '">' : '';
    modal(mh('Pague com Pix') + '<p class="small muted" style="margin-top:0">Pedido #' + esc(r.number) + ' · <b style="color:var(--ink)">' + money(r.total_cents) + '</b></p>' +
      qr + '<div class="code" id="pixCode">' + esc(r.pix.copy_paste) + '</div>' +
      '<button class="btn sec full" style="margin-top:10px" data-act="copyPix">📋 Copiar código Pix</button>' +
      '<p class="small muted">Assim que o banco confirmar o pagamento, seu pedido vai para a cozinha automaticamente. O código vale por 30 minutos.</p>' +
      '<a class="btn full" href="pedido.html?t=' + encodeURIComponent(r.public_token) + '">Acompanhar pedido</a>');
  }

  // ------------------------------------------------------------ ações
  ui.bind(document, {
    goCat: (el) => { const t = document.getElementById('cat-' + el.dataset.id); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    ovClick: (el, e) => { if (e.target === el) closeModal(); },
    close: () => closeModal(),
    openProduct: (el) => { const p = prodById(el.dataset.id); if (p) { pm = { p, qty: 1, sel: new Set(), notes: '' }; drawProduct(); } },
    toggleAddon: (el) => { keepObs(); el.checked ? pm.sel.add(el.dataset.id) : pm.sel.delete(el.dataset.id); drawProduct(); },
    pmQty: (el) => { keepObs(); pm.qty = Math.max(1, Math.min(50, pm.qty + Number(el.dataset.d))); drawProduct(); },
    addToCart: () => { keepObs(); addItem(pm.p.id, [...pm.sel], pm.qty, pm.notes.trim().slice(0, 200)); closeModal(); render(); toast(pm.p.name + ' adicionado à sacola'); },
    openCart: () => { step = 'cart'; drawCart(); },
    cQty: (el) => { const i = cart[Number(el.dataset.ix)]; if (!i) return; i.qty = Math.min(50, i.qty + Number(el.dataset.d)); if (i.qty <= 0) cart.splice(Number(el.dataset.ix), 1); saveCart(); render(); drawCart(); },
    quickAdd: (el) => { addItem(el.dataset.id, [], 1, ''); render(); drawCart(); },
    toCheckout: () => { step = 'dados'; ck.quote = null; drawCart(); refreshQuote(); },
    backCart: () => { keepCk(); step = 'cart'; drawCart(); },
    setCk: (el) => { keepCk(); ck[el.dataset.k] = el.dataset.v; drawCart(); if (el.dataset.k === 'mode') refreshQuote(); },
    applyCoupon: () => { keepCk(); ck.quote = null; drawCart(); refreshQuote(); },
    placeOrder: () => placeOrder(),
    copyPix: () => {
      const t = $('#pixCode').textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Código copiado'), () => toast('Selecione e copie o código'));
    }
  });

  // máscara de CPF
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'ckCpf') return;
    const d = e.target.value.replace(/\D/g, '').slice(0, 11);
    e.target.value = d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
  });

  load();
})();
