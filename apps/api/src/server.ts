import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { Server as SocketServer } from 'socket.io';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { z } from 'zod';
import { PrismaClient, Permission, ConversationType, MessageStatus } from '@prisma/client';

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const webUrl = process.env.WEB_URL ?? 'http://localhost:5173';
const io = new SocketServer(server, { cors: { origin: webUrl, credentials: true } });
const port = Number(process.env.PORT ?? 3000);
const secret = process.env.JWT_SECRET;
if (!secret) throw new Error('JWT_SECRET is required');

app.use(cors({ origin: webUrl, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'loelsti-api' }));
app.get('/ready', async (_req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; res.json({ status: 'ready' }); }
  catch { res.status(503).json({ code: 'NOT_READY', message: 'Dienst ist noch nicht bereit.' }); }
});

function tokenFor(userId: string) { return jwt.sign({ sub: userId, jti: crypto.randomUUID() }, secret!, { expiresIn: '7d' }); }
function auth(req: express.Request): string {
  const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!raw) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const payload = jwt.verify(raw, secret!) as jwt.JwtPayload;
  if (!payload.sub) throw Object.assign(new Error('Invalid token'), { status: 401 });
  return String(payload.sub);
}
function fail(message: string, status = 400) { throw Object.assign(new Error(message), { status }); }
function asyncRoute(fn: (req: express.Request, res: express.Response) => Promise<void>) {
  return (req: express.Request, res: express.Response) => fn(req, res).catch(err => {
    const status = typeof err?.status === 'number' ? err.status : 500;
    res.status(status).json({ code: status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED', message: status === 500 ? 'Interner Serverfehler.' : String(err?.message ?? 'Anfrage fehlgeschlagen.') });
  });
}
async function requireMember(userId: string, serverId: string) {
  const member = await prisma.serverMember.findUnique({ where: { serverId_userId: { serverId, userId } }, include: { roles: { include: { role: { include: { permissions: true } } } } } });
  if (!member) fail('Server-Mitgliedschaft erforderlich.', 403);
  return member;
}
async function can(userId: string, serverId: string, permission: Permission) {
  const serverRecord = await prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } });
  if (!serverRecord) return false;
  if (serverRecord.ownerId === userId) return true;
  const member = await requireMember(userId, serverId);
  return member.roles.some(r => r.role.permissions.some(p => p.permission === permission));
}
const publicUser = { id: true, username: true, displayName: true, avatarUrl: true, presence: true, customStatus: true } as const;
const registerSchema = z.object({ username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/), displayName: z.string().trim().min(1).max(64), email: z.string().email().max(320), password: z.string().min(8).max(128) });

app.post('/api/v1/auth/register', asyncRoute(async (req, res) => {
  const input = registerSchema.parse(req.body);
  const username = input.username.toLowerCase();
  const email = input.email.toLowerCase();
  const exists = await prisma.user.findFirst({ where: { OR: [{ email }, { username }] } });
  if (exists) fail('Username oder E-Mail wird bereits verwendet.', 409);
  const user = await prisma.user.create({ data: { username, displayName: input.displayName, email, passwordHash: await bcrypt.hash(input.password, 12), presence: 'ONLINE' } });
  res.status(201).json({ token: tokenFor(user.id), user: await prisma.user.findUnique({ where: { id: user.id }, select: publicUser }) });
}));
app.post('/api/v1/auth/login', asyncRoute(async (req, res) => {
  const input = z.object({ login: z.string().min(1), password: z.string().min(1) }).parse(req.body);
  const login = input.login.toLowerCase();
  const user = await prisma.user.findFirst({ where: { OR: [{ email: login }, { username: login }] } });
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) fail('Login-Daten sind ungültig.', 401);
  await prisma.user.update({ where: { id: user.id }, data: { presence: 'ONLINE' } });
  res.json({ token: tokenFor(user.id), user: await prisma.user.findUnique({ where: { id: user.id }, select: publicUser }) });
}));
app.post('/api/v1/auth/logout', asyncRoute(async (req, res) => { const userId = auth(req); await prisma.user.update({ where: { id: userId }, data: { presence: 'OFFLINE' } }); res.status(204).end(); }));
app.get('/api/v1/me', asyncRoute(async (req, res) => { const userId = auth(req); const user = await prisma.user.findUnique({ where: { id: userId }, select: { ...publicUser, email: true, bannerUrl: true, bio: true } }); if (!user) fail('Benutzer nicht gefunden.', 404); res.json({ user }); }));
app.patch('/api/v1/me/profile', asyncRoute(async (req, res) => {
  const userId = auth(req); const input = z.object({ displayName: z.string().trim().min(1).max(64).optional(), bio: z.string().max(500).nullable().optional(), avatarUrl: z.string().url().max(2048).nullable().optional(), bannerUrl: z.string().url().max(2048).nullable().optional(), customStatus: z.string().max(128).nullable().optional() }).parse(req.body);
  const user = await prisma.user.update({ where: { id: userId }, data: input, select: { ...publicUser, email: true, bannerUrl: true, bio: true } });
  io.emit('USER_UPDATE', user); res.json({ user });
}));

app.get('/api/v1/users/search', asyncRoute(async (req, res) => {
  const userId = auth(req); const q = String(req.query.q ?? '').trim(); if (!q) return res.json({ users: [] });
  const users = await prisma.user.findMany({ where: { id: { not: userId }, OR: [{ username: { contains: q.toLowerCase(), mode: 'insensitive' } }, { displayName: { contains: q, mode: 'insensitive' } }] }, select: publicUser, take: 25 });
  res.json({ users });
}));

app.get('/api/v1/friends', asyncRoute(async (req, res) => {
  const userId = auth(req);
  const [a, b, incoming, outgoing, blocks] = await Promise.all([
    prisma.friendship.findMany({ where: { userAId: userId }, include: { userB: { select: publicUser } } }),
    prisma.friendship.findMany({ where: { userBId: userId }, include: { userA: { select: publicUser } } }),
    prisma.friendRequest.findMany({ where: { receiverId: userId }, include: { sender: { select: publicUser } }, orderBy: { createdAt: 'desc' } }),
    prisma.friendRequest.findMany({ where: { senderId: userId }, include: { receiver: { select: publicUser } }, orderBy: { createdAt: 'desc' } }),
    prisma.block.findMany({ where: { fromUserId: userId }, include: { toUser: { select: publicUser } } })
  ]);
  res.json({ friends: [...a.map(x => x.userB), ...b.map(x => x.userA)], incoming, outgoing, blocked: blocks.map(x => x.toUser) });
}));
app.post('/api/v1/friends/requests', asyncRoute(async (req, res) => {
  const userId = auth(req); const { userId: targetId } = z.object({ userId: z.string().min(1) }).parse(req.body); if (userId === targetId) fail('Du kannst dich nicht selbst hinzufügen.');
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: publicUser }); if (!target) fail('Benutzer nicht gefunden.', 404);
  const blocked = await prisma.block.findFirst({ where: { OR: [{ fromUserId: userId, toUserId: targetId }, { fromUserId: targetId, toUserId: userId }] } }); if (blocked) fail('Diese Kontaktanfrage ist nicht möglich.', 403);
  const existing = await prisma.friendRequest.findFirst({ where: { OR: [{ senderId: userId, receiverId: targetId }, { senderId: targetId, receiverId: userId }] } }); if (existing) fail('Es existiert bereits eine Anfrage.', 409);
  const friendship = await prisma.friendship.findFirst({ where: { OR: [{ userAId: userId, userBId: targetId }, { userAId: targetId, userBId: userId }] } }); if (friendship) fail('Ihr seid bereits befreundet.', 409);
  const request = await prisma.friendRequest.create({ data: { senderId: userId, receiverId: targetId } });
  await prisma.notification.create({ data: { userId: targetId, type: 'FRIEND_REQUEST', title: 'Neue Freundschaftsanfrage', body: 'Du hast eine neue Freundschaftsanfrage.', data: { requestId: request.id, senderId: userId } } });
  io.emit('FRIEND_REQUEST', request); res.status(201).json({ request });
}));
app.post('/api/v1/friends/requests/:requestId/accept', asyncRoute(async (req, res) => {
  const userId = auth(req); const request = await prisma.friendRequest.findUnique({ where: { id: req.params.requestId } }); if (!request || request.receiverId !== userId) fail('Anfrage nicht gefunden.', 404);
  const friendship = await prisma.$transaction(async tx => { await tx.friendRequest.delete({ where: { id: request.id } }); return tx.friendship.create({ data: { userAId: request.senderId, userBId: request.receiverId } }); });
  io.emit('FRIENDSHIP_CREATE', friendship); res.status(201).json({ friendship });
}));
app.delete('/api/v1/friends/requests/:requestId', asyncRoute(async (req, res) => { const userId = auth(req); const r = await prisma.friendRequest.findUnique({ where: { id: req.params.requestId } }); if (!r || (r.receiverId !== userId && r.senderId !== userId)) fail('Anfrage nicht gefunden.', 404); await prisma.friendRequest.delete({ where: { id: r.id } }); res.status(204).end(); }));
app.delete('/api/v1/friends/:targetId', asyncRoute(async (req, res) => { const userId = auth(req); const targetId = req.params.targetId; await prisma.friendship.deleteMany({ where: { OR: [{ userAId: userId, userBId: targetId }, { userAId: targetId, userBId: userId }] } }); res.status(204).end(); }));
app.post('/api/v1/blocks/:targetId', asyncRoute(async (req, res) => { const userId = auth(req); const targetId = req.params.targetId; if (userId === targetId) fail('Ungültiger Benutzer.'); await prisma.$transaction([prisma.block.upsert({ where: { fromUserId_toUserId: { fromUserId: userId, toUserId: targetId } }, update: {}, create: { fromUserId: userId, toUserId: targetId } }), prisma.friendship.deleteMany({ where: { OR: [{ userAId: userId, userBId: targetId }, { userAId: targetId, userBId: userId }] } })]); res.status(201).json({ blocked: true }); }));
app.delete('/api/v1/blocks/:targetId', asyncRoute(async (req, res) => { const userId = auth(req); await prisma.block.deleteMany({ where: { fromUserId: userId, toUserId: req.params.targetId } }); res.status(204).end(); }));

app.get('/api/v1/servers', asyncRoute(async (req, res) => { const userId = auth(req); const memberships = await prisma.serverMember.findMany({ where: { userId }, include: { server: { include: { channels: { orderBy: { position: 'asc' } }, roles: true } } }, orderBy: { joinedAt: 'asc' } }); res.json({ servers: memberships.map(m => m.server) }); }));
app.get('/api/v1/servers/:serverId', asyncRoute(async (req, res) => { const userId = auth(req); const s = await prisma.server.findUnique({ where: { id: req.params.serverId }, include: { channels: { orderBy: { position: 'asc' } }, categories: { orderBy: { position: 'asc' } }, roles: { orderBy: { position: 'desc' } } } }); if (!s) fail('Server nicht gefunden.', 404); await requireMember(userId, s.id); res.json({ server: s }); }));
app.post('/api/v1/servers', asyncRoute(async (req, res) => {
  const userId = auth(req); const input = z.object({ name: z.string().trim().min(2).max(100), description: z.string().max(500).optional() }).parse(req.body);
  const serverRecord = await prisma.$transaction(async tx => {
    const s = await tx.server.create({ data: { name: input.name, description: input.description, ownerId: userId } });
    const everyone = await tx.role.create({ data: { serverId: s.id, name: '@everyone', position: 0 } });
    await tx.rolePermission.createMany({ data: ['VIEW_SERVER','SEND_MESSAGES','ATTACH_FILES','EMBED_LINKS','ADD_REACTIONS','CONNECT','SPEAK','CREATE_THREADS'].map(permission => ({ roleId: everyone.id, permission: permission as Permission })) });
    const member = await tx.serverMember.create({ data: { serverId: s.id, userId } }); await tx.memberRole.create({ data: { memberId: member.id, roleId: everyone.id } });
    await tx.channel.createMany({ data: [{ serverId: s.id, name: 'general', type: 'TEXT', position: 0 }, { serverId: s.id, name: 'Lounge', type: 'VOICE', position: 1 }] });
    return tx.server.findUnique({ where: { id: s.id }, include: { channels: true, roles: true } });
  });
  io.emit('SERVER_CREATE', serverRecord); res.status(201).json({ server: serverRecord });
}));
app.post('/api/v1/servers/:serverId/channels', asyncRoute(async (req, res) => { const userId = auth(req); const { serverId } = req.params; if (!(await can(userId, serverId, Permission.MANAGE_CHANNELS))) fail('Keine Berechtigung.', 403); const input = z.object({ name: z.string().trim().min(1).max(100), type: z.enum(['TEXT','VOICE','VIDEO','FORUM','ANNOUNCEMENT','STAGE','TICKET']).default('TEXT'), topic: z.string().max(1024).optional() }).parse(req.body); const max = await prisma.channel.aggregate({ where: { serverId }, _max: { position: true } }); const channel = await prisma.channel.create({ data: { serverId, name: input.name, type: input.type, topic: input.topic, position: (max._max.position ?? -1) + 1 } }); io.to(`server:${serverId}`).emit('CHANNEL_CREATE', channel); res.status(201).json({ channel }); }));
app.patch('/api/v1/channels/:channelId', asyncRoute(async (req,res)=>{ const userId=auth(req); const c=await prisma.channel.findUnique({where:{id:req.params.channelId}}); if(!c) fail('Kanal nicht gefunden.',404); if(!(await can(userId,c.serverId,Permission.MANAGE_CHANNELS))) fail('Keine Berechtigung.',403); const input=z.object({name:z.string().trim().min(1).max(100).optional(),topic:z.string().max(1024).nullable().optional(),slowmodeSeconds:z.number().int().min(0).max(21600).optional()}).parse(req.body); const channel=await prisma.channel.update({where:{id:c.id},data:input}); io.to(`server:${c.serverId}`).emit('CHANNEL_UPDATE',channel); res.json({channel}); }));

async function loadChannelMessage(userId: string, messageId: string) { const message = await prisma.message.findUnique({ where: { id: messageId }, include: { channel: true, conversation: { include: { members: true } } } }); if (!message) fail('Nachricht nicht gefunden.', 404); if (message.channel) await requireMember(userId, message.channel.serverId); else if (!message.conversation?.members.some(m => m.userId === userId)) fail('Kein Zugriff auf diese Unterhaltung.', 403); return message; }
app.get('/api/v1/channels/:channelId/messages', asyncRoute(async (req,res)=>{ const userId=auth(req); const c=await prisma.channel.findUnique({where:{id:req.params.channelId}}); if(!c) fail('Kanal nicht gefunden.',404); await requireMember(userId,c.serverId); const before=req.query.before?.toString(); const limit=Math.min(Number(req.query.limit??50),100); const messages=await prisma.message.findMany({where:{channelId:c.id,status:MessageStatus.SENT,...(before?{createdAt:{lt:new Date(before)}}:{})},include:{author:{select:publicUser},reactions:true,replyTo:{include:{author:{select:publicUser}}}},orderBy:[{createdAt:'desc'},{id:'desc'}],take:limit}); res.json({messages:messages.reverse(),nextBefore:messages.length?messages[0].createdAt.toISOString():null}); }));
app.post('/api/v1/channels/:channelId/messages', asyncRoute(async(req,res)=>{ const userId=auth(req); const c=await prisma.channel.findUnique({where:{id:req.params.channelId}}); if(!c) fail('Kanal nicht gefunden.',404); await requireMember(userId,c.serverId); const input=z.object({content:z.string().trim().min(1).max(4000),clientMessageId:z.string().max(100).optional(),replyToId:z.string().optional()}).parse(req.body); if(c.type!=='TEXT' && c.type!=='ANNOUNCEMENT' && c.type!=='FORUM') fail('In diesem Kanal können keine normalen Nachrichten gesendet werden.',400); const message=await prisma.message.create({data:{channelId:c.id,authorId:userId,content:input.content,replyToId:input.replyToId,clientMessageId:input.clientMessageId},include:{author:{select:publicUser}}}); io.to(`server:${c.serverId}`).emit('MESSAGE_CREATE',message); res.status(201).json({message}); }));
app.patch('/api/v1/messages/:messageId', asyncRoute(async(req,res)=>{ const userId=auth(req); const m=await loadChannelMessage(userId,req.params.messageId); if(m.authorId!==userId) { if(!m.channel || !(await can(userId,m.channel.serverId,Permission.MANAGE_MESSAGES))) fail('Keine Berechtigung.',403); } const input=z.object({content:z.string().trim().min(1).max(4000)}).parse(req.body); const message=await prisma.message.update({where:{id:m.id},data:{content:input.content},include:{author:{select:publicUser},reactions:true}}); if(m.channel) io.to(`server:${m.channel.serverId}`).emit('MESSAGE_UPDATE',message); else io.emit('MESSAGE_UPDATE',message); res.json({message}); }));
app.delete('/api/v1/messages/:messageId', asyncRoute(async(req,res)=>{ const userId=auth(req); const m=await loadChannelMessage(userId,req.params.messageId); if(m.authorId!==userId) { if(!m.channel || !(await can(userId,m.channel.serverId,Permission.MANAGE_MESSAGES))) fail('Keine Berechtigung.',403); } await prisma.message.update({where:{id:m.id},data:{status:MessageStatus.DELETED,content:''}}); if(m.channel) io.to(`server:${m.channel.serverId}`).emit('MESSAGE_DELETE',{id:m.id}); else io.emit('MESSAGE_DELETE',{id:m.id}); res.status(204).end(); }));
app.post('/api/v1/messages/:messageId/reactions', asyncRoute(async(req,res)=>{ const userId=auth(req); const m=await loadChannelMessage(userId,req.params.messageId); const emoji=z.object({emoji:z.string().trim().min(1).max(64)}).parse(req.body).emoji; if(m.channel && !(await can(userId,m.channel.serverId,Permission.ADD_REACTIONS))) fail('Keine Berechtigung.',403); const reaction=await prisma.messageReaction.create({data:{messageId:m.id,userId,emoji}}); if(m.channel) io.to(`server:${m.channel.serverId}`).emit('REACTION_ADD',reaction); res.status(201).json({reaction}); }));
app.delete('/api/v1/messages/:messageId/reactions/:emoji', asyncRoute(async(req,res)=>{ const userId=auth(req); const m=await loadChannelMessage(userId,req.params.messageId); await prisma.messageReaction.deleteMany({where:{messageId:m.id,userId,emoji:req.params.emoji}}); if(m.channel) io.to(`server:${m.channel.serverId}`).emit('REACTION_REMOVE',{messageId:m.id,userId,emoji:req.params.emoji}); res.status(204).end(); }));
app.put('/api/v1/read-state', asyncRoute(async(req,res)=>{ const userId=auth(req); const input=z.object({channelId:z.string().optional(),conversationId:z.string().optional(),lastReadMessageId:z.string().optional(),mentionCount:z.number().int().min(0).optional()}).refine(x=>x.channelId||x.conversationId); const data=input.parse(req.body); const where=data.channelId?{userId_channelId:{userId,channelId:data.channelId}}:{userId_conversationId:{userId,conversationId:data.conversationId!}}; const create={userId,...data}; const state=await prisma.readState.upsert({where:where as never,update:{lastReadMessageId:data.lastReadMessageId,mentionCount:data.mentionCount??0},create}); res.json({state}); }));

app.post('/api/v1/threads', asyncRoute(async(req,res)=>{ const userId=auth(req); const input=z.object({channelId:z.string(),messageId:z.string(),name:z.string().trim().min(1).max(100)}).parse(req.body); const starter=await loadChannelMessage(userId,input.messageId); if(!starter.channel || starter.channel.id!==input.channelId) fail('Ungültige Startnachricht.',400); if(!(await can(userId,starter.channel.serverId,Permission.CREATE_THREADS))) fail('Keine Berechtigung.',403); const thread=await prisma.$transaction(async tx=>{ const t=await tx.thread.create({data:{channelId:input.channelId,starterMessageId:input.messageId,name:input.name,members:{create:{userId}}}}); return tx.thread.findUnique({where:{id:t.id},include:{members:{include:{user:{select:publicUser}}},starterMessage:{include:{author:{select:publicUser}}}}}); }); io.to(`server:${starter.channel.serverId}`).emit('THREAD_CREATE',thread); res.status(201).json({thread}); }));
app.get('/api/v1/channels/:channelId/threads', asyncRoute(async(req,res)=>{ const userId=auth(req); const c=await prisma.channel.findUnique({where:{id:req.params.channelId}}); if(!c) fail('Kanal nicht gefunden.',404); await requireMember(userId,c.serverId); const threads=await prisma.thread.findMany({where:{channelId:c.id},include:{members:{include:{user:{select:publicUser}}},starterMessage:{include:{author:{select:publicUser}}}},orderBy:{updatedAt:'desc'},take:100}); res.json({threads}); }));

app.post('/api/v1/conversations', asyncRoute(async(req,res)=>{ const userId=auth(req); const input=z.object({userIds:z.array(z.string().min(1)).min(1).max(25),type:z.enum(['DM','GROUP']).default('DM'),name:z.string().trim().max(100).optional()}).parse(req.body); const ids=[...new Set([userId,...input.userIds])]; if(input.type==='DM' && ids.length!==2) fail('Eine Direktnachricht benötigt genau zwei Personen.'); const blocked=await prisma.block.findFirst({where:{OR:input.userIds.flatMap(targetId=>[{fromUserId:userId,toUserId:targetId},{fromUserId:targetId,toUserId:userId}])}}); if(blocked) fail('Diese Unterhaltung kann nicht erstellt werden.',403); const conversation=await prisma.conversation.create({data:{type:input.type as ConversationType, name:input.name, createdById:userId, members:{create:ids.map(id=>({userId:id}))}},include:{members:{include:{user:{select:publicUser}}}}}); res.status(201).json({conversation}); }));
app.get('/api/v1/conversations', asyncRoute(async(req,res)=>{ const userId=auth(req); const conversations=await prisma.conversation.findMany({where:{members:{some:{userId}}},include:{members:{include:{user:{select:publicUser}}},messages:{orderBy:{createdAt:'desc'},take:1,include:{author:{select:publicUser}}}},orderBy:{updatedAt:'desc'}}); res.json({conversations}); }));
app.get('/api/v1/conversations/:conversationId/messages', asyncRoute(async(req,res)=>{ const userId=auth(req); const conversation=await prisma.conversation.findUnique({where:{id:req.params.conversationId},include:{members:true}}); if(!conversation || !conversation.members.some(m=>m.userId===userId)) fail('Unterhaltung nicht gefunden.',404); const before=req.query.before?.toString(); const messages=await prisma.message.findMany({where:{conversationId:conversation.id,status:MessageStatus.SENT,...(before?{createdAt:{lt:new Date(before)}}:{})},include:{author:{select:publicUser},reactions:true},orderBy:[{createdAt:'desc'},{id:'desc'}],take:50}); res.json({messages:messages.reverse()}); }));
app.post('/api/v1/conversations/:conversationId/messages', asyncRoute(async(req,res)=>{ const userId=auth(req); const conversation=await prisma.conversation.findUnique({where:{id:req.params.conversationId},include:{members:true}}); if(!conversation || !conversation.members.some(m=>m.userId===userId)) fail('Unterhaltung nicht gefunden.',404); const input=z.object({content:z.string().trim().min(1).max(4000),clientMessageId:z.string().max(100).optional(),replyToId:z.string().optional()}).parse(req.body); const message=await prisma.message.create({data:{conversationId:conversation.id,authorId:userId,content:input.content,clientMessageId:input.clientMessageId,replyToId:input.replyToId},include:{author:{select:publicUser}}}); io.to(`conversation:${conversation.id}`).emit('MESSAGE_CREATE',message); await Promise.all(conversation.members.filter(m=>m.userId!==userId).map(m=>prisma.notification.create({data:{userId:m.userId,type:'MESSAGE',title:'Neue Nachricht',body:input.content.slice(0,120),data:{conversationId:conversation.id,messageId:message.id}}}))); res.status(201).json({message}); }));

io.use((socket,next)=>{ try { const token=socket.handshake.auth?.token; if(!token) return next(new Error('Authentication required')); const p=jwt.verify(token,secret!) as jwt.JwtPayload; socket.data.userId=String(p.sub); next(); } catch { next(new Error('Invalid session')); } });
io.on('connection', socket=>{
  const userId=socket.data.userId as string;
  socket.on('subscribeServer', async (serverId:string)=>{ if(await prisma.serverMember.findUnique({where:{serverId_userId:{serverId,userId}}})) socket.join(`server:${serverId}`); });
  socket.on('subscribeConversation', async (conversationId:string)=>{ if(await prisma.conversationMember.findUnique({where:{conversationId_userId:{conversationId,userId}}})) socket.join(`conversation:${conversationId}`); });
  socket.on('typing', async({channelId,conversationId}:{channelId?:string;conversationId?:string})=>{ if(channelId){const c=await prisma.channel.findUnique({where:{id:channelId}}); if(c && await prisma.serverMember.findUnique({where:{serverId_userId:{serverId:c.serverId,userId}}})) socket.to(`server:${c.serverId}`).emit('TYPING_START',{channelId,userId});} else if(conversationId){const m=await prisma.conversationMember.findUnique({where:{conversationId_userId:{conversationId,userId}}}); if(m) socket.to(`conversation:${conversationId}`).emit('TYPING_START',{conversationId,userId});} });
  socket.on('presence', async (presence:'ONLINE'|'IDLE'|'DND'|'INVISIBLE'|'OFFLINE')=>{ await prisma.user.update({where:{id:userId},data:{presence}}); io.emit('PRESENCE_UPDATE',{userId,presence}); });
});

app.use((err: unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{ if(res.headersSent) return; res.status(500).json({code:'INTERNAL_ERROR',message:'Interner Serverfehler.'}); });
server.listen(port,()=>console.log(`LOELSTI API listening on :${port}`));
