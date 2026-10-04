-- Human-intervention alert center.
-- Creates durable per-applicant alerts whenever the bot hands off to staff.
-- Run after 003_multi_whatsapp.sql. Safe to rerun.
begin;

create table if not exists public.masar_alerts (
 id uuid primary key default gen_random_uuid(),
 applicant_id uuid not null references public.masar_applicants(id) on delete cascade,
 whatsapp_account_id uuid not null references public.masar_whatsapp_accounts(id) on delete cascade,
 source_message_id uuid unique references public.masar_messages(id) on delete cascade,
 kind text not null default 'ai_handoff' check(kind in ('ai_handoff')),
 title text not null default 'متقدم يحتاج تدخل',
 body text not null default '',
 phone text,
 status text not null default 'open' check(status in ('open','resolved')),
 resolved_by uuid references auth.users(id) on delete set null,
 resolved_at timestamptz,
 resolution text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create index if not exists masar_alerts_open_account
 on public.masar_alerts(status,whatsapp_account_id,created_at desc);
create index if not exists masar_alerts_applicant
 on public.masar_alerts(applicant_id,status,created_at desc);

create table if not exists public.masar_alert_reads (
 alert_id uuid not null references public.masar_alerts(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 read_at timestamptz not null default now(),
 primary key(alert_id,user_id)
);

create index if not exists masar_alert_reads_user
 on public.masar_alert_reads(user_id,read_at desc);

do $$ declare t text; begin
 foreach t in array array['masar_alerts','masar_alert_reads'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

commit;
