-- Click-to-WhatsApp ad attribution + campaign reporting.
-- Run once in Supabase SQL Editor on an existing installation. Safe to rerun.
begin;
create extension if not exists pgcrypto;

create table if not exists public.masar_campaigns (
 id uuid primary key default gen_random_uuid(),
 name text not null,
 meta_campaign_id text,
 active boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists public.masar_ads (
 ad_id text primary key,
 campaign_id uuid references public.masar_campaigns(id) on delete set null,
 name text not null default '',
 headline text not null default '',
 source_url text,
 source_app text,
 source_type text not null default 'ad',
 spend numeric(14,2) not null default 0 check(spend>=0),
 first_seen_at timestamptz,
 last_seen_at timestamptz,
 updated_at timestamptz not null default now()
);

create index if not exists masar_ads_campaign on public.masar_ads(campaign_id);

do $$ declare t text; begin
 foreach t in array array['masar_campaigns','masar_ads'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

commit;
