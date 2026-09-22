require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { connectDatabase, recordEvent, recordTicket } = require('./database');
const { createDashboard } = require('./dashboard');
const { allocateTicketNumber, syncTicketWebhook } = require('./supabase');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TRANSCRIPT_DIR = path.join(__dirname, '..', 'transcripts');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });

if (!process.env.DISCORD_TOKEN || process.env.DISCORD_TOKEN === 'your_bot_token') {
  throw new Error('Missing DISCORD_TOKEN. Copy .env.example to .env and add your Discord bot token.');
}

const defaultStore = {
  nextTicketNumber: 1,
  guilds: {},
  tickets: {},
  blacklist: {},
  ticketAttempts: {},
  roundRobin: {},
};

function loadStore() {
  try {
    return { ...defaultStore, ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) };
  } catch {
    return structuredClone(defaultStore);
  }
}

let store = loadStore();
store.ticketAttempts ??= {};
function saveStore() {
  const tempFile = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(store, null, 2));
  fs.renameSync(tempFile, STORE_FILE);
}

const colors = { brand: 0x2f80ed, success: 0x27ae60, danger: 0xeb5757, neutral: 0x5865f2, warning: 0xf2c94c };
const prefix = process.env.PREFIX || '!';
const dailyTicketLimit = Math.max(1, Number(process.env.TICKET_DAILY_LIMIT || 3));
const ticketCooldownMinutes = Math.max(0, Number(process.env.TICKET_COOLDOWN_MINUTES || 30));
const departments = {
  general_support: { label: 'General Support', emoji: '🎫', prefix: 'support', categoryEnv: 'TICKET_SUPPORT_CATEGORY_ID', roleEnv: 'TICKET_SUPPORT_ROLE_ID', fallbackCategory: 'categoryId', fallbackRole: 'supportRoleId' },
  member_report: { label: 'Player/Member Report', emoji: '🛡️', prefix: 'report', categoryEnv: 'TICKET_REPORT_CATEGORY_ID', roleEnv: 'TICKET_REPORT_ROLE_ID', fallbackCategory: 'categoryId', fallbackRole: 'supportRoleId' },
  partnerships: { label: 'Partnerships', emoji: '🤝', prefix: 'partner', categoryEnv: 'TICKET_PARTNERSHIP_CATEGORY_ID', roleEnv: 'TICKET_PARTNERSHIP_ROLE_ID', fallbackCategory: 'categoryId', fallbackRole: 'supportRoleId' },
  staff_application: { label: 'Staff Application', emoji: '📝', prefix: 'application', categoryEnv: 'TICKET_APPLICATION_CATEGORY_ID', roleEnv: 'TICKET_APPLICATION_ROLE_ID', fallbackCategory: 'categoryId', fallbackRole: 'supportRoleId' },
  billing_donations: { label: 'Billing & Donations', emoji: '💳', prefix: 'billing', categoryEnv: 'TICKET_BILLING_CATEGORY_ID', roleEnv: 'TICKET_BILLING_ROLE_ID', fallbackCategory: 'categoryId', fallbackRole: 'supportRoleId' },
};
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const activeTicketActions = new Set();

function guildConfig(guildId) {
  if (!store.guilds[guildId]) {
    store.guilds[guildId] = {
      supportRoleId: process.env.SUPPORT_ROLE_ID || null,
      categoryId: process.env.TICKET_CATEGORY_ID || null,
      transcriptChannelId: process.env.TRANSCRIPT_CHANNEL_ID || null,
      panelChannelId: null,
      prefix: process.env.PREFIX || '!',
      departments: {},
    };
  }
  store.guilds[guildId].departments ??= {};
  return store.guilds[guildId];
}

function guildPrefix(guildId) {
  return guildConfig(guildId).prefix || process.env.PREFIX || '!';
}

function departmentConfig(guildId, departmentId) {
  const config = guildConfig(guildId);
  const department = departments[departmentId];
  if (!department) return null;
  return {
    ...department,
    categoryId: config.departments[departmentId]?.categoryId || process.env[department.categoryEnv] || (department.fallbackCategory ? config[department.fallbackCategory] : null),
    roleId: config.departments[departmentId]?.roleId || process.env[department.roleEnv] || (department.fallbackRole ? config[department.fallbackRole] : null),
  };
}

function isStaff(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const ticket = ticketForChannel(interaction.channelId);
  const roleIds = Object.keys(departments).map((departmentId) => departmentConfig(interaction.guildId, departmentId)?.roleId).filter(Boolean);
  const ticketRoleId = ticket ? departmentConfig(interaction.guildId, ticket.departmentId)?.roleId : null;
  return Boolean(ticketRoleId && roleIds.includes(ticketRoleId)) || roleIds.some((roleId) => interaction.member?.roles?.cache?.has(roleId));
}

function ticketForChannel(channelId) {
  return Object.values(store.tickets).find((ticket) => ticket.channelId === channelId);
}

function ticketType(ticket) {
  return departments[ticket.departmentId] || departments.general_support;
}

function canCreateTicket(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const attempts = (store.ticketAttempts[key] || []).filter((timestamp) => now - timestamp < 24 * 60 * 60 * 1000);
  store.ticketAttempts[key] = attempts;
  if (attempts.length >= dailyTicketLimit) return `You have reached the limit of ${dailyTicketLimit} ticket creations in 24 hours.`;
  const lastAttempt = attempts.at(-1);
  if (ticketCooldownMinutes > 0 && lastAttempt && now - lastAttempt < ticketCooldownMinutes * 60 * 1000) return `Please wait ${Math.ceil((ticketCooldownMinutes * 60 * 1000 - (now - lastAttempt)) / 60000)} minutes before opening another ticket.`;
  return null;
}

function recordTicketAttempt(guildId, userId) {
  const key = `${guildId}:${userId}`;
  store.ticketAttempts[key] = [...(store.ticketAttempts[key] || []), Date.now()];
}

function ticketChannelName(username, ticketNumber) {
  const cleanUsername = String(username || 'user').toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
  const paddedNumber = String(ticketNumber).padStart(4, '0');
  const suffix = `-${paddedNumber}`;
  const availableUsernameLength = Math.max(1, 32 - 'ticket-'.length - suffix.length);
  return `ticket-${cleanUsername.slice(0, availableUsernameLength)}${suffix}`;
}

async function nextOnlineStaff(guild, roleId) {
  if (!roleId) return null;
  const members = await guild.members.fetch().catch(() => null);
  if (!members) return null;
  const available = members.filter((member) => !member.user.bot && member.roles.cache.has(roleId) && member.presence?.status && member.presence.status !== 'offline');
  if (!available.size) return null;
  const ids = [...available.keys()];
  const index = store.roundRobin[guild.id] || 0;
  const selected = ids[index % ids.length];
  store.roundRobin[guild.id] = (index + 1) % ids.length;
  return selected;
}

async function logEvent(guild, event, ticket, details = '', actorId = null) {
  await recordEvent(guild.id, ticket, event, actorId, details);
  await syncTicketWebhook(ticket, event);
  const channelId = guildConfig(guild.id).transcriptChannelId;
  const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
  if (!channel?.isTextBased()) return;
  await channel.send({ embeds: [new EmbedBuilder().setColor(event.includes('CLOSED') || event.includes('DELETED') ? colors.danger : colors.neutral).setTitle(event).addFields(
    { name: 'Ticket', value: `#${ticket.number}`, inline: true },
    { name: 'Type', value: ticketType(ticket).label, inline: true },
    { name: 'Owner', value: `<@${ticket.ownerId}>`, inline: true },
    ...(details ? [{ name: 'Details', value: details.slice(0, 1024) }] : []),
  ).setTimestamp()] }).catch(() => null);
}

function ticketEmbed(ticket) {
  return new EmbedBuilder()
    .setColor(ticket.status === 'open' ? colors.brand : colors.danger)
    .setTitle('🎫 Ticket Opened')
    .setDescription('A member of the support team will be with you shortly.')
    .addFields(
      { name: 'User', value: `<@${ticket.ownerId}>`, inline: true },
      { name: 'Status', value: ticket.claimedBy ? `Claimed by ${ticket.claimedByName || `<@${ticket.claimedBy}>`}` : 'Awaiting Staff', inline: true },
    );
}

function ticketButtons(ticket) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ticket.status === 'open' ? 'ticket:close' : 'ticket:reopen').setLabel(ticket.status === 'open' ? '🔒 Close Ticket' : '🔓 Reopen Ticket').setStyle(ticket.status === 'open' ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ticket:claim').setLabel(ticket.claimedBy ? '📌 Unclaim Ticket' : '📌 Claim Ticket').setStyle(ticket.claimedBy ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ticket:add-member').setLabel('👤 Add Member').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:logs').setLabel('📊 View Logs').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:delete').setLabel('⛔ Delete Ticket').setStyle(ButtonStyle.Danger),
  )];
}

function panelComponents() {
  return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId('ticket:select')
    .setPlaceholder('Select the department you need')
    .addOptions(Object.entries(departments).map(([value, department]) => ({ label: department.label, value, emoji: department.emoji })) ))];
}

function panelEmbed() {
  return new EmbedBuilder()
    .setColor(colors.brand)
    .setTitle('Support Center')
    .setDescription('Need assistance? Select the department that best matches your request below.\n\nPlease provide complete and accurate information, including relevant usernames, timestamps, screenshots, and reference IDs. Do not open duplicate tickets or ping individual staff members.')
    .addFields(
      { name: '🎫 General Support', value: 'Account, server, gameplay, technical, or general assistance.' },
      { name: '🛡️ Reports • 🤝 Partnerships • 📝 Applications • 💳 Billing', value: 'Choose the matching department from the menu below.' },
      { name: 'Privacy', value: 'Only you and the support team will be able to see your ticket.' },
    )
    .setFooter({ text: 'Support Center • One active ticket per member' });
}

function setupCommand() {
  return new SlashCommandBuilder()
    .setName('ticket-setup')
    .setDescription('Configure the ticket system and post its panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName('category').setDescription('Category where tickets are created').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .addRoleOption((o) => o.setName('support_role').setDescription('Role that can see and manage tickets').setRequired(true))
    .addChannelOption((o) => o.setName('panel_channel').setDescription('Channel where the panel should be posted').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addChannelOption((o) => o.setName('transcript_channel').setDescription('Channel for transcript files').addChannelTypes(ChannelType.GuildText).setRequired(false));
}

const commands = [
  setupCommand(),
  new SlashCommandBuilder().setName('prefix').setDescription('Change the bot prefix for this server.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addStringOption((o) => o.setName('symbol').setDescription('One to three characters, for example $').setMinLength(1).setMaxLength(3).setRequired(true)),
  new SlashCommandBuilder().setName('ticket-config').setDescription('Show the current ticket configuration.'),
  new SlashCommandBuilder().setName('ticket-close').setDescription('Close the current ticket.').addStringOption((o) => o.setName('reason').setDescription('Why it is being closed').setRequired(false)),
  new SlashCommandBuilder().setName('ticket-reopen').setDescription('Reopen the current ticket.'),
  new SlashCommandBuilder().setName('ticket-claim').setDescription('Claim or unclaim the current ticket.'),
  new SlashCommandBuilder().setName('ticket-unclaim').setDescription('Remove your claim from the current ticket.'),
  new SlashCommandBuilder().setName('ticket-transcript').setDescription('Generate a transcript for the current ticket.'),
  new SlashCommandBuilder().setName('ticket-rename').setDescription('Rename the current ticket.').addStringOption((o) => o.setName('name').setDescription('New channel name').setRequired(true)),
  new SlashCommandBuilder().setName('ticket-add').setDescription('Add a member to the current ticket.').addUserOption((o) => o.setName('user').setDescription('Member to add').setRequired(true)),
  new SlashCommandBuilder().setName('ticket-remove').setDescription('Remove a member from the current ticket.').addUserOption((o) => o.setName('user').setDescription('Member to remove').setRequired(true)),
  new SlashCommandBuilder().setName('ticket-delete').setDescription('Permanently delete the current ticket.'),
  new SlashCommandBuilder().setName('ticket-blacklist').setDescription('Blacklist a member from opening tickets.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addUserOption((o) => o.setName('user').setDescription('Member to blacklist').setRequired(true)).addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false)),
  new SlashCommandBuilder().setName('ticket-unblacklist').setDescription('Remove a member from the ticket blacklist.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addUserOption((o) => o.setName('user').setDescription('Member to unblacklist').setRequired(true)),
].map((command) => command.toJSON());

async function registerCommands() {
  if (!process.env.CLIENT_ID || !/^\d{17,20}$/.test(process.env.CLIENT_ID)) throw new Error('CLIENT_ID must be a valid Discord application ID.');
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const guildId = /^\d{17,20}$/.test(process.env.GUILD_ID || '') ? process.env.GUILD_ID : null;
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), { body: commands });
    console.log(`Registered ${commands.length} slash commands in test guild ${guildId}.`);
    return;
  }
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log(`Registered ${commands.length} global slash commands for ${client.guilds.cache.size} connected server(s).`);
}

function helpEmbed(guildId) {
  const currentPrefix = guildId ? guildPrefix(guildId) : prefix;
  return new EmbedBuilder()
    .setColor(colors.brand)
    .setTitle('Ticket Bot Help')
    .setDescription(`Use slash commands with "/" or the prefix command \`${currentPrefix}help\`.`)
    .addFields(
      { name: 'Getting started', value: '`/ticket-setup` configures the category, support role, transcript channel, and panel.' },
      { name: 'Ticket controls', value: '`/ticket-close` `/ticket-reopen` `/ticket-claim` `/ticket-unclaim` `/ticket-transcript` `/ticket-rename` `/ticket-add` `/ticket-remove` `/ticket-delete`' },
      { name: 'Server administration', value: '`/ticket-config` `/ticket-blacklist` `/ticket-unblacklist`' },
    )
    .setFooter({ text: `Prefix: ${currentPrefix} | Slash commands are registered to this server.` });
}

async function sendTranscript(channel, ticket, interaction) {
  const messages = [];
  let before;
  do {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    messages.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  } while (messages.length < 2000);
  messages.reverse();
  const escape = (value) => String(value ?? '').replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
  const body = messages.map((message) => `<article><b>${escape(message.author.tag)}</b> <time>${escape(message.createdAt.toISOString())}</time><p>${escape(message.content)}</p></article>`).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>Ticket #${ticket.number}</title><style>body{font:15px system-ui;max-width:900px;margin:40px auto;background:#f4f5f7;color:#202124}article{background:white;border:1px solid #ddd;padding:12px 16px;margin:8px 0;border-radius:8px}time{color:#6b7280;font-size:12px}p{white-space:pre-wrap}</style><h1>Ticket #${ticket.number}</h1>${body}`;
  const filePath = path.join(TRANSCRIPT_DIR, `ticket-${ticket.number}-${Date.now()}.html`);
  fs.writeFileSync(filePath, html);
  const attachment = new AttachmentBuilder(filePath);
  const config = guildConfig(interaction.guildId);
  const target = config.transcriptChannelId ? await interaction.guild.channels.fetch(config.transcriptChannelId).catch(() => null) : null;
  if (target?.isTextBased()) await target.send({ content: `Transcript for ticket #${ticket.number} owned by <@${ticket.ownerId}>`, files: [attachment] });
  return filePath;
}

async function requireTicket(interaction) {
  const ticket = ticketForChannel(interaction.channelId);
  if (!ticket) {
    await interaction.reply({ content: 'This command can only be used inside a ticket channel.', ephemeral: true });
    return null;
  }
  return ticket;
}

async function closeTicket(interaction, ticket, reason) {
  if (!isStaff(interaction) && interaction.user.id !== ticket.ownerId) return interaction.reply({ content: 'Only the ticket owner or staff can close this ticket.', ephemeral: true });
  ticket.status = 'closed';
  ticket.closedAt = new Date().toISOString();
  ticket.closeReason = reason || 'No reason provided';
  saveStore();
  await interaction.channel.permissionOverwrites.edit(ticket.ownerId, { SendMessages: false, ViewChannel: true });
  ticket.transcriptPath = await sendTranscript(interaction.channel, ticket, interaction).catch(() => null);
  await recordTicket(ticket);
  await logEvent(interaction.guild, 'TICKET_CLOSED', ticket, `Closed by ${interaction.user.tag}. Reason: ${ticket.closeReason}`, interaction.user.id);
  const response = { embeds: [new EmbedBuilder().setColor(colors.danger).setTitle('Ticket closed').setDescription(`Closed by ${interaction.user}.\nReason: ${ticket.closeReason}`)], components: ticketButtons(ticket) };
  return interaction.deferred ? interaction.editReply(response) : interaction.reply(response);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag} in public mode with ${client.guilds.cache.size} connected server(s).`);
  try {
    await registerCommands();
  } catch (error) {
    console.error('Could not register slash commands:', error.message);
  }
});

client.on(Events.GuildCreate, (guild) => {
  guildConfig(guild.id);
  saveStore();
  console.log(`Joined ${guild.name} (${guild.id}); guild configuration initialized automatically.`);
});

client.on(Events.Error, (error) => {
  console.error('Discord client error:', error);
});

client.on(Events.Warn, (warning) => {
  console.warn('Discord warning:', warning);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const content = message.content.trim();
  if (content.toLowerCase() !== `${guildPrefix(message.guild.id)}help`.toLowerCase()) return;
  await message.reply({ embeds: [helpEmbed(message.guild.id)] });
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket:select') {
      const blacklist = store.blacklist[`${interaction.guildId}:${interaction.user.id}`];
      if (blacklist) return interaction.reply({ content: `You are blocked from opening tickets${blacklist.reason ? `: ${blacklist.reason}` : '.'}`, ephemeral: true });
      const existing = Object.values(store.tickets).find((ticket) => ticket.guildId === interaction.guildId && ticket.ownerId === interaction.user.id && ticket.status === 'open');
      if (existing) return interaction.reply({ content: `You already have an open ticket: <#${existing.channelId}>`, ephemeral: true });
      const limitMessage = canCreateTicket(interaction.guildId, interaction.user.id);
      if (limitMessage) return interaction.reply({ content: limitMessage, ephemeral: true });
      const departmentId = interaction.values[0];
      const department = departmentConfig(interaction.guildId, departmentId);
      if (!department?.categoryId || !department.roleId) return interaction.reply({ content: 'This department is not configured yet. Please contact an administrator.', ephemeral: true });
      const modal = new ModalBuilder().setCustomId(`ticket:create-modal:${departmentId}`).setTitle(department.label);
      const subject = new TextInputBuilder().setCustomId('subject').setLabel('What is your main concern?').setPlaceholder('Example: Payment failed on my order').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true);
      const description = new TextInputBuilder().setCustomId('description').setLabel('Describe what happened (optional)').setPlaceholder('Include the timeline, impact, and what you already tried.').setStyle(TextInputStyle.Paragraph).setMaxLength(2000).setRequired(false);
      const reference = new TextInputBuilder().setCustomId('reference').setLabel('Provide evidence links (if any)').setPlaceholder('Screenshots, videos, logs, order IDs, or related links').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false);
      return interaction.showModal(modal.addComponents(new ActionRowBuilder().addComponents(subject), new ActionRowBuilder().addComponents(description), new ActionRowBuilder().addComponents(reference)));
    }

    if (interaction.isButton() && interaction.customId === 'ticket:create') {
      const blacklist = store.blacklist[`${interaction.guildId}:${interaction.user.id}`];
      if (blacklist) return interaction.reply({ content: `You are blocked from opening tickets${blacklist.reason ? `: ${blacklist.reason}` : '.'}`, ephemeral: true });
      const existing = Object.values(store.tickets).find((ticket) => ticket.guildId === interaction.guildId && ticket.ownerId === interaction.user.id && ticket.status === 'open');
      if (existing) return interaction.reply({ content: `You already have an open ticket: <#${existing.channelId}>`, ephemeral: true });
      const limitMessage = canCreateTicket(interaction.guildId, interaction.user.id);
      if (limitMessage) return interaction.reply({ content: limitMessage, ephemeral: true });
      const departmentId = 'general_support';
      const department = departmentConfig(interaction.guildId, departmentId);
      if (!department?.categoryId || !department.roleId) return interaction.reply({ content: 'Ticket setup is incomplete. Ask an administrator to configure the support department.', ephemeral: true });
      const modal = new ModalBuilder().setCustomId(`ticket:create-modal:${departmentId}`).setTitle('Open a support ticket');
      const subject = new TextInputBuilder().setCustomId('subject').setLabel('What is your main concern?').setPlaceholder('Example: Payment failed on my order').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true);
      const description = new TextInputBuilder().setCustomId('description').setLabel('Describe what happened (optional)').setPlaceholder('Include the timeline, impact, and what you already tried.').setStyle(TextInputStyle.Paragraph).setMaxLength(2000).setRequired(false);
      const reference = new TextInputBuilder().setCustomId('reference').setLabel('Provide evidence links (if any)').setPlaceholder('Screenshots, videos, logs, order IDs, or related links').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false);
      return interaction.showModal(modal.addComponents(new ActionRowBuilder().addComponents(subject), new ActionRowBuilder().addComponents(description), new ActionRowBuilder().addComponents(reference)));
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket:create-modal:')) {
      await interaction.deferReply({ ephemeral: true });
      const departmentId = interaction.customId.split(':').at(-1);
      const department = departmentConfig(interaction.guildId, departmentId);
      const limitMessage = canCreateTicket(interaction.guildId, interaction.user.id);
      if (limitMessage) return interaction.editReply(limitMessage);
      if (!department?.categoryId || !department.roleId) return interaction.editReply('This department is not configured yet. Ask an administrator to configure it.');
      const number = await allocateTicketNumber(interaction.guildId, interaction.user.id, departmentId, store, saveStore);
      const ticketId = `${interaction.guildId}:${number}`;
      const channelName = ticketChannelName(interaction.user.username, number);
      const channel = await interaction.guild.channels.create({ name: channelName, type: ChannelType.GuildText, parent: department.categoryId, topic: `ticket:${ticketId}:${departmentId}`, permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: department.roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
      ] });
      const ticket = { id: ticketId, guildId: interaction.guildId, channelId: channel.id, ownerId: interaction.user.id, ownerUsername: interaction.user.username, number, channelName, departmentId, subject: interaction.fields.getTextInputValue('subject'), description: interaction.fields.getTextInputValue('description') || 'No description provided.', reference: interaction.fields.getTextInputValue('reference') || null, status: 'open', claimedBy: null, claimedByName: null, createdAt: new Date().toISOString() };
      ticket.claimedBy = await nextOnlineStaff(interaction.guild, department.roleId);
      store.tickets[ticketId] = ticket;
      recordTicketAttempt(interaction.guildId, interaction.user.id);
      saveStore();
      await recordTicket(ticket);
      await channel.send({ content: `<@${interaction.user.id}> <@&${department.roleId}>`, embeds: [ticketEmbed(ticket)], components: ticketButtons(ticket) });
      await logEvent(interaction.guild, 'TICKET_OPENED', ticket, `Created by ${interaction.user.tag}${ticket.claimedBy ? `; assigned to <@${ticket.claimedBy}>` : '; no online staff were available'}`, ticket.claimedBy);
      return interaction.editReply(`Your ticket is ready: ${channel}`);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket:add-member-modal:')) {
      await interaction.deferReply({ ephemeral: true });
      const ticket = ticketForChannel(interaction.channelId);
      if (!ticket || !isStaff(interaction)) return interaction.editReply('This action is no longer available.');
      const userId = interaction.fields.getTextInputValue('user_id').trim();
      if (!/^\d{17,20}$/.test(userId)) return interaction.editReply('Enter a valid Discord user ID.');
      const member = await interaction.guild.members.fetch(userId).catch(() => null);
      if (!member) return interaction.editReply('That member is not in this server.');
      await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      return interaction.editReply(`${member} was added to this ticket.`);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket:delete-confirm:')) {
      await interaction.deferReply({ ephemeral: true });
      const ticket = ticketForChannel(interaction.channelId);
      if (!ticket || !isStaff(interaction)) return interaction.editReply('Only authorized staff can delete this ticket.');
      if (interaction.fields.getTextInputValue('confirmation').trim().toUpperCase() !== 'DELETE') return interaction.editReply('Deletion cancelled. Type DELETE exactly to confirm.');
      const actionKey = `${ticket.id}:delete`;
      if (activeTicketActions.has(actionKey)) return interaction.editReply('Deletion is already in progress.');
      activeTicketActions.add(actionKey);
      try {
        ticket.transcriptPath = await sendTranscript(interaction.channel, ticket, interaction).catch(() => null);
        ticket.status = 'deleted';
        ticket.closedAt = new Date().toISOString();
        await recordTicket(ticket);
        await logEvent(interaction.guild, 'TICKET_DELETED', ticket, `Deleted by ${interaction.user.tag}`, interaction.user.id);
        await interaction.editReply('Ticket deleted.');
        await interaction.channel.delete();
      } finally {
        activeTicketActions.delete(actionKey);
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('ticket:')) {
      const ticket = ticketForChannel(interaction.channelId);
      if (!ticket) return interaction.reply({ content: 'This button is no longer connected to an active ticket.', ephemeral: true });
      if (interaction.customId === 'ticket:close') {
        if (!isStaff(interaction) && interaction.user.id !== ticket.ownerId) return interaction.reply({ content: 'Only the ticket owner or staff can close this ticket.', ephemeral: true });
        await interaction.deferReply();
        return closeTicket(interaction, ticket, 'Closed from the ticket panel');
      }
      if (interaction.customId === 'ticket:claim') {
        if (!isStaff(interaction)) return interaction.reply({ content: 'Only support staff can claim tickets.', ephemeral: true });
        const actionKey = `${ticket.id}:claim`;
        if (activeTicketActions.has(actionKey)) return interaction.deferUpdate();
        if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) return interaction.deferUpdate();
        activeTicketActions.add(actionKey);
        ticket.claimedBy = ticket.claimedBy === interaction.user.id ? null : interaction.user.id;
        ticket.claimedByName = ticket.claimedBy ? interaction.user.tag : null;
        saveStore();
        try {
          await interaction.update({ embeds: [ticketEmbed(ticket)], components: ticketButtons(ticket) });
          await recordTicket(ticket);
          await logEvent(interaction.guild, ticket.claimedBy ? 'TICKET_CLAIMED' : 'TICKET_UNCLAIMED', ticket, ticket.claimedBy ? `Claimed by ${interaction.user.tag}` : `Unclaimed by ${interaction.user.tag}`, interaction.user.id);
        } finally {
          activeTicketActions.delete(actionKey);
        }
        return;
      }
      if (interaction.customId === 'ticket:add-member') {
        if (!isStaff(interaction)) return interaction.reply({ content: 'Only support staff can add members.', ephemeral: true });
        const modal = new ModalBuilder().setCustomId(`ticket:add-member-modal:${ticket.id}`).setTitle('Add a ticket member');
        const userId = new TextInputBuilder().setCustomId('user_id').setLabel('Discord user ID').setPlaceholder('Paste the member ID').setStyle(TextInputStyle.Short).setMinLength(17).setMaxLength(20).setRequired(true);
        return interaction.showModal(modal.addComponents(new ActionRowBuilder().addComponents(userId)));
      }
      if (interaction.customId === 'ticket:logs') {
        if (!isStaff(interaction)) return interaction.reply({ content: 'Only support staff can view ticket logs.', ephemeral: true });
        const messages = await interaction.channel.messages.fetch({ limit: 50 });
        const logLines = [...messages.values()].filter((message) => message.author.id === client.user.id).slice(-10).map((message) => `• ${message.createdAt.toISOString()} — ${message.embeds[0]?.title || 'Ticket event'}`);
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(colors.neutral).setTitle(`Activity log • Ticket #${ticket.number}`).setDescription(logLines.join('\n') || 'No bot activity has been recorded in this channel.')], ephemeral: true });
      }
      if (interaction.customId === 'ticket:transcript') {
        if (!isStaff(interaction)) return interaction.reply({ content: 'Only support staff can generate transcripts.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const filePath = await sendTranscript(interaction.channel, ticket, interaction);
        await logEvent(interaction.guild, 'TICKET_TRANSCRIPT_CREATED', ticket, `Generated by ${interaction.user.tag}`);
        return interaction.editReply({ content: 'Transcript generated successfully.', files: [new AttachmentBuilder(filePath)] });
      }
      if (interaction.customId === 'ticket:delete') {
        if (!isStaff(interaction)) return interaction.reply({ content: 'Only authorized staff can delete this ticket.', ephemeral: true });
        const modal = new ModalBuilder().setCustomId(`ticket:delete-confirm:${ticket.id}`).setTitle('Confirm ticket deletion');
        const confirmation = new TextInputBuilder().setCustomId('confirmation').setLabel('Type DELETE to confirm').setPlaceholder('DELETE').setStyle(TextInputStyle.Short).setMaxLength(6).setRequired(true);
        return interaction.showModal(modal.addComponents(new ActionRowBuilder().addComponents(confirmation)));
      }
      if (interaction.customId === 'ticket:reopen') {
        if (!isStaff(interaction)) return interaction.reply({ content: 'Only support staff can reopen tickets.', ephemeral: true });
        await interaction.deferReply();
        ticket.status = 'open';
        ticket.closedAt = null;
        saveStore();
        await recordTicket(ticket);
        await interaction.channel.permissionOverwrites.edit(ticket.ownerId, { SendMessages: true, ViewChannel: true });
        await logEvent(interaction.guild, 'TICKET_REOPENED', ticket, `Reopened by ${interaction.user.tag}`);
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(colors.success).setTitle('Ticket reopened').setDescription(`Reopened by ${interaction.user}.`)], components: ticketButtons(ticket) });
      }
    }

    if (!interaction.isChatInputCommand()) return;
    const name = interaction.commandName;
    if (name === 'prefix') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: 'Only members with Manage Server can change the prefix.', ephemeral: true });
      const newPrefix = interaction.options.getString('symbol').trim();
      if (!/^[^\s`@#<>]{1,3}$/.test(newPrefix)) return interaction.reply({ content: 'Choose one to three non-space characters, such as `$`, `?`, or `!!`.', ephemeral: true });
      const config = guildConfig(interaction.guildId);
      config.prefix = newPrefix;
      saveStore();
      return interaction.reply({ content: `The server prefix is now \`${newPrefix}\`. Use \`${newPrefix}help\` for help.`, ephemeral: true });
    }
    if (name === 'ticket-setup') {
      const config = guildConfig(interaction.guildId);
      config.categoryId = interaction.options.getChannel('category').id;
      config.supportRoleId = interaction.options.getRole('support_role').id;
      config.transcriptChannelId = interaction.options.getChannel('transcript_channel')?.id || null;
      config.panelChannelId = interaction.options.getChannel('panel_channel').id;
      saveStore();
      await interaction.options.getChannel('panel_channel').send({ embeds: [panelEmbed()], components: panelComponents() });
      return interaction.reply({ content: 'Ticket system configured and panel posted.', ephemeral: true });
    }
    if (name === 'ticket-config') {
      const config = guildConfig(interaction.guildId);
      const departmentStatus = Object.entries(departments).map(([id, department]) => { const resolved = departmentConfig(interaction.guildId, id); return `${department.emoji} ${department.label}: ${resolved?.categoryId ? `<#${resolved.categoryId}>` : 'category not set'} / ${resolved?.roleId ? `<@&${resolved.roleId}>` : 'role not set'}`; }).join('\n');
      return interaction.reply({ content: `Category: ${config.categoryId ? `<#${config.categoryId}>` : 'not set'}\nSupport role: ${config.supportRoleId ? `<@&${config.supportRoleId}>` : 'not set'}\nTranscript channel: ${config.transcriptChannelId ? `<#${config.transcriptChannelId}>` : 'not set'}\nPanel channel: ${config.panelChannelId ? `<#${config.panelChannelId}>` : 'not set'}\n\nDepartments:\n${departmentStatus}`, ephemeral: true });
    }
    if (name === 'ticket-blacklist' || name === 'ticket-unblacklist') {
      if (!isStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const user = interaction.options.getUser('user');
      const key = `${interaction.guildId}:${user.id}`;
      if (name === 'ticket-blacklist') { store.blacklist[key] = { reason: interaction.options.getString('reason') || '', createdBy: interaction.user.id }; saveStore(); return interaction.reply({ content: `${user} is now blocked from opening tickets.` }); }
      delete store.blacklist[key]; saveStore(); return interaction.reply({ content: `${user} can open tickets again.` });
    }

    const ticket = await requireTicket(interaction);
    if (!ticket) return;
    if (name === 'ticket-close') return closeTicket(interaction, ticket, interaction.options.getString('reason'));
    if (name === 'ticket-reopen') {
      if (!isStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      ticket.status = 'open'; ticket.closedAt = null; saveStore();
      await interaction.channel.permissionOverwrites.edit(ticket.ownerId, { SendMessages: true, ViewChannel: true });
      await logEvent(interaction.guild, 'TICKET_REOPENED', ticket, `Reopened by ${interaction.user.tag}`);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(colors.success).setTitle('Ticket reopened').setDescription(`Reopened by ${interaction.user}.`)], components: ticketButtons(ticket) });
    }
    if (name === 'ticket-claim' || name === 'ticket-unclaim') {
      if (!isStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      ticket.claimedBy = name === 'ticket-unclaim' ? null : (ticket.claimedBy === interaction.user.id ? null : interaction.user.id); saveStore();
      await logEvent(interaction.guild, ticket.claimedBy ? 'TICKET_CLAIMED' : 'TICKET_UNCLAIMED', ticket, ticket.claimedBy ? `Claimed by ${interaction.user.tag}` : `Unclaimed by ${interaction.user.tag}`);
      return interaction.reply({ content: ticket.claimedBy ? `Claimed by ${interaction.user}.` : 'Ticket is now unclaimed.' });
    }
    if (name === 'ticket-transcript') {
      if (!isStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true }); const filePath = await sendTranscript(interaction.channel, ticket, interaction); await logEvent(interaction.guild, 'TICKET_TRANSCRIPT_CREATED', ticket, `Generated by ${interaction.user.tag}`); return interaction.editReply({ content: 'Transcript generated.', files: [new AttachmentBuilder(filePath)] });
    }
    if (name === 'ticket-rename') { if (!isStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true }); const newName = interaction.options.getString('name'); ticket.channelName = ticketChannelName(newName, ticket.number); await interaction.channel.setName(ticket.channelName); await recordTicket(ticket); return interaction.reply(`Ticket renamed to \`${ticket.channelName}\`.`); }
    if (name === 'ticket-add' || name === 'ticket-remove') { if (!isStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true }); const user = interaction.options.getUser('user'); await interaction.channel.permissionOverwrites.edit(user.id, name === 'ticket-add' ? { ViewChannel: true, SendMessages: true, ReadMessageHistory: true } : { ViewChannel: false }); return interaction.reply(`${user} ${name === 'ticket-add' ? 'added to' : 'removed from'} this ticket.`); }
    if (name === 'ticket-delete') { if (!isStaff(interaction) && interaction.user.id !== ticket.ownerId) return interaction.reply({ content: 'Only the ticket owner or staff can delete this ticket.', ephemeral: true }); await interaction.deferReply(); await sendTranscript(interaction.channel, ticket, interaction).catch(() => null); delete store.tickets[ticket.id]; saveStore(); await logEvent(interaction.guild, 'TICKET_DELETED', ticket, `Deleted by ${interaction.user.tag}`); await interaction.editReply('Deleting this ticket...'); return interaction.channel.delete(); }
  } catch (error) {
    const errorId = `ERR-${Date.now().toString(36).toUpperCase()}`;
    console.error(`[${errorId}] Interaction ${interaction.type} ${interaction.customId || interaction.commandName || 'unknown'} failed:`, error);
    if (error?.code === 10062 || error?.code === 40060) return;
    const response = { content: `Something went wrong while handling that request. Please contact staff with error ID \`${errorId}\`.`, ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(response).catch(() => null); else await interaction.reply(response).catch(() => null);
  }
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

async function start() {
  const dashboard = createDashboard({ store, guildConfig, transcriptDir: TRANSCRIPT_DIR });
  dashboard.app.listen(dashboard.port, '0.0.0.0', () => {
    console.log(`Dashboard listening on port ${dashboard.port}.`);
  });
  await connectDatabase();
  await client.login(process.env.DISCORD_TOKEN);
}

start().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exitCode = 1;
});
