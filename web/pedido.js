// Acompanhamento do pedido pelo link secreto (?t=token). Atualiza a cada 10s.
(function () {
  const { esc, money, toast } = ui;
  const app = document.getElementById('app');
  const token = new URLSearchParams(location.search).get('t') || '';
  let timer = null;

  const LABELS = {
    delivery: [['pending', 'Pedido recebido'], ['preparing', 'Em preparo'], ['ready', 'Pronto'], ['out_for_delivery', 'Saiu para entrega'], ['completed', 'Entregue']],
    pickup: [['pending', 'Pedido recebido'], ['preparing', 'Em preparo'], ['ready', 'Pronto para retirada'], ['completed', 'Retirado']]
  };
  const PAY = { pix: 'Pix', card_online: 'Cartão online', card_on_delivery: 'Cartão na entrega', cash: 'Dinheiro' };

  async function load() {
    if (!/^[0-9a-f-]{36}$/i.test(token)) { app.innerHTML = '<div class="card">Link de pedido inválido.</div>'; return; }
    try {
      const o = await api.rpc('get_order_tracking', { p_token: token }, { auth: false });
      if (!o) { app.innerHTML = '<div class="card">Pedido não encontrado.</div>'; return; }
      render(o);
      if (['completed', 'rejected', 'canceled'].includes(o.status)) { clearInterval(timer); timer = null; }
    } catch (e) {
      if (!app.querySelector('.card')) app.innerHTML = '<div class="card">' + esc(e.message) + '</div>';
    }
  }

  function render(o) {
    document.title = 'Pedido #' + o.number + ' — ' + o.store.name;
    const flow = LABELS[o.mode] || LABELS.delivery;
    const idx = flow.findIndex(([s]) => s === o.status);
    const created = new Date(o.created_at).getTime();
    let body = '';
    if (o.status === 'rejected') body = '<div class="note red" style="margin:0">A loja não conseguiu aceitar seu pedido.' + (o.payment_status === 'paid' ? ' O valor pago será devolvido.' : '') + '</div>';
    else if (o.status === 'canceled') body = '<div class="note red" style="margin:0">Pedido cancelado.' + (o.payment_status === 'paid' ? ' O valor pago será devolvido.' : (o.payment_status === 'expired' ? ' O Pix não foi pago dentro do prazo.' : '')) + '</div>';
    else if (o.status === 'awaiting_payment') {
      body = '<div class="note warn" style="margin:0">Aguardando o pagamento do Pix. Assim que o banco confirmar, seu pedido vai para a cozinha.</div>' +
        (o.pix_copy_paste ? '<div class="code" id="pixCode" style="margin-top:10px">' + esc(o.pix_copy_paste) + '</div><button class="btn sec full" style="margin-top:8px" data-act="copyPix">📋 Copiar código Pix</button>' : '');
    } else {
      body = '<p class="muted small" style="margin:0">Previsão: ' + ui.hhmm(created + o.store.prep_minutes * 60000) + ' – ' + ui.hhmm(created + (o.store.prep_minutes + 15) * 60000) + '</p>' +
        '<ul class="steps">' + flow.map(([s, l], i) => {
          const done = i < idx || o.status === 'completed';
          return '<li class="' + (done ? 'done' : i === idx ? 'cur' : '') + '"><i>' + (done ? '✓' : i + 1) + '</i>' + esc(l) + '</li>';
        }).join('') + '</ul>';
    }
    app.innerHTML = '<div class="card"><div class="small muted">' + esc(o.store.name) + '</div><h2 style="margin:4px 0 14px">Pedido #' + esc(o.number) + '</h2>' + body + '</div>' +
      '<div class="card">' + o.items.map((i) => '<div class="line small"><span>' + i.quantity + '× ' + esc(i.name) +
        (i.addons.length ? ' <span class="muted">(+' + esc(i.addons.join(', ')) + ')</span>' : '') + '</span><span>' + money(i.line_total_cents) + '</span></div>').join('') +
      (o.discount_cents ? '<div class="line small" style="color:var(--ok)"><span>Desconto</span><span>− ' + money(o.discount_cents) + '</span></div>' : '') +
      '<div class="line small"><span>Entrega</span><span>' + (o.delivery_fee_cents ? money(o.delivery_fee_cents) : (o.mode === 'pickup' ? 'Retirada' : 'Grátis')) + '</span></div>' +
      '<div class="line tot"><span>Total</span><span>' + money(o.total_cents) + '</span></div>' +
      '<div class="small muted">' + esc(PAY[o.payment_method] || o.payment_method) + (o.payment_status === 'paid' ? ' · pago' : '') + '</div></div>' +
      '<p class="small muted" style="text-align:center">Esta página atualiza sozinha. <a href="loja.html?s=' + encodeURIComponent(o.store.slug) + '">Voltar ao cardápio</a></p>';
  }

  ui.bind(document, {
    copyPix: () => {
      const t = document.getElementById('pixCode').textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Código copiado'), () => toast('Selecione e copie o código'));
    }
  });

  load();
  timer = setInterval(load, 10000);
})();
