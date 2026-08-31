import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io, Socket } from 'socket.io-client';
import './styles.css';

type User = { id: string; username: string; displayName: string; avatarUrl?: string | null; presence?: string; customStatus?: string | null };
type Channel = { id: string; name: string; type: string; topic?: string | null };
type Server = { id: string; name: string; description?: string | null; channels: Channel[] };
type Message = { id: string; content: string; createdAt: string; updatedAt: string; author: User; reactions?: { id: string; emoji: string; userId: string }[] };
type Conversation = { id: string; type: 'DM' | 'GROUP'; name?: string | null; members: { id: string; user: User }[]; messages?: Message[] };
type FriendsData = { friends: User[]; incoming: { id: string; sender: User }[]; outgoing: { id: string; receiver: User }[]; blocked: User[] };

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('loelsti_token');
  const res = await fetch(`${API}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? 'Das hat nicht funktioniert. Bitte versuche es erneut.');
  return data as T;
}

function Avatar({ user, small = false }: { user: User; small?: boolean }) {
  return <div className={small ? 'avatar small-avatar' : 'avatar'} title={`@${user.username}`}>{user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : user.displayName.slice(0, 1).toUpperCase()}</div>;
}

function Auth({ onLogin }: { onLogin: (data: { token: string; user: User }) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(''); const fd = new FormData(e.currentTarget);
    try {
      const body = mode === 'login' ? { login: fd.get('login'), password: fd.get('password') } : { username: fd.get('username'), displayName: fd.get('displayName'), email: fd.get('email'), password: fd.get('password') };
      const data = await api<{ token: string; user: User }>(mode === 'login' ? '/api/v1/auth/login' : '/api/v1/auth/register', { method: 'POST', body: JSON.stringify(body) });
      localStorage.setItem('loelsti_token', data.token); onLogin(data);
    } catch (err) { setError(err instanceof Error ? err.message : 'Fehler'); }
  }
  return <main className="auth"><div className="brand"><div className="logo">L</div><div><h1>LOELSTI</h1><p>Deine Community. Echtzeit. Gemeinsam.</p></div></div><form onSubmit={submit} className="card"><h2>{mode === 'login' ? 'Willkommen zurück' : 'Konto erstellen'}</h2>{mode === 'register' && <><input name="username" placeholder="Username" required/><input name="displayName" placeholder="Anzeigename" required/><input name="email" type="email" placeholder="E-Mail" required/></>}<input name="login" placeholder="Username oder E-Mail" required style={{ display: mode === 'register' ? 'none' : undefined }}/><input name="password" type="password" placeholder="Passwort" minLength={8} required/><button>{mode === 'login' ? 'Einloggen' : 'Registrieren'}</button>{error && <div className="error">{error}</div>}<button type="button" className="ghost" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Neues Konto erstellen' : 'Ich habe bereits ein Konto'}</button></form></main>;
}

function App({ initialUser }: { initialUser: User }) {
  const [user, setUser] = useState(initialUser);
  const [servers, setServers] = useState<Server[]>([]);
  const [activeServer, setActiveServer] = useState<Server | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [socket, setSocket] = useState<Socket | null>(null);
  const [page, setPage] = useState<'home' | 'friends' | 'messages' | 'discover' | 'settings'>('home');
  const [friends, setFriends] = useState<FriendsData>({ friends: [], incoming: [], outgoing: [], blocked: [] });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [dmMessages, setDmMessages] = useState<Message[]>([]);
  const [error, setError] = useState('');
  const [profileName, setProfileName] = useState(user.displayName);
  const [bio, setBio] = useState('');

  const activeChannel = useMemo(() => activeServer?.channels.find(c => c.id === channel), [activeServer, channel]);

  async function loadServers() {
    const data = await api<{ servers: Server[] }>('/api/v1/servers'); setServers(data.servers);
    if (!activeServer && data.servers[0]) { setActiveServer(data.servers[0]); setChannel(data.servers[0].channels.find(c => c.type === 'TEXT')?.id ?? null); }
  }
  async function loadFriends() { setFriends(await api<FriendsData>('/api/v1/friends')); }
  async function loadConversations() { setConversations((await api<{ conversations: Conversation[] }>('/api/v1/conversations')).conversations); }
  async function loadProfile() { const d = await api<{ user: User & { bio?: string | null } }>('/api/v1/me'); setUser(d.user); setProfileName(d.user.displayName); setBio(d.user.bio ?? ''); }

  useEffect(() => { loadServers().catch(e => setError(e.message)); loadFriends().catch(() => {}); loadConversations().catch(() => {}); loadProfile().catch(() => {}); }, []);
  useEffect(() => {
    const s = io(API, { auth: { token: localStorage.getItem('loelsti_token') } });
    s.on('connect', () => servers.forEach(x => s.emit('subscribeServer', x.id)));
    s.on('MESSAGE_CREATE', (m: Message) => setMessages(prev => prev.some(x => x.id === m.id) ? prev : [...prev, m]));
    s.on('MESSAGE_UPDATE', (m: Message) => { setMessages(prev => prev.map(x => x.id === m.id ? m : x)); setDmMessages(prev => prev.map(x => x.id === m.id ? m : x)); });
    s.on('MESSAGE_DELETE', ({ id }: { id: string }) => { setMessages(prev => prev.filter(x => x.id !== id)); setDmMessages(prev => prev.filter(x => x.id !== id)); });
    s.on('REACTION_ADD', (r) => setMessages(prev => prev.map(m => m.id === r.messageId ? { ...m, reactions: [...(m.reactions ?? []), r] } : m)));
    s.on('FRIEND_REQUEST', () => loadFriends().catch(() => {}));
    s.on('FRIENDSHIP_CREATE', () => loadFriends().catch(() => {}));
    s.on('PRESENCE_UPDATE', ({ userId, presence }: { userId: string; presence: string }) => { setFriends(prev => ({ ...prev, friends: prev.friends.map(f => f.id === userId ? { ...f, presence } : f) })); });
    setSocket(s); return () => s.disconnect();
  }, [servers.length]);
  useEffect(() => { if (!channel || page !== 'home') return; api<{ messages: Message[] }>(`/api/v1/channels/${channel}/messages`).then(x => setMessages(x.messages)).catch(e => setError(e.message)); }, [channel, page]);

  async function createServer() { const name = prompt('Servername'); if (!name) return; try { const d = await api<{ server: Server }>('/api/v1/servers', { method: 'POST', body: JSON.stringify({ name }) }); setServers(p => [...p, d.server]); setActiveServer(d.server); setChannel(d.server.channels.find(c => c.type === 'TEXT')?.id ?? null); } catch (e) { setError(e instanceof Error ? e.message : 'Fehler'); } }
  async function sendChannelMessage() { if (!channel || !text.trim()) return; try { const d = await api<{ message: Message }>(`/api/v1/channels/${channel}/messages`, { method: 'POST', body: JSON.stringify({ content: text.trim() }) }); setMessages(p => p.some(m => m.id === d.message.id) ? p : [...p, d.message]); setText(''); socket?.emit('typing', { channelId: channel }); } catch (e) { setError(e instanceof Error ? e.message : 'Fehler'); } }
  async function sendDm() { if (!activeConversation || !text.trim()) return; try { const d = await api<{ message: Message }>(`/api/v1/conversations/${activeConversation.id}/messages`, { method: 'POST', body: JSON.stringify({ content: text.trim(), clientMessageId: crypto.randomUUID() }) }); setDmMessages(p => [...p, d.message]); setText(''); } catch (e) { setError(e instanceof Error ? e.message : 'Fehler'); } }
  async function openConversation(c: Conversation) { setActiveConversation(c); setPage('messages'); socket?.emit('subscribeConversation', c.id); try { const d = await api<{ messages: Message[] }>(`/api/v1/conversations/${c.id}/messages`); setDmMessages(d.messages); } catch (e) { setError(e instanceof Error ? e.message : 'Fehler'); } }
  async function addFriend() { const username = prompt('Username des Benutzers'); if (!username) return; try { const d = await api<{ users: User[] }>(`/api/v1/users/search?q=${encodeURIComponent(username)}`); const found = d.users.find(x => x.username.toLowerCase() === username.toLowerCase()) ?? d.users[0]; if (!found) throw new Error('Benutzer nicht gefunden.'); await api('/api/v1/friends/requests', { method: 'POST', body: JSON.stringify({ userId: found.id }) }); await loadFriends(); } catch (e) { setError(e instanceof Error ? e.message : 'Fehler'); } }
  async function acceptFriend(id: string) { await api(`/api/v1/friends/requests/${id}/accept`, { method: 'POST' }); await loadFriends(); }
  async function startDm(friend: User) { try { const d = await api<{ conversation: Conversation }>('/api/v1/conversations', { method: 'POST', body: JSON.stringify({ userIds: [friend.id], type: 'DM' }) }); await loadConversations(); await openConversation(d.conversation); } catch (e) { setError(e instanceof Error ? e.message : 'Fehler'); } }
  async function saveProfile() { try { const d = await api<{ user: User }>('/api/v1/me/profile', { method: 'PATCH', body: JSON.stringify({ displayName: profileName, bio: bio || null }) }); setUser(d.user); } catch (e) { setError(e instanceof Error ? e.message : 'Fehler'); } }

  const content = page === 'friends' ? <section className="panel"><div className="panel-head"><div><h2>Freunde</h2><p>Kontakte, Anfragen und Blockierungen</p></div><button onClick={addFriend}>Freund hinzufügen</button></div>{friends.incoming.map(r => <div className="list-row" key={r.id}><Avatar user={r.sender} small/><div><b>{r.sender.displayName}</b><span>@{r.sender.username}</span></div><button onClick={() => acceptFriend(r.id)}>Annehmen</button></div>)}{friends.friends.map(f => <div className="list-row" key={f.id}><Avatar user={f} small/><div><b>{f.displayName}</b><span>{f.presence ?? 'offline'}</span></div><button className="ghost" onClick={() => startDm(f)}>Nachricht</button></div>)}{!friends.incoming.length && !friends.friends.length && <div className="empty">Noch keine Freunde.</div>}</section> : page === 'messages' ? <section className="panel dm-panel"><div className="panel-head"><div><h2>Nachrichten</h2><p>Direkte Unterhaltungen</p></div></div><div className="dm-layout"><aside className="dm-list">{conversations.map(c => { const other = c.members.find(m => m.user.id !== user.id)?.user ?? c.members[0]?.user; return <button key={c.id} className={activeConversation?.id === c.id ? 'dm-item active' : 'dm-item'} onClick={() => openConversation(c)}><Avatar user={other} small/><span>{c.name ?? other?.displayName ?? 'Gruppe'}</span></button>; })}</aside>{activeConversation ? <div className="dm-chat"><div className="dm-messages">{dmMessages.map(m => <article className="message" key={m.id}><Avatar user={m.author}/><div><div className="meta"><b>{m.author.displayName}</b><time>{new Date(m.createdAt).toLocaleString('de-DE')}</time></div><p>{m.content}</p></div></article>)}</div><Composer value={text} setValue={setText} onSend={sendDm}/></div> : <div className="empty">Wähle eine Unterhaltung aus.</div>}</div></section> : page === 'discover' ? <section className="panel"><div className="panel-head"><div><h2>Entdecken</h2><p>Deine Server und Communitys</p></div></div><div className="server-grid">{servers.map(s => <button className="server-card" key={s.id} onClick={() => { setPage('home'); setActiveServer(s); setChannel(s.channels.find(c => c.type === 'TEXT')?.id ?? null); }}><strong>{s.name}</strong><span>{s.description || 'Community auf LOELSTI'}</span><small>{s.channels.length} Kanäle</small></button>)}</div></section> : page === 'settings' ? <section className="panel"><div className="panel-head"><div><h2>Einstellungen</h2><p>Dein LOELSTI-Profil</p></div></div><div className="settings-form"><label>Anzeigename<input value={profileName} onChange={e => setProfileName(e.target.value)}/></label><label>Bio<textarea value={bio} onChange={e => setBio(e.target.value)} maxLength={500}/></label><button onClick={saveProfile}>Änderungen speichern</button><button className="ghost" onClick={async () => { await api('/api/v1/auth/logout', { method: 'POST' }); localStorage.removeItem('loelsti_token'); location.reload(); }}>Abmelden</button></div></section> : <div className="chat"><header><div><h2>#{activeChannel?.name ?? 'general'}</h2><span>{activeChannel?.topic || activeServer?.description || 'Willkommen bei LOELSTI'}</span></div></header><section className="messages">{messages.map(m => <article className="message" key={m.id}><Avatar user={m.author}/><div><div className="meta"><b>{m.author.displayName}</b><time>{new Date(m.createdAt).toLocaleString('de-DE')}{m.updatedAt !== m.createdAt ? ' · bearbeitet' : ''}</time></div><p>{m.content}</p>{m.reactions?.length ? <div className="reactions">{Array.from(new Set(m.reactions.map(r => r.emoji))).map(emoji => <span key={emoji}>{emoji} {m.reactions?.filter(r => r.emoji === emoji).length}</span>)}</div> : null}</div></article>)}</section><Composer value={text} setValue={setText} onSend={sendChannelMessage} disabled={!channel}/>{error && <div className="toast error">{error}<button onClick={() => setError('')}>×</button></div>}</div>;

  return <div className="shell"><nav className="topnav"><button className={page === 'home' ? 'nav active' : 'nav'} onClick={() => setPage('home')}>Home</button><button className={page === 'friends' ? 'nav active' : 'nav'} onClick={() => { setPage('friends'); loadFriends(); }}>Freunde</button><button className={page === 'messages' ? 'nav active' : 'nav'} onClick={() => { setPage('messages'); loadConversations(); }}>Nachrichten</button><button className={page === 'discover' ? 'nav active' : 'nav'} onClick={() => setPage('discover')}>Entdecken</button><button className={page === 'settings' ? 'nav active' : 'nav'} onClick={() => setPage('settings')}>Einstellungen</button></nav><div className="app"><aside className="servers"><div className="logo small">L</div>{servers.map(s => <button key={s.id} className={activeServer?.id === s.id ? 'server active' : 'server'} onClick={() => { setPage('home'); setActiveServer(s); setChannel(s.channels.find(c => c.type === 'TEXT')?.id ?? null); }}>{s.name.slice(0, 2).toUpperCase()}</button>)}<button className="server add" onClick={createServer}>+</button></aside><aside className="channels"><div className="server-head"><strong>{activeServer?.name ?? 'LOELSTI'}</strong><span>{user.displayName}</span></div>{activeServer?.channels.filter(c => ['TEXT', 'FORUM', 'ANNOUNCEMENT'].includes(c.type)).map(c => <button key={c.id} className={channel === c.id ? 'channel active' : 'channel'} onClick={() => { setPage('home'); setChannel(c.id); }}># {c.name}</button>)}<div className="userbar"><div><b>{user.displayName}</b><span>@{user.username}</span></div><button aria-label="Einstellungen" onClick={() => setPage('settings')}>⚙</button></div></aside>{content}</div><footer className="mobile-nav"><button onClick={() => setPage('home')}>Home</button><button onClick={() => setPage('friends')}>Freunde</button><button onClick={() => setPage('messages')}>DMs</button><button onClick={() => setPage('settings')}>Profil</button></footer></div>;
}

function Composer({ value, setValue, onSend, disabled }: { value: string; setValue: (v: string) => void; onSend: () => void; disabled?: boolean }) {
  return <div className="composer"><textarea value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }} placeholder={disabled ? 'Wähle einen Kanal' : 'Nachricht schreiben …'} disabled={disabled}/><button onClick={onSend} disabled={disabled || !value.trim()}>Senden</button></div>;
}

function Root() { const [user, setUser] = useState<User | null>(null); useEffect(() => { if (!localStorage.getItem('loelsti_token')) return; api<{ user: User }>('/api/v1/me').then(d => setUser(d.user)).catch(() => localStorage.removeItem('loelsti_token')); }, []); return user ? <App initialUser={user}/> : <Auth onLogin={d => setUser(d.user)}/>; }
createRoot(document.getElementById('root')!).render(<Root/>);
