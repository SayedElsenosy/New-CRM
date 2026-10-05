-- Early qualification flow: canonical Breadfast questions, residence aliases and qualification gates.
-- Run after 014_meta_ads_connection.sql. Safe to rerun. Does not touch attribution or Meta campaign data.
begin;
create extension if not exists pgcrypto;

alter table public.masar_areas
 add column if not exists aliases text[] not null default '{}';

alter table public.masar_settings
 add column if not exists qualification_require_shift boolean not null default false,
 add column if not exists qualification_require_motorcycle_license boolean not null default false;

alter table public.masar_office_settings
 add column if not exists qualification_require_shift boolean not null default false,
 add column if not exists qualification_require_motorcycle_license boolean not null default false;

do $$
declare
 o record;
 spec record;
 qid uuid;
begin
 for o in select id from public.masar_offices order by created_at,id loop
  for spec in
   select * from (values
    ('has_motorcycle',array['motorcycle']::text[],'هل معاك موتوسيكل متاح للشغل يوميًا؟','yes_no',true,1),
    ('residence_area',array['residence_zone']::text[],'ساكن فين حاليًا؟ اكتب اسم المنطقة أو الحي بالتحديد.','text',true,2),
    ('preferred_work_area',array['work_area','area']::text[],'أنهي منطقة تفضل تشتغل فيها؟','area',true,3),
    ('full_name',array['name']::text[],'اكتب اسمك بالكامل.','name',true,4),
    ('shift_acceptance',array[]::text[],'الشيفت 9 ساعات. النظام ده مناسب ليك؟','yes_no',true,5),
    ('ready_to_start',array[]::text[],'لو تم قبولك، تقدر تبدأ الشغل قريب؟','yes_no',true,6)
   ) as x(field_key,old_keys,label,kind,required,position)
  loop
   qid=null;
   select id into qid
   from public.masar_questions
   where office_id=o.id and field_key=spec.field_key
   order by position,id limit 1;

   if qid is null and cardinality(spec.old_keys)>0 then
    select id into qid
    from public.masar_questions
    where office_id=o.id and field_key=any(spec.old_keys)
    order by position,id limit 1;
    if qid is not null then
     update public.masar_questions set field_key=spec.field_key where id=qid;
    end if;
   end if;

   if qid is null then
    insert into public.masar_questions(label,field_key,kind,required,active,position,office_id)
    values(spec.label,spec.field_key,spec.kind,spec.required,true,spec.position,o.id)
    returning id into qid;
   else
    update public.masar_questions
    set label=spec.label,kind=spec.kind,required=spec.required,active=true,position=spec.position
    where id=qid;
   end if;
  end loop;

  update public.masar_questions
  set active=false
  where office_id=o.id
    and field_key not in ('has_motorcycle','residence_area','preferred_work_area','full_name','shift_acceptance','ready_to_start');

  insert into public.masar_office_settings(
   office_id,ai_enabled,welcome,completion,followup_enabled,followup_hours,
   qualification_require_shift,qualification_require_motorcycle_license
  )
  select o.id,s.ai_enabled,s.welcome,s.completion,coalesce(s.followup_enabled,true),coalesce(s.followup_hours,8),false,false
  from public.masar_settings s where s.id=true
  on conflict(office_id) do nothing;
 end loop;
end $$;

-- Canonical hiring residences and editable aliases. These are office-scoped and can be changed later from Masar.
do $$
declare o record;
begin
 for o in select id from public.masar_offices order by created_at,id loop
  insert into public.masar_areas(name,details,active,position,office_id,recruitment_eligible,zone,aliases)
  values
   ('أكتوبر','',true,101,o.id,true,'WEST',array['اكتوبر','6 أكتوبر','6 اكتوبر','٦ أكتوبر','٦ اكتوبر','السادس من أكتوبر','السادس من اكتوبر']),
   ('الشيخ زايد','',true,102,o.id,true,'WEST',array['زايد']),
   ('الهرم','',true,103,o.id,true,'WEST',array[]::text[]),
   ('حدائق الأهرام','',true,104,o.id,true,'WEST',array['حدائق الاهرام']),
   ('الفردوس','',true,105,o.id,true,'WEST',array[]::text[]),
   ('حدائق أكتوبر','',true,106,o.id,true,'WEST',array['حدائق اكتوبر']),
   ('التجمع','',true,201,o.id,true,'EAST',array['القاهرة الجديدة','القاهره الجديده','التجمع الأول','التجمع الاول','التجمع الثالث','التجمع الخامس']),
   ('الرحاب','',true,202,o.id,true,'EAST',array[]::text[]),
   ('مدينتي','',true,203,o.id,true,'EAST',array[]::text[]),
   ('الشروق','',true,204,o.id,true,'EAST',array[]::text[]),
   ('مصر الجديدة','',true,205,o.id,true,'EAST',array['مصر الجديده','هليوبوليس']),
   ('مدينة نصر','',true,301,o.id,true,'NORTH_CENTRAL',array['مدينه نصر']),
   ('النزهة','',true,302,o.id,true,'NORTH_CENTRAL',array['النزهه']),
   ('المقطم','',true,303,o.id,true,'NORTH_CENTRAL',array[]::text[]),
   ('مدينة العبور','',true,304,o.id,true,'NORTH_CENTRAL',array['مدينه العبور','العبور'])
  on conflict(office_id,name) do update set
   active=true,
   recruitment_eligible=true,
   zone=excluded.zone,
   aliases=(
    select array_agg(distinct v order by v)
    from unnest(coalesce(public.masar_areas.aliases,'{}'::text[])||excluded.aliases) v
    where length(trim(v))>0
   );
 end loop;
end $$;

update public.masar_settings
set welcome='أهلاً بيك في التقديم لوظيفة طيار دليفري مع Breadfast 👋🏍️

تفاصيل سريعة قبل ما نبدأ:

💰 مرتب ثابت 6200 جنيه

💵 قبض أسبوعي + شهري

📈 إجمالي دخل ممكن يوصل لـ 25,000 جنيه

🩺 تأمين طبي

⏰ شيفت 9 ساعات

🎁 حوافز ومزايا

🏍️ شرط أساسي للتقديم: يكون معاك موتوسيكل متاح للشغل يوميًا.

التقديم مجاني 100%، وهسألك كام سؤال سريع علشان نعرف أنسب فرصة ليك 👇',
completion='تمام ✅ بياناتك اتسجلت بنجاح.

أنت خلصت مرحلة التقديم الأولية، وبياناتك هتراجعها إدارة التوظيف لتأكيد استيفاء الشروط وتحديد الخطوة التالية.

📞 خليك متابع واتساب والمكالمات علشان مسؤول التوظيف يقدر يتواصل معاك.

التقديم مجاني 100% ومفيش أي رسوم للتعيين.',
qualification_require_shift=false,
qualification_require_motorcycle_license=false
where id=true;

update public.masar_office_settings
set welcome='أهلاً بيك في التقديم لوظيفة طيار دليفري مع Breadfast 👋🏍️

تفاصيل سريعة قبل ما نبدأ:

💰 مرتب ثابت 6200 جنيه

💵 قبض أسبوعي + شهري

📈 إجمالي دخل ممكن يوصل لـ 25,000 جنيه

🩺 تأمين طبي

⏰ شيفت 9 ساعات

🎁 حوافز ومزايا

🏍️ شرط أساسي للتقديم: يكون معاك موتوسيكل متاح للشغل يوميًا.

التقديم مجاني 100%، وهسألك كام سؤال سريع علشان نعرف أنسب فرصة ليك 👇',
completion='تمام ✅ بياناتك اتسجلت بنجاح.

أنت خلصت مرحلة التقديم الأولية، وبياناتك هتراجعها إدارة التوظيف لتأكيد استيفاء الشروط وتحديد الخطوة التالية.

📞 خليك متابع واتساب والمكالمات علشان مسؤول التوظيف يقدر يتواصل معاك.

التقديم مجاني 100% ومفيش أي رسوم للتعيين.',
qualification_require_shift=false,
qualification_require_motorcycle_license=false,
updated_at=now();

insert into public.masar_knowledge(question,answer,keywords,active,source)
select x.question,x.answer,x.keywords,true,'manual'
from (values
 ('المرتب كام؟','المرتب الثابت 6200 جنيه، بالإضافة لنظام القبض الأسبوعي والحوافز حسب نظام التشغيل.',array['مرتب','راتب','قبض','6200']::text[]),
 ('الدخل كام؟','إجمالي الدخل ممكن يوصل إلى 25,000 جنيه حسب الشغل والأوردرات والحوافز.',array['دخل','25000','25,000','حوافز']::text[]),
 ('الشيفت كام ساعة؟','الشيفت 9 ساعات.',array['شيفت','ساعات','9']::text[]),
 ('لازم موتوسيكل؟','أيوه، وجود موتوسيكل متاح للشغل يوميًا شرط أساسي للوظيفة الحالية.',array['موتوسيكل','مكنة','شرط']::text[]),
 ('في تأمين؟','أيوه، الوظيفة فيها تأمين طبي حسب نظام Breadfast.',array['تأمين','تامين','طبي']::text[]),
 ('التقديم بفلوس؟','لا، التقديم والتعيين مجانيين 100% ومفيش أي رسوم مطلوبة منك.',array['تقديم','فلوس','رسوم','مجاني']::text[])
) as x(question,answer,keywords)
where not exists(select 1 from public.masar_knowledge k where lower(trim(k.question))=lower(trim(x.question)));

-- Keep future office cloning aware of aliases and qualification flags.
create or replace function public.masar_clone_office_config(p_source uuid,p_target uuid,p_remap_existing boolean default false)
returns void language plpgsql security definer set search_path=public as $$
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
   insert into public.masar_questions(id,label,field_key,kind,required,active,position,created_at,office_id)
   values(nid,q.label,q.field_key,q.kind,q.required,q.active,q.position,now(),p_target);
  end if;
  insert into masar_q_map(old_id,new_id) values(q.id,nid) on conflict(old_id) do update set new_id=excluded.new_id;
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
  insert into masar_a_map(old_id,new_id) values(z.id,nid) on conflict(old_id) do update set new_id=excluded.new_id;
 end loop;

 insert into public.masar_office_settings(
  office_id,ai_enabled,welcome,completion,followup_enabled,followup_hours,
  qualification_require_shift,qualification_require_motorcycle_license
 )
 select p_target,s.ai_enabled,s.welcome,s.completion,coalesce(s.followup_enabled,true),coalesce(s.followup_hours,8),
  coalesce(s.qualification_require_shift,false),coalesce(s.qualification_require_motorcycle_license,false)
 from public.masar_office_settings s where s.office_id=p_source
 on conflict(office_id) do nothing;

 if not exists(select 1 from public.masar_office_settings where office_id=p_target) then
  insert into public.masar_office_settings(
   office_id,ai_enabled,welcome,completion,followup_enabled,followup_hours,
   qualification_require_shift,qualification_require_motorcycle_license
  )
  select p_target,s.ai_enabled,s.welcome,s.completion,coalesce(s.followup_enabled,true),coalesce(s.followup_hours,8),
   coalesce(s.qualification_require_shift,false),coalesce(s.qualification_require_motorcycle_license,false)
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
    if mapped_key ~* '^[0-9a-f]{8}-[0-9a-f-]{27}$' then
     select new_id::text into mapped_key from masar_q_map where old_id::text=pair.key;
     mapped_key=coalesce(mapped_key,pair.key);
    end if;
    if pair.value->>'kind' in ('area','area_preview') and (pair.value->>'value') ~* '^[0-9a-f]{8}-[0-9a-f-]{27}$' then
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
end $$;
revoke all on function public.masar_clone_office_config(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.masar_clone_office_config(uuid,uuid,boolean) to service_role;

commit;
