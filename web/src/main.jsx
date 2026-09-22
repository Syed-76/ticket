import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const api = async (url, options) => {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Request failed');
  return response.json();
};

function Login() {
  return <main className="login-shell"><div className="login-panel"><div className="brand-mark">TC</div><p className="eyebrow">TICKET COMMAND</p><h1>Support operations,<br /><em>under control.</em></h1><p className="muted">A focused command center for your Discord support team. Review live queues, measure response work, and inspect transcripts securely.</p><a className="primary-button" href="/auth/login">Continue with Discord <span>↗</span></a><p className="fine-print">Administrator access only · Your Discord permissions are checked on every request.</p></div><div className="login-art"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="signal-card"><span className="live-dot" /> LIVE OPERATIONS <strong>24 / 7</strong></div><div className="art-copy"><span>01</span><p>Everything your<br />support team needs.</p></div></div></main>;
}

function App() {
  const [session, setSession] = useState(null);
  const [guild, setGuild] = useState('');
  const [stats, setStats] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { api('/api/session').then((data) => setSession(data.user)).catch(() => setSession(null)); }, []);
  useEffect(() => {
    if (!guild) return;
    setError('');
    api(`/api/stats/${guild}`).then(setStats).catch((reason) => setError(reason.message));
  }, [guild]);

  if (session === null) return <Login />;
  if (!session) return <Login />;
  const manageableGuilds = session.guilds.filter((item) => item.owner || (Number(item.permissions) & 0x20) === 0x20);
  const current = manageableGuilds.find((item) => item.id === guild);
  const refresh = () => guild && api(`/api/stats/${guild}`).then(setStats).catch((reason) => setError(reason.message));

  return <div className="app-shell"><aside className="sidebar"><div className="logo"><span>TC</span><b>Ticket<br /><i>Command</i></b></div><div className="side-label">WORKSPACE</div><label className="select-wrap"><span>SERVER</span><select value={guild} onChange={(event) => setGuild(event.target.value)}><option value="">Choose a server</option>{manageableGuilds.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><nav><a className="active" href="#overview"><span>▦</span> Overview</a><a href="#tickets"><span>▤</span> Tickets</a><a href="#team"><span>◉</span> Team performance</a></nav><div className="sidebar-bottom"><div className="user-chip"><div className="avatar">{session.username.slice(0, 1).toUpperCase()}</div><div><strong>{session.username}</strong><small>Administrator</small></div></div><button className="logout" onClick={() => api('/auth/logout', { method: 'POST' }).then(() => window.location.reload())}>Sign out</button></div></aside><main className="main-content"><header><div><p className="eyebrow">{current ? current.name.toUpperCase() : 'WELCOME BACK'}</p><h2>Good to see you.</h2></div><div className="header-actions"><span className="status-pill"><span className="live-dot" /> Bot online</span><button className="icon-button" title="Refresh analytics" onClick={refresh}>↻</button></div></header>{!guild ? <section className="empty-state"><div className="empty-icon">⌁</div><h3>Select a server to begin</h3><p>Choose a server from the workspace switcher to see its support operations.</p></section> : error ? <section className="error-state">{error}</section> : stats && <><section className="metric-grid"><Metric label="Open tickets" value={stats.openTickets} detail="Currently in queue" accent="blue" /><Metric label="Handled tickets" value={stats.totalHandled} detail="All-time resolution count" accent="green" /><Metric label="Team members" value={stats.leaderboard.length} detail="With recorded activity" accent="gold" /></section><section className="content-grid"><div className="surface"><div className="surface-heading"><div><p className="eyebrow">QUEUE ACTIVITY</p><h3>Recent tickets</h3></div><button className="text-button" onClick={refresh}>Refresh ↻</button></div><div className="ticket-list">{stats.recentTickets.length ? stats.recentTickets.map((ticket) => <button className="ticket-row" key={ticket.ticketId || ticket.id} onClick={() => setSelected(ticket)}><span className={`ticket-status ${ticket.status}`} /><span className="ticket-number">#{ticket.number}</span><span className="ticket-subject">{ticket.subject || 'Untitled request'}<small>{ticket.departmentId?.replaceAll('_', ' ') || 'General support'}</small></span><span className="ticket-state">{ticket.status}</span><span className="row-arrow">›</span></button>) : <p className="empty-copy">No tickets have been recorded yet.</p>}</div></div><div className="surface leaderboard"><div className="surface-heading"><div><p className="eyebrow">TEAM PERFORMANCE</p><h3>Top handlers</h3></div></div>{stats.leaderboard.length ? stats.leaderboard.map((member, index) => <div className="leader-row" key={member._id}><span className="rank">0{index + 1}</span><div className="mini-avatar">{member._id.slice(-2)}</div><span className="leader-id">{member._id}</span><strong>{member.handled}</strong></div>) : <p className="empty-copy">Activity will appear here after tickets are handled.</p>}</div></section></>}</main>{selected && <div className="modal-backdrop" onClick={() => setSelected(null)}><article className="modal" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setSelected(null)}>×</button><p className="eyebrow">TICKET #{selected.number}</p><h3>{selected.subject || 'Untitled request'}</h3><div className="transcript-frame">{selected.id || selected.ticketId ? <iframe title={`Transcript ${selected.number}`} src={`/api/transcripts/${guild}/${selected.id || selected.ticketId}`} /> : <p>No transcript available.</p>}</div></article></div>}</div>;
}

function Metric({ label, value, detail, accent }) { return <div className={`metric ${accent}`}><div className="metric-top"><span>{label}</span><i>↗</i></div><strong>{value}</strong><small>{detail}</small></div>; }

createRoot(document.getElementById('root')).render(<App />);
