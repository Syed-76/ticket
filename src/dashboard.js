const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { dashboardStats, findTranscript, getGuildSettings, saveGuildSettings } = require('./database');

function createDashboard({ store, guildConfig, transcriptDir }) {
  const app = express();
  const port = Number(process.env.PORT || 3000);
  const sessions = new Map();
  const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');
  const cookieName = 'ticket_dashboard';

  app.use(express.json({ limit: '256kb' }));
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  function sign(value) {
    return crypto.createHmac('sha256', sessionSecret).update(value).digest('hex');
  }
  function cookie(request) {
    const raw = request.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!raw) return null;
    const [token, signature] = raw.split('.');
    if (!token || signature !== sign(token)) return null;
    return sessions.get(token) || null;
  }
  function requireAuth(request, response, next) {
    const session = cookie(request);
    if (!session) return response.status(401).json({ error: 'Authentication required.' });
    request.dashboardUser = session;
    return next();
  }
  function allowedGuild(user, guildId) {
    return user.guilds.some((guild) => guild.id === guildId && (guild.owner || (Number(guild.permissions) & 0x20) === 0x20));
  }

  app.get('/healthz', (request, response) => response.json({ ok: true, service: 'ticket-bot-dashboard' }));
  app.get('/auth/login', (request, response) => {
    if (!process.env.DISCORD_CLIENT_SECRET || !process.env.DISCORD_CLIENT_ID) return response.status(503).send('Discord OAuth2 is not configured.');
    const state = crypto.randomBytes(18).toString('hex');
    sessions.set(`state:${state}`, { createdAt: Date.now() });
    const query = new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, response_type: 'code', redirect_uri: `${publicUrl}/auth/callback`, scope: 'identify guilds', state });
    response.redirect(`https://discord.com/oauth2/authorize?${query}`);
  });
  app.get('/auth/callback', async (request, response) => {
    const state = request.query.state;
    if (!request.query.code || !state || !sessions.has(`state:${state}`)) return response.status(400).send('Invalid or expired OAuth request.');
    sessions.delete(`state:${state}`);
    try {
      const tokenResponse = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code: request.query.code, redirect_uri: `${publicUrl}/auth/callback` }) });
      const tokens = await tokenResponse.json();
      if (!tokenResponse.ok) return response.status(401).send('OAuth authorization failed.');
      const [userResponse, guildResponse] = await Promise.all([
        fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokens.access_token}` } }),
        fetch('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${tokens.access_token}` } }),
      ]);
      const user = await userResponse.json();
      const guilds = await guildResponse.json();
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { id: user.id, username: user.global_name || user.username, avatar: user.avatar, guilds, createdAt: Date.now() });
      response.setHeader('Set-Cookie', `${cookieName}=${token}.${sign(token)}; HttpOnly; SameSite=Lax; Secure=${publicUrl.startsWith('https://')}; Path=/; Max-Age=86400`);
      return response.redirect('/');
    } catch (error) {
      console.error('OAuth callback failed:', error.message);
      return response.status(500).send('OAuth authorization failed.');
    }
  });
  app.post('/auth/logout', (request, response) => {
    const session = cookie(request);
    if (session) {
      const raw = request.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)?.split('.')[0];
      if (raw) sessions.delete(raw);
    }
    response.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    response.json({ ok: true });
  });
  app.get('/api/session', (request, response) => response.json({ user: cookie(request) || null }));
  app.get('/api/stats/:guildId', requireAuth, async (request, response) => {
    if (!allowedGuild(request.dashboardUser, request.params.guildId)) return response.status(403).json({ error: 'You need Manage Server permissions.' });
    const fromDatabase = await dashboardStats(request.params.guildId);
    if (fromDatabase) return response.json(fromDatabase);
    const tickets = Object.values(store.tickets).filter((ticket) => ticket.guildId === request.params.guildId);
    const handled = tickets.filter((ticket) => ['closed', 'deleted'].includes(ticket.status));
    const counts = new Map();
    handled.forEach((ticket) => { if (ticket.claimedBy) counts.set(ticket.claimedBy, (counts.get(ticket.claimedBy) || 0) + 1); });
    return response.json({ openTickets: tickets.filter((ticket) => ticket.status === 'open').length, totalHandled: handled.length, leaderboard: [...counts.entries()].map(([_id, handledCount]) => ({ _id, handled: handledCount })).sort((a, b) => b.handled - a.handled), recentTickets: tickets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 12) });
  });
  app.get('/api/settings/:guildId', requireAuth, async (request, response) => {
    if (!allowedGuild(request.dashboardUser, request.params.guildId)) return response.status(403).json({ error: 'You need Manage Server permissions.' });
    const saved = await getGuildSettings(request.params.guildId);
    return response.json(saved?.dashboard || guildConfig(request.params.guildId));
  });
  app.put('/api/settings/:guildId', requireAuth, async (request, response) => {
    if (!allowedGuild(request.dashboardUser, request.params.guildId)) return response.status(403).json({ error: 'You need Manage Server permissions.' });
    const settings = request.body && typeof request.body === 'object' ? request.body : {};
    if (Object.keys(settings).length > 30) return response.status(400).json({ error: 'Too many settings.' });
    return response.json(await saveGuildSettings(request.params.guildId, settings));
  });
  app.get('/api/transcripts/:guildId/:ticketId', requireAuth, async (request, response) => {
    if (!allowedGuild(request.dashboardUser, request.params.guildId)) return response.status(403).send('Forbidden.');
    const record = await findTranscript(request.params.guildId, request.params.ticketId);
    const ticketNumber = record?.number || request.params.ticketId.split(':').at(-1);
    const filename = record?.transcriptPath || fs.readdirSync(transcriptDir).find((name) => name.startsWith(`ticket-${ticketNumber}-`));
    if (!filename) return response.status(404).send('Transcript not found.');
    const filePath = path.isAbsolute(filename) ? filename : path.join(transcriptDir, filename);
    if (!fs.existsSync(filePath)) return response.status(404).send('Transcript is no longer available on this host.');
    return response.sendFile(filePath);
  });

  const webDist = path.join(__dirname, '..', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api|\/auth|\/healthz).*/, (request, response) => response.sendFile(path.join(webDist, 'index.html')));
  }
  return { app, port };
}

module.exports = { createDashboard };
