import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { Server as SocketServer } from 'socket.io';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { PrismaClient, Permission } from '@prisma/client';

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: process.env.WEB_URL ?? 'http://localhost:5173', credentials: true } });
const port = Number(process.env.PORT ?? 3000);
const secret = process.env.JWT_SECRET;
if (!secret) throw new Error('JWT_SECRET is required');

app.use(cors({ origin: process.env.WEB_URL ?? 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'loelsti-api' }));

function tokenFor(userId: string) { return jwt.sign({ sub: userId }, secret, { expiresIn: '7d' }); }
function auth(req: express.Request): string {
  const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!raw) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const payload = jwt.verify(raw, secret) as jwt.JwtPayload;
  if (!payload.sub) throw Object.assign(new Error('Invalid token'), { status: 401 });
  return payload.sub;
}
async function requireMember(userId: string, serverId: string) {
  const member = await prisma.serverMember.findUnique({ where: { serverId_userId: { serverId, userId } }, include: { roles: { include: { role: { include: { permissions: true } } } } } });
  if (!member) throw Object.assign(new Error('Server membership required'), { status: 403 });
  return member;
}
async function can(userId: string, serverId: string, permission: Permission) {
  const serverRecord = await prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } });
  if (serverRecord?.ownerId === userId) return true;
  const member = await requireMember(userId, serverId);
  return member.roles.some(r => r.role.permissions.some(p => p.permission === permission));
}
function asyncRoute(fn: (req: express.Request, res: express.Response) => Promise<void>) { return (req: express.Request, res: express.Response) => fn(req, res).catch(err => res.status(err.status ?? 500).json({ code: 'REQUEST_FAILED', message: err.message ?? 'Request failed' })); }

const registerSchema = z.object({ username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/), displayName: z.string().trim().min(1).max(64), email: z.string().email().max(320), password: z.string().min(8).max(128) });
app.post('/api/v1/auth/register', asyncRoute(async (req, res) => {
  const input = registerSchema.parse(req.body);
  const exists = await prisma.user.findFirst({ where: { OR: [{ email: input.email.toLowerCase() }, { username: input.username.toLowerCase() }] } });
  if (exists) return res.status(409).json({ code: 'ACCOUNT_EXISTS', message: 'Username oder E-Mail wird bereits verwendet.' });
  const user = await prisma.user.create({ data: { username: input.username, displayName: input.displayName, email: input.email.toLowerCase(), passwordHash: await bcrypt.hash(input.password, 12) } });
  res.status(201).json({ token: tokenFor(user.id), user: { id: user.id, username: user.username, displayName: user.displayName } });
}));

app.post('/api/v1/auth/login', asyncRoute(async (req, res) => {
  const input = z.object({ login: z.string().min(1), password: z.string().min(1) }).parse(req.body);
  const user = await prisma.user.findFirst({ where: { OR: [{ email: input.login.toLowerCase() }, { username: input.login }] } });
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) return res.status(401).json({ code: 'INVALID_LOGIN', message: 'Login-Daten sind ungültig.' });
  await prisma.user.update({ where: { id: user.id }, data: { presence: 'ONLINE' } });
  res.json({ token: tokenFor(user.id), user: { id: user.id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl } });
}));

app.get('/api/v1/me', asyncRoute(async (req, res) => { const userId = auth(req); const user = await prisma.user.findUnique({ where: { id: userId }, select: { id:true,username:true,displayName:true,email:true,avatarUrl:true,bannerUrl:true,bio:true,presence:true,customStatus:true } }); if (!user) throw Object.assign(new Error('User not found'), { status:404 }); res.json({ user }); }));

app.get('/api/v1/servers', asyncRoute(async (req, res) => { const userId = auth(req); const memberships = await prisma.serverMember.findMany({ where:{userId}, include:{server:{include:{channels:{orderBy:{position:'asc'}},roles:true}}}, orderBy:{joinedAt:'asc'} }); res.json({ servers: memberships.map(m=>m.server) }); }));

app.post('/api/v1/servers', asyncRoute(async (req, res) => {
  const userId = auth(req); const input = z.object({ name:z.string().trim().min(2).max(100), description:z.string().max(500).optional() }).parse(req.body);
  const serverRecord = await prisma.$transaction(async tx => {
    const s = await tx.server.create({ data:{ name:input.name, description:input.description, ownerId:userId } });
    const role = await tx.role.create({ data:{ serverId:s.id, name:'@everyone', position:0 } });
    await tx.rolePermission.createMany({ data:[{roleId:role.id,permission:'VIEW_SERVER'},{roleId:role.id,permission:'SEND_MESSAGES'},{roleId:role.id,permission:'ATTACH_FILES'},{roleId:role.id,permission:'EMBED_LINKS'},{roleId:role.id,permission:'ADD_REACTIONS'},{roleId:role.id,permission:'CONNECT'},{roleId:role.id,permission:'SPEAK'}] });
    const member = await tx.serverMember.create({ data:{serverId:s.id,userId} });
    await tx.memberRole.create({ data:{memberId:member.id,roleId:role.id} });
    await tx.channel.create({ data:{serverId:s.id,name:'general',type:'TEXT',position:0} });
    await tx.channel.create({ data:{serverId:s.id,name:'Lounge',type:'VOICE',position:1} });
    return tx.server.findUnique({where:{id:s.id},include:{channels:true,roles:true}});
  });
  io.emit('SERVER_CREATE', serverRecord); res.status(201).json({ server:serverRecord });
}));

app.post('/api/v1/servers/:serverId/channels', asyncRoute(async (req,res)=>{
  const userId=auth(req); const {serverId}=req.params; if(!(await can(userId,serverId,'MANAGE_CHANNELS'))) return res.status(403).json({code:'FORBIDDEN',message:'Keine Berechtigung.'});
  const input=z.object({name:z.string().trim().min(1).max(100),type:z.enum(['TEXT','VOICE','VIDEO','FORUM','ANNOUNCEMENT','STAGE','TICKET']).default('TEXT')}).parse(req.body);
  const channel=await prisma.channel.create({data:{serverId,name:input.name,type:input.type as never,position:Date.now()}}); io.to(`server:${serverId}`).emit('CHANNEL_CREATE',channel); res.status(201).json({channel});
}));

app.get('/api/v1/channels/:channelId/messages', asyncRoute(async(req,res)=>{ const userId=auth(req); const {channelId}=req.params; const channel=await prisma.channel.findUnique({where:{id:channelId}}); if(!channel) return res.status(404).json({code:'NOT_FOUND',message:'Kanal nicht gefunden.'}); await requireMember(userId,channel.serverId); const before=req.query.before?.toString(); const messages=await prisma.message.findMany({where:{channelId,status:'SENT',...(before?{createdAt:{lt:new Date(before)}}:{})},include:{author:{select:{id:true,username:true,displayName:true,avatarUrl:true}},reactions:true},orderBy:[{createdAt:'desc'},{id:'desc'}],take:50}); res.json({messages:messages.reverse()}); }));

app.post('/api/v1/channels/:channelId/messages', asyncRoute(async(req,res)=>{ const userId=auth(req); const {channelId}=req.params; const channel=await prisma.channel.findUnique({where:{id:channelId}}); if(!channel) return res.status(404).json({code:'NOT_FOUND',message:'Kanal nicht gefunden.'}); await requireMember(userId,channel.serverId); const input=z.object({content:z.string().trim().min(1).max(4000),clientMessageId:z.string().max(100).optional(),replyToId:z.string().optional()}).parse(req.body); const message=await prisma.message.create({data:{channelId,authorId:userId,content:input.content,replyToId:input.replyToId},include:{author:{select:{id:true,username:true,displayName:true,avatarUrl:true}}}}); io.to(`server:${channel.serverId}`).emit('MESSAGE_CREATE',message); res.status(201).json({message}); }));

io.use((socket,next)=>{ try { const token=socket.handshake.auth?.token; if(!token) return next(new Error('Authentication required')); const p=jwt.verify(token,secret) as jwt.JwtPayload; socket.data.userId=p.sub; next(); } catch { next(new Error('Invalid session')); } });
io.on('connection', socket=>{ socket.on('subscribeServer', async (serverId:string)=>{ if(!socket.data.userId) return; const member=await prisma.serverMember.findUnique({where:{serverId_userId:{serverId,userId:socket.data.userId}}}); if(member) socket.join(`server:${serverId}`); }); socket.on('typing', async({channelId}:{channelId:string})=>{ const c=await prisma.channel.findUnique({where:{id:channelId}}); if(c) socket.to(`server:${c.serverId}`).emit('TYPING_START',{channelId,userId:socket.data.userId}); }); socket.on('disconnect',()=>{}); });

app.use((err: unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{ const status=(err as {status?:number})?.status??500; res.status(status).json({code:'INTERNAL_ERROR',message:status===500?'Interner Serverfehler.':'Anfrage fehlgeschlagen.'}); });
server.listen(port,()=>console.log(`LOELSTI API listening on :${port}`));
