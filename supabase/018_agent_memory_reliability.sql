-- Reliability layer for autonomous Agent memory: evidence, conflicts, freshness and rollback history.
-- Run after 017_autonomous_office_agent.sql. Safe to rerun.
begin;

alter table public.masar_knowledge
 add column if not exists memory_status text not null default 'verified'
  check(memory_status in ('verified','conflict','stale')),
 add column if not exists evidence_count integer not null default 1 check(evidence_count >= 0),
 add column if not exists conflict_count integer not null default 0 check(conflict_count >= 0),
 add column if not exists confidence numeric(4,3) not null default 0.800
  check(confidence between 0 and 1),
 add column if not exists last_verified_at timestamptz,
 add column if not exists valid_from timestamptz,
 add column if not exists valid_until timestamptz,
 add column if not exists version integer not null default 1 check(version >= 1);

update public.masar_knowledge
set last_verified_at=coalesce(last_verified_at,updated_at,created_at,now())
where last_verified_at is null;

create table if not exists public.masar_knowledge_evidence (
 id uuid primary key default gen_random_uuid(),
 knowledge_id uuid references public.masar_knowledge(id) on delete cascade,
 office_id uuid references public.masar_offices(id) on delete cascade,
 applicant_id uuid references public.masar_applicants(id) on delete set null,
 source_message_id uuid references public.masar_messages(id) on delete set null,
 staff_message_id uuid references public.masar_messages(id) on delete set null,
 kind text not null check(kind in ('learned','reinforced','updated','corrected','conflict','manual','rollback')),
 question_excerpt text not null default '',
 answer_excerpt text not null default '',
 context_excerpt text not null default '',
 confidence numeric(4,3) not null default 0.800 check(confidence between 0 and 1),
 created_at timestamptz not null default now()
);

create table if not exists public.masar_knowledge_versions (
 id uuid primary key default gen_random_uuid(),
 knowledge_id uuid not null references public.masar_knowledge(id) on delete cascade,
 version integer not null,
 office_id uuid references public.masar_offices(id) on delete cascade,
 question text not null,
 answer text not null,
 keywords text[] not null default '{}',
 active boolean not null,
 memory_status text not null default 'verified',
 confidence numeric(4,3) not null default 0.800,
 evidence_count integer not null default 0,
 conflict_count integer not null default 0,
 changed_by uuid references auth.users(id) on delete set null,
 change_reason text not null default 'update',
 created_at timestamptz not null default now(),
 unique(knowledge_id,version)
);

insert into public.masar_knowledge_versions(
 knowledge_id,version,office_id,question,answer,keywords,active,memory_status,
 confidence,evidence_count,conflict_count,change_reason,created_at
)
select k.id,k.version,k.office_id,k.question,k.answer,k.keywords,k.active,k.memory_status,
 k.confidence,k.evidence_count,k.conflict_count,'migration_snapshot',coalesce(k.updated_at,k.created_at,now())
from public.masar_knowledge k
where not exists(
 select 1 from public.masar_knowledge_versions v
 where v.knowledge_id=k.id and v.version=k.version
);

create index if not exists masar_knowledge_reliability
 on public.masar_knowledge(office_id,active,memory_status,last_verified_at desc);
create index if not exists masar_knowledge_evidence_knowledge
 on public.masar_knowledge_evidence(knowledge_id,created_at desc);
create index if not exists masar_knowledge_versions_knowledge
 on public.masar_knowledge_versions(knowledge_id,version desc);

do $agent_memory_rls$
declare t text;
begin
 foreach t in array array['masar_knowledge_evidence','masar_knowledge_versions'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end
$agent_memory_rls$;

commit;
