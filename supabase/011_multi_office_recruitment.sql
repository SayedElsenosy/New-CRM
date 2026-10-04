-- Multi-office recruitment CRM foundation.
-- Run after 003_multi_whatsapp.sql and before using the new Offices / Interviews dashboard.
-- Safe to rerun.
begin;
create extension if not exists pgcrypto;

create table if not exists public.masar_offices (
 id uuid primary key default gen_random_uuid(),
 name text not null,
 code text not null unique,
 address text not null default '',
 phone text,
 manager_name text not null default '',
 active boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

alter table public.masar_whatsapp_accounts
 add column if not exists office_id uuid references public.masar_offices(id) on delete restrict;

-- Preserve all existing WhatsApp accounts by creating one office for each current account.
insert into public.masar_offices(id,name,code,phone,active)
select
 w.id,
 coalesce(nullif(trim(w.name),''),'مكتب التوظيف'),
 'OFF-'||upper(substr(replace(w.id::text,'-',''),1,8)),
 w.phone,
 w.active
from public.masar_whatsapp_accounts w
where w.office_id is null
on conflict(id) do nothing;

update public.masar_whatsapp_accounts w
set office_id=w.id
where w.office_id is null
  and exists(select 1 from public.masar_offices o where o.id=w.id);

create index if not exists masar_whatsapp_accounts_office
 on public.masar_whatsapp_accounts(office_id,active);

alter table public.masar_applicants
 add column if not exists office_id uuid references public.masar_offices(id) on delete restrict;
-- Add nullable first so existing rows can be backfilled from the old workflow without
-- overwriting recruiter-selected stages when this migration is rerun.
alter table public.masar_applicants
 add column if not exists recruitment_stage text;

do $ begin
 if not exists(
  select 1 from pg_constraint
  where conname='masar_applicants_recruitment_stage_check'
    and conrelid='public.masar_applicants'::regclass
 ) then
  alter table public.masar_applicants
   add constraint masar_applicants_recruitment_stage_check
   check(recruitment_stage in ('new','review','interview','accepted','hired','rejected'));
 end if;
end $$;

update public.masar_applicants a
set office_id=w.office_id
from public.masar_whatsapp_accounts w
where a.whatsapp_account_id=w.id
  and a.office_id is null;

update public.masar_applicants
set recruitment_stage=case
 when stage='working' then 'hired'
 when stage='lecture' then 'interview'
 when stage='complete' then 'review'
 else 'new'
end
where recruitment_stage is null
   or recruitment_stage not in ('new','review','interview','accepted','hired','rejected');

alter table public.masar_applicants alter column recruitment_stage set default 'new';
alter table public.masar_applicants alter column recruitment_stage set not null;
alter table public.masar_applicants alter column office_id set not null;
create index if not exists masar_applicants_office_time
 on public.masar_applicants(office_id,created_at desc);
create index if not exists masar_applicants_recruitment_stage
 on public.masar_applicants(office_id,recruitment_stage,created_at desc);

create table if not exists public.masar_interviews (
 id uuid primary key default gen_random_uuid(),
 applicant_id uuid not null references public.masar_applicants(id) on delete cascade,
 office_id uuid not null references public.masar_offices(id) on delete restrict,
 scheduled_at timestamptz not null,
 status text not null default 'scheduled'
  check(status in ('scheduled','completed','cancelled','no_show')),
 notes text not null default '',
 interviewer_id uuid references auth.users(id) on delete set null,
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists masar_interviews_office_time
 on public.masar_interviews(office_id,scheduled_at desc);
create index if not exists masar_interviews_applicant
 on public.masar_interviews(applicant_id,scheduled_at desc);

-- New applicants automatically inherit their office from the linked WhatsApp account.
-- Intake progress also advances the recruitment pipeline without overwriting a stage
-- that a recruiter explicitly selected.
create or replace function public.masar_sync_applicant_office_stage()
returns trigger language plpgsql security definer set search_path=public as $$
declare linked_office uuid;
begin
 if new.whatsapp_account_id is not null
    and (tg_op='INSERT' or new.office_id is null or new.whatsapp_account_id is distinct from old.whatsapp_account_id) then
  select office_id into linked_office
  from public.masar_whatsapp_accounts
  where id=new.whatsapp_account_id;
  if linked_office is not null then new.office_id=linked_office; end if;
 end if;

 if tg_op='INSERT' then
  if new.stage='working' then new.recruitment_stage='hired';
  elsif new.stage='lecture' then new.recruitment_stage='interview';
  elsif new.stage='complete' then new.recruitment_stage='review';
  elsif new.recruitment_stage is null then new.recruitment_stage='new';
  end if;
 elsif new.recruitment_stage is not distinct from old.recruitment_stage then
  if new.stage='working' then new.recruitment_stage='hired';
  elsif new.stage='lecture' and old.recruitment_stage in ('new','review') then new.recruitment_stage='interview';
  elsif new.stage='complete' and old.recruitment_stage='new' then new.recruitment_stage='review';
  end if;
 end if;
 return new;
end $$;

drop trigger if exists masar_applicant_office_stage_sync on public.masar_applicants;
create trigger masar_applicant_office_stage_sync
before insert or update of whatsapp_account_id,stage,recruitment_stage
on public.masar_applicants
for each row execute function public.masar_sync_applicant_office_stage();

-- Moving a WhatsApp number between offices moves its applicants too, keeping all
-- office dashboards and reports consistent.
create or replace function public.masar_sync_whatsapp_office()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.office_id is distinct from old.office_id and new.office_id is not null then
  update public.masar_applicants
  set office_id=new.office_id,updated_at=now()
  where whatsapp_account_id=new.id;
 end if;
 return new;
end $$;

drop trigger if exists masar_whatsapp_office_sync on public.masar_whatsapp_accounts;
create trigger masar_whatsapp_office_sync
after update of office_id on public.masar_whatsapp_accounts
for each row execute function public.masar_sync_whatsapp_office();

do $$ declare t text; begin
 foreach t in array array['masar_offices','masar_interviews'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

commit;
