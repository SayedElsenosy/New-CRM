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

commit;
