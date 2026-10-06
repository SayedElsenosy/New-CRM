-- AI Agent control plane: LLM planner, hybrid memory policy, decision traces and quality lab.
-- Safe to rerun. LLM stays disabled until a provider secret is configured in the runtime.
begin;

alter table public.masar_settings
 add column if not exists agent_llm_enabled boolean not null default false,
 add column if not exists agent_llm_mode text not null default 'shadow',
 add column if not exists agent_llm_provider text not null default 'openai_compatible',
 add column if not exists agent_llm_model text not null default '',
 add column if not exists agent_llm_temperature numeric(3,2) not null default 0.20,
 add column if not exists agent_llm_timeout_ms integer not null default 8000,
 add column if not exists agent_llm_max_tokens integer not null default 800,
 add column if not exists agent_planner_confidence_threshold numeric(4,3) not null default 0.720,
 add column if not exists agent_hybrid_memory_enabled boolean not null default true,
 add column if not exists agent_llm_rerank_enabled boolean not null default true,
 add column if not exists agent_fact_extraction_enabled boolean not null default true,
 add column if not exists agent_next_best_action_enabled boolean not null default true,
 add column if not exists agent_context_messages integer not null default 12,
 add column if not exists agent_tone text not null default 'egyptian_natural',
 add column if not exists agent_system_instructions text not null default
  'اتكلم كمساعد توظيف مصري طبيعي ومختصر. افهم الرسالة كلها قبل الرد، سجل أي معلومة واضحة في مكانها، جاوب الأسئلة الجانبية من المعرفة الموثقة، ولا تخمن حقائق تشغيلية. قواعد التأهيل النهائية يحددها النظام وليست الموديل.';

alter table public.masar_settings drop constraint if exists masar_settings_agent_llm_mode_check;
alter table public.masar_settings add constraint masar_settings_agent_llm_mode_check
 check(agent_llm_mode in ('shadow','assist','live'));

alter table public.masar_settings drop constraint if exists masar_settings_agent_llm_temperature_check;
alter table public.masar_settings add constraint masar_settings_agent_llm_temperature_check
 check(agent_llm_temperature between 0 and 1);

alter table public.masar_settings drop constraint if exists masar_settings_agent_llm_timeout_check;
alter table public.masar_settings add constraint masar_settings_agent_llm_timeout_check
 check(agent_llm_timeout_ms between 1000 and 30000);

alter table public.masar_settings drop constraint if exists masar_settings_agent_llm_tokens_check;
alter table public.masar_settings add constraint masar_settings_agent_llm_tokens_check
 check(agent_llm_max_tokens between 200 and 3000);

alter table public.masar_settings drop constraint if exists masar_settings_agent_planner_confidence_check;
alter table public.masar_settings add constraint masar_settings_agent_planner_confidence_check
 check(agent_planner_confidence_threshold between 0.50 and 0.95);

alter table public.masar_settings drop constraint if exists masar_settings_agent_context_messages_check;
alter table public.masar_settings add constraint masar_settings_agent_context_messages_check
 check(agent_context_messages between 4 and 30);

create table if not exists public.masar_agent_decisions (
 id uuid primary key default gen_random_uuid(),
 applicant_id uuid references public.masar_applicants(id) on delete set null,
 office_id uuid references public.masar_offices(id) on delete set null,
 message_id uuid references public.masar_messages(id) on delete set null,
 planner_mode text not null default 'deterministic'
  check(planner_mode in ('deterministic','llm_shadow','llm_assist','llm_live','fallback')),
 input_text text not null default '',
 intents jsonb not null default '[]'::jsonb,
 facts jsonb not null default '[]'::jsonb,
 action text not null default 'unknown',
 confidence numeric(4,3),
 knowledge_ids jsonb not null default '[]'::jsonb,
 decision_summary text not null default '',
 provider text,
 model text,
 latency_ms integer,
 fallback_used boolean not null default false,
 error text,
 created_at timestamptz not null default now()
);

create index if not exists masar_agent_decisions_created
 on public.masar_agent_decisions(created_at desc);
create index if not exists masar_agent_decisions_office
 on public.masar_agent_decisions(office_id,created_at desc);
create index if not exists masar_agent_decisions_action
 on public.masar_agent_decisions(action,created_at desc);

create table if not exists public.masar_agent_eval_cases (
 id uuid primary key default gen_random_uuid(),
 title text not null check(length(title) between 2 and 200),
 input_text text not null check(length(input_text) between 2 and 4000),
 expected jsonb not null default '{}'::jsonb,
 tags text[] not null default '{}',
 active boolean not null default true,
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists public.masar_agent_eval_runs (
 id uuid primary key default gen_random_uuid(),
 case_id uuid references public.masar_agent_eval_cases(id) on delete cascade,
 result jsonb not null default '{}'::jsonb,
 passed boolean,
 provider text,
 model text,
 latency_ms integer,
 created_at timestamptz not null default now()
);

create index if not exists masar_agent_eval_runs_case
 on public.masar_agent_eval_runs(case_id,created_at desc);

do $agent_rls$
declare t text;
begin
 foreach t in array array['masar_agent_decisions','masar_agent_eval_cases','masar_agent_eval_runs'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $agent_rls$;

commit;
