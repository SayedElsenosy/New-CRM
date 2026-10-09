# Per-office pilot control

**UI:** AI Agent → الأداء والتجربة → مقارنة تجارب المكاتب.

Every office starts with pilot observation disabled until a system admin starts it. The active main office (الرقم الرئيسي) retains its already started 50-person run because its previously recorded start event includes the office ID.

The administrator chooses a cohort size of 10, 25, 50, 100 or 200 new inbound WhatsApp applicants **per office**. Multiple active WhatsApp accounts linked to one office share that limit. A new office with no active linked WhatsApp number or with a disabled office Agent cannot activate monitoring.

Stopping observation for an office never stops its existing bot or another office's pilot. The last completed sample remains available for the selected office. Starting again creates a fresh run with a new capacity. The standard office bot continues accepting and replying to inbound applicants outside the tracked cohort. No bulk messaging, paid LLM activation, candidate qualification changes or schema migrations are introduced.

Only the system administrator can use POST /api/agent/pilot/start with {office_id,capacity} or POST /api/agent/pilot/stop with {office_id}. GET /api/agent/performance?office_id=...&days=7 provides office-isolated counts, messages and form-completion trends. Historic inbound applicants whose office_id is missing are scoped to their office through the linked WhatsApp account. No raw messages, candidate phone numbers, names or identities appear in the aggregate dashboard.

Controls and enrollment are stored as office-tagged metadata in existing masar_events. The previous account-level main pilot run is preserved. JSONB filtering is performed server-side BEFORE event LIMIT. The tracked cohort maximum depends on the pilot's stored size; office A cannot consume office B's slots.

This is a monitoring cap, not a cap on normal bot conversations. The event-only enrollment limit relies on one live message-ingestion worker; deploying multiple parallel workers would require transactional enforcement to guarantee strict cross-process limits.

Testing covers independent office start/stop, original 50-person run continuity, alternate 100-person cohort, multiple WhatsApp numbers in one office, over-cap exclusion, incoming-only and privacy behavior. The production database backup remains managed by the project owner.
