-- Clean applicant reset markers for re-testing the same WhatsApp number.
-- Prevents old queued/history messages from recreating deleted applicants.
-- Run after 003_multi_whatsapp.sql. Safe to rerun.
begin;

create table if not exists public.masar_applicant_resets (
 whatsapp_account_id uuid not null references public.masar_whatsapp_accounts(id) on delete cascade,
 contact_id text not null,
 phone text,
 reset_at timestamptz not null default now(),
 primary key(whatsapp_account_id,contact_id)
);

create index if not exists masar_applicant_resets_phone
 on public.masar_applicant_resets(whatsapp_account_id,phone,reset_at desc)
 where phone is not null;

alter table public.masar_applicant_resets enable row level security;
revoke all on public.masar_applicant_resets from anon, authenticated;
grant all on public.masar_applicant_resets to service_role;

commit;
