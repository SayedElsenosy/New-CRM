-- Work-area qualification correction.
-- Residence is informational only. Geo qualification now means Work Area Qualification.
-- Safe to rerun. Does not change Meta attribution, Ad IDs, campaign data, or recruitment_stage.
begin;

do $$
declare
 o record;
 preferred_id uuid;
 residence_id uuid;
begin
 for o in select id from public.masar_offices order by created_at,id loop
  update public.masar_questions
  set label='هل معاك موتوسيكل متاح للشغل يوميًا؟',kind='yes_no',required=true,active=true,position=1
  where office_id=o.id and field_key='has_motorcycle';

  update public.masar_questions
  set label='أنهي منطقة تقدر تشتغل فيها يوميًا؟ اختار المنطقة اللي تقدر تلتزم بالشغل فيها بشكل مستمر.',
      kind='area',required=true,active=true,position=2
  where office_id=o.id and field_key='preferred_work_area'
  returning id into preferred_id;

  update public.masar_questions
  set required=false,active=false,position=90
  where office_id=o.id and field_key='residence_area'
  returning id into residence_id;

  update public.masar_questions
  set label='اكتب اسمك بالكامل.',kind='name',required=true,active=true,position=3
  where office_id=o.id and field_key='full_name';

  update public.masar_questions
  set label='الشيفت 9 ساعات. النظام ده مناسب ليك؟',kind='yes_no',required=true,active=true,position=4
  where office_id=o.id and field_key='shift_acceptance';

  update public.masar_questions
  set label='لو تم قبولك، تقدر تبدأ الشغل قريب؟',kind='yes_no',required=true,active=true,position=5
  where office_id=o.id and field_key='ready_to_start';

  -- Anyone who was stopped only because of residence must be allowed to continue.
  if preferred_id is not null then
   update public.masar_applicants
   set answers=(coalesce(answers,'{}'::jsonb)-'__qualification_stop'-'__residence_clarification')
       ||jsonb_build_object('__application_flow_status',jsonb_build_object(
         'value','active','at',now(),'kind','flow_status'
       )),
       awaiting_id=preferred_id,
       updated_at=now()
   where office_id=o.id
     and answers->'__qualification_stop'->>'reason'='residence_outside_hiring_zones';

   -- Move applicants who were waiting for the old residence question directly to Work Area.
   if residence_id is not null then
    update public.masar_applicants
    set awaiting_id=preferred_id,updated_at=now()
    where office_id=o.id
      and awaiting_id=residence_id
      and coalesce(answers->'__qualification_stop'->>'reason','')<>'no_motorcycle';
   end if;
  end if;
 end loop;
end $$;

commit;
