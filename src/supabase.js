const { createClient } = require('@supabase/supabase-js');

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

async function allocateTicketNumber(guildId, ownerId, departmentId, localStore, saveLocalStore) {
  if (!supabase) {
    const number = localStore.nextTicketNumber++;
    saveLocalStore();
    return number;
  }
  const { data, error } = await supabase.rpc('allocate_ticket_number', { p_guild_id: guildId, p_owner_id: ownerId, p_department_id: departmentId });
  if (error) {
    console.error(`Supabase ticket allocator unavailable; using local fallback: ${error.message}`);
    const number = localStore.nextTicketNumber++;
    saveLocalStore();
    return number;
  }
  return data;
}

async function syncTicketWebhook(ticket, event) {
  const endpoint = process.env.DASHBOARD_WEBHOOK_URL;
  if (!endpoint) return;
  await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DASHBOARD_WEBHOOK_SECRET || ''}` }, body: JSON.stringify({ event, ticket: { id: ticket.id, guildId: ticket.guildId, number: ticket.number, channelId: ticket.channelId, channelName: ticket.channelName, ownerId: ticket.ownerId, status: ticket.status, claimedBy: ticket.claimedBy, departmentId: ticket.departmentId, createdAt: ticket.createdAt, closedAt: ticket.closedAt || null } }) }).then((response) => { if (!response.ok) throw new Error(`Dashboard webhook returned ${response.status}`); }).catch((error) => console.error('Dashboard webhook failed:', error.message));
}

module.exports = { allocateTicketNumber, syncTicketWebhook };
