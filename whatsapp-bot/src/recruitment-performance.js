/**
 * Phase 6: privacy-preserving recruitment pilot measurements.
 *
 * Only data from a bounded cohort is considered. Applicant IDs remain in
 * process for counting message activity and are never included in the output.
 * Completion is current FORM stage, not hiring/acceptance. The database does
 * not store an authoritative completion timestamp, so we do not invent one.
 */
const doneStages=new Set(['complete','lecture','working']);
const stages=new Set(['new','incomplete','complete','lecture','working']);
const pct=(n,d)=>d?Math.round(n/d*1000)/10:null;
const median=values=>{
 const ordered=values.filter(x=>Number.isFinite(x)&&x>=0).sort((a,b)=>a-b);
 if(!ordered.length)return null;
 const mid=Math.floor(ordered.length/2);
 return Math.round(ordered.length%2?ordered[mid]:(ordered[mid-1]+ordered[mid])/2);
};
function validDays(value){
 const n=Number(value);
 return Number.isInteger(n)&&n>=1&&n<=30?n:7;
}
const stamp=value=>{
 const n=Date.parse(value);
 return Number.isFinite(n)?n:null;
};
export function recruitmentPerformance({
 applicants=[],messages=[],decisions=[],days=7,now=Date.now(),
 applicantsTotal=null,messagesTotal=null,decisionsTotal=null
}={}){
 const windowDays=validDays(days),start=now-windowDays*86400000;
 const cohort=(Array.isArray(applicants)?applicants:[]).filter(x=>{
  const t=stamp(x?.created_at);
  return t!==null&&t>=start&&t<=now;
 });
 const byId=new Map(cohort.filter(x=>typeof x.id==='string').map(x=>[x.id,x]));
 const counts={new:0,incomplete:0,complete:0,lecture:0,working:0,unknown:0};
 const incompleteAges=[],completed=[];
 const staleCutoff=now-24*3600000;
 let stale=0;
 for(const applicant of cohort){
  const stage=stages.has(applicant.stage)?applicant.stage:'unknown';
  counts[stage]++;
  if(doneStages.has(stage))completed.push(applicant);
  if(stage==='new'||stage==='incomplete'){
   const last=stamp(applicant.last_message_at)||stamp(applicant.created_at);
   if(last!==null){
    incompleteAges.push(Math.max(0,(now-last)/3600000));
    if(last<staleCutoff)stale++;
   }
  }
 }
 const inboundCounts=new Map(),botCount=new Map();
 let inbound=0,outboundBot=0;
 for(const m of Array.isArray(messages)?messages:[]){
  const at=stamp(m?.created_at);
  if(at===null||at<start||at>now||!byId.has(m.applicant_id))continue;
  if(m.direction==='in'){
   inbound++;
   inboundCounts.set(m.applicant_id,(inboundCounts.get(m.applicant_id)||0)+1);
  }else if(m.direction==='out'&&m.sender==='bot'){
   outboundBot++;
   botCount.set(m.applicant_id,(botCount.get(m.applicant_id)||0)+1);
  }
 }
 const latency=[];
 for(const d of Array.isArray(decisions)?decisions:[]){
  const at=stamp(d?.created_at),n=Number(d?.latency_ms);
  if(at!==null&&at>=start&&at<=now&&Number.isFinite(n)&&n>=0&&n<=120000
   &&(!d.applicant_id||byId.has(d.applicant_id)))latency.push(n);
 }
 const sample={
  cohort_applicants:cohort.length,inbound_messages:inbound,
  bot_messages:outboundBot,planner_latency_samples:latency.length,
  capped:{
   applicants:Number.isFinite(Number(applicantsTotal))&&Number(applicantsTotal)>applicants.length,
   messages:Number.isFinite(Number(messagesTotal))&&Number(messagesTotal)>messages.length,
   decisions:Number.isFinite(Number(decisionsTotal))&&Number(decisionsTotal)>decisions.length
  }
 };
 const truncated=Object.values(sample.capped).some(Boolean);
 const engaged=[...inboundCounts.values()].filter(x=>x>0).length;
 return {
  version:'6.0',period_days:windowDays,cohort_definition:'متقدمون تم إنشاؤهم خلال الفترة المختارة',
  sample,partial_sample:truncated,
  funnel:{
   registered:cohort.length,
   engaged,engagement_rate:truncated?null:pct(engaged,cohort.length),
   form_completed:completed.length,
   completion_rate:truncated?null:pct(completed.length,cohort.length),
   by_stage:counts,
   stalled_24h:stale,stalled_rate:truncated?null:pct(stale,counts.new+counts.incomplete)
  },
  volume:{
   inbound_messages:inbound,bot_messages:outboundBot,
   avg_inbound_per_applicant:truncated?null:cohort.length?Math.round(inbound/cohort.length*10)/10:null,
   median_planner_latency_ms:median(latency),
   completion_duration_minutes:null,
   completion_duration_note:'مش متاح حاليًا توقيت موثوق لاكتمال البيانات؛ آخر تعديل للملف مش معناه اكتمال التقديم.'
  },
  accuracy:{
   human_verified_responses:0,correct:null,accuracy_rate:null,
   note:'دقة الإجابات تحتاج أحكام مراجعة بشرية موثقة. الثقة واختبارات المحاكاة مش بديل ليها.'
  },
  privacy:{raw_text_used:false,pii_returned:false,applicant_ids_returned:false},
  methodology:'حالة اكتمال الاستمارة الحالية للمتقدمين المسجلين خلال الفترة؛ لا تمثل قرار قبول أو تعيين، ولا تقيس الزمن الحقيقي لإكمال البيانات.',
  daily_cohort:aggregateDays(cohort)
 };
}
function aggregateDays(cohort){
 const days=new Map();
 for(const a of cohort){
  const day=String(a.created_at||'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))continue;
  if(!days.has(day))days.set(day,{day,registered:0,currently_completed:0});
  const d=days.get(day);d.registered++;
  if(doneStages.has(a.stage))d.currently_completed++;
 }
 return [...days.values()].sort((a,b)=>a.day.localeCompare(b.day));
}

/**
 * A READ-ONLY rollout planning card, deliberately not a feature toggle.
 * No pilot can be turned on in this phase without independent DB+Storage
 * backups and explicit later deployment/launch approval.
 */
export function pilotReadiness({databaseBackupVerified=false,storageBackupVerified=false,
 recoveryTestVerified=false,qualitySuitePassed=false,humanReviewProcessReady=false}={}){
 const checks=[
  {id:'db_backup',label:'نسخة قاعدة بيانات مستقلة قابلة للاسترجاع',ready:databaseBackupVerified===true},
  {id:'storage_backup',label:'نسخة فعلية من ملفات Supabase Storage',ready:storageBackupVerified===true},
  {id:'restore_verified',label:'اختبار استرجاع آمن على بيئة معزولة',ready:recoveryTestVerified===true},
  {id:'synthetic_regression',label:'اجتياز اختبارات الـ Agent الاصطناعية',ready:qualitySuitePassed===true},
  {id:'review_workflow',label:'مراجعة بشرية ومعايير تصعيد واضحة',ready:humanReviewProcessReady===true}
 ];
 return {status:'blocked',pilot_active:false,production_cohort_size:0,
  proposal:{first_cohort_min:50,first_cohort_max:100,expansion_requires_manual_approval:true},
  checks,ready_for_approval:checks.every(x=>x.ready),
  note:'دي قائمة جاهزية للمرحلة التجريبية وليست أداة لتفعيلها. ما تمش اختيار أرقام أو إرسال رسائل جديدة.'
 };
}
