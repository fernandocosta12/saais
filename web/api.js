// Cliente mínimo do Supabase (REST + Auth + Edge Functions), sem dependências.
(function () {
  const C = window.APP_CONFIG;
  const SKEY = 'pd_session_v1';

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  let session = null;
  try { session = JSON.parse(localStorage.getItem(SKEY)); } catch (e) { session = null; }

  function saveSession(s) {
    session = s;
    try { s ? localStorage.setItem(SKEY, JSON.stringify(s)) : localStorage.removeItem(SKEY); } catch (e) {}
  }

  function fromAuthResponse(d) {
    if (!d || !d.access_token) return null;
    return {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
      user: d.user ? { id: d.user.id, email: d.user.email } : null
    };
  }

  function errorMessage(data, status) {
    if (data && typeof data === 'object') {
      const m = data.error || data.message || data.error_description || data.msg;
      if (m) return translate(String(m));
    }
    if (status === 0) return 'Sem conexão. Verifique sua internet.';
    return 'Algo deu errado. Tente novamente.';
  }

  function translate(m) {
    const map = {
      'Invalid login credentials': 'E-mail ou senha incorretos.',
      'Email not confirmed': 'Confirme seu e-mail antes de entrar (veja sua caixa de entrada).',
      'User already registered': 'Este e-mail já tem cadastro. Faça login.',
      'Password should be at least 6 characters': 'A senha precisa ter pelo menos 6 caracteres.'
    };
    if (map[m]) return map[m];
    if (/permission denied|row-level security/i.test(m)) return 'Você não tem permissão para essa ação.';
    if (/JWT expired/i.test(m)) return 'Sua sessão expirou. Entre novamente.';
    return m;
  }

  let refreshing = null;
  async function refresh() {
    if (!session || !session.refresh_token) return;
    if (!refreshing) {
      refreshing = (async () => {
        const r = await fetch(C.url + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', headers: { apikey: C.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: session.refresh_token })
        });
        const d = await r.json().catch(() => null);
        saveSession(r.ok ? fromAuthResponse(d) : null);
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function request(path, opts) {
    opts = opts || {};
    const useAuth = opts.auth !== false;
    if (useAuth && session && session.expires_at * 1000 < Date.now() + 60000) await refresh();
    const headers = Object.assign({ apikey: C.key, 'Content-Type': 'application/json' }, opts.headers || {});
    if (useAuth && session) headers.Authorization = 'Bearer ' + session.access_token;
    let r;
    try {
      r = await fetch(C.url + path, {
        method: opts.method || 'GET', headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
      });
    } catch (e) {
      throw new ApiError('Sem conexão. Verifique sua internet.', 0);
    }
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!r.ok) {
      if (r.status === 401 && useAuth && session) saveSession(null);
      throw new ApiError(errorMessage(data, r.status), r.status);
    }
    return data;
  }

  const qs = (params) => Object.entries(params || {})
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

  window.api = {
    ApiError,
    get session() { return session; },
    get userId() { return session && session.user ? session.user.id : null; },

    // ---------- Auth ----------
    async signUp(email, password, fullName) {
      const d = await request('/auth/v1/signup', {
        method: 'POST', auth: false,
        body: { email, password, data: { full_name: fullName } }
      });
      const s = fromAuthResponse(d);
      if (s) saveSession(s);
      return { needsConfirmation: !s };
    },
    async signIn(email, password) {
      const d = await request('/auth/v1/token?grant_type=password', {
        method: 'POST', auth: false, body: { email, password }
      });
      saveSession(fromAuthResponse(d));
    },
    async recover(email) {
      await request('/auth/v1/recover', { method: 'POST', auth: false, body: { email } });
    },
    async signOut() {
      try { await request('/auth/v1/logout', { method: 'POST' }); } catch (e) {}
      saveSession(null);
    },
    // Link de confirmação/recuperação de e-mail volta com #access_token=...
    async handleAuthRedirect() {
      if (!location.hash.includes('access_token=')) return false;
      const p = new URLSearchParams(location.hash.slice(1));
      const s = {
        access_token: p.get('access_token'), refresh_token: p.get('refresh_token'),
        expires_at: Number(p.get('expires_at')) || Math.floor(Date.now() / 1000) + Number(p.get('expires_in') || 3600),
        user: null
      };
      saveSession(s);
      history.replaceState(null, '', location.pathname + location.search);
      try {
        const u = await request('/auth/v1/user');
        s.user = { id: u.id, email: u.email }; saveSession(s);
      } catch (e) { saveSession(null); return false; }
      return p.get('type') || 'signup';
    },
    async updatePassword(password) {
      await request('/auth/v1/user', { method: 'PUT', body: { password } });
    },

    // ---------- Banco (PostgREST) ----------
    select(table, params, opts) {
      return request('/rest/v1/' + table + '?' + qs(params), Object.assign({}, opts));
    },
    insert(table, rows, opts) {
      opts = opts || {};
      const q = opts.onConflict ? '?on_conflict=' + encodeURIComponent(opts.onConflict) : '';
      const prefer = ['return=representation'];
      if (opts.onConflict) prefer.push('resolution=merge-duplicates');
      return request('/rest/v1/' + table + q, { method: 'POST', body: rows, headers: { Prefer: prefer.join(',') } });
    },
    update(table, filters, patch) {
      return request('/rest/v1/' + table + '?' + qs(filters), {
        method: 'PATCH', body: patch, headers: { Prefer: 'return=representation' }
      });
    },
    remove(table, filters) {
      return request('/rest/v1/' + table + '?' + qs(filters), { method: 'DELETE' });
    },
    rpc(fn, args, opts) {
      return request('/rest/v1/rpc/' + fn, Object.assign({ method: 'POST', body: args || {} }, opts));
    },

    // ---------- Edge Functions ----------
    fn(name, body) {
      return request('/functions/v1/' + name, { method: 'POST', auth: false, body });
    }
  };

  // ---------- Utilitários de tela ----------
  window.ui = {
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    money: (cents) => ((Number(cents) || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    toCents: (v) => {
      const n = parseFloat(String(v == null ? '' : v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
      return isFinite(n) ? Math.round(n * 100) : NaN;
    },
    centsToInput: (c) => ((Number(c) || 0) / 100).toFixed(2).replace('.', ','),
    hhmm: (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    ago: (t) => {
      const m = Math.floor((Date.now() - new Date(t).getTime()) / 60000);
      if (m < 1) return 'agora'; if (m < 60) return 'há ' + m + ' min';
      const h = Math.floor(m / 60); if (h < 24) return 'há ' + h + 'h';
      return 'há ' + Math.floor(h / 24) + 'd';
    },
    digits: (s) => String(s || '').replace(/\D/g, ''),
    waLink: (phone, text) => {
      let d = String(phone || '').replace(/\D/g, ''); if (d.length <= 11) d = '55' + d;
      return 'https://wa.me/' + d + '?text=' + encodeURIComponent(text);
    },
    toast: (msg) => {
      document.querySelectorAll('.toast').forEach((x) => x.remove());
      const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
      document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
    },
    // Ações por data-act (sem onclick inline — compatível com CSP rígida)
    bind(root, handlers) {
      root.addEventListener('click', (e) => {
        const el = e.target.closest('[data-act]');
        if (!el || !root.contains(el)) return;
        const h = handlers[el.dataset.act];
        if (!h) return;
        // só cancela o comportamento padrão de links/botões (não de checkboxes dentro de um modal)
        if (el.tagName === 'A' || el.tagName === 'BUTTON') e.preventDefault();
        h(el, e);
      });
      root.addEventListener('change', (e) => {
        const el = e.target.closest('[data-change]');
        if (!el) return;
        const h = handlers[el.dataset.change];
        if (h) h(el, e);
      });
    }
  };
})();
