create table if not exists public.manus_workspace_state (
  id text primary key check (id = 'primary'),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.manus_workspace_state enable row level security;
revoke all on public.manus_workspace_state from anon, authenticated;
