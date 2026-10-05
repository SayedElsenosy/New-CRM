-- Recruitment performance funnel, qualification rules, ad zones and spend sync metadata.
-- Run after 012_office_admin_scoped_config.sql. Safe to rerun and preserves existing data.
begin;

alter table public.masar_ads
 add column if not exists zone text not null default 'UNKNOWN',
 add column if not exists spend_source text not null default 'manual',
 add column if not exists spend_synced_at timestamptz;

alter table public.masar_ads drop constraint if exists masar_ads_zone_check;
alter table public.masar_ads
 add constraint masar_ads_zone_check check(zone in ('WEST','EAST','NORTH_CENTRAL','UNKNOWN'));
alter table public.masar_ads drop constraint if exists masar_ads_spend_source_check;
alter table public.masar_ads
 add constraint masar_ads_spend_source_check check(spend_source in ('manual','meta'));

alter table public.masar_areas
 add column if not exists recruitment_eligible boolean not null default false,
 add column if not exists zone text not null default 'UNKNOWN';

alter table public.masar_areas drop constraint if exists masar_areas_zone_check;
alter table public.masar_areas
 add constraint masar_areas_zone_check check(zone in ('WEST','EAST','NORTH_CENTRAL','UNKNOWN'));

create index if not exists masar_ads_zone on public.masar_ads(zone,campaign_id);
create index if not exists masar_areas_recruitment_zone on public.masar_areas(office_id,recruitment_eligible,zone);

-- Preserve the old question answers (answers are keyed by question UUID) while giving
-- measurement questions stable field keys. Do not overwrite an already-created canonical key.
update public.masar_questions q
set field_key='preferred_work_area'
where q.field_key='area'
  and not exists (
   select 1 from public.masar_questions x
   where x.office_id is not distinct from q.office_id
     and x.field_key='preferred_work_area'
  );

update public.masar_questions q
set field_key='has_motorcycle'
where q.field_key='motorcycle'
  and not exists (
   select 1 from public.masar_questions x
   where x.office_id is not distinct from q.office_id
     and x.field_key='has_motorcycle'
  );

update public.masar_questions q
set field_key='motorcycle_license'
where q.field_key='license'
  and not exists (
   select 1 from public.masar_questions x
   where x.office_id is not distinct from q.office_id
     and x.field_key='motorcycle_license'
  );

-- Add a dedicated residence question to each office. It is text so a candidate can name
-- an area that is not one of the work-area buttons; qualification then matches it against
-- the office's editable area catalog.
do $$
declare o record; insert_pos integer;
begin
 for o in select id from public.masar_offices order by created_at,id loop
  if not exists(select 1 from public.masar_questions where office_id=o.id and field_key='residence_area') then
   select position into insert_pos
   from public.masar_questions
   where office_id=o.id and field_key='preferred_work_area'
   order by position,id limit 1;

   if insert_pos is null then
    select coalesce(max(position),0)+1 into insert_pos from public.masar_questions where office_id=o.id;
   else
    update public.masar_questions set position=position+1 where office_id=o.id and position>=insert_pos;
   end if;

   insert into public.masar_questions(label,field_key,kind,required,active,position,office_id)
   values('ساكن فين حاليًا؟ اكتب اسم المنطقة أو الحي.','residence_area','text',true,true,insert_pos,o.id);
  end if;
 end loop;
end $$;

-- Seed only confident zone matches. Admin can edit both zone and eligibility later.
update public.masar_areas
set zone='WEST',recruitment_eligible=true
where zone='UNKNOWN' and recruitment_eligible=false
  and lower(trim(name)) in (
   'أكتوبر','اكتوبر','6 أكتوبر','6 اكتوبر','٦ أكتوبر','٦ اكتوبر',
   'الشيخ زايد','زايد','الهرم','حدائق الأهرام','حدائق الاهرام',
   'الفردوس','حدائق أكتوبر','حدائق اكتوبر'
  );

update public.masar_areas
set zone='EAST',recruitment_eligible=true
where zone='UNKNOWN' and recruitment_eligible=false
  and lower(trim(name)) in (
   'التجمع','التجمع الأول','التجمع الاول','التجمع الثالث','التجمع الخامس',
   'الرحاب','مدينتي','الشروق','مصر الجديدة','مصر الجديده'
  );

update public.masar_areas
set zone='NORTH_CENTRAL',recruitment_eligible=true
where zone='UNKNOWN' and recruitment_eligible=false
  and lower(trim(name)) in (
   'مدينة نصر','مدينه نصر','النزهة','النزهه','المقطم','مدينة العبور','مدينه العبور','العبور'
  );

-- Keep new-office cloning aware of the qualification metadata introduced above.
create or replace function public.masar_clone_office_config(p_source uuid,p_target uuid,p_remap_existing boolean default false)
returns void language plpgsql security definer set search_path=public as $
declare q record; z record; app_row record; nid uuid; mapped_key text; mapped_value jsonb; pair record;
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
   insert into public.masar_areas(id,name,details,active,position,created_at,office_id,recruitment_eligible,zone)
   values(nid,z.name,z.details,z.active,z.position,now(),p_target,coalesce(z.recruitment_eligible,false),coalesce(z.zone,'UNKNOWN'));
  else
   update public.masar_areas
   set recruitment_eligible=coalesce(z.recruitment_eligible,false),zone=coalesce(z.zone,'UNKNOWN')
   where id=nid;
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
  update public.masar_applicants applicant
  set awaiting_id=m.new_id
  from masar_q_map m
  where applicant.office_id=p_target and applicant.awaiting_id=m.old_id;

  for app_row in select id,answers from public.masar_applicants where office_id=p_target loop
   for pair in select * from jsonb_each(coalesce(app_row.answers,'{}'::jsonb)) loop
    mapped_key=pair.key;
    mapped_value=pair.value;
    if mapped_key ~* '^[0-9a-f]{8}-[0-9a-f-]{27}
     select new_id::text into mapped_key from masar_q_map where old_id::text=pair.key;
     mapped_key=coalesce(mapped_key,pair.key);
    end if;
    if pair.value->>'kind' in ('area','area_preview') and (pair.value->>'value') ~* '^[0-9a-f]{8}-[0-9a-f-]{27}
     select jsonb_set(pair.value,'{value}',to_jsonb(new_id::text),false) into mapped_value
     from masar_a_map where old_id::text=pair.value->>'value';
     mapped_value=coalesce(mapped_value,pair.value);
    end if;
    update public.masar_applicants
    set answers=coalesce(answers,'{}'::jsonb) - pair.key || jsonb_build_object(mapped_key,mapped_value)
    where id=app_row.id;
   end loop;
  end loop;
 end if;
end $;
revoke all on function public.masar_clone_office_config(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.masar_clone_office_config(uuid,uuid,boolean) to service_role;

commit;
 then
     select new_id::text into mapped_key from masar_q_map where old_id::text=pair.key;
     mapped_key=coalesce(mapped_key,pair.key);
    end if;
    if pair.value->>'kind' in ('area','area_preview') and (pair.value->>'value') ~* '^[0-9a-f]{8}-[0-9a-f-]{27}
 then
     select jsonb_set(pair.value,'{value}',to_jsonb(new_id::text),false) into mapped_value
     from masar_a_map where old_id::text=pair.value->>'value';
     mapped_value=coalesce(mapped_value,pair.value);
    end if;
    update public.masar_applicants
    set answers=coalesce(answers,'{}'::jsonb) - pair.key || jsonb_build_object(mapped_key,mapped_value)
    where id=app_row.id;
   end loop;
  end loop;
 end if;
end $;
revoke all on function public.masar_clone_office_config(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.masar_clone_office_config(uuid,uuid,boolean) to service_role;

commit;
 then
     select jsonb_set(pair.value,'{value}',to_jsonb(new_id::text),false) into mapped_value
     from masar_a_map where old_id::text=pair.value->>'value';
     mapped_value=coalesce(mapped_value,pair.value);
    end if;
    update public.masar_applicants
    set answers=coalesce(answers,'{}'::jsonb) - pair.key || jsonb_build_object(mapped_key,mapped_value)
    where id=app_row.id;
   end loop;
  end loop;
 end if;
end $;
revoke all on function public.masar_clone_office_config(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.masar_clone_office_config(uuid,uuid,boolean) to service_role;

commit;
 then
     select new_id::text into mapped_key from masar_q_map where old_id::text=pair.key;
     mapped_key=coalesce(mapped_key,pair.key);
    end if;
    if pair.value->>'kind' in ('area','area_preview') and (pair.value->>'value') ~* '^[0-9a-f]{8}-[0-9a-f-]{27}
 then
     select jsonb_set(pair.value,'{value}',to_jsonb(new_id::text),false) into mapped_value
     from masar_a_map where old_id::text=pair.value->>'value';
     mapped_value=coalesce(mapped_value,pair.value);
    end if;
    update public.masar_applicants
    set answers=coalesce(answers,'{}'::jsonb) - pair.key || jsonb_build_object(mapped_key,mapped_value)
    where id=app_row.id;
   end loop;
  end loop;
 end if;
end $;
revoke all on function public.masar_clone_office_config(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.masar_clone_office_config(uuid,uuid,boolean) to service_role;

commit;
