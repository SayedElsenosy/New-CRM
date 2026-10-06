-- Make work area the first recruitment decision and require applicant confirmation
-- after seeing the selected area's details.
begin;

update public.masar_questions
set priority=case field_key
 when 'preferred_work_area' then 100
 when 'has_motorcycle' then 90
 when 'motorcycle_license' then 85
 when 'full_name' then 80
 when 'shift_acceptance' then 70
 when 'ready_to_start' then 60
 else priority
end,
confirmation_required=case
 when field_key='preferred_work_area' then true
 else confirmation_required
end,
agent_instruction=case
 when field_key='preferred_work_area' then 'اسأل عن منطقة العمل أولًا. اعرض تفاصيل المنطقة قبل تسجيلها، ولا تعتبر مكان السكن اختيارًا لمنطقة العمل. لا تسجلها إلا بعد تأكيد أن التفاصيل مناسبة.'
 when field_key='has_motorcycle' then 'بعد تأكيد منطقة العمل، اتأكد إن الموتوسيكل متاح للشغل بشكل مستمر.'
 else agent_instruction
end
where field_key in (
 'preferred_work_area','has_motorcycle','motorcycle_license',
 'full_name','shift_acceptance','ready_to_start'
);

commit;
