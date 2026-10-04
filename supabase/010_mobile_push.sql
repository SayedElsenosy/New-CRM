begin;
create table if not exists public.masar_push_tokens (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 token text not null unique,
 platform text not null default 'unknown' check(platform in ('ios','android','unknown')),
 device_name text not null default '',
 active boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 last_seen_at timestamptz not null default now()
);
create index if not exists masar_push_tokens_user on public.masar_push_tokens(user_id,active);
alter table public.masar_push_tokens enable row level security;
revoke all on public.masar_push_tokens from anon, authenticated;
grant all on public.masar_push_tokens to service_role;
commit;
