create table if not exists public.ticket_sequences (
  sequence_id boolean primary key default true check (sequence_id = true),
  next_number bigint not null default 1 check (next_number > 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  ticket_number bigint not null,
  owner_id text not null,
  department_id text not null,
  channel_id text not null,
  channel_name text not null,
  subject text not null,
  description text not null,
  evidence_links text,
  status text not null default 'open' check (status in ('open', 'closed', 'deleted')),
  claimed_by text,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (ticket_number),
  unique (guild_id, channel_id)
);

create index if not exists tickets_guild_status_idx on public.tickets (guild_id, status);
create index if not exists tickets_guild_created_idx on public.tickets (guild_id, created_at desc);

alter table public.ticket_sequences enable row level security;
alter table public.tickets enable row level security;

create or replace function public.allocate_ticket_number(p_guild_id text, p_owner_id text, p_department_id text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  allocated bigint;
begin
  insert into public.ticket_sequences (sequence_id) values (true)
  on conflict (sequence_id) do nothing;

  update public.ticket_sequences
  set next_number = next_number + 1, updated_at = now()
  where sequence_id = true
  returning next_number - 1 into allocated;

  return allocated;
end;
$$;

revoke all on function public.allocate_ticket_number(text, text, text) from public;
grant execute on function public.allocate_ticket_number(text, text, text) to service_role;
