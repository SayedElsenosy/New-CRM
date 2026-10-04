-- Automatic follow-ups for applicants who have not completed required data.
-- Default: every 8 hours while the applicant is new/incomplete and their bot is enabled.
-- Run after previous migrations. Safe to rerun.
begin;

alter table public.masar_settings
 add column if not exists followup_enabled boolean not null default true,
 add column if not exists followup_hours integer not null default 8
  check(followup_hours between 1 and 72);

alter table public.masar_applicants
 add column if not exists followup_last_sent_at timestamptz,
 add column if not exists followup_count integer not null default 0
  check(followup_count >= 0);

create index if not exists masar_applicants_followup_due
 on public.masar_applicants(stage,bot_enabled,last_message_at,followup_last_sent_at);

commit;
