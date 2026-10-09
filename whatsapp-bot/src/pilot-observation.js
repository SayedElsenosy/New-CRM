/**
 * Recruitment pilot observation, isolated per OFFICE and manually activated.
 * No messaging, applicant qualification change, paid LLM activation, or
 * production schema migration occurs here. Stores only audit metadata.
 *
 * Backward compatible with the earlier account-level control and its run IDs:
 * prior events for the main account already carry detail.office_id.
 */
export const PILOT_LIMIT=50;
export const PILOT_MAX=200;
export const PILOT_SIZES=Object.freeze([10,25,50,100,200]);
const CONTROL_KINDS=['agent_pilot_started','agent_pilot_stopped'];
const safeRows=x=>Array.isArray(x)?x:[];
function requireData(result){if(result?.error)throw result.error;return result?.data||[];}
export const validPilotSize=x=>Number.isInteger(Number(x))&&PILOT_SIZES.includes(Number(x));
const capacityOf=x=>validPilotSize(x)?Number(x):PILOT_LIMIT;
const ordered=events=>safeRows(events)
 .filter(e=>CONTROL_KINDS.includes(e?.kind))
 .sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')));

/** Preserves the original account-scoped helper for existing QA scenarios. */
export function currentPilot(events=[],accountId=null){
 const latest=ordered(events).find(e=>String(e?.detail?.whatsapp_account_id||'')===String(accountId||''));
 if(!latest||latest.kind==='agent_pilot_stopped')
  return {active:false,run_id:null,started_at:null,account_id:accountId,max:PILOT_LIMIT};
 return {active:true,run_id:latest.id,started_at:latest.created_at,
  account_id:accountId,max:capacityOf(latest.detail?.capacity)};
}

/** The OFFICE owns the pilot. New offices never inherit another office's run. */
export function currentOfficePilot(events=[],officeId=null){
 const latest=ordered(events).find(e=>String(e?.detail?.office_id||'')===String(officeId||''));
 if(!latest)return {active:false,run_id:null,started_at:null,office_id:officeId,max:PILOT_LIMIT};
 if(latest.kind==='agent_pilot_stopped')
  return {active:false,run_id:latest.detail?.run_id||null,
   started_at:latest.detail?.started_at||null,office_id:officeId,
   max:capacityOf(latest.detail?.capacity)};
 return {active:true,run_id:latest.id,started_at:latest.created_at,
  office_id:officeId,max:capacityOf(latest.detail?.capacity)};
}

export async function loadPilotControl(db,scopeId,{officeId=false}={}){
 let q=db.from('masar_events').select('id,kind,detail,created_at')
  .in('kind',CONTROL_KINDS);
 if(officeId)q=q.contains('detail',{office_id:scopeId});
 // Legacy account-scoped callers still work, including original tests.
 else q=q.contains('detail',{whatsapp_account_id:scopeId});
 const rows=requireData(await q.order('created_at',{ascending:false}).limit(1));
 return officeId?currentOfficePilot(rows,scopeId):currentPilot(rows,scopeId);
}

/** Filter in Postgres BEFORE LIMIT; otherwise events from other offices can hide ours. */
export async function loadPilotEnrollments(db,pilot){
 if(!pilot?.run_id)return [];
 const rows=requireData(await db.from('masar_events')
  .select('applicant_id,detail,created_at')
  .eq('kind','agent_pilot_enrolled').contains('detail',{run_id:pilot.run_id})
  .order('created_at',{ascending:true}).limit(PILOT_MAX+10));
 const unique=new Map();
 for(const row of rows){
  if(row.detail?.run_id!==pilot.run_id||typeof row.applicant_id!=='string')continue;
  if(!unique.has(row.applicant_id))unique.set(row.applicant_id,row);
  if(unique.size>=capacityOf(pilot.max))break;
 }
 return [...unique.values()];
}

/** An inbound, newly inserted candidate can be enrolled into ONE office run. */
export async function enrollNewInboundApplicant(db,{applicantId,accountId,officeId}={}){
 if(!applicantId||!accountId||!officeId)return {enrolled:false,reason:'missing_office_or_account'};
 const pilot=await loadPilotControl(db,officeId,{officeId:true});
 if(!pilot.active)return {enrolled:false,reason:'not_active'};
 const entries=await loadPilotEnrollments(db,pilot);
 if(entries.some(x=>x.applicant_id===applicantId))return {enrolled:true,already:true};
 if(entries.length>=pilot.max)return {enrolled:false,reason:'cohort_full'};
 requireData(await db.from('masar_events').insert({
  kind:'agent_pilot_enrolled',applicant_id:applicantId,
  detail:{run_id:pilot.run_id,office_id:officeId,whatsapp_account_id:accountId,source:'new_inbound'}
 }));
 return {enrolled:true,already:false};
}

export function pilotCohortSummary({pilot,enrollments=[],applicants=[],handoffs=[]}={}){
 const enroll=safeRows(enrollments).filter(x=>x?.applicant_id);
 const ids=new Set(enroll.map(x=>x.applicant_id));
 const candidates=safeRows(applicants).filter(x=>ids.has(x.id));
 const formCompleted=candidates.filter(x=>['complete','lecture','working'].includes(x.stage)).length;
 const interrupted=candidates.filter(x=>['new','incomplete'].includes(x.stage)).length;
 const transferred=new Set(safeRows(handoffs).map(x=>x.applicant_id).filter(id=>ids.has(id))).size;
 const total=ids.size,limit=capacityOf(pilot?.max);
 return {
  active:pilot?.active===true,
  status:!pilot?.active?'stopped':total>=limit?'cohort_full':'running',
  observation_only:true,existing_office_bot_unchanged:true,unsolicited_messages:false,
  started_at:pilot?.started_at||null,capacity:limit,enrolled:total,
  remaining:Math.max(0,limit-total),
  form_completed:formCompleted,awaiting_completion:interrupted,
  staff_intervention_candidates:transferred,
  completion_rate:total?Math.round(formCompleted/total*1000)/10:null,
  phone_numbers_returned:false,applicant_ids_returned:false,
  note:'كل مكتب له تجربة مستقلة بأول متقدمين جدد بيبدأوا المحادثة بنفسهم. الإيقاف يوقف المراقبة فقط، مش بوت المكتب؛ ولا توجد رسائل جماعية.'
 };
}
