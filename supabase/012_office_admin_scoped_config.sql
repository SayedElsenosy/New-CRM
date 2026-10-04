-- Office admins, office-scoped configuration, user profiles and avatars.
-- Run after 011_multi_office_recruitment.sql.
-- Safe to rerun.
begin;
create extension if not exists pgcrypto;

alter table public.masar_staff add column if not exists office_id uuid references public.masar_offices(id) on delete set null;
alter table public.masar_staff add column if not exists phone text;
alter table public.masar_staff add column if not exists job_title text not null default '';
alter table public.masar_staff add column if not exists bio text not null default '';
alter table public.masar_staff add column if not exists avatar_path text;
alter table public.masar_staff add column if not exists updated_at timestamptz not null default now();

-- Existing non-admin staff inherit the office of their assigned WhatsApp number when unambiguous.
update public.masar_staff s
set office_id=x.office_id,updated_at=now()
from (
 select a.user_id,(array_agg(distinct w.office_id) filter(where w.office_id is not null))[1] as office_id
 from public.masar_staff_whatsapp_access a
 join public.masar_whatsapp_accounts w on w.id=a.whatsapp_account_id
 group by a.user_id
 having count(distinct w.office_id)=1
) x
where s.user_id=x.user_id and s.office_id is null;

-- Questions and areas now belong to an office. Current rows become the template
-- for the oldest office, then are cloned to every other existing office.
alter table public.masar_questions add column if not exists office_id uuid references public.masar_offices(id) on delete cascade;
alter table public.masar_areas add column if not exists office_id uuid references public.masar_offices(id) on delete cascade;
alter table public.masar_campaigns add column if not exists office_id uuid references public.masar_offices(id) on delete cascade;

alter table public.masar_questions drop constraint if exists masar_questions_field_key_key;
alter table public.masar_areas drop constraint if exists masar_areas_name_key;
create unique index if not exists masar_questions_office_field_key on public.masar_questions(office_id,field_key);
create unique index if not exists masar_areas_office_name on public.masar_areas(office_id,name);
create index if not exists masar_questions_office_position on public.masar_questions(office_id,position,id);
create index if not exists masar_areas_office_position on public.masar_areas(office_id,position,id);
create index if not exists masar_campaigns_office on public.masar_campaigns(office_id,created_at);

create table if not exists public.masar_office_settings (
 office_id uuid primary key references public.masar_offices(id) on delete cascade,
 ai_enabled boolean not null default true,
 welcome text not null default 'أهلاً بيك 👋',
 completion text not null default 'تم استلام البيانات المطلوبة ✅ مسؤول التوظيف هيراجعها ويتواصل معاك.',
 followup_enabled boolean not null default true,
 followup_hours integer not null default 8 check(followup_hours between 1 and 72),
 updated_at timestamptz not null default now()
);

create or replace function public.masar_clone_office_config(p_source uuid,p_target uuid,p_remap_existing boolean default false)
returns void language plpgsql security definer set search_path=public as $$
declare q record; z record; a record; nid uuid; mapped_key text; mapped_value jsonb; pair record;
begin
 if p_source is null or p_target is null or p_source=p_target then return; end if;

 create temporary table if not exists masar_q_map(old_id uuid primary key,new_id uuid) on commit drop;
 create temporary table if not exists masar_a_map(old_id uuid primary key,new_id uuid) on commit drop;
 truncate table masar_q_map;
 truncate table masar_a_map;

 for q in select * from public.masar_questions where office_id=p_source order by position,id loop
  select id into nid from public.masar_questions where office_id=p_target and field_key=q.field_key limit 1;
  if nid is null then
   nid=gen_random_uuid();
   insert into public.masar_questions(id,label,field_key,kind,required,active,position,created_at,office_id)
   values(nid,q.label,q.field_key,q.kind,q.required,q.active,q.position,now(),p_target);
  end if;
  insert into masar_q_map(old_id,new_id) values(q.id,nid) on conflict(old_id) do update set new_id=excluded.new_id;
 end loop;

 for z in select * from public.masar_areas where office_id=p_source order by position,id loop
  select id into nid from public.masar_areas where office_id=p_target and name=z.name limit 1;
  if nid is null then
   nid=gen_random_uuid();
   insert into public.masar_areas(id,name,details,active,position,created_at,office_id)
   values(nid,z.name,z.details,z.active,z.position,now(),p_target);
  end if;
  insert into masar_a_map(old_id,new_id) values(z.id,nid) on conflict(old_id) do update set new_id=excluded.new_id;
 end loop;

 insert into public.masar_office_settings(office_id,ai_enabled,welcome,completion,followup_enabled,followup_hours)
 select p_target,s.ai_enabled,s.welcome,s.completion,coalesce(s.followup_enabled,true),coalesce(s.followup_hours,8)
 from public.masar_office_settings s where s.office_id=p_source
 on conflict(office_id) do nothing;

 if not exists(select 1 from public.masar_office_settings where office_id=p_target) then
  insert into public.masar_office_settings(office_id,ai_enabled,welcome,completion,followup_enabled,followup_hours)
  select p_target,s.ai_enabled,s.welcome,s.completion,coalesce(s.followup_enabled,true),coalesce(s.followup_hours,8)
  from public.masar_settings s where s.id=true
  on conflict(office_id) do nothing;
 end if;

 if p_remap_existing then
  update public.masar_applicants a
  set awaiting_id=m.new_id
  from masar_q_map m
  where a.office_id=p_target and a.awaiting_id=m.old_id;

  for a in select id,answers from public.masar_applicants where office_id=p_target loop
   mapped_value='{}'::jsonb;
   for pair in select * from jsonb_each(coalesce(a.answers,'{}'::jsonb)) loop
    mapped_key=pair.key;
    if mapped_key ~* '^[0-9a-f]{8}-[0-9a-f-]{27}$' then
     select new_id::text into mapped_key from masar_q_map where old_id::text=pair.key;
     mapped_key=coalesce(mapped_key,pair.key);
    end if;
    if pair.value->>'kind' in ('area','area_preview') and (pair.value->>'value') ~* '^[0-9a-f]{8}-[0-9a-f-]{27}$' then
     select jsonb_set(pair.value,'{value}',to_jsonb(new_id::text),false) into mapped_value
     from masar_a_map where old_id::text=pair.value->>'value';
     mapped_value=coalesce(mapped_value,pair.value);
    else
     mapped_value=pair.value;
    end if;
    update public.masar_applicants
    set answers=coalesce(answers,'{}'::jsonb) - pair.key || jsonb_build_object(mapped_key,mapped_value)
    where id=a.id;
   end loop;
  end loop;
 end if;
end $$;
revoke all on function public.masar_clone_office_config(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.masar_clone_office_config(uuid,uuid,boolean) to service_role;

do $$
declare primary_office uuid; o record;
begin
 select id into primary_office from public.masar_offices order by created_at,id limit 1;
 if primary_office is null then return; end if;

 update public.masar_questions set office_id=primary_office where office_id is null;
 update public.masar_areas set office_id=primary_office where office_id is null;
 update public.masar_campaigns set office_id=primary_office where office_id is null;

 insert into public.masar_office_settings(office_id,ai_enabled,welcome,completion,followup_enabled,followup_hours)
 select primary_office,s.ai_enabled,s.welcome,s.completion,coalesce(s.followup_enabled,true),coalesce(s.followup_hours,8)
 from public.masar_settings s where s.id=true
 on conflict(office_id) do nothing;

 for o in select id from public.masar_offices where id<>primary_office order by created_at,id loop
  perform public.masar_clone_office_config(primary_office,o.id,true);
 end loop;
end $$;

alter table public.masar_office_settings enable row level security;
revoke all on public.masar_office_settings from anon,authenticated;
grant all on public.masar_office_settings to service_role;

-- Users may upload only their own profile image into masar-documents/staff/<uid>/...
drop policy if exists masar_staff_avatar_insert on storage.objects;
drop policy if exists masar_staff_avatar_update on storage.objects;
drop policy if exists masar_staff_avatar_select on storage.objects;
drop policy if exists masar_staff_avatar_delete on storage.objects;
create policy masar_staff_avatar_insert on storage.objects for insert to authenticated
with check(bucket_id='masar-documents' and (storage.foldername(name))[1]='staff' and (storage.foldername(name))[2]=auth.uid()::text);
create policy masar_staff_avatar_update on storage.objects for update to authenticated
using(bucket_id='masar-documents' and (storage.foldername(name))[1]='staff' and (storage.foldername(name))[2]=auth.uid()::text)
with check(bucket_id='masar-documents' and (storage.foldername(name))[1]='staff' and (storage.foldername(name))[2]=auth.uid()::text);
create policy masar_staff_avatar_select on storage.objects for select to authenticated
using(bucket_id='masar-documents' and (storage.foldername(name))[1]='staff' and (storage.foldername(name))[2]=auth.uid()::text);
create policy masar_staff_avatar_delete on storage.objects for delete to authenticated
using(bucket_id='masar-documents' and (storage.foldername(name))[1]='staff' and (storage.foldername(name))[2]=auth.uid()::text);

commit;
