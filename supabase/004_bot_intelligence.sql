-- Supervised bot intelligence: approved knowledge + staff-learning suggestions.
-- Run after 003_multi_whatsapp.sql. Safe to rerun.
begin;
create extension if not exists pgcrypto;

alter table public.masar_settings
 add column if not exists ai_knowledge_enabled boolean not null default true,
 add column if not exists ai_learning_enabled boolean not null default true,
 add column if not exists ai_confidence_threshold numeric(4,3) not null default 0.620
  check(ai_confidence_threshold between 0.35 and 0.95),
 add column if not exists ai_fallback text not null default 'السؤال ده محتاج تأكيد من مسؤول التوظيف، هحوّل المحادثة للفريق علشان يرد عليك بدقة.';

create table if not exists public.masar_learning_suggestions (
 id uuid primary key default gen_random_uuid(),
 applicant_id uuid references public.masar_applicants(id) on delete set null,
 source_message_id uuid references public.masar_messages(id) on delete set null,
 staff_message_id uuid unique references public.masar_messages(id) on delete set null,
 question text not null check(length(question) between 2 and 2000),
 answer text not null check(length(answer) between 2 and 4000),
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 created_by uuid references auth.users(id) on delete set null,
 reviewed_by uuid references auth.users(id) on delete set null,
 reviewed_at timestamptz,
 created_at timestamptz not null default now()
);

create table if not exists public.masar_knowledge (
 id uuid primary key default gen_random_uuid(),
 question text not null check(length(question) between 2 and 2000),
 answer text not null check(length(answer) between 2 and 4000),
 keywords text[] not null default '{}',
 active boolean not null default true,
 source text not null default 'manual' check(source in ('manual','staff')),
 source_suggestion_id uuid unique references public.masar_learning_suggestions(id) on delete set null,
 usage_count bigint not null default 0,
 last_used_at timestamptz,
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create index if not exists masar_knowledge_active on public.masar_knowledge(active,updated_at desc);
create index if not exists masar_learning_suggestions_status on public.masar_learning_suggestions(status,created_at desc);

do $$ declare t text; begin
 foreach t in array array['masar_knowledge','masar_learning_suggestions'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

-- Bot turns may now pause themselves when confidence is too low.
create or replace function public.masar_commit_turn(p_message uuid,p_patch jsonb,p_reply text)
returns void language plpgsql security definer set search_path=public as $$
declare m public.masar_messages; a public.masar_applicants; next_stage text;
begin
 select * into m from public.masar_messages where id=p_message for update;
 if not found or m.direction<>'in' or m.status<>'pending' then return; end if;
 select * into a from public.masar_applicants where id=m.applicant_id for update;
 next_stage=coalesce(p_patch->>'stage',a.stage);
 if a.stage in ('lecture','working') then next_stage=a.stage; end if;
 update public.masar_applicants set
  answers=coalesce(p_patch->'answers',answers),
  awaiting_id=case when p_patch ? 'awaiting_id' then (p_patch->>'awaiting_id')::uuid else awaiting_id end,
  bot_enabled=case when p_patch ? 'bot_enabled' then coalesce((p_patch->>'bot_enabled')::boolean,bot_enabled) else bot_enabled end,
  stage=next_stage, updated_at=now()
 where id=a.id;
 if next_stage<>a.stage then
  insert into public.masar_events(applicant_id,kind,detail) values(a.id,'stage',jsonb_build_object('from',a.stage,'to',next_stage,'source','bot'));
 end if;
 if length(coalesce(p_reply,''))>0 then
  insert into public.masar_messages(applicant_id,whatsapp_account_id,direction,sender,body,status,reply_to)
  values(a.id,m.whatsapp_account_id,'out','bot',p_reply,'queued',m.id);
 end if;
 update public.masar_messages set status='processed',error=null where id=m.id;
end $$;
revoke all on function public.masar_commit_turn(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.masar_commit_turn(uuid,jsonb,text) to service_role;

commit;
