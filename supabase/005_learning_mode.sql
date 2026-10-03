-- Three-day observation/training mode for supervised bot learning.
-- Run after 004_bot_intelligence.sql. Safe to rerun.
begin;

alter table public.masar_settings
 add column if not exists ai_run_mode text not null default 'live'
  check(ai_run_mode in ('live','training','paused')),
 add column if not exists ai_training_started_at timestamptz,
 add column if not exists ai_training_until timestamptz;

commit;
