-- Bootstrap trusted Breadfast-wide facts from identical manual knowledge
-- already present in multiple offices. A fact is shared only when at least two
-- offices agree and there is no competing active manual answer for that topic.
-- Office-specific rows remain available as overrides.
begin;

create temporary table if not exists masar_trusted_breadfast_facts(
 question text primary key,
 answer text not null,
 office_count integer not null
) on commit drop;
truncate table masar_trusted_breadfast_facts;

insert into masar_trusted_breadfast_facts(question,answer,office_count)
select question,min(answer) as answer,count(distinct office_id)::int as office_count
from public.masar_knowledge
where source='manual'
  and office_id is not null
  and active=true
  and memory_status not in ('conflict','stale')
  and question in (
   'المرتب كام؟','الدخل كام؟','الشيفت كام ساعة؟',
   'لازم موتوسيكل؟','في تأمين؟','التقديم بفلوس؟'
  )
group by question
having count(distinct office_id)>=2
   and count(distinct answer)=1;

-- If a trusted shared row already exists, refresh that row instead of creating
-- a second truth for the same Breadfast question.
update public.masar_knowledge k
set answer=t.answer,
    active=true,
    knowledge_scope='breadfast',
    confidence=1.000,
    evidence_count=greatest(coalesce(k.evidence_count,0),t.office_count),
    conflict_count=0,
    memory_status='verified',
    last_verified_at=now(),
    shared_office_count=t.office_count,
    examples=case
      when coalesce(array_length(k.examples,1),0)=0 then array[t.question]
      else k.examples
    end,
    updated_at=now()
from masar_trusted_breadfast_facts t
where k.office_id is null
  and k.source='manual'
  and k.knowledge_scope='breadfast'
  and lower(trim(k.question))=lower(trim(t.question));

insert into public.masar_knowledge(
 question,answer,keywords,examples,active,source,office_id,knowledge_scope,
 confidence,evidence_count,conflict_count,memory_status,last_verified_at,
 shared_office_count,version,created_at,updated_at
)
select t.question,t.answer,'{}'::text[],array[t.question],
 true,'manual',null,'breadfast',1.000,t.office_count,0,'verified',now(),
 t.office_count,1,now(),now()
from masar_trusted_breadfast_facts t
where not exists(
 select 1 from public.masar_knowledge k
 where k.office_id is null
   and k.knowledge_scope='breadfast'
   and k.source='manual'
   and lower(trim(k.question))=lower(trim(t.question))
);

-- Any pre-existing shared bootstrap fact that now has disagreement across the
-- offices is not safe to answer from.
update public.masar_knowledge k
set active=false,
    memory_status='conflict',
    updated_at=now()
where k.office_id is null
  and k.source='manual'
  and k.knowledge_scope='breadfast'
  and k.question in (
   'المرتب كام؟','الدخل كام؟','الشيفت كام ساعة؟',
   'لازم موتوسيكل؟','في تأمين؟','التقديم بفلوس؟'
  )
  and not exists(
   select 1 from masar_trusted_breadfast_facts t
   where lower(trim(t.question))=lower(trim(k.question))
  );

-- Defensively collapse any historic duplicate shared rows to one active row per
-- topic. The duplicate rows remain for audit/history but cannot answer.
with ranked as (
 select id,
        row_number() over(
         partition by lower(trim(question))
         order by active desc,last_verified_at desc nulls last,updated_at desc,id
        ) as rn
 from public.masar_knowledge
 where office_id is null
   and source='manual'
   and knowledge_scope='breadfast'
   and question in (
    'المرتب كام؟','الدخل كام؟','الشيفت كام ساعة؟',
    'لازم موتوسيكل؟','في تأمين؟','التقديم بفلوس؟'
   )
)
update public.masar_knowledge k
set active=false,updated_at=now()
from ranked r
where k.id=r.id and r.rn>1;

commit;
