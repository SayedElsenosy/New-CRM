-- Autonomous always-learning agent with per-office runtime control and fact-oriented interview fields.
-- Run after 016_work_area_qualification.sql. Safe to rerun.
begin;

alter table public.masar_office_settings
 add column if not exists agent_enabled boolean not null default true;

alter table public.masar_questions
 add column if not exists agent_instruction text not null default '',
 add column if not exists priority integer not null default 50 check(priority between 1 and 100),
 add column if not exists allow_inference boolean not null default true,
 add column if not exists confirmation_required boolean not null default false;

update public.masar_questions
set priority=case field_key
 when 'has_motorcycle' then 100
 when 'preferred_work_area' then 95
 when 'shift_acceptance' then 80
 when 'full_name' then 90
 when 'ready_to_start' then 70
 else priority
end
where field_key in ('has_motorcycle','preferred_work_area','shift_acceptance','full_name','ready_to_start');

-- Learned operational facts are isolated by office. NULL means global knowledge
-- created by the system owner and is intentionally reusable across offices.
alter table public.masar_knowledge
 add column if not exists office_id uuid references public.masar_offices(id) on delete cascade;

alter table public.masar_learning_suggestions
 add column if not exists office_id uuid references public.masar_offices(id) on delete cascade;

update public.masar_learning_suggestions s
set office_id=a.office_id
from public.masar_applicants a
where s.office_id is null and s.applicant_id=a.id and a.office_id is not null;

update public.masar_knowledge k
set office_id=s.office_id
from public.masar_learning_suggestions s
where k.office_id is null
  and k.source='staff'
  and k.source_suggestion_id=s.id
  and s.office_id is not null;

-- The six Breadfast facts installed by migration 015 were historically global.
-- Preserve them for every office that already existed at upgrade time, but stop
-- the old global copies so future/different offices cannot inherit Breadfast
-- salary/shift/policy by accident.
do $
declare o record; k record;
begin
 for k in
  select * from public.masar_knowledge
  where office_id is null
    and source='manual'
    and question in (
     'المرتب كام؟','الدخل كام؟','الشيفت كام ساعة؟',
     'لازم موتوسيكل؟','في تأمين؟','التقديم بفلوس؟'
    )
 loop
  for o in select id from public.masar_offices loop
   if not exists(
    select 1 from public.masar_knowledge scoped
    where scoped.office_id=o.id
      and lower(trim(scoped.question))=lower(trim(k.question))
   ) then
    insert into public.masar_knowledge(
     question,answer,keywords,active,source,source_suggestion_id,usage_count,
     last_used_at,created_by,created_at,updated_at,office_id
    )
    values(
     k.question,k.answer,k.keywords,k.active,k.source,null,k.usage_count,
     k.last_used_at,k.created_by,k.created_at,k.updated_at,o.id
    );
   end if;
  end loop;
 end loop;

 update public.masar_knowledge
 set active=false,updated_at=now()
 where office_id is null
   and source='manual'
   and question in (
    'المرتب كام؟','الدخل كام؟','الشيفت كام ساعة؟',
    'لازم موتوسيكل؟','في تأمين؟','التقديم بفلوس؟'
   );
end $;

create index if not exists masar_knowledge_office_active
 on public.masar_knowledge(office_id,active,updated_at desc);
create index if not exists masar_learning_suggestions_office
 on public.masar_learning_suggestions(office_id,created_at desc);
create index if not exists masar_questions_agent_priority
 on public.masar_questions(office_id,active,priority desc,position,id);

-- Learning is continuous. Legacy training-window columns are kept only for
-- backwards compatibility, but runtime no longer depends on them.
update public.masar_settings
set ai_learning_enabled=true,
    ai_run_mode='live',
    ai_training_started_at=null,
    ai_training_until=null
where id=true;

-- Keep future office cloning aware of the autonomous-agent metadata.
create or replace function public.masar_clone_office_config(p_source uuid,p_target uuid,p_remap_existing boolean default false)
returns void language plpgsql security definer set search_path=public as $
declare q record; z record; app_row record; nid uuid; mapped_key text; mapped_value jsonb; pair record;
begin
 if p_source is null or p_target is null or p_source=p_target then return; end if;
 create temporary table if not exists masar_q_map(old_id uuid primary key,new_id uuid) on commit drop;
 create temporary table if not exists masar_a_map(old_id uuid primary key,new_id uuid) on commit drop;
 truncate table masar_q_map;truncate table masar_a_map;

 for q in select * from public.masar_questions where office_id=p_source order by position,id loop
  select id into nid from public.masar_questions where office_id=p_target and field_key=q.field_key limit 1;
  if nid is null then
   nid=gen_random_uuid();
   insert into public.masar_questions(
    id,label,field_key,kind,required,active,position,created_at,office_id,
    agent_instruction,priority,allow_inference,confirmation_required
   )
   values(
    nid,q.label,q.field_key,q.kind,q.required,q.active,q.position,now(),p_target,
    coalesce(q.agent_instruction,''),coalesce(q.priority,50),coalesce(q.allow_inference,true),coalesce(q.confirmation_required,false)
   );
  else
   update public.masar_questions set
    agent_instruction=coalesce(q.agent_instruction,''),
    priority=coalesce(q.priority,50),
    allow_inference=coalesce(q.allow_inference,true),
    confirmation_required=coalesce(q.confirmation_required,false)
   where id=nid;
  end if;
  insert into masar_q_map(old_id,new_id) values(q.id,nid)
   on conflict(old_id) do update set new_id=excluded.new_id;
 end loop;

 for z in select * from public.masar_areas where office_id=p_source order by position,id loop
  select id into nid from public.masar_areas where office_id=p_target and name=z.name limit 1;
  if nid is null then
   nid=gen_random_uuid();
   insert into public.masar_areas(id,name,details,active,position,created_at,office_id,recruitment_eligible,zone,aliases)
   values(nid,z.name,z.details,z.active,z.position,now(),p_target,coalesce(z.recruitment_eligible,false),coalesce(z.zone,'UNKNOWN'),coalesce(z.aliases,'{}'::text[]));
  else
   update public.masar_areas set
    recruitment_eligible=coalesce(z.recruitment_eligible,false),
    zone=coalesce(z.zone,'UNKNOWN'),
    aliases=coalesce(z.aliases,'{}'::text[])
   where id=nid;
  end if;
  insert into masar_a_map(old_id,new_id) values(z.id,nid)
   on conflict(old_id) do update set new_id=excluded.new_id;
 end loop;

 insert into public.masar_office_settings(
  office_id,ai_enabled,welcome,completion,followup_enabled,followup_hours,
  qualification_require_shift,qualification_require_motorcycle_license,agent_enabled
 )
 select p_target,s.ai_enabled,s.welcome,s.completion,coalesce(s.followup_enabled,true),coalesce(s.followup_hours,8),
  coalesce(s.qualification_require_shift,false),coalesce(s.qualification_require_motorcycle_license,false),coalesce(s.agent_enabled,true)
 from public.masar_office_settings s where s.office_id=p_source
 on conflict(office_id) do nothing;

 if not exists(select 1 from public.masar_office_settings where office_id=p_target) then
  insert into public.masar_office_settings(
   office_id,ai_enabled,welcome,completion,followup_enabled,followup_hours,
   qualification_require_shift,qualification_require_motorcycle_license,agent_enabled
  )
  select p_target,s.ai_enabled,s.welcome,s.completion,coalesce(s.followup_enabled,true),coalesce(s.followup_hours,8),
   coalesce(s.qualification_require_shift,false),coalesce(s.qualification_require_motorcycle_license,false),true
  from public.masar_settings s where s.id=true
  on conflict(office_id) do nothing;
 end if;

 if p_remap_existing then
  update public.masar_applicants applicant
  set awaiting_id=m.new_id
  from masar_q_map m
  where applicant.office_id=p_target and applicant.awaiting_id=m.old_id;

  for app_row in select id,answers from public.masar_applicants where office_id=p_target loop
   for pair in select * from jsonb_each(coalesce(app_row.answers,'{}'::jsonb)) loop
    mapped_key=pair.key;mapped_value=pair.value;
    if mapped_key ~* '^[0-9a-f]{8}-[0-9a-f-]{27} then
     select new_id::text into mapped_key from masar_q_map where old_id::text=pair.key;
     mapped_key=coalesce(mapped_key,pair.key);
    end if;
    if pair.value->>'kind' in ('area','area_preview') and (pair.value->>'value') ~* '^[0-9a-f]{8}-[0-9a-f-]{27} then
     select jsonb_set(pair.value,'{value}',to_jsonb(new_id::text),false) into mapped_value
     from masar_a_map where old_id::text=pair.value->>'value';
     mapped_value=coalesce(mapped_value,pair.value);
    end if;
    update public.masar_applicants
    set answers=coalesce(answers,'{}'::jsonb)-pair.key||jsonb_build_object(mapped_key,mapped_value)
    where id=app_row.id;
   end loop;
  end loop;
 end if;
end $;
revoke all on function public.masar_clone_office_config(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.masar_clone_office_config(uuid,uuid,boolean) to service_role;

commit;
