# Discord Ticket Bot

A production-minded Discord ticket bot built with Node.js and discord.js v14.

## Included features

- Button-based ticket panel with modal intake form
- Department select menu for General Support, Reports, Partnerships, Applications, and Billing
- Professional support panel with ticket-writing guidance
- Working panel buttons for claim, close, reopen, transcript, and delete
- One open ticket per member
- Persistent ticket state in `data/store.json`
- Configurable support role, category, and transcript channel
- Claim and unclaim tickets
- Close, reopen, and permanently delete tickets
- HTML transcripts saved locally and optionally posted to a transcript channel
- Rename tickets
- Add and remove ticket members
- Staff-only controls with owner access to normal ticket actions
- Blacklist and unblacklist members
- Per-user ticket cooldown and daily creation limits
- Structured open, claim, close, reopen, transcript, and delete audit events
- Automatic ticket numbering
- Optional order ID or reference field on every ticket
- React/Tailwind responsive operations dashboard
- Discord OAuth2 administrator login with guild permission checks
- MongoDB Atlas persistence for ticket records, audit events, settings, and analytics
- Authenticated live transcript viewer
- Docker, Render, Railway, health-check, and restart configuration

## Setup

1. Install Node.js 20 or newer.
2. Create a Discord application and bot in the Discord Developer Portal.
3. Enable the `Message Content Intent` for the `!help` prefix command. Enable the `Server Members Intent` if you want member management features.
4. Invite the bot with the `bot` and `applications.commands` scopes and these permissions: Manage Channels, Manage Messages, View Channels, Send Messages, Embed Links, Attach Files, Read Message History, and Use Slash Commands.
5. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `CLIENT_ID`, and `GUILD_ID`.
6. Run `npm install`, then `npm start` for a temporary/local run.
7. Run `/ticket-setup` in your server to configure the category, support role, transcript channel, and post the panel.

For multi-department routing, set the optional `TICKET_*_CATEGORY_ID` and `TICKET_*_ROLE_ID` values in `.env` before starting the bot when departments need separate categories or staff roles. Otherwise, every department falls back to the category and role supplied to `/ticket-setup`.

## Keep the bot online

Running `npm start` keeps the bot online only while that terminal process is alive. For automatic restarts after crashes or disconnections, install PM2 and start the managed process:

```powershell
npm install --global pm2
npm run start:managed
pm2 save
```

Check the bot with `npm run logs:managed` and stop it with `npm run stop:managed`.

The prefix help command is `!help` by default. Change `PREFIX` in `.env` to use a different prefix.

## Commands

- `/ticket-setup category support_role transcript_channel panel_channel`
- `/ticket-config`
- `/ticket-blacklist user reason`
- `/ticket-unblacklist user`
- `/ticket-close reason`
- `/ticket-reopen`
- `/ticket-claim`
- `/ticket-unclaim`
- `/ticket-transcript`
- `/ticket-rename name`
- `/ticket-add user`
- `/ticket-remove user`
- `/ticket-delete`

The bot stores configuration and ticket metadata in `data/store.json`. Transcript HTML files are written to `transcripts/`.

## Enterprise deployment

### Architecture

```mermaid
flowchart LR
	U[Administrator] -->|Discord OAuth2| W[React dashboard]
	W --> A[Express API]
	A --> M[(MongoDB Atlas)]
	D[Discord gateway] --> B[Discord worker]
	B --> M
	B --> T[Transcript HTML]
	B --> L[Secret Discord log channel]
	A --> T
```

The Docker image runs the dashboard and Discord worker in one service. Render or Railway supplies the public HTTPS URL; `PUBLIC_URL` must match that URL exactly. Vercel is suitable for a separate static dashboard, but this repository's OAuth callback and Discord worker should run on a persistent Node/Docker service.

### Exact environment variables

Copy `.env.example` to `.env` locally or add these values to the hosting provider's environment settings:

```env
DISCORD_TOKEN=bot_token_from_discord_developer_portal
CLIENT_ID=discord_application_id
GUILD_ID=test_server_id_for_fast_slash_command_registration
PREFIX=!
PORT=3000
PUBLIC_URL=https://your-service.onrender.com
DISCORD_CLIENT_ID=discord_application_id
DISCORD_CLIENT_SECRET=oauth2_client_secret
SESSION_SECRET=at-least-32-random-characters
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/ticket_command?retryWrites=true&w=majority
```

Keep `DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET`, and `MONGODB_URI` private. Never commit `.env`.

### Discord Developer Portal

1. Create or open the application and copy the Application ID into `CLIENT_ID` and `DISCORD_CLIENT_ID`.
2. Reset the bot token and place it in `DISCORD_TOKEN`.
3. Under OAuth2, add exactly `https://your-service.onrender.com/auth/callback` as a redirect URI after the service is deployed. Replace the hostname with the real Render/Railway hostname.
4. Invite the bot with `bot` and `applications.commands` scopes. Grant View Channel, Send Messages, Embed Links, Attach Files, Read Message History, Manage Channels, and Manage Messages.
5. Enable Message Content, Server Members, and Presence intents. Presence and member intents are needed for online-staff round-robin assignment.

### MongoDB Atlas

Create a free M0 cluster, create a database user, set Network Access to allow the hosting provider, and copy the generated connection string to `MONGODB_URI`. The application creates indexed `Ticket` and `TicketEvent` collections automatically. MongoDB is required for durable dashboard analytics across container redeployments; the local JSON fallback is intended only for development.

### Render deployment

1. Push this repository to GitHub and choose **New > Web Service** in Render.
2. Select the repository, choose Docker, and deploy using `Dockerfile`.
3. Set the environment variables above. Use the generated `https://...onrender.com` hostname as `PUBLIC_URL`.
4. Set the health check path to `/healthz`.
5. Deploy once, copy the public hostname, add the OAuth redirect URI in Discord, then redeploy.
6. Open `/auth/login`, select the server, and use `/ticket-setup` in Discord to publish the panel.

### Railway deployment

1. Create a project from this GitHub repository and select the Dockerfile deployment.
2. Add the same environment variables, using the Railway-generated HTTPS domain as `PUBLIC_URL`.
3. Expose port `3000`, generate a public domain, then add `https://your-railway-domain/auth/callback` to Discord OAuth2 redirects.
4. Use `/healthz` for the service health check and `/auth/login` for the dashboard.

### Health pinger and free-tier limits

The service exposes `/healthz`, and `npm run healthcheck` pings it using `KEEP_ALIVE_URL` or `PUBLIC_URL`. Configure an external cron provider to call the URL every 10 minutes if your host permits it. A pinger cannot guarantee that a provider's free tier will never sleep, and it cannot replace durable storage or a paid always-on plan. The Discord gateway connection reconnects automatically after transient network loss.

### Local production check

```powershell
npm install
npm run build
npm start
```

Open `http://localhost:3000/healthz`, then use `http://localhost:3000/auth/login` after setting the OAuth redirect URI to the local callback.
