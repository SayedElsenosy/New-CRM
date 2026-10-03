-- Multi-WhatsApp accounts + per-recruiter account access.
-- Run once in Supabase SQL Editor after 001_masar.sql and 002_campaign_attribution.sql.
-- Safe to rerun and preserves the current linked WhatsApp session as the default account.
begin;
create extension if not exists pgcrypto;

create table if not exists public.masar_whatsapp_accounts (
 id uuid primary key default gen_random_uuid(),
 name text not null,
 phone text,
 legacy_session boolean not null default false,
 active boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

-- The first/default account reuses the current /data WhatsApp session so no QR relink is required.
insert into public.masar_whatsapp_accounts(name,legacy_session,active)
select 'الرقم الرئيسي',true,true
where not exists(select 1 from public.masar_whatsapp_accounts);

alter table public.masar_applicants add column if not exists whatsapp_account_id uuid references public.masar_whatsapp_accounts(id);
alter table public.masar_messages add column if not exists whatsapp_account_id uuid references public.masar_whatsapp_accounts(id);
alter table public.masar_contacts add column if not exists whatsapp_account_id uuid references public.masar_whatsapp_accounts(id);

do $$
declare v_default uuid;
begin
 select id into v_default from public.masar_whatsapp_accounts order by legacy_session desc,created_at asc limit 1;
 update public.masar_applicants set whatsapp_account_id=v_default where whatsapp_account_id is null;
 update public.masar_messages m set whatsapp_account_id=a.whatsapp_account_id
 from public.masar_applicants a where m.applicant_id=a.id and m.whatsapp_account_id is null;
 update public.masar_contacts c set whatsapp_account_id=a.whatsapp_account_id
 from public.masar_applicants a where c.applicant_id=a.id and c.whatsapp_account_id is null;
end $$;

alter table public.masar_applicants alter column whatsapp_account_id set not null;
alter table public.masar_messages alter column whatsapp_account_id set not null;
alter table public.masar_contacts alter column whatsapp_account_id set not null;

alter table public.masar_applicants drop constraint if exists masar_applicants_contact_id_key;
alter table public.masar_applicants drop constraint if exists masar_applicants_phone_key;
create unique index if not exists masar_applicants_account_contact on public.masar_applicants(whatsapp_account_id,contact_id);
create unique index if not exists masar_applicants_account_phone on public.masar_applicants(whatsapp_account_id,phone) where phone is not null;
create index if not exists masar_applicants_account_time on public.masar_applicants(whatsapp_account_id,created_at desc);
create index if not exists masar_messages_account_time on public.masar_messages(whatsapp_account_id,created_at desc);
alter table public.masar_messages drop constraint if exists masar_messages_wa_id_key;
create unique index if not exists masar_messages_account_wa_id on public.masar_messages(whatsapp_account_id,wa_id) where wa_id is not null;

-- contact_id is only unique inside a linked WhatsApp account.
alter table public.masar_contacts drop constraint if exists masar_contacts_pkey;
alter table public.masar_contacts add constraint masar_contacts_pkey primary key(whatsapp_account_id,contact_id);

create table if not exists public.masar_staff_whatsapp_access (
 user_id uuid not null references auth.users(id) on delete cascade,
 whatsapp_account_id uuid not null references public.masar_whatsapp_accounts(id) on delete cascade,
 created_at timestamptz not null default now(),
 primary key(user_id,whatsapp_account_id)
);

-- Existing staff keep access to the original/default number until you edit their account.
insert into public.masar_staff_whatsapp_access(user_id,whatsapp_account_id)
select s.user_id,w.id
from public.masar_staff s
cross join lateral (
 select id from public.masar_whatsapp_accounts order by legacy_session desc,created_at asc limit 1
) w
on conflict do nothing;

do $$ declare t text; begin
 foreach t in array array['masar_whatsapp_accounts','masar_staff_whatsapp_access'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

-- Preserve the WhatsApp account when the bot creates a reply.
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
  insert into public.masar_messages(applicant_id,whatsapp_account_id,direction,sender,body,status,reply_to)
  values(a.id,m.whatsapp_account_id,'out','bot',p_reply,'queued',m.id);
 end if;
 update public.masar_messages set status='processed',error=null where id=m.id;
end $$;
revoke all on function public.masar_commit_turn(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.masar_commit_turn(uuid,jsonb,text) to service_role;

-- Only merge identities inside the same linked WhatsApp account.
create or replace function public.masar_merge_applicants(p_source uuid,p_target uuid)
returns void language plpgsql security definer set search_path=public as $$
declare src public.masar_applicants; dst public.masar_applicants;
begin
 if p_source=p_target then return; end if;
 select * into src from public.masar_applicants where id=p_source for update;
 select * into dst from public.masar_applicants where id=p_target for update;
 if src.id is null or dst.id is null or src.whatsapp_account_id<>dst.whatsapp_account_id
    or (src.phone is not null and src.phone is distinct from dst.phone) then
  raise exception 'Unsafe identity merge';
 end if;
 update public.masar_messages set applicant_id=p_target where applicant_id=p_source;
 update public.masar_events set applicant_id=p_target where applicant_id=p_source;
 update public.masar_contacts set applicant_id=p_target where applicant_id=p_source;
 insert into public.masar_contacts(whatsapp_account_id,contact_id,applicant_id)
 values(src.whatsapp_account_id,src.contact_id,p_target)
 on conflict(whatsapp_account_id,contact_id) do update set applicant_id=p_target;
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

commit;
