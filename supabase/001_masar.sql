-- Run once in Supabase SQL Editor. Safe to rerun. Keeps ALL old project tables.
begin;
create extension if not exists pgcrypto;
create table if not exists public.masar_staff (
 user_id uuid primary key references auth.users(id) on delete cascade,
 created_at timestamptz not null default now()
);
create table if not exists public.masar_areas (
 id uuid primary key default gen_random_uuid(), name text not null unique,
 details text not null default '', active boolean not null default true,
 position integer not null default 0, created_at timestamptz not null default now()
);
create table if not exists public.masar_questions (
 id uuid primary key default gen_random_uuid(), label text not null,
 field_key text not null unique check(field_key ~ '^[a-z][a-z0-9_]{0,39}$'),
 kind text not null check(kind in ('text','name','number','yes_no','area','image')),
 required boolean not null default true, active boolean not null default true,
 position integer not null default 0, created_at timestamptz not null default now()
);
-- Normalize defaults when upgrading an older Masar questions table.
alter table public.masar_questions alter column required set default true;
alter table public.masar_questions alter column active set default true;
alter table public.masar_questions alter column position set default 0;

create table if not exists public.masar_applicants (
 id uuid primary key default gen_random_uuid(), contact_id text unique not null,
 phone text unique check(phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
 display_name text not null default '', stage text not null default 'new'
 check(stage in ('new','incomplete','complete','lecture','working')),
 answers jsonb not null default '{}', awaiting_id uuid references public.masar_questions(id),
 bot_enabled boolean not null default true, notes text not null default '',
 lecture_at timestamptz, working_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 last_message_at timestamptz, legacy_id text unique
);
create table if not exists public.masar_contacts (
 contact_id text primary key, applicant_id uuid not null references public.masar_applicants(id) on delete cascade
);
create table if not exists public.masar_messages (
 id uuid primary key default gen_random_uuid(), sequence bigint generated always as identity, applicant_id uuid not null references public.masar_applicants(id) on delete cascade,
 wa_id text unique, direction text not null check(direction in ('in','out')),
 sender text not null check(sender in ('applicant','bot','staff')),
 body text not null default '', media_path text, media_type text, media_error text,
 status text not null default 'pending' check(status in ('pending','processed','queued','sending','sent','failed','uncertain')),
 reply_to uuid references public.masar_messages(id), error text,
 attempts integer not null default 0,
 created_at timestamptz not null default now()
);
alter table public.masar_messages add column if not exists sequence bigint generated always as identity;
grant usage, select on sequence public.masar_messages_sequence_seq to service_role;
create index if not exists masar_messages_applicant_time on public.masar_messages(applicant_id,created_at);
create index if not exists masar_messages_queue on public.masar_messages(status,created_at);
create index if not exists masar_applicants_time on public.masar_applicants(created_at);
create table if not exists public.masar_events (
 id uuid primary key default gen_random_uuid(), applicant_id uuid references public.masar_applicants(id),
 kind text not null, detail jsonb not null default '{}', staff_id uuid references auth.users(id),
 created_at timestamptz not null default now()
);
create table if not exists public.masar_settings (
 id boolean primary key default true check(id), ai_enabled boolean not null default true,
 welcome text not null default 'أهلاً بيك في مسار للتقديم لوظيفة دليفري 👋',
 completion text not null default 'تم استلام البيانات المطلوبة ✅ مسؤول التوظيف هيراجعها ويتواصل معاك. استلام البيانات لا يعني قبول التعيين.'
);
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
insert into public.masar_settings(id) values(true) on conflict do nothing;
-- Staff allowlist from previous installation, if one exists.
do $$ begin
 if to_regclass('public.recruiter_users') is not null then
  execute 'insert into public.masar_staff(user_id) select user_id from public.recruiter_users on conflict do nothing';
 end if;
end $$;
-- Server-only data: frontend uses authenticated API, never the service key.
do $$ declare t text; begin
 foreach t in array array['masar_contacts','masar_staff','masar_areas','masar_questions','masar_applicants','masar_messages','masar_events','masar_settings','masar_campaigns','masar_ads'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('masar-documents','masar-documents',false,10485760,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict(id) do update set public=false;
-- Atomic application update + reply creation + inbox acknowledgement.
create or replace function public.masar_commit_turn(p_message uuid,p_patch jsonb,p_reply text)
returns void language plpgsql security definer set search_path=public as $$
declare m public.masar_messages; a public.masar_applicants; next_stage text;
begin
 select * into m from public.masar_messages where id=p_message for update;
 if not found or m.direction<>'in' or m.status<>'pending' then return; end if;
 select * into a from public.masar_applicants where id=m.applicant_id for update;
 next_stage=coalesce(p_patch->>'stage',a.stage);
 if a.stage in ('lecture','working') then next_stage=a.stage; end if;
 update public.masar_applicants set
  answers=coalesce(p_patch->'answers',answers),
  awaiting_id=case when p_patch ? 'awaiting_id' then (p_patch->>'awaiting_id')::uuid else awaiting_id end,
  stage=next_stage, updated_at=now()
 where id=a.id;
 if next_stage<>a.stage then
  insert into public.masar_events(applicant_id,kind,detail) values(a.id,'stage',jsonb_build_object('from',a.stage,'to',next_stage,'source','bot'));
 end if;
 if length(coalesce(p_reply,''))>0 then
  insert into public.masar_messages(applicant_id,direction,sender,body,status,reply_to)
  values(a.id,'out','bot',p_reply,'queued',m.id);
 end if;
 update public.masar_messages set status='processed',error=null where id=m.id;
end $$;
revoke all on function public.masar_commit_turn(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.masar_commit_turn(uuid,jsonb,text) to service_role;
commit;
create or replace function public.masar_reorder_questions(p_ids uuid[])
returns void language plpgsql security definer set search_path=public as $$
begin
 update public.masar_questions q set position=s.ord
 from unnest(p_ids) with ordinality as s(id,ord) where q.id=s.id;
end $$;
revoke all on function public.masar_reorder_questions(uuid[]) from public,anon,authenticated;
grant execute on function public.masar_reorder_questions(uuid[]) to service_role;

-- Merge a previously unresolved LID only after WhatsApp resolves its real PN.
create or replace function public.masar_merge_applicants(p_source uuid,p_target uuid)
returns void language plpgsql security definer set search_path=public as $$
declare src public.masar_applicants; dst public.masar_applicants;
begin
 if p_source=p_target then return; end if;
 select * into src from public.masar_applicants where id=p_source for update;
 select * into dst from public.masar_applicants where id=p_target for update;
 if src.id is null or dst.id is null or (src.phone is not null and src.phone is distinct from dst.phone) then
  raise exception 'Unsafe identity merge';
 end if;
 update public.masar_messages set applicant_id=p_target where applicant_id=p_source;
 update public.masar_events set applicant_id=p_target where applicant_id=p_source;
 update public.masar_contacts set applicant_id=p_target where applicant_id=p_source;
 insert into public.masar_contacts(contact_id,applicant_id) values(src.contact_id,p_target)
 on conflict(contact_id) do update set applicant_id=p_target;
 update public.masar_applicants set answers=src.answers||dst.answers,
 notes=concat_ws(E'\n',nullif(dst.notes,''),nullif(src.notes,'')),
 stage=case when src.stage='working' or dst.stage='working' then 'working'
 when src.stage='lecture' or dst.stage='lecture' then 'lecture' else dst.stage end,
 lecture_at=coalesce(dst.lecture_at,src.lecture_at),working_at=coalesce(dst.working_at,src.working_at),
 created_at=least(src.created_at,dst.created_at),updated_at=now()
 where id=p_target;
 delete from public.masar_applicants where id=p_source;
end $$;
revoke all on function public.masar_merge_applicants(uuid,uuid) from public,anon,authenticated;
grant execute on function public.masar_merge_applicants(uuid,uuid) to service_role;
