-- Disable legacy automatically learned knowledge that predates office scoping.
-- These rows are preserved for audit/history but must never answer applicants,
-- because their original office cannot be proven safely.
begin;

update public.masar_knowledge
set active=false,
    memory_status=case when memory_status='verified' then 'stale' else memory_status end,
    updated_at=now()
where office_id is null
  and source='staff'
  and active=true;

commit;
