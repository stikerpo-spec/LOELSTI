(() => {
  const isTauri = () => Boolean(window.__TAURI_INTERNALS__);
  const REAL_API = (window.__LOELSTI_API__ || 'http://localhost:3000').replace(/\/$/, '');
  const AUTH_KEY = 'loelsti_local_account_v1';
  const SESSION_KEY = 'loelsti_local_session_v1';
  const text = (value) => typeof value === 'string' ? value.trim() : '';

  const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

  const loadAccount = () => {
    try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; }
  };
  const loadSession = () => text(localStorage.getItem(SESSION_KEY));
  const saveAccount = (account) => localStorage.setItem(AUTH_KEY, JSON.stringify(account));

  async function sha256(value) {
    const bytes = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash)).map(x => x.toString(16).padStart(2, '0')).join('');
  }

  async function derivePassword(password, salt) {
    let value = `${salt}:${password}`;
    for (let i = 0; i < 120000; i += 1) value = await sha256(value);
    return value;
  }

  function localUser(account) {
    return {
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      avatarUrl: null,
      presence: 'ONLINE',
      customStatus: null,
      email: account.email,
      bio: account.bio || null,
      bannerUrl: null
    };
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const isLocalApi = url.startsWith(REAL_API + '/api/v1/');
    if (!isTauri() || !isLocalApi) return originalFetch(input, init);

    try {
      return await originalFetch(input, init);
    } catch (networkError) {
      const path = url.slice((REAL_API).length);
      const method = String(init.method || 'GET').toUpperCase();
      const body = (() => { try { return init.body ? JSON.parse(init.body) : {}; } catch { return {}; } })();
      const account = loadAccount();
      const session = loadSession();

      if (path === '/api/v1/auth/register' && method === 'POST') {
        const username = text(body.username).toLowerCase();
        const email = text(body.email).toLowerCase();
        const displayName = text(body.displayName);
        const password = String(body.password || '');
        if (!username || !email || !displayName || password.length < 8) return jsonResponse({ message: 'Bitte fülle alle Felder aus. Das Passwort muss mindestens 8 Zeichen haben.' }, 400);
        if (loadAccount()) return jsonResponse({ message: 'Auf diesem Gerät existiert bereits ein lokales Konto.' }, 409);
        const salt = crypto.randomUUID();
        const hash = await derivePassword(password, salt);
        const created = { id: crypto.randomUUID(), username, email, displayName, bio: null, salt, hash };
        saveAccount(created);
        const token = `local-${crypto.randomUUID()}`;
        localStorage.setItem(SESSION_KEY, token);
        return jsonResponse({ token, user: localUser(created) }, 201);
      }

      if (path === '/api/v1/auth/login' && method === 'POST') {
        if (!account || !session && !account) return jsonResponse({ message: 'Kein lokales Konto vorhanden.' }, 401);
        const login = text(body.login).toLowerCase();
        const password = String(body.password || '');
        const validLogin = login === account.username.toLowerCase() || login === account.email.toLowerCase();
        const validPassword = validLogin && (await derivePassword(password, account.salt)) === account.hash;
        if (!validPassword) return jsonResponse({ message: 'Login-Daten sind ungültig.' }, 401);
        const token = `local-${crypto.randomUUID()}`;
        localStorage.setItem(SESSION_KEY, token);
        return jsonResponse({ token, user: localUser(account) });
      }

      if (path === '/api/v1/auth/logout' && method === 'POST') {
        localStorage.removeItem(SESSION_KEY);
        return new Response(null, { status: 204 });
      }

      if (path === '/api/v1/me' && method === 'GET' && account && session) {
        return jsonResponse({ user: localUser(account) });
      }

      if (path === '/api/v1/me/profile' && method === 'PATCH' && account && session) {
        const updated = { ...account };
        if (body.displayName !== undefined) updated.displayName = text(body.displayName) || account.displayName;
        if (body.bio !== undefined) updated.bio = body.bio === null ? null : String(body.bio).slice(0, 500);
        saveAccount(updated);
        return jsonResponse({ user: localUser(updated) });
      }

      if (path === '/api/v1/servers' && method === 'GET') return jsonResponse({ servers: [] });
      if (path === '/api/v1/friends' && method === 'GET') return jsonResponse({ friends: [], incoming: [], outgoing: [], blocked: [] });
      if (path === '/api/v1/conversations' && method === 'GET') return jsonResponse({ conversations: [] });

      throw networkError;
    }
  };

  async function getLatestRelease() {
    const response = await fetch('https://api.github.com/repos/stikerpo-spec/LOELSTI/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' }
    });
    if (!response.ok) throw new Error('Der aktuelle LOELSTI-Stand konnte nicht ermittelt werden.');
    return response.json();
  }

  function tagNumber(tag) {
    const match = String(tag || '').match(/(?:-|v)(\d+)$/i);
    return match ? Number(match[1]) : 0;
  }

  async function currentVersion() {
    if (!isTauri()) return 'web';
    try { return String(await window.__TAURI_INTERNALS__.invoke('app_version')); } catch { return '0.0.0'; }
  }

  async function installUpdate(url) {
    if (!isTauri()) {
      window.location.href = url;
      return;
    }
    await window.__TAURI_INTERNALS__.invoke('install_update_from_url', { url });
  }

  async function checkUpdate(button, silent = false) {
    if (button) { button.disabled = true; button.textContent = 'Prüfe Updates …'; }
    try {
      const release = await getLatestRelease();
      const current = await currentVersion();
      const currentPatch = Number((current.split('.').pop() || '0').replace(/\D/g, '')) || 0;
      const latest = tagNumber(release.tag_name);
      const asset = (release.assets || []).find(a => a.name === 'LOELSTI-Windows.exe');
      const available = isTauri() && latest > currentPatch && Boolean(asset?.browser_download_url);
      if (available) {
        if (button) button.textContent = `Update ${release.tag_name} installieren`;
        button.disabled = false;
        button.onclick = async () => {
          button.disabled = true;
          button.textContent = 'Update wird installiert …';
          try { await installUpdate(asset.browser_download_url); }
          catch (error) { button.disabled = false; button.textContent = 'Update erneut versuchen'; alert(error?.message || 'Das Update konnte nicht gestartet werden.'); }
        };
        return;
      }
      if (button) { button.textContent = 'Nach Updates suchen'; button.disabled = false; }
      if (!silent) alert(`LOELSTI ist aktuell (${current}).`);
    } catch (error) {
      if (button) { button.textContent = 'Update-Prüfung fehlgeschlagen'; button.disabled = false; }
      if (!silent) alert(error?.message || 'Update-Prüfung fehlgeschlagen.');
    }
  }

  function addUpdaterToSettings() {
    if (!isTauri()) return;
    const settingsForm = document.querySelector('.settings-form');
    if (!settingsForm || settingsForm.querySelector('[data-loelsti-update]')) return;
    const box = document.createElement('div');
    box.setAttribute('data-loelsti-update', '1');
    box.style.cssText = 'margin-top:18px;padding:16px;border:1px solid rgba(120,140,190,.35);border-radius:14px;background:rgba(20,27,43,.75)';
    box.innerHTML = '<strong style="display:block;margin-bottom:6px">LOELSTI Updates</strong><span style="display:block;opacity:.72;margin-bottom:12px;font-size:13px">Neue Windows-Versionen direkt aus der App prüfen und installieren.</span><button type="button" data-update-button>Nach Updates suchen</button>';
    settingsForm.appendChild(box);
    const button = box.querySelector('[data-update-button]');
    button.addEventListener('click', () => checkUpdate(button, false));
    checkUpdate(button, true);
  }

  const observer = new MutationObserver(addUpdaterToSettings);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('load', () => { addUpdaterToSettings(); setTimeout(addUpdaterToSettings, 800); });
})();