-- Breadfast shared brain + generic choice questions.
-- This product version is intentionally Breadfast-only. Shared learned knowledge
-- is promoted by runtime consensus across offices, while office facts stay local.
begin;

alter table public.masar_questions
 drop constraint if exists masar_questions_kind_check;

alter table public.masar_questions
 add constraint masar_questions_kind_check
 check(kind in ('text','name','number','yes_no','area','choice','image'));

alter table public.masar_questions
 add column if not exists options jsonb not null default '[]'::jsonb;

alter table public.masar_questions
 drop constraint if exists masar_questions_options_array_check;

alter table public.masar_questions
 add constraint masar_questions_options_array_check
 check(jsonb_typeof(options)='array');

alter table public.masar_knowledge
 add column if not exists knowledge_scope text not null default 'office',
 add column if not exists examples text[] not null default '{}',
 add column if not exists shared_office_count integer not null default 0;

alter table public.masar_knowledge
 drop constraint if exists masar_knowledge_scope_check;

alter table public.masar_knowledge
 add constraint masar_knowledge_scope_check
 check(knowledge_scope in ('office','breadfast','system','legacy'));

update public.masar_knowledge
set knowledge_scope=case
 when office_id is not null then 'office'
 when source='manual' and active=true then 'breadfast'
 when source='staff' then 'legacy'
 else knowledge_scope
end;

update public.masar_knowledge
set examples=array[question]
where coalesce(array_length(examples,1),0)=0
  and trim(coalesce(question,''))<>'';

create index if not exists masar_knowledge_scope_active
 on public.masar_knowledge(knowledge_scope,active,memory_status,updated_at desc);

-- Preserve choice options when office configuration is cloned.
create or replace function public.masar_clone_office_config(p_source uuid,p_target uuid,p_remap_existing boolean default false)
returns void language plpgsql security definer set search_path=public as $agent_clone$
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
    agent_instruction,priority,allow_inference,confirmation_required,options
   )
   values(
    nid,q.label,q.field_key,q.kind,q.required,q.active,q.position,now(),p_target,
    coalesce(q.agent_instruction,''),coalesce(q.priority,50),coalesce(q.allow_inference,true),
    coalesce(q.confirmation_required,false),coalesce(q.options,'[]'::jsonb)
   );
  else
   update public.masar_questions set
    label=q.label,kind=q.kind,required=q.required,active=q.active,position=q.position,
    agent_instruction=coalesce(q.agent_instruction,''),
    priority=coalesce(q.priority,50),
    allow_inference=coalesce(q.allow_inference,true),
    confirmation_required=coalesce(q.confirmation_required,false),
    options=coalesce(q.options,'[]'::jsonb)
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
    name=z.name,details=z.details,active=z.active,position=z.position,
    recruitment_eligible=coalesce(z.recruitment_eligible,false),
    zone=coalesce(z.zone,'UNKNOWN'),aliases=coalesce(z.aliases,'{}'::text[])
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
  set awaiting_id=m.new_id from masar_q_map m
  where applicant.office_id=p_target and applicant.awaiting_id=m.old_id;

  for app_row in select id,answers from public.masar_applicants where office_id=p_target loop
   for pair in select * from jsonb_each(coalesce(app_row.answers,'{}'::jsonb)) loop
    mapped_key=pair.key;mapped_value=pair.value;
    if length(mapped_key)=36 and mapped_key ~* '^[0-9a-f]{8}-[0-9a-f-]{27}' then
     select new_id::text into mapped_key from masar_q_map where old_id::text=pair.key;
     mapped_key=coalesce(mapped_key,pair.key);
    end if;
    if pair.value->>'kind' in ('area','area_preview') and length(pair.value->>'value')=36 and (pair.value->>'value') ~* '^[0-9a-f]{8}-[0-9a-f-]{27}' then
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
end $agent_clone$;

revoke all on function public.masar_clone_office_config(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.masar_clone_office_config(uuid,uuid,boolean) to service_role;

commit;
