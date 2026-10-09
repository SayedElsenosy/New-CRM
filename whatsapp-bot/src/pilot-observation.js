/**
 * Opt-in inbound-only recruitment pilot. Runs on the existing office Agent,
 * without unsolicited messages, changing qualifications or opening LLM modes.
 *
 * A pilot enrollment is only an audit event written for a NEW inbound
 * WhatsApp applicant. Once 50 are enrolled, no more applicants enter the
 * pilot cohort; the pre-existing office bot still handles other messages.
 * A stop action ends PILOT OBSERVATION, not the office Agent.
 */
export const PILOT_LIMIT=50;
const controlKinds=['agent_pilot_started','agent_pilot_stopped'];
const accountMatches=(event,accountId)=>String(event?.detail?.whatsapp_account_id||'')===String(accountId||'');
const safeRows=x=>Array.isArray(x)?x:[];
function requireData(result){if(result?.error)throw result.error;return result?.data||[];}

export function currentPilot(events=[],accountId=null){
 const controls=safeRows(events)
  .filter(e=>controlKinds.includes(e.kind)&&accountMatches(e,accountId))
  .sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')));
 const latest=controls[0];
 if(!latest||latest.kind==='agent_pilot_stopped')
  return {active:false,run_id:null,started_at:null,account_id:accountId,max:PILOT_LIMIT};
 return {active:true,run_id:latest.id,started_at:latest.created_at,
  account_id:accountId,max:PILOT_LIMIT};
}
export async function loadPilotControl(db,accountId){
 const rows=requireData(await db.from('masar_events')
  .select('id,kind,detail,created_at')
  .in('kind',controlKinds).order('created_at',{ascending:false}).limit(120));
 return currentPilot(rows,accountId);
}
export async function loadPilotEnrollments(db,pilot){
 if(!pilot?.active||!pilot.run_id)return [];
 const rows=requireData(await db.from('masar_events')
  .select('applicant_id,detail,created_at')
  .eq('kind','agent_pilot_enrolled').gte('created_at',pilot.started_at)
  .order('created_at',{ascending:true}).limit(500));
 return rows.filter(row=>row.detail?.run_id===pilot.run_id&&typeof row.applicant_id==='string')
  .slice(0,PILOT_LIMIT);
}
export async function enrollNewInboundApplicant(db,{applicantId,accountId}={}){
 if(!applicantId||!accountId)return {enrolled:false,reason:'no_account'};
 const pilot=await loadPilotControl(db,accountId);
 if(!pilot.active)return {enrolled:false,reason:'not_active'};
 const entries=await loadPilotEnrollments(db,pilot);
 if(entries.some(x=>x.applicant_id===applicantId))return {enrolled:true,already:true};
 if(entries.length>=PILOT_LIMIT)return {enrolled:false,reason:'cohort_full'};
 requireData(await db.from('masar_events').insert({
  kind:'agent_pilot_enrolled',applicant_id:applicantId,
  detail:{run_id:pilot.run_id,whatsapp_account_id:accountId,source:'new_inbound'}
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
 const total=enroll.length;
 return {
  active:pilot?.active===true,
  status:!pilot?.active?'stopped':total>=PILOT_LIMIT?'cohort_full':'running',
  observation_only:true,existing_office_bot_unchanged:true,unsolicited_messages:false,
  started_at:pilot?.started_at||null,capacity:PILOT_LIMIT,enrolled:total,
  remaining:Math.max(0,PILOT_LIMIT-total),
  form_completed:formCompleted,awaiting_completion:interrupted,
  staff_intervention_candidates:transferred,
  completion_rate:total?Math.round(formCompleted/total*1000)/10:null,
  phone_numbers_returned:false,applicant_ids_returned:false,
  note:'التجربة بتراقب أول 50 متقدم جديد بدأوا المحادثة بأنفسهم على الرقم المحدد. هي لا توقف البوت الأساسي خارج العينة، ولا ترسل رسائل إضافية. زر الإيقاف يوقف المراقبة فقط.'
 };
}
