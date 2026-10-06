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

commit;
