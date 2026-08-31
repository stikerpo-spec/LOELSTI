const isTauriDesktop = window.location.hostname === 'tauri.localhost' || Boolean(window.__TAURI_INTERNALS__);

if (isTauriDesktop) {
  const realFetch = window.fetch.bind(window);
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const key = 'loelsti_local_account';
  const getAccount = () => {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  };
  const save = value => localStorage.setItem(key, JSON.stringify(value));
  const uid = () => `local-${crypto.randomUUID()}`;
  const hash = async value => {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  };
  const currentUser = () => {
    const account = getAccount();
    const token = localStorage.getItem('loelsti_token') || '';
    if (!account || token !== `local:${account.id}`) return null;
    return account.user;
  };
  const server = () => {
    const account = currentUser();
    return {
      id: 'local-server', name: 'Mein Server', description: 'LOELSTI',
      channels: [{ id: 'local-general', name: 'general', type: 'TEXT', topic: 'Willkommen bei LOELSTI' }]
    };
  };
  const messages = () => { try { return JSON.parse(localStorage.getItem('loelsti_local_messages') || '[]'); } catch { return []; } };
  const saveMessages = value => localStorage.setItem('loelsti_local_messages', JSON.stringify(value));
  const user = currentUser();

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
    if (!url.pathname.startsWith('/api/v1/')) return realFetch(input, init);
    const path = url.pathname;
    let body = {};
    try { body = init.body ? JSON.parse(String(init.body)) : {}; } catch { body = {}; }

    if (path === '/api/v1/auth/register' && init.method === 'POST') {
      if (getAccount()) return json({ code: 'REQUEST_FAILED', message: 'Auf diesem Gerät existiert bereits ein LOELSTI-Konto.' }, 409);
      const username = String(body.username || '').trim().toLowerCase();
      const displayName = String(body.displayName || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (username.length < 3 || displayName.length < 1 || !email.includes('@') || password.length < 8) return json({ code: 'REQUEST_FAILED', message: 'Bitte fülle alle Felder korrekt aus.' }, 400);
      const id = uid();
      const accountUser = { id, username, displayName, avatarUrl: null, presence: 'ONLINE', customStatus: null };
      save({ id, user: accountUser, email, passwordHash: await hash(password) });
      localStorage.setItem('loelsti_token', `local:${id}`);
      return json({ token: `local:${id}`, user: accountUser }, 201);
    }

    if (path === '/api/v1/auth/login' && init.method === 'POST') {
      const account = getAccount();
      if (!account) return json({ code: 'REQUEST_FAILED', message: 'Noch kein Konto auf diesem Gerät. Bitte registriere dich zuerst.' }, 401);
      const login = String(body.login || '').trim().toLowerCase();
      const passwordHash = await hash(String(body.password || ''));
      if ((login !== account.user.username && login !== account.email) || passwordHash !== account.passwordHash) return json({ code: 'REQUEST_FAILED', message: 'Login-Daten sind ungültig.' }, 401);
      localStorage.setItem('loelsti_token', `local:${account.id}`);
      return json({ token: `local:${account.id}`, user: { ...account.user, presence: 'ONLINE' } });
    }

    if (path === '/api/v1/auth/logout' && init.method === 'POST') {
      localStorage.removeItem('loelsti_token');
      return new Response(null, { status: 204 });
    }

    if (path === '/api/v1/me') {
      const me = currentUser();
      return me ? json({ user: me }) : json({ code: 'REQUEST_FAILED', message: 'Nicht eingeloggt.' }, 401);
    }

    if (path === '/api/v1/me/profile' && init.method === 'PATCH') {
      const account = getAccount();
      if (!account || !currentUser()) return json({ code: 'REQUEST_FAILED', message: 'Nicht eingeloggt.' }, 401);
      account.user = { ...account.user, ...body, email: undefined };
      delete account.user.email;
      save(account);
      return json({ user: account.user });
    }

    if (path === '/api/v1/servers') {
      return json({ servers: [server()] });
    }

    if (path.startsWith('/api/v1/channels/') && path.endsWith('/messages')) {
      const channelId = path.split('/')[4];
      if (init.method === 'POST') {
        const me = currentUser();
        if (!me) return json({ code: 'REQUEST_FAILED', message: 'Nicht eingeloggt.' }, 401);
        const list = messages();
        const now = new Date().toISOString();
        const message = { id: uid(), content: String(body.content || ''), createdAt: now, updatedAt: now, author: me, reactions: [] };
        list.push({ ...message, channelId }); saveMessages(list);
        return json({ message }, 201);
      }
      return json({ messages: messages().filter(m => m.channelId === channelId) });
    }

    if (path === '/api/v1/friends') return json({ friends: [], incoming: [], outgoing: [], blocked: [] });
    if (path === '/api/v1/conversations') return json({ conversations: [] });
    if (path.includes('/api/v1/users/search')) return json({ users: [] });

    return json({});
  };
}
