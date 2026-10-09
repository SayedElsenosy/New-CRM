/**
 * Real Conversation Intelligence — privacy-by-design, deterministic observation.
 *
 * No LLM call, applicant transcript, phone, name, ID or message body enters
 * metrics or pattern output. Raw applicant IDs may be present in server-side
 * audit records for detecting consecutive incidents but are never returned.
 * Signals are heuristics for human review, NOT ground truth or hiring decisions.
 */
export const SIGNAL_TYPES=Object.freeze({
 ambiguous_reply:{label:'إجابة غير واضحة',severity:'medium',advice:'راجع صياغة سؤال التقديم وزوّد أمثلة توضيحية.'},
 knowledge_gap:{label:'معلومة غير مؤكدة',severity:'medium',advice:'راجع مخزن المعرفة واعتمد إجابة من المكتب قبل تعميمها.'},
 tool_failure:{label:'أداة CRM لم تُكمل الطلب',severity:'high',advice:'راجع نتائج أدوات المناطق/المسافات ومصدر البيانات.'},
 llm_fallback:{label:'رجوع للوضع الاحتياطي',severity:'medium',advice:'راجع اتصال مزود الذكاء وحدود الاستخدام قبل تعديل الرد.'},
 handoff:{label:'مطلوب تدخل موظف',severity:'high',advice:'افتح تنبيهات التدخل البشري وراجع أسباب التحويل.'},
 repeated_stall:{label:'توقف متكرر عند سؤال',severity:'high',advice:'افحص أسباب عدم فهم السؤال المتكرر قبل تغيير قواعد التأهيل.'},
 correction:{label:'تصحيح من المتقدم',severity:'low',advice:'راقب لو النظام حافظ على المعلومة المصححة.'},
 multiple_intents:{label:'طلب مركب',severity:'low',advice:'اختبر إن كل أجزاء الرسالة اتجاوبت من بيانات المكتب.'},
 domain_guidance:{label:'إجابة إرشاد عام',severity:'low',advice:'تأكد إنها مش بتقدم شرط توظيف خاص من غير مصدر.'}
});
const allowed=new Set(Object.keys(SIGNAL_TYPES));
const patt={
 ambiguous_reply:/(?:محتاج أوضح|مش فاهم الإجابة|وضح إجابتك|مش واضح|محتاج توضيح|قولّي قصدك|تقصد ايه)/,
 knowledge_gap:/(?:مش عندي إجابة مؤكدة|معلومة مش مؤكدة|مش هخمن|المعلومة دي مش متاحة|لازم نأكد)/,
 correction:/(?:قصدي|اقصد|أقصد|تصحيح|عايز أغير|عاوز اغير|غير الاجابة|مش ده اللي أقصده|لا أنا قصدي)/,
};
const cleanCount=value=>Number.isSafeInteger(Number(value))?Math.max(0,Math.min(99,Number(value))):0;
const validSignal=s=>typeof s==='string'&&allowed.has(s);

/**
 * Called after planTurn. Only bounded signal names go to masar_events.detail.
 * Incoming message is analyzed in memory and never saved as training text.
 */
export function turnQualitySignals({message='',reply='',turn={},llmUnavailable=false,awaitingBefore=null,awaitingAfter=null}={}){
 const source=String(message||'').slice(0,900);
 const output=String(reply||'').slice(0,2500);
 const signals=[];
 const add=name=>{if(allowed.has(name)&&!signals.includes(name))signals.push(name);};
 const action=String(turn?.agent_action||'');
 const noProgress=Boolean(awaitingBefore&&String(awaitingBefore)===String(awaitingAfter));
 if(noProgress&&(patt.ambiguous_reply.test(output)||/(?:clarify|retry|unknown_answer|ask_clarification)/.test(action)))add('ambiguous_reply');
 if(patt.knowledge_gap.test(output)||/(?:knowledge_gap|unknown_question|low_confidence)/.test(action))add('knowledge_gap');
 if(patt.correction.test(source))add('correction');
 if((turn?.tool_calls||[]).some(x=>x?.ok===false))add('tool_failure');
 if(llmUnavailable===true)add('llm_fallback');
 if(turn?.handoff===true)add('handoff');
 if(Array.isArray(turn?.tool_calls)&&turn.tool_calls.length>=2)add('multiple_intents');
 if(turn?.expert_source==='general_guidance')add('domain_guidance');
 return signals.slice(0,8);
}

/** Aggregate admin-visible patterns, not transcripts or applicant identities. */
export function conversationIntelligenceMetrics(events=[],{days=7,now=Date.now(),limit=5000}={}){
 const windowDays=Math.max(1,Math.min(30,Math.floor(Number(days)||7)));
 const since=now-windowDays*86400000;
 const sample=(Array.isArray(events)?events:[]).filter(x=>
  x.kind==='agent_turn'&&Date.parse(x.created_at)>=since
 ).slice(0,Math.max(1,Math.min(5000,Math.floor(Number(limit)||5000))));
 const signals=Object.fromEntries([...allowed].map(k=>[k,0]));
 const daily=new Map();
 const grouping=new Map();
 let flagged=0;
 // Input is ordered newest first. Work chronologically to detect consecutive
 // unproductive turns for the same person/question, then discard identity.
 for(const e of [...sample].sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at))){
  const detail=e.detail&&typeof e.detail==='object'?e.detail:{};
  const list=Array.isArray(detail.quality_signals)?[...new Set(detail.quality_signals.filter(validSignal))].slice(0,8):[];
  let repeat=false;
  if(e.applicant_id&&detail.awaiting_before&&detail.awaiting_after
   &&String(detail.awaiting_before)===String(detail.awaiting_after)
   &&(list.includes('ambiguous_reply')||list.includes('knowledge_gap'))){
   const key=String(e.applicant_id);
   const prior=grouping.get(key);
   const currentTime=Date.parse(e.created_at);
   const nextCount=prior?.question===detail.awaiting_after
    &&Number.isFinite(currentTime-prior.at)&&currentTime-prior.at<=48*3600000?prior.count+1:1;
   grouping.set(key,{question:detail.awaiting_after,count:nextCount,at:currentTime});
   if(nextCount>=2)repeat=true;
  }else if(e.applicant_id)grouping.delete(String(e.applicant_id));
  if(repeat)list.push('repeated_stall');
  if(list.length)flagged++;
  for(const name of new Set(list))signals[name]++;
  const day=String(e.created_at||'').slice(0,10);
  if(day){
   if(!daily.has(day))daily.set(day,{day,turns:0,flagged:0,handovers:0});
   const row=daily.get(day);row.turns++;if(list.length)row.flagged++;
   if(list.includes('handoff'))row.handovers++;
  }
 }
 const total=sample.length;
 const rate=total?Math.round(flagged/total*1000)/10:null;
 const patterns=Object.entries(signals).filter(([,count])=>count>0)
  .map(([key,count])=>({key,label:SIGNAL_TYPES[key].label,severity:SIGNAL_TYPES[key].severity,
   count,rate:total?Math.round(count/total*1000)/10:null,advice:SIGNAL_TYPES[key].advice}))
  .sort((a,b)=>({high:3,medium:2,low:1}[b.severity]-{high:3,medium:2,low:1}[a.severity])||b.count-a.count);
 return {
  version:'5.0',mode:'observation_only',
  window_days:windowDays,sampled_turns:total,flagged_turns:flagged,flag_rate:rate,
  patterns,day_trend:[...daily.values()].sort((a,b)=>a.day.localeCompare(b.day)),
  requires_human_approval:true,auto_learning:false,applicant_data_used_in_output:false,
  warning:'مؤشرات احتمالية تعتمد على بيانات التشغيل، مش حكم على دقة الإجابات. يلزم تقييم بشري للحالات.'
 };
}

export function safeLearningProposal(question,answer){
 const q=String(question||'').trim(),a=String(answer||'').trim();
 if(q.length<3||a.length<3||q.length>2000||a.length>4000)return false;
 const value=(q+'\n'+a).replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-0x660))
  .replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-0x6f0));
 const sensitive=/(?:\+?20[\s-]*)?01[0125](?:[\s-]*\d){8}\b|\b\d{14,16}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:شارع|عمارة|شقة|منزل رقم|رقمي الشخصي|بطاقتي رقم|تليفوني|موبايلي)/i;
 if(sensitive.test(value))return false;
 return true;
}
