-- Meta Ads account connection + secure campaign/ad sync metadata.
-- Run after 013_recruitment_performance_funnel.sql. Safe to rerun.
begin;
create extension if not exists pgcrypto;

create table if not exists public.masar_meta_connections (
 office_id uuid primary key references public.masar_offices(id) on delete cascade,
 meta_user_id text,
 meta_user_name text not null default '',
 access_token_encrypted text not null,
 token_expires_at timestamptz,
 selected_ad_account_id text,
 selected_ad_account_name text,
 currency text,
 timezone_name text,
 status text not null default 'connected' check(status in ('connected','error')),
 connected_by uuid references auth.users(id) on delete set null,
 last_sync_at timestamptz,
 last_sync_error text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists public.masar_meta_ad_accounts (
 office_id uuid not null references public.masar_offices(id) on delete cascade,
 account_id text not null,
 name text not null default '',
 account_status integer,
 currency text,
 timezone_name text,
 business_name text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(office_id,account_id)
);

create table if not exists public.masar_meta_oauth_states (
 state_hash text primary key,
 office_id uuid not null references public.masar_offices(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);

create index if not exists masar_meta_oauth_states_expiry on public.masar_meta_oauth_states(expires_at);
create index if not exists masar_meta_ad_accounts_office on public.masar_meta_ad_accounts(office_id,updated_at desc);

alter table public.masar_campaigns
 add column if not exists meta_status text,
 add column if not exists meta_effective_status text,
 add column if not exists objective text,
 add column if not exists meta_start_time timestamptz,
 add column if not exists meta_stop_time timestamptz,
 add column if not exists meta_synced_at timestamptz;

alter table public.masar_ads
 add column if not exists office_id uuid references public.masar_offices(id) on delete cascade,
 add column if not exists meta_adset_id text,
 add column if not exists meta_adset_name text,
 add column if not exists meta_status text,
 add column if not exists meta_effective_status text,
 add column if not exists meta_synced_at timestamptz;

update public.masar_ads a
set office_id=c.office_id
from public.masar_campaigns c
where a.campaign_id=c.id
  and a.office_id is null
  and c.office_id is not null;

create index if not exists masar_ads_office on public.masar_ads(office_id,last_seen_at desc);
create index if not exists masar_campaigns_meta on public.masar_campaigns(office_id,meta_campaign_id);

do $$ declare t text; begin
 foreach t in array array['masar_meta_connections','masar_meta_ad_accounts','masar_meta_oauth_states'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

commit;
