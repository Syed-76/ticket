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
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

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
};

function loadStore() {
  try {
    return { ...defaultStore, ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) };
  } catch {
    return structuredClone(defaultStore);
  }
}

let store = loadStore();
function saveStore() {
  const tempFile = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(store, null, 2));
  fs.renameSync(tempFile, STORE_FILE);
}

const colors = { brand: 0x2f80ed, success: 0x27ae60, danger: 0xeb5757, neutral: 0x5865f2 };
const prefix = process.env.PREFIX || '!';
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

function guildConfig(guildId) {
  if (!store.guilds[guildId]) {
    store.guilds[guildId] = {
      supportRoleId: process.env.SUPPORT_ROLE_ID || null,
      categoryId: process.env.TICKET_CATEGORY_ID || null,
      transcriptChannelId: process.env.TRANSCRIPT_CHANNEL_ID || null,
      panelChannelId: null,
    };
  }
  return store.guilds[guildId];
}

function isStaff(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function ticketForChannel(channelId) {
  return Object.values(store.tickets).find((ticket) => ticket.channelId === channelId);
}

function ticketEmbed(ticket) {
  return new EmbedBuilder()
    .setColor(ticket.status === 'open' ? colors.brand : colors.danger)
    .setTitle(`${ticket.status === 'open' ? 'Support ticket' : 'Closed ticket'} #${ticket.number}`)
    .setDescription(`**${ticket.subject || 'Support request'}**\n\n${ticket.description || 'No description provided.'}`)
    .addFields(
      { name: 'Owner', value: `<@${ticket.ownerId}>`, inline: true },
      { name: 'Status', value: ticket.status === 'open' ? '🟢 Open' : '🔴 Closed', inline: true },
      { name: 'Claimed by', value: ticket.claimedBy ? `<@${ticket.claimedBy}>` : 'Unclaimed', inline: true },
      ...(ticket.reference ? [{ name: 'Reference', value: ticket.reference, inline: true }] : []),
    )
    .setTimestamp(new Date(ticket.createdAt))
    .setFooter({ text: 'Support Center • Please keep all relevant details in this ticket.' });
}

function ticketButtons(ticket) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:claim').setLabel(ticket.claimedBy ? 'Unclaim' : 'Claim').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ticket.status === 'open' ? 'ticket:close' : 'ticket:reopen').setLabel(ticket.status === 'open' ? 'Close' : 'Reopen').setStyle(ticket.status === 'open' ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ticket:transcript').setLabel('Transcript').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:delete').setLabel('Delete').setStyle(ButtonStyle.Danger),
  )];
}

function panelComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:create').setLabel('Open a support ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary),
  )];
}

function panelEmbed() {
  return new EmbedBuilder()
    .setColor(colors.brand)
    .setTitle('Support Center')
    .setDescription('Need help? Open a private ticket and our support team will get back to you.')
    .addFields(
      { name: 'Before opening a ticket', value: 'Please check that you do not already have an open ticket and gather any order IDs, screenshots, or error messages.' },
      { name: 'What should I write?', value: 'Tell us what happened, when it happened, what you expected, and what you have already tried. More detail helps us resolve your request faster.' },
      { name: 'Privacy', value: 'Only you and the support team will be able to see your ticket.' },
    )
    .setFooter({ text: 'Click the button below to contact support.' });
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
  if (!process.env.CLIENT_ID || !process.env.GUILD_ID) throw new Error('Set CLIENT_ID and GUILD_ID in .env');
  if (!/^\d{17,20}$/.test(process.env.CLIENT_ID) || !/^\d{17,20}$/.test(process.env.GUILD_ID)) {
    throw new Error('CLIENT_ID and GUILD_ID must be Discord Snowflake IDs. Replace the placeholders in .env.');
  }
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  console.log(`Registered ${commands.length} slash commands in guild ${process.env.GUILD_ID}.`);
}

function helpEmbed() {
  return new EmbedBuilder()
    .setColor(colors.brand)
    .setTitle('Ticket Bot Help')
    .setDescription(`Use slash commands with "/" or the prefix command \`${prefix}help\`.`)
    .addFields(
      { name: 'Getting started', value: '`/ticket-setup` configures the category, support role, transcript channel, and panel.' },
      { name: 'Ticket controls', value: '`/ticket-close` `/ticket-reopen` `/ticket-claim` `/ticket-unclaim` `/ticket-transcript` `/ticket-rename` `/ticket-add` `/ticket-remove` `/ticket-delete`' },
      { name: 'Server administration', value: '`/ticket-config` `/ticket-blacklist` `/ticket-unblacklist`' },
    )
    .setFooter({ text: `Prefix: ${prefix} | Slash commands are registered to this server.` });
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
  await interaction.channel.setName(`closed-${ticket.number}`).catch(() => null);
  const response = { embeds: [new EmbedBuilder().setColor(colors.danger).setTitle('Ticket closed').setDescription(`Closed by ${interaction.user}.\nReason: ${ticket.closeReason}`)], components: ticketButtons(ticket) };
  return interaction.deferred ? interaction.editReply(response) : interaction.reply(response);
}

client.once(Events.ClientReady, async (readyClient) => {
  try {
    await registerCommands();
    console.log(`Logged in as ${readyClient.user.tag}`);
  } catch (error) {
    console.error('Could not register slash commands:', error.message);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const content = message.content.trim();
  if (content.toLowerCase() !== `${prefix}help`.toLowerCase()) return;
  await message.reply({ embeds: [helpEmbed()] });
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId === 'ticket:create') {
      const blacklist = store.blacklist[`${interaction.guildId}:${interaction.user.id}`];
      if (blacklist) return interaction.reply({ content: `You are blocked from opening tickets${blacklist.reason ? `: ${blacklist.reason}` : '.'}`, ephemeral: true });
      const existing = Object.values(store.tickets).find((ticket) => ticket.guildId === interaction.guildId && ticket.ownerId === interaction.user.id && ticket.status === 'open');
      if (existing) return interaction.reply({ content: `You already have an open ticket: <#${existing.channelId}>`, ephemeral: true });
      const modal = new ModalBuilder().setCustomId('ticket:create-modal').setTitle('Open a support ticket');
      const subject = new TextInputBuilder().setCustomId('subject').setLabel('What do you need help with?').setPlaceholder('Example: Payment failed on my order').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true);
      const description = new TextInputBuilder().setCustomId('description').setLabel('Explain the issue').setPlaceholder('What happened, when did it happen, and what have you tried?').setStyle(TextInputStyle.Paragraph).setMaxLength(2000).setRequired(true);
      const reference = new TextInputBuilder().setCustomId('reference').setLabel('Order ID or useful reference (optional)').setPlaceholder('Leave blank if this does not apply').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false);
      return interaction.showModal(modal.addComponents(new ActionRowBuilder().addComponents(subject), new ActionRowBuilder().addComponents(description), new ActionRowBuilder().addComponents(reference)));
    }

    if (interaction.isModalSubmit() && interaction.customId === 'ticket:create-modal') {
      await interaction.deferReply({ ephemeral: true });
      const config = guildConfig(interaction.guildId);
      if (!config.categoryId || !config.supportRoleId) return interaction.editReply('Ticket setup is incomplete. Ask an administrator to run `/ticket-setup`.');
      const number = store.nextTicketNumber++;
      const ticketId = `${interaction.guildId}:${number}`;
      const channel = await interaction.guild.channels.create({ name: `ticket-${number}`, type: ChannelType.GuildText, parent: config.categoryId, topic: `ticket:${ticketId}`, permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: config.supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
      ] });
      const ticket = { id: ticketId, guildId: interaction.guildId, channelId: channel.id, ownerId: interaction.user.id, number, subject: interaction.fields.getTextInputValue('subject'), description: interaction.fields.getTextInputValue('description'), reference: interaction.fields.getTextInputValue('reference') || null, status: 'open', claimedBy: null, createdAt: new Date().toISOString() };
      store.tickets[ticketId] = ticket;
      saveStore();
      await channel.send({ content: `<@${interaction.user.id}> <@&${config.supportRoleId}>`, embeds: [ticketEmbed(ticket)], components: ticketButtons(ticket) });
      return interaction.editReply(`Your ticket is ready: ${channel}`);
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
        await interaction.deferReply();
        ticket.claimedBy = ticket.claimedBy === interaction.user.id ? null : interaction.user.id;
        saveStore();
        return interaction.editReply({ content: ticket.claimedBy ? `Ticket claimed by ${interaction.user}.` : 'Ticket is now unclaimed.', components: ticketButtons(ticket) });
      }
      if (interaction.customId === 'ticket:transcript') {
        if (!isStaff(interaction)) return interaction.reply({ content: 'Only support staff can generate transcripts.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const filePath = await sendTranscript(interaction.channel, ticket, interaction);
        return interaction.editReply({ content: 'Transcript generated successfully.', files: [new AttachmentBuilder(filePath)] });
      }
      if (interaction.customId === 'ticket:delete') {
        if (!isStaff(interaction) && interaction.user.id !== ticket.ownerId) return interaction.reply({ content: 'Only the ticket owner or staff can delete this ticket.', ephemeral: true });
        await interaction.deferReply();
        delete store.tickets[ticket.id];
        saveStore();
        await interaction.editReply('Deleting this ticket...');
        return interaction.channel.delete();
      }
      if (interaction.customId === 'ticket:reopen') {
        if (!isStaff(interaction)) return interaction.reply({ content: 'Only support staff can reopen tickets.', ephemeral: true });
        await interaction.deferReply();
        ticket.status = 'open';
        ticket.closedAt = null;
        saveStore();
        await interaction.channel.permissionOverwrites.edit(ticket.ownerId, { SendMessages: true, ViewChannel: true });
        await interaction.channel.setName(`ticket-${ticket.number}`).catch(() => null);
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(colors.success).setTitle('Ticket reopened').setDescription(`Reopened by ${interaction.user}.`)], components: ticketButtons(ticket) });
      }
    }

    if (!interaction.isChatInputCommand()) return;
    const name = interaction.commandName;
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
      return interaction.reply({ content: `Category: ${config.categoryId ? `<#${config.categoryId}>` : 'not set'}\nSupport role: ${config.supportRoleId ? `<@&${config.supportRoleId}>` : 'not set'}\nTranscript channel: ${config.transcriptChannelId ? `<#${config.transcriptChannelId}>` : 'not set'}\nPanel channel: ${config.panelChannelId ? `<#${config.panelChannelId}>` : 'not set'}`, ephemeral: true });
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
      await interaction.channel.setName(`ticket-${ticket.number}`).catch(() => null);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(colors.success).setTitle('Ticket reopened').setDescription(`Reopened by ${interaction.user}.`)], components: ticketButtons(ticket) });
    }
    if (name === 'ticket-claim' || name === 'ticket-unclaim') {
      if (!isStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      ticket.claimedBy = name === 'ticket-unclaim' ? null : (ticket.claimedBy === interaction.user.id ? null : interaction.user.id); saveStore();
      return interaction.reply({ content: ticket.claimedBy ? `Claimed by ${interaction.user}.` : 'Ticket is now unclaimed.' });
    }
    if (name === 'ticket-transcript') {
      if (!isStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true }); const filePath = await sendTranscript(interaction.channel, ticket, interaction); return interaction.editReply({ content: 'Transcript generated.', files: [new AttachmentBuilder(filePath)] });
    }
    if (name === 'ticket-rename') { if (!isStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true }); await interaction.channel.setName(interaction.options.getString('name').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90)); return interaction.reply('Ticket renamed.'); }
    if (name === 'ticket-add' || name === 'ticket-remove') { if (!isStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true }); const user = interaction.options.getUser('user'); await interaction.channel.permissionOverwrites.edit(user.id, name === 'ticket-add' ? { ViewChannel: true, SendMessages: true, ReadMessageHistory: true } : { ViewChannel: false }); return interaction.reply(`${user} ${name === 'ticket-add' ? 'added to' : 'removed from'} this ticket.`); }
    if (name === 'ticket-delete') { if (!isStaff(interaction) && interaction.user.id !== ticket.ownerId) return interaction.reply({ content: 'Only the ticket owner or staff can delete this ticket.', ephemeral: true }); await interaction.reply('Deleting this ticket...'); delete store.tickets[ticket.id]; saveStore(); return interaction.channel.delete(); }
  } catch (error) {
    console.error(error);
    const response = { content: 'Something went wrong while handling that request.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(response).catch(() => null); else await interaction.reply(response).catch(() => null);
  }
});

client.login(process.env.DISCORD_TOKEN);
