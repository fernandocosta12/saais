// Painel do restaurante: login, pedidos em tempo real (atualização a cada 5s),
// cardápio, cupons, clientes, relatórios e configurações.
// Todas as permissões são garantidas no banco (RLS + funções); a tela só
// esconde o que o papel do usuário não pode fazer.
(function () {
  const { esc, money, toast } = ui;
  const $ = (s) => document.querySelector(s);
  const app = $('#app');

  const STATUS = [['pending', 'Em análise'], ['preparing', 'Em preparo'], ['ready', 'Pronto'], ['out_for_delivery', 'Em entrega'], ['completed', 'Finalizado']];
  const PAY = { pix: 'Pix', card_online: 'Cartão online', card_on_delivery: 'Cartão na entrega', cash: 'Dinheiro' };
  const ROLE = { owner: 'Dono', manager: 'Gerente', staff: 'Funcionário' };
  const STORE_COLS = 'id,slug,name,logo_url,address,whatsapp,status,is_open,high_demand,delivery_fee_cents,min_order_cents,prep_minutes';

  let memberships = [], cur = null, tab = 'pedidos';
  let orders = [], seenPending = null, pollTimer = null, audioCtx = null;
  let menu = { cats: [], prods: [], addons: [], costs: {} };
  let clientFilter = 'todos', reportPeriod = 'hoje', authMode = 'login';

  const role = () => cur ? cur.role : null;
  const isAdmin = () => ['owner', 'manager'].includes(role());
  const isOwner = () => role() === 'owner';
  const store = () => cur.stores;

  // =============================================================== boot
  async function boot() {
    const redirect = await api.handleAuthRedirect().catch(() => false);
    if (redirect === 'recovery') return renderNewPassword();
    if (!api.session) return renderAuth();
    await loadMemberships();
  }

  async function loadMemberships() {
    try {
      memberships = await api.select('store_members', { user_id: 'eq.' + api.userId, select: 'role,store_id,stores(' + STORE_COLS + ')' });
    } catch (e) {
      if (!api.session) return renderAuth();
      app.innerHTML = '<div class="center card">' + esc(e.message) + '</div>'; return;
    }
    memberships = memberships.filter((m) => m.stores).sort((a, b) => a.stores.name.localeCompare(b.stores.name, 'pt-BR'));
    if (!memberships.length) return renderOnboarding();
    let saved = null; try { saved = localStorage.getItem('pd_cur_store'); } catch (e) {}
    cur = memberships.find((m) => m.store_id === saved) || memberships[0];
    renderShell();
    startPolling();
  }

  // =============================================================== auth
  function renderAuth(msg) {
    stopPolling();
    const t = { login: 'Entrar no painel', signup: 'Criar conta', forgot: 'Recuperar senha' }[authMode];
    app.innerHTML = '<div class="center"><div class="card"><h2 style="margin-bottom:6px">' + t + '</h2>' +
      '<p class="small muted" style="margin-top:0">Painel do restaurante</p>' +
      (authMode === 'signup' ? '<label class="f" for="aName">Seu nome</label><input id="aName" autocomplete="name" maxlength="120">' : '') +
      '<label class="f" for="aEmail">E-mail</label><input id="aEmail" type="email" autocomplete="email">' +
      (authMode !== 'forgot' ? '<label class="f" for="aPass">Senha</label><input id="aPass" type="password" autocomplete="' + (authMode === 'signup' ? 'new-password' : 'current-password') + '">' : '') +
      (authMode === 'signup' ? '<p class="small muted">Mínimo de 8 caracteres, com letras e números.</p>' : '') +
      '<div id="aErr" class="err">' + esc(msg || '') + '</div>' +
      '<button class="btn full" style="margin-top:8px" data-act="authSubmit">' + { login: 'Entrar', signup: 'Criar conta', forgot: 'Enviar link' }[authMode] + '</button>' +
      '<div class="row small" style="justify-content:space-between;margin-top:14px">' +
      (authMode === 'login' ? '<a href="#" data-act="authMode" data-m="signup">Criar conta</a><a href="#" data-act="authMode" data-m="forgot">Esqueci a senha</a>'
        : '<a href="#" data-act="authMode" data-m="login">Já tenho conta</a>') + '</div></div></div>';
  }

  async function authSubmit(btn) {
    const v = (id) => { const e = $('#' + id); return e ? e.value.trim() : ''; };
    const err = (m) => { $('#aErr').textContent = m; };
    const email = v('aEmail'), pass = $('#aPass') ? $('#aPass').value : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('Informe um e-mail válido.');
    btn.disabled = true;
    try {
      if (authMode === 'login') {
        await api.signIn(email, pass); await loadMemberships();
      } else if (authMode === 'signup') {
        if (v('aName').length < 2) { btn.disabled = false; return err('Informe seu nome.'); }
        if (pass.length < 8 || !/[a-z]/i.test(pass) || !/\d/.test(pass)) { btn.disabled = false; return err('A senha precisa ter 8+ caracteres, com letras e números.'); }
        const r = await api.signUp(email, pass, v('aName'));
        if (r.needsConfirmation) {
          app.innerHTML = '<div class="center card"><h2>Confirme seu e-mail</h2><p class="muted">Enviamos um link para <b>' + esc(email) + '</b>. Clique nele para ativar a conta e voltar ao painel.</p></div>';
        } else await loadMemberships();
      } else {
        await api.recover(email);
        app.innerHTML = '<div class="center card"><h2>Verifique seu e-mail</h2><p class="muted">Se houver uma conta com esse e-mail, você vai receber um link para criar uma nova senha.</p></div>';
      }
    } catch (e) { btn.disabled = false; err(e.message); }
  }

  function renderNewPassword() {
    app.innerHTML = '<div class="center card"><h2>Nova senha</h2><label class="f" for="nPass">Nova senha</label><input id="nPass" type="password" autocomplete="new-password">' +
      '<p class="small muted">Mínimo de 8 caracteres, com letras e números.</p><div id="aErr" class="err"></div>' +
      '<button class="btn full" data-act="savePassword">Salvar</button></div>';
  }

  // =============================================================== onboarding
  function slugify(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }
  function renderOnboarding() {
    stopPolling();
    app.innerHTML = '<div class="center card"><h2>Cadastre sua loja</h2><p class="small muted">Você poderá ajustar tudo depois.</p>' +
      '<label class="f" for="oName">Nome da loja</label><input id="oName" maxlength="80" data-change="slugFromName">' +
      '<label class="f" for="oSlug">Endereço do cardápio</label><input id="oSlug" maxlength="40" placeholder="minha-loja">' +
      '<p class="small muted">Só letras minúsculas, números e hífen.</p><div id="oErr" class="err"></div>' +
      '<button class="btn full" data-act="createStore">Criar loja</button>' +
      '<p class="small" style="text-align:center;margin-top:14px"><a href="#" data-act="logout">Sair</a></p></div>';
  }

  // =============================================================== shell
  function renderShell() {
    const pending = orders.filter((o) => o.status === 'pending').length;
    const tabs = [['pedidos', '📋 Pedidos', pending], ['cardapio', '🍔 Cardápio'], ['cupons', '🏷️ Cupons', 0, true],
      ['clientes', '👥 Clientes'], ['relatorios', '📊 Relatórios', 0, true], ['loja', '⚙️ Loja']]
      .filter((t) => !t[3] || isAdmin());
    if (!tabs.some((t) => t[0] === tab)) tab = 'pedidos';
    app.innerHTML = '<div class="panel"><aside class="side"><div class="brand">' + esc(store().name) + '</div>' +
      (memberships.length > 1 ? '<div style="padding:0 10px 8px"><select data-change="pickStore" aria-label="Escolher loja" style="padding:7px 9px;font-size:13px">' +
        memberships.map((m) => '<option value="' + m.store_id + '"' + (m === cur ? ' selected' : '') + '>' + esc(m.stores.name) + '</option>').join('') + '</select></div>' : '') +
      '<div class="who">' + esc(ROLE[role()]) + '</div>' +
      tabs.map(([id, l, b]) => '<button class="tab ' + (tab === id ? 'on' : '') + '" data-act="tab" data-t="' + id + '"><span>' + l + '</span>' + (b ? '<span class="badge">' + b + '</span>' : '') + '</button>').join('') +
      '<div class="foot"><button class="btn sec sm" data-act="logout">Sair</button></div></aside><main class="main" id="pmain"><div class="loading">Carregando…</div></main></div>';
    ({ pedidos: tabOrders, cardapio: tabMenu, cupons: tabCoupons, clientes: tabClients, relatorios: tabReports, loja: tabStore })[tab]();
  }
  const main = () => $('#pmain');
  const showErr = (e) => { main().innerHTML = '<div class="card">' + esc(e.message || e) + '</div>'; };

  function storeToggles() {
    const s = store(), dis = isAdmin() ? '' : 'disabled title="Só dono ou gerente"';
    return '<button class="toggle ' + (s.is_open ? 'on' : '') + '" data-act="toggleStore" data-k="is_open" ' + dis + '><span class="sw"></span>' + (s.is_open ? 'Loja aberta' : 'Loja fechada') + '</button>' +
      '<button class="toggle warn ' + (s.high_demand ? 'on' : '') + '" data-act="toggleStore" data-k="high_demand" ' + dis + '><span class="sw"></span>Alta demanda</button>';
  }

  // =============================================================== pedidos
  function startOfDay() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }
  async function fetchOrders() {
    const rows = await api.select('orders', {
      store_id: 'eq.' + store().id,
      select: 'id,number,created_at,customer_name,customer_phone,delivery_address,mode,status,payment_method,payment_status,coupon_code,total_cents,change_for_cents,notes,refund_required,order_items(product_name,quantity,addons,notes)',
      or: '(status.in.(awaiting_payment,pending,preparing,ready,out_for_delivery),created_at.gte.' + startOfDay() + ')',
      order: 'created_at.asc', limit: '500'
    });
    orders = rows;
    const pend = new Set(rows.filter((o) => o.status === 'pending').map((o) => o.id));
    if (seenPending && [...pend].some((id) => !seenPending.has(id))) alertNewOrder();
    seenPending = pend;
  }
  function alertNewOrder() {
    toast('🔔 Novo pedido!');
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.2, 0.4].forEach((t) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
        g.gain.setValueAtTime(0.25, audioCtx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t + 0.15);
        o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.16);
      });
    } catch (e) {}
    if (document.hidden) document.title = '🔔 Novo pedido — Painel';
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'Painel do restaurante'; });

  function startPolling() {
    stopPolling();
    const tick = async () => {
      try {
        await fetchOrders();
        const busy = document.activeElement && document.activeElement.matches('input,textarea,select');
        if (tab === 'pedidos' && !busy && !$('#modalRoot').innerHTML) tabOrders(true);
        const badge = document.querySelector('[data-t="pedidos"] .badge');
        const n = orders.filter((o) => o.status === 'pending').length;
        const btn = document.querySelector('[data-t="pedidos"]');
        if (btn) { if (badge) badge.textContent = n; else if (n) btn.insertAdjacentHTML('beforeend', '<span class="badge">' + n + '</span>'); if (!n && badge) badge.remove(); }
      } catch (e) { if (!api.session) renderAuth('Sua sessão expirou. Entre novamente.'); }
    };
    tick(); pollTimer = setInterval(tick, 5000);
  }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; seenPending = null; }

  function tabOrders(fromPoll) {
    if (!fromPoll && !orders.length) { fetchOrders().then(() => tab === 'pedidos' && tabOrders(true)).catch(showErr); }
    const waiting = orders.filter((o) => o.status === 'awaiting_payment');
    const refunds = orders.filter((o) => o.refund_required);
    let h = '<div class="ptop"><h2>Pedidos</h2>' + storeToggles() + '</div>';
    if (refunds.length) h += '<div class="card small" style="background:#fde6e6;border-color:#f1c4c4">⚠️ Estorno necessário (pago e não concluído): ' + refunds.map((o) => '#' + o.number + ' ' + esc(o.customer_name) + ' ' + money(o.total_cents)).join(', ') + '</div>';
    if (waiting.length) h += '<div class="card small" style="background:#fff8ec;border-color:#f0d9a8">⏳ Aguardando pagamento do Pix: ' + waiting.map((o) => '#' + o.number + ' (' + esc(o.customer_name) + ', ' + money(o.total_cents) + ')').join(', ') + '. Eles entram na fila automaticamente quando o pagamento for confirmado.</div>';
    h += '<div class="kanban">' + STATUS.map(([s, label]) => {
      const list = orders.filter((o) => o.status === s);
      if (s === 'completed') list.reverse();
      return '<div class="col"><h4>' + label + '<span class="muted">' + list.length + '</span></h4>' + (list.map(orderCard).join('') || '<div class="small muted" style="padding:6px">Nenhum pedido</div>') + '</div>';
    }).join('') + '</div>';
    const closed = orders.filter((o) => ['rejected', 'canceled'].includes(o.status));
    if (closed.length) h += '<p class="small muted">Recusados/cancelados hoje: ' + closed.map((o) => '#' + o.number).join(', ') + '</p>';
    h += '<p class="small muted">A lista atualiza a cada 5 segundos. Deixe esta aba aberta para ouvir o aviso de novos pedidos.</p>';
    main().innerHTML = h;
  }

  function orderCard(o) {
    const s = store();
    const late = !['completed'].includes(o.status) && Date.now() - new Date(o.created_at).getTime() > (s.prep_minutes + (s.high_demand ? 20 : 0)) * 60000;
    const btn = (to, label, cls) => '<button class="btn ' + (cls || '') + ' sm" data-act="setStatus" data-id="' + o.id + '" data-to="' + to + '">' + label + '</button>';
    let acts = '';
    if (o.status === 'pending') acts = btn('preparing', 'Aceitar', 'ok') + btn('rejected', 'Recusar', 'red');
    if (o.status === 'preparing') acts = btn('ready', 'Marcar pronto');
    if (o.status === 'ready') acts = o.mode === 'delivery' ? btn('out_for_delivery', 'Saiu p/ entrega') : btn('completed', 'Cliente retirou', 'ok');
    if (o.status === 'out_for_delivery') acts = btn('completed', 'Finalizar', 'ok');
    if (isAdmin() && ['preparing', 'ready', 'out_for_delivery'].includes(o.status)) acts += btn('canceled', 'Cancelar', 'red');
    const first = esc(o.customer_name.split(' ')[0]);
    const msg = {
      preparing: 'Oi ' + o.customer_name.split(' ')[0] + '! Seu pedido #' + o.number + ' foi aceito e já está em preparo 🔥',
      ready: o.mode === 'pickup' ? 'Oi ' + o.customer_name.split(' ')[0] + '! Seu pedido #' + o.number + ' está pronto para retirada 🎉' : '',
      out_for_delivery: 'Oi ' + o.customer_name.split(' ')[0] + '! Seu pedido #' + o.number + ' saiu para entrega 🛵'
    }[o.status];
    if (msg && /^\d{10,13}$/.test(o.customer_phone)) acts += '<a class="btn sec sm" target="_blank" rel="noopener noreferrer" href="' + esc(ui.waLink(o.customer_phone, msg)) + '">💬 Avisar</a>';
    const payLabel = esc(PAY[o.payment_method] || o.payment_method) + (o.payment_status === 'paid' ? ' · pago' : '') + (o.payment_method === 'cash' && o.change_for_cents ? ' · troco p/ ' + money(o.change_for_cents) : '');
    return '<div class="oc ' + (o.status === 'pending' ? 'new' : '') + '">' +
      '<div class="h"><b>#' + o.number + ' · ' + first + '</b><span class="small muted">' + ui.hhmm(o.created_at) + '</span></div>' +
      '<div class="row" style="flex-wrap:wrap;gap:5px"><span class="pill ' + (o.mode === 'delivery' ? 'blue' : '') + '">' + (o.mode === 'delivery' ? '🛵 Entrega' : '🏪 Retirada') + '</span>' +
      '<span class="pill ' + (o.payment_status === 'paid' ? 'ok' : '') + '">' + payLabel + '</span>' + (late ? '<span class="pill red">Atrasado</span>' : '') + '</div>' +
      '<ul>' + o.order_items.map((i) => '<li>' + i.quantity + '× ' + esc(i.product_name) +
        (i.addons && i.addons.length ? ' <span class="muted">+' + esc(i.addons.map((a) => a.name).join(', ')) + '</span>' : '') +
        (i.notes ? '<br><span class="small" style="color:var(--warn)">Obs.: ' + esc(i.notes) + '</span>' : '') + '</li>').join('') + '</ul>' +
      (o.notes ? '<div class="small" style="color:var(--warn)">📝 ' + esc(o.notes) + '</div>' : '') +
      (o.delivery_address ? '<div class="small muted">📍 ' + esc(o.delivery_address) + '</div>' : '') +
      '<div class="small muted">' + esc(o.customer_name) + ' · ' + esc(o.customer_phone) + '</div>' +
      '<div class="row" style="justify-content:space-between;margin-top:6px"><span class="small muted">' + ui.ago(o.created_at) + (o.coupon_code ? ' · ' + esc(o.coupon_code) : '') + '</span><b>' + money(o.total_cents) + '</b></div>' +
      '<div class="acts">' + acts + '</div></div>';
  }

  // =============================================================== cardápio
  async function loadMenu() {
    const sid = 'eq.' + store().id;
    const [cats, prods, addons] = await Promise.all([
      api.select('categories', { store_id: sid, select: '*', order: 'position,name' }),
      api.select('products', { store_id: sid, select: '*', order: 'position,name' }),
      api.select('product_addons', { store_id: sid, select: '*', order: 'position,name' })
    ]);
    let costs = {};
    if (isAdmin()) (await api.select('product_costs', { store_id: sid, select: 'product_id,cost_cents' })).forEach((c) => { costs[c.product_id] = c.cost_cents; });
    menu = { cats, prods, addons, costs };
  }
  async function tabMenu() {
    try { await loadMenu(); } catch (e) { return showErr(e); }
    const adm = isAdmin();
    const catName = (id) => (menu.cats.find((c) => c.id === id) || {}).name || '—';
    const catOptions = (sel) => '<option value="">Sem categoria</option>' + menu.cats.map((c) => '<option value="' + c.id + '" ' + (c.id === sel ? 'selected' : '') + '>' + esc(c.name) + '</option>').join('');
    let h = '<div class="ptop"><h2>Cardápio</h2><a class="btn sec sm" target="_blank" rel="noopener" href="' + esc(storeUrl()) + '">Ver cardápio público ↗</a></div>';
    if (!adm) h += '<div class="card small">Somente dono ou gerente pode alterar o cardápio.</div>';
    h += '<div class="card"><h3 style="margin-bottom:8px">Categorias</h3><div class="row" style="flex-wrap:wrap;gap:8px">' +
      (menu.cats.map((c) => '<span class="pill ' + (c.is_active ? '' : 'red') + '" style="padding:6px 10px">' + esc(c.name) +
        (adm ? ' <a href="#" data-act="toggleCat" data-id="' + c.id + '" title="Mostrar/ocultar">' + (c.is_active ? '👁' : '🚫') + '</a> <a href="#" data-act="delCat" data-id="' + c.id + '" title="Excluir">✕</a>' : '') + '</span>').join('') || '<span class="muted small">Nenhuma categoria.</span>') + '</div>' +
      (adm ? '<div class="row" style="margin-top:12px;max-width:420px"><input id="newCat" maxlength="60" placeholder="Nova categoria"><button class="btn sec" data-act="addCat">Adicionar</button></div>' : '') + '</div>';
    h += '<div class="card tblwrap"><table><thead><tr><th>Item</th><th>Categoria</th><th>Preço (R$)</th>' + (adm ? '<th>Custo (R$)</th><th>Margem</th>' : '') + '<th>Disponível</th>' + (adm ? '<th></th>' : '') + '</tr></thead><tbody>' +
      (menu.prods.map((p) => {
        const cost = menu.costs[p.id] || 0, m = p.price_cents ? (p.price_cents - cost) / p.price_cents * 100 : 0;
        const nAdd = menu.addons.filter((a) => a.product_id === p.id).length;
        return '<tr><td><b>' + esc(p.name) + '</b>' + (p.description ? '<div class="small muted">' + esc(p.description.slice(0, 70)) + '</div>' : '') + '</td>' +
          '<td>' + (adm ? '<select data-change="prodCat" data-id="' + p.id + '" style="width:150px">' + catOptions(p.category_id) + '</select>' : esc(catName(p.category_id))) + '</td>' +
          '<td>' + (adm ? '<input inputmode="decimal" value="' + ui.centsToInput(p.price_cents) + '" data-change="prodPrice" data-id="' + p.id + '">' : money(p.price_cents)) + '</td>' +
          (adm ? '<td><input inputmode="decimal" value="' + ui.centsToInput(cost) + '" data-change="prodCost" data-id="' + p.id + '"></td><td><span class="pill ' + (m >= 60 ? 'ok' : m >= 45 ? 'warn' : 'red') + '">' + m.toFixed(0) + '%</span></td>' : '') +
          '<td><button class="toggle ' + (p.is_available ? 'on' : '') + '" data-act="toggleProd" data-id="' + p.id + '" ' + (adm ? '' : 'disabled') + '><span class="sw"></span>' + (p.is_available ? 'Sim' : 'Esgotado') + '</button></td>' +
          (adm ? '<td class="row" style="gap:6px"><button class="btn sec sm" data-act="openAddons" data-id="' + p.id + '">Adicionais (' + nAdd + ')</button><button class="btn red sm" data-act="delProd" data-id="' + p.id + '">Excluir</button></td>' : '') + '</tr>';
      }).join('') || '<tr><td colspan="7" class="muted">Nenhum item ainda.</td></tr>') + '</tbody></table></div>';
    if (adm) {
      h += '<div class="card"><h3>Novo item</h3><div class="formgrid">' +
        '<div><label class="f" for="nName">Nome</label><input id="nName" maxlength="80"></div>' +
        '<div><label class="f" for="nCat">Categoria</label><select id="nCat">' + catOptions(menu.cats[0] && menu.cats[0].id) + '</select></div>' +
        '<div><label class="f" for="nPrice">Preço (R$)</label><input id="nPrice" inputmode="decimal" placeholder="29,90"></div>' +
        '<div><label class="f" for="nCost">Custo (R$)</label><input id="nCost" inputmode="decimal" placeholder="11,00"></div></div>' +
        '<label class="f" for="nDesc">Descrição</label><input id="nDesc" maxlength="500">' +
        '<label class="f" for="nImg">Link da foto (https://…, opcional)</label><input id="nImg" maxlength="500">' +
        '<div id="nErr" class="err"></div><button class="btn" data-act="addProd">Adicionar ao cardápio</button></div>';
    }
    main().innerHTML = h;
  }

  function drawAddons(pid) {
    const p = menu.prods.find((x) => x.id === pid); if (!p) return;
    const list = menu.addons.filter((a) => a.product_id === pid);
    $('#modalRoot').innerHTML = '<div class="ov" data-act="ovClick"><div class="modal"><div class="mh"><h2 style="font-size:20px">Adicionais · ' + esc(p.name) + '</h2><button class="x" data-act="closeModal">×</button></div>' +
      (list.map((a) => '<div class="addon"><span>' + esc(a.name) + '</span><b>+ ' + money(a.price_cents) + '</b>' +
        '<button class="toggle ' + (a.is_available ? 'on' : '') + '" data-act="toggleAddon" data-id="' + a.id + '" data-p="' + pid + '"><span class="sw"></span></button>' +
        '<button class="btn red sm" data-act="delAddon" data-id="' + a.id + '" data-p="' + pid + '">✕</button></div>').join('') || '<p class="muted small">Nenhum adicional.</p>') +
      '<div class="row" style="margin-top:12px"><input id="adName" maxlength="60" placeholder="Ex.: Bacon"><input id="adPrice" inputmode="decimal" placeholder="4,00" style="max-width:110px">' +
      '<button class="btn" data-act="addAddon" data-p="' + pid + '">Adicionar</button></div><div id="adErr" class="err"></div></div></div>';
  }

  // =============================================================== cupons
  async function tabCoupons() {
    let list;
    try { list = await api.select('coupons', { store_id: 'eq.' + store().id, select: '*', order: 'created_at.desc' }); } catch (e) { return showErr(e); }
    const tl = (c) => c.type === 'percent' ? c.value + '% off' : c.type === 'fixed' ? money(c.value) + ' off' : 'Frete grátis';
    main().innerHTML = '<div class="ptop"><h2>Cupons</h2></div><div class="card tblwrap"><table><thead><tr><th>Código</th><th>Benefício</th><th>Pedido mínimo</th><th>Usos</th><th>Validade</th><th>Ativo</th><th></th></tr></thead><tbody>' +
      (list.map((c) => '<tr><td><b>' + esc(c.code) + '</b></td><td>' + tl(c) + '</td><td>' + money(c.min_order_cents) + '</td>' +
        '<td>' + c.uses_count + (c.max_uses ? ' / ' + c.max_uses : '') + '</td><td>' + (c.ends_at ? 'até ' + new Date(c.ends_at).toLocaleDateString('pt-BR') : '—') + '</td>' +
        '<td><button class="toggle ' + (c.is_active ? 'on' : '') + '" data-act="toggleCoupon" data-id="' + c.id + '" data-v="' + (!c.is_active) + '"><span class="sw"></span></button></td>' +
        '<td><button class="btn red sm" data-act="delCoupon" data-id="' + c.id + '">Excluir</button></td></tr>').join('') || '<tr><td colspan="7" class="muted">Nenhum cupom.</td></tr>') +
      '</tbody></table></div><div class="card"><h3>Novo cupom</h3><div class="formgrid">' +
      '<div><label class="f" for="cCode">Código</label><input id="cCode" maxlength="20" style="text-transform:uppercase" placeholder="SEXTOU"></div>' +
      '<div><label class="f" for="cType">Tipo</label><select id="cType"><option value="percent">% de desconto</option><option value="fixed">Valor fixo (R$)</option><option value="free_delivery">Frete grátis</option></select></div>' +
      '<div><label class="f" for="cVal">Valor (% ou R$)</label><input id="cVal" inputmode="decimal" placeholder="10"></div>' +
      '<div><label class="f" for="cMin">Pedido mínimo (R$)</label><input id="cMin" inputmode="decimal" value="0"></div>' +
      '<div><label class="f" for="cMax">Limite de usos (opcional)</label><input id="cMax" inputmode="numeric"></div>' +
      '<div><label class="f" for="cEnd">Válido até (opcional)</label><input id="cEnd" type="date"></div></div>' +
      '<div id="cErr" class="err"></div><button class="btn" data-act="addCoupon">Criar cupom</button></div>' +
      '<p class="small muted">Dica: use pedido mínimo para proteger a margem. Cupons nunca ficam visíveis para o público.</p>';
  }

  // =============================================================== clientes
  async function tabClients() {
    let all;
    try { all = await api.select('customers', { store_id: 'eq.' + store().id, anonymized_at: 'is.null', select: 'id,name,phone,marketing_opt_in,orders_count,total_spent_cents,last_order_at,created_at', order: 'total_spent_cents.desc', limit: '1000' }); } catch (e) { return showErr(e); }
    const days = (c) => c.last_order_at ? Math.floor((Date.now() - new Date(c.last_order_at).getTime()) / 864e5) : null;
    const list = all.filter((c) => {
      const d = days(c);
      if (clientFilter === 'fieis') return c.orders_count >= 2 && d !== null && d < 30;
      if (clientFilter === 'inativos') return d !== null && d >= 30;
      if (clientFilter === 'optin') return c.marketing_opt_in;
      return true;
    });
    const link = storeUrl();
    const f = (id, l) => '<button class="' + (clientFilter === id ? 'on' : '') + '" data-act="clientFilter" data-f="' + id + '">' + l + '</button>';
    main().innerHTML = '<div class="ptop"><h2>Clientes</h2><div class="seg" style="min-width:420px">' + f('todos', 'Todos (' + all.length + ')') + f('fieis', 'Fiéis') + f('inativos', 'Inativos 30d+') + f('optin', 'Aceitam promoções') + '</div></div>' +
      '<div class="card tblwrap"><table><thead><tr><th>Cliente</th><th>WhatsApp</th><th>Pedidos</th><th>Total gasto</th><th>Último pedido</th><th></th></tr></thead><tbody>' +
      (list.map((c) => {
        const d = days(c), first = c.name.split(' ')[0];
        const tag = d === null ? '<span class="pill">Sem pedido concluído</span>' : d >= 30 ? '<span class="pill red">Inativo</span>' : c.orders_count >= 2 ? '<span class="pill ok">Fiel</span>' : '<span class="pill blue">Novo</span>';
        const msg = d !== null && d >= 30 ? 'Oi ' + first + '! Sentimos sua falta no ' + store().name + ' 😊 Peça aqui: ' + link : 'Oi ' + first + '! Obrigado por pedir no ' + store().name + ' 🔥 Cardápio: ' + link;
        return '<tr><td><b>' + esc(c.name) + '</b> ' + tag + (c.marketing_opt_in ? ' <span class="pill ok" title="Aceitou receber promoções">✓ promo</span>' : '') + '</td>' +
          '<td>' + esc(c.phone) + '</td><td>' + c.orders_count + '</td><td>' + money(c.total_spent_cents) + '</td><td>' + (d === null ? '—' : d === 0 ? 'Hoje' : 'há ' + d + ' dias') + '</td>' +
          '<td class="row" style="gap:6px">' + (c.marketing_opt_in ? '<a class="btn sec sm" target="_blank" rel="noopener noreferrer" href="' + esc(ui.waLink(c.phone, msg)) + '">💬 Mensagem</a>' : '') +
          (isOwner() ? '<button class="btn red sm" data-act="anonymize" data-id="' + c.id + '" title="Atender pedido de exclusão (LGPD)">Anonimizar</button>' : '') + '</td></tr>';
      }).join('') || '<tr><td colspan="6" class="muted">Nenhum cliente nesse filtro.</td></tr>') + '</tbody></table></div>' +
      '<p class="small muted">Mensagens de promoção só para quem aceitou na hora do pedido (LGPD). "Anonimizar" atende um pedido de exclusão de dados do cliente, sem apagar o histórico financeiro.</p>';
  }

  // =============================================================== relatórios
  async function tabReports() {
    const now = new Date(), from = new Date(now);
    if (reportPeriod === 'hoje') from.setHours(0, 0, 0, 0);
    else from.setDate(from.getDate() - (reportPeriod === '7d' ? 7 : 30));
    let r;
    try { r = await api.rpc('sales_report', { p_store_id: store().id, p_from: from.toISOString(), p_to: new Date(now.getTime() + 60000).toISOString() }); } catch (e) { return showErr(e); }
    const top = r.top_products || [], maxQ = top.length ? top[0].qty : 1;
    const f = (id, l) => '<button class="' + (reportPeriod === id ? 'on' : '') + '" data-act="period" data-p="' + id + '">' + l + '</button>';
    const cmvPct = r.revenue_cents ? (r.cogs_cents / r.revenue_cents * 100).toFixed(0) + '%' : '—';
    main().innerHTML = '<div class="ptop"><h2>Relatórios</h2><div class="seg" style="min-width:260px">' + f('hoje', 'Hoje') + f('7d', '7 dias') + f('30d', '30 dias') + '</div></div>' +
      '<div class="kpis">' +
      [['Faturamento', money(r.revenue_cents)], ['Pedidos', r.orders], ['Ticket médio', money(r.avg_ticket_cents)], ['Lucro bruto (após CMV)', money(r.gross_profit_cents)],
        ['CMV', cmvPct], ['Descontos dados', money(r.discount_cents)], ['Recusados/cancelados', r.rejected_or_canceled]]
        .map(([l, v]) => '<div class="kpi"><small>' + l + '</small><b>' + v + '</b></div>').join('') + '</div>' +
      '<div class="card"><h3>Mais vendidos</h3>' + (top.map((t) => '<div class="hbar"><span class="t">' + esc(t.name) + '</span><span class="b"><i style="width:' + (t.qty / maxQ * 100) + '%"></i></span><span>' + t.qty + ' · ' + money(t.revenue_cents) + '</span></div>').join('') || '<p class="muted">Sem vendas no período.</p>') + '</div>' +
      '<div class="card"><h3>Por forma de pagamento</h3>' + (Object.entries(r.by_payment || {}).map(([k, v]) => '<div class="line"><span>' + esc(PAY[k] || k) + '</span><b>' + money(v) + '</b></div>').join('') || '<p class="muted">Sem vendas no período.</p>') + '</div>' +
      '<p class="small muted">Considera pedidos aceitos (não inclui Pix não pago, recusados e cancelados). Lucro bruto = itens − descontos − custo dos itens no momento da venda. Não inclui taxas de pagamento, entrega e despesas fixas.</p>';
  }

  // =============================================================== loja
  function storeUrl() {
    const base = location.href.split('#')[0].split('?')[0].replace(/[^/]*$/, '');
    return base + 'loja.html?s=' + encodeURIComponent(store().slug);
  }
  function tabStore() {
    const s = store(), adm = isAdmin(), dis = adm ? '' : 'disabled';
    main().innerHTML = '<div class="ptop"><h2>Configurações da loja</h2>' + storeToggles() + '</div>' +
      '<div class="card"><h3>Link do seu cardápio</h3><p class="small muted">Coloque na bio do Instagram, no Google e no WhatsApp:</p><div class="code" id="storeLink">' + esc(storeUrl()) + '</div>' +
      '<div class="row" style="margin-top:10px"><button class="btn sec sm" data-act="copyLink">Copiar link</button><a class="btn sec sm" target="_blank" rel="noopener" href="' + esc(storeUrl()) + '">Abrir ↗</a></div></div>' +
      '<div class="card"><div class="formgrid">' +
      '<div><label class="f" for="sName">Nome da loja</label><input id="sName" maxlength="80" value="' + esc(s.name) + '" ' + dis + '></div>' +
      '<div><label class="f" for="sWa">WhatsApp da loja (com DDD)</label><input id="sWa" inputmode="tel" value="' + esc(s.whatsapp || '') + '" ' + dis + '></div>' +
      '<div><label class="f" for="sFee">Taxa de entrega (R$)</label><input id="sFee" inputmode="decimal" value="' + ui.centsToInput(s.delivery_fee_cents) + '" ' + dis + '></div>' +
      '<div><label class="f" for="sMin">Pedido mínimo (R$)</label><input id="sMin" inputmode="decimal" value="' + ui.centsToInput(s.min_order_cents) + '" ' + dis + '></div>' +
      '<div><label class="f" for="sPrep">Tempo de preparo (min)</label><input id="sPrep" inputmode="numeric" value="' + s.prep_minutes + '" ' + dis + '></div></div>' +
      '<label class="f" for="sAddr">Endereço</label><input id="sAddr" maxlength="300" value="' + esc(s.address || '') + '" ' + dis + '>' +
      '<label class="f" for="sLogo">Link do logo (https://…, opcional)</label><input id="sLogo" maxlength="500" value="' + esc(s.logo_url || '') + '" ' + dis + '>' +
      '<div id="sErr" class="err"></div>' + (adm ? '<button class="btn" data-act="saveStore">Salvar</button>' : '<p class="small muted">Somente dono ou gerente pode alterar.</p>') + '</div>' +
      '<div class="card small muted">Logado como ' + esc(api.session && api.session.user ? api.session.user.email : '') + ' · ' + esc(ROLE[role()]) + '</div>';
  }

  // =============================================================== helpers de ação
  async function run(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg); return true; } catch (e) { toast(e.message); return false; }
  }
  function patchStore(patch) {
    return api.update('stores', { id: 'eq.' + store().id }, patch).then((rows) => {
      if (rows && rows[0]) Object.assign(cur.stores, rows[0]);
    });
  }

  // =============================================================== ações
  ui.bind(document, {
    // auth
    authMode: (el) => { authMode = el.dataset.m; renderAuth(); },
    authSubmit: (el) => authSubmit(el),
    savePassword: async (el) => {
      const p = $('#nPass').value;
      if (p.length < 8 || !/[a-z]/i.test(p) || !/\d/.test(p)) { $('#aErr').textContent = 'A senha precisa ter 8+ caracteres, com letras e números.'; return; }
      el.disabled = true;
      try { await api.updatePassword(p); toast('Senha alterada'); loadMemberships(); } catch (e) { el.disabled = false; $('#aErr').textContent = e.message; }
    },
    logout: async () => { stopPolling(); await api.signOut(); authMode = 'login'; renderAuth(); },
    // onboarding
    slugFromName: (el) => { const s = $('#oSlug'); if (s && !s.dataset.touched) s.value = slugify(el.value); },
    createStore: async (el) => {
      const name = $('#oName').value.trim(), slug = $('#oSlug').value.trim().toLowerCase();
      if (name.length < 2) return ($('#oErr').textContent = 'Informe o nome da loja.');
      if (!/^[a-z0-9-]{3,40}$/.test(slug)) return ($('#oErr').textContent = 'Endereço inválido: use 3 a 40 letras minúsculas, números ou hífen.');
      el.disabled = true;
      try { await api.rpc('create_store', { p_name: name, p_slug: slug }); toast('Loja criada! Agora monte o cardápio.'); tab = 'cardapio'; await loadMemberships(); }
      catch (e) { el.disabled = false; $('#oErr').textContent = e.message; }
    },
    // navegação
    tab: (el) => { tab = el.dataset.t; renderShell(); },
    pickStore: (el) => {
      const m = memberships.find((x) => x.store_id === el.value); if (!m) return; cur = m;
      try { localStorage.setItem('pd_cur_store', cur.store_id); } catch (e) {}
      orders = []; seenPending = null; tab = 'pedidos'; renderShell(); startPolling();
    },
    ovClick: (el, e) => { if (e.target === el) { $('#modalRoot').innerHTML = ''; tabMenu(); } },
    closeModal: () => { $('#modalRoot').innerHTML = ''; tabMenu(); },
    // loja
    toggleStore: async (el) => {
      const k = el.dataset.k;
      if (await run(() => patchStore({ [k]: !store()[k] }))) renderShell();
    },
    copyLink: () => { const t = $('#storeLink').textContent; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Link copiado'), () => toast('Selecione e copie o link')); },
    saveStore: async () => {
      const err = (m) => { $('#sErr').textContent = m; };
      const fee = ui.toCents($('#sFee').value), min = ui.toCents($('#sMin').value), prep = parseInt($('#sPrep').value, 10);
      const wa = ui.digits($('#sWa').value), logo = $('#sLogo').value.trim();
      if ($('#sName').value.trim().length < 2) return err('Informe o nome.');
      if (!(fee >= 0) || !(min >= 0)) return err('Valores inválidos.');
      if (!(prep >= 5 && prep <= 240)) return err('Tempo de preparo entre 5 e 240 minutos.');
      if (wa && !/^\d{10,13}$/.test(wa)) return err('WhatsApp inválido.');
      if (logo && !/^https:\/\//i.test(logo)) return err('O link do logo precisa começar com https://');
      if (await run(() => patchStore({ name: $('#sName').value.trim(), whatsapp: wa || null, delivery_fee_cents: fee, min_order_cents: min, prep_minutes: prep, address: $('#sAddr').value.trim() || null, logo_url: logo || null }), 'Configurações salvas')) renderShell();
    },
    // pedidos
    setStatus: async (el) => {
      const to = el.dataset.to;
      if (to === 'rejected' && !confirm('Recusar este pedido?')) return;
      if (to === 'canceled' && !confirm('Cancelar este pedido? Se já foi pago, ficará marcado para estorno.')) return;
      el.disabled = true;
      if (await run(() => api.rpc('update_order_status', { p_order_id: el.dataset.id, p_to: to }))) { await fetchOrders().catch(() => {}); tabOrders(true); }
      else el.disabled = false;
    },
    // cardápio
    addCat: async () => {
      const n = $('#newCat').value.trim(); if (!n) return;
      if (await run(() => api.insert('categories', { store_id: store().id, name: n, position: menu.cats.length + 1 }), 'Categoria criada')) tabMenu();
    },
    toggleCat: async (el) => { const c = menu.cats.find((x) => x.id === el.dataset.id); if (await run(() => api.update('categories', { id: 'eq.' + c.id }, { is_active: !c.is_active }))) tabMenu(); },
    delCat: async (el) => { if (!confirm('Excluir a categoria? Os itens dela ficam "sem categoria".')) return; if (await run(() => api.remove('categories', { id: 'eq.' + el.dataset.id }), 'Categoria excluída')) tabMenu(); },
    prodCat: (el) => run(() => api.update('products', { id: 'eq.' + el.dataset.id }, { category_id: el.value || null }), 'Salvo'),
    prodPrice: async (el) => {
      const v = ui.toCents(el.value);
      if (!(v > 0)) { toast('Preço inválido'); return tabMenu(); }
      if (await run(() => api.update('products', { id: 'eq.' + el.dataset.id }, { price_cents: v }), 'Preço salvo')) tabMenu();
    },
    prodCost: async (el) => {
      const v = ui.toCents(el.value);
      if (!(v >= 0)) { toast('Custo inválido'); return tabMenu(); }
      if (await run(() => api.insert('product_costs', { product_id: el.dataset.id, store_id: store().id, cost_cents: v }, { onConflict: 'product_id' }), 'Custo salvo')) tabMenu();
    },
    toggleProd: async (el) => { const p = menu.prods.find((x) => x.id === el.dataset.id); if (await run(() => api.update('products', { id: 'eq.' + p.id }, { is_available: !p.is_available }))) tabMenu(); },
    delProd: async (el) => { if (!confirm('Excluir este item do cardápio?')) return; if (await run(() => api.remove('products', { id: 'eq.' + el.dataset.id }), 'Item excluído')) tabMenu(); },
    addProd: async () => {
      const err = (m) => { $('#nErr').textContent = m; };
      const name = $('#nName').value.trim(), price = ui.toCents($('#nPrice').value), costRaw = $('#nCost').value.trim(), cost = costRaw ? ui.toCents(costRaw) : 0, img = $('#nImg').value.trim();
      if (!name) return err('Informe o nome.');
      if (!(price > 0)) return err('Informe um preço válido.');
      if (!(cost >= 0)) return err('Custo inválido.');
      if (img && !/^https:\/\//i.test(img)) return err('O link da foto precisa começar com https://');
      const ok = await run(async () => {
        const rows = await api.insert('products', { store_id: store().id, category_id: $('#nCat').value || null, name, description: $('#nDesc').value.trim() || null, price_cents: price, image_url: img || null, position: menu.prods.length + 1 });
        if (cost) await api.insert('product_costs', { product_id: rows[0].id, store_id: store().id, cost_cents: cost }, { onConflict: 'product_id' });
      }, 'Item adicionado');
      if (ok) tabMenu();
    },
    openAddons: (el) => drawAddons(el.dataset.id),
    addAddon: async (el) => {
      const name = $('#adName').value.trim(), price = ui.toCents($('#adPrice').value || '0');
      if (!name || !(price >= 0)) { $('#adErr').textContent = 'Informe nome e preço.'; return; }
      if (await run(() => api.insert('product_addons', { store_id: store().id, product_id: el.dataset.p, name, price_cents: price }))) { await loadMenu(); drawAddons(el.dataset.p); }
    },
    toggleAddon: async (el) => { const a = menu.addons.find((x) => x.id === el.dataset.id); if (await run(() => api.update('product_addons', { id: 'eq.' + a.id }, { is_available: !a.is_available }))) { await loadMenu(); drawAddons(el.dataset.p); } },
    delAddon: async (el) => { if (await run(() => api.remove('product_addons', { id: 'eq.' + el.dataset.id }))) { await loadMenu(); drawAddons(el.dataset.p); } },
    // cupons
    addCoupon: async () => {
      const err = (m) => { $('#cErr').textContent = m; };
      const code = $('#cCode').value.trim().toUpperCase(), type = $('#cType').value;
      const raw = $('#cVal').value.trim(), min = ui.toCents($('#cMin').value || '0'), max = $('#cMax').value.trim(), end = $('#cEnd').value;
      if (!/^[A-Z0-9]{3,20}$/.test(code)) return err('Código: 3 a 20 letras ou números, sem espaço.');
      let value = 0;
      if (type === 'percent') { value = parseInt(raw, 10); if (!(value >= 1 && value <= 100)) return err('Percentual entre 1 e 100.'); }
      if (type === 'fixed') { value = ui.toCents(raw); if (!(value > 0)) return err('Informe o valor do desconto.'); }
      if (!(min >= 0)) return err('Pedido mínimo inválido.');
      if (max && !(parseInt(max, 10) > 0)) return err('Limite de usos inválido.');
      const row = { store_id: store().id, code, type, value, min_order_cents: min, max_uses: max ? parseInt(max, 10) : null, ends_at: end ? new Date(end + 'T23:59:59').toISOString() : null };
      try { await api.insert('coupons', row); toast('Cupom criado'); tabCoupons(); }
      catch (e) { err(/duplicate|unique/i.test(e.message) ? 'Já existe um cupom com esse código.' : e.message); }
    },
    toggleCoupon: async (el) => { if (await run(() => api.update('coupons', { id: 'eq.' + el.dataset.id }, { is_active: el.dataset.v === 'true' }))) tabCoupons(); },
    delCoupon: async (el) => { if (!confirm('Excluir este cupom?')) return; if (await run(() => api.remove('coupons', { id: 'eq.' + el.dataset.id }), 'Cupom excluído')) tabCoupons(); },
    // clientes / relatórios
    clientFilter: (el) => { clientFilter = el.dataset.f; tabClients(); },
    anonymize: async (el) => {
      if (!confirm('Anonimizar este cliente? Nome, telefone e endereços serão apagados de forma definitiva (pedido de exclusão LGPD).')) return;
      if (await run(() => api.rpc('anonymize_customer', { p_customer_id: el.dataset.id }), 'Cliente anonimizado')) tabClients();
    },
    period: (el) => { reportPeriod = el.dataset.p; tabReports(); }
  });

  // marca o campo de endereço da loja como editado manualmente
  document.addEventListener('input', (e) => { if (e.target.id === 'oSlug') e.target.dataset.touched = '1'; if (e.target.id === 'oName') { const s = $('#oSlug'); if (s && !s.dataset.touched) s.value = slugify(e.target.value); } });

  boot();
})();
