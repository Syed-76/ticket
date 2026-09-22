const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  ticketId: { type: String, required: true, unique: true },
  number: { type: Number, required: true },
  channelId: String,
  channelName: String,
  ownerId: String,
  ownerUsername: String,
  subject: String,
  description: String,
  reference: String,
  departmentId: String,
  status: { type: String, enum: ['open', 'closed', 'deleted'], index: true },
  claimedBy: String,
  createdAt: { type: Date, default: Date.now, index: true },
  closedAt: Date,
  closeReason: String,
  transcriptPath: String,
}, { timestamps: true });

ticketSchema.index({ guildId: 1, createdAt: -1 });
ticketSchema.index({ guildId: 1, status: 1, claimedBy: 1 });

const eventSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  ticketId: { type: String, index: true },
  event: { type: String, required: true },
  actorId: String,
  details: String,
  createdAt: { type: Date, default: Date.now, index: true },
});

const settingsSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true, index: true },
  dashboard: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

eventSchema.index({ guildId: 1, createdAt: -1 });

const Ticket = mongoose.models.Ticket || mongoose.model('Ticket', ticketSchema);
const TicketEvent = mongoose.models.TicketEvent || mongoose.model('TicketEvent', eventSchema);
const GuildSettings = mongoose.models.GuildSettings || mongoose.model('GuildSettings', settingsSchema);
let connected = false;

async function connectDatabase() {
  if (!process.env.MONGODB_URI) {
    console.warn('MONGODB_URI is not set; dashboard uses local JSON fallback and analytics are not durable across redeploys.');
    return false;
  }
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10 });
    connected = true;
    console.log('MongoDB connected.');
    return true;
  } catch (error) {
    console.error('MongoDB connection failed; continuing with local fallback:', error.message);
    return false;
  }
}

async function recordTicket(ticket) {
  if (!connected) return;
  await Ticket.findOneAndUpdate({ ticketId: ticket.id }, { ...ticket, ticketId: ticket.id }, { upsert: true, setDefaultsOnInsert: true }).catch((error) => console.error('Ticket persistence failed:', error.message));
}

async function recordEvent(guildId, ticket, event, actorId, details) {
  if (!connected) return;
  await TicketEvent.create({ guildId, ticketId: ticket?.id, event, actorId, details }).catch((error) => console.error('Event persistence failed:', error.message));
  if (ticket) await Ticket.findOneAndUpdate({ ticketId: ticket.id }, { ...ticket, ticketId: ticket.id }, { upsert: true }).catch((error) => console.error('Ticket update failed:', error.message));
}

async function dashboardStats(guildId) {
  if (!connected) return null;
  const [openTickets, totalHandled, leaderboard, recentTickets] = await Promise.all([
    Ticket.countDocuments({ guildId, status: 'open' }),
    Ticket.countDocuments({ guildId, status: { $in: ['closed', 'deleted'] } }),
    TicketEvent.aggregate([
      { $match: { guildId, event: { $in: ['TICKET_CLAIMED', 'TICKET_CLOSED'] }, actorId: { $exists: true } } },
      { $group: { _id: '$actorId', handled: { $sum: 1 } } },
      { $sort: { handled: -1 } },
      { $limit: 10 },
    ]),
    Ticket.find({ guildId }).sort({ createdAt: -1 }).limit(12).lean(),
  ]);
  return { openTickets, totalHandled, leaderboard, recentTickets };
}

async function findTranscript(guildId, ticketId) {
  if (!connected) return null;
  return Ticket.findOne({ guildId, ticketId }).lean();
}

async function getGuildSettings(guildId) {
  if (!connected) return null;
  return GuildSettings.findOne({ guildId }).lean();
}

async function saveGuildSettings(guildId, dashboard) {
  if (!connected) return dashboard;
  return GuildSettings.findOneAndUpdate({ guildId }, { guildId, dashboard }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
}

module.exports = { connectDatabase, recordTicket, recordEvent, dashboardStats, findTranscript, getGuildSettings, saveGuildSettings, get connected() { return connected; } };
