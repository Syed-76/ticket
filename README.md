# Discord Ticket Bot

A production-minded Discord ticket bot built with Node.js and discord.js v14.

## Included features

- Button-based ticket panel with modal intake form
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
- Automatic ticket numbering
- Optional order ID or reference field on every ticket

## Setup

1. Install Node.js 20 or newer.
2. Create a Discord application and bot in the Discord Developer Portal.
3. Enable the `Message Content Intent` for the `!help` prefix command. Enable the `Server Members Intent` if you want member management features.
4. Invite the bot with the `bot` and `applications.commands` scopes and these permissions: Manage Channels, Manage Messages, View Channels, Send Messages, Embed Links, Attach Files, Read Message History, and Use Slash Commands.
5. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `CLIENT_ID`, and `GUILD_ID`.
6. Run `npm install`, then `npm start` for a temporary/local run.
7. Run `/ticket-setup` in your server to configure the category, support role, transcript channel, and post the panel.

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
