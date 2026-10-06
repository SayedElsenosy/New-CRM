-- Bootstrap trusted Breadfast-wide facts from identical manual knowledge
-- already present in multiple offices. Office-specific rows remain available
-- as overrides, while new offices can use the shared truth immediately.
begin;

with trusted as (
 select question,answer,
        max(keywords) as keywords,
        count(distinct office_id)::int as office_count
 from public.masar_knowledge
 where source='manual'
   and office_id is not null
   and active=true
   and memory_status not in ('conflict','stale')
   and question in (
    'المرتب كام؟','الدخل كام؟','الشيفت كام ساعة؟',
    'لازم موتوسيكل؟','في تأمين؟','التقديم بفلوس؟'
   )
 group by question,answer
 having count(distinct office_id)>=2
)
insert into public.masar_knowledge(
 question,answer,keywords,examples,active,source,office_id,knowledge_scope,
 confidence,evidence_count,conflict_count,memory_status,last_verified_at,
 shared_office_count,version,created_at,updated_at
)
select t.question,t.answer,coalesce(t.keywords,'{}'::text[]),array[t.question],
 true,'manual',null,'breadfast',1.000,t.office_count,0,'verified',now(),
 t.office_count,1,now(),now()
from trusted t
where not exists(
 select 1 from public.masar_knowledge k
 where k.office_id is null
   and k.knowledge_scope='breadfast'
   and k.source='manual'
   and lower(trim(k.question))=lower(trim(t.question))
);

commit;
