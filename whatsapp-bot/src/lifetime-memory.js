import {norm} from './domain.js';

/**
 * Lifetime conversational topic index (not a transcript, hiring decision or AI
 * knowledge base). Source of truth remains masar_messages; the index is only a
 * bounded, deterministic navigation aid for an entire applicant's history.
 *
 * Cursor lets long chats be processed incrementally instead of reloading only
 * their last N messages. Existing conversations are backfilled on first turn.
 */
const TOPICS={
 location:/(?:ساكن|سكن|المنصوريه|المنصوره|الهرم|اقرب|قريب|منطقه|مكان الشغل|زون|فرع)/,
 job_details:/(?:تفاصيل|طبيعه الشغل|نظام الشغل|الوظيفه|الماركت|ماركت|مطاعم|مطعم)/,
 payroll:/(?:مرتب|رواتب|راتب|قبض|فلوس|الفيزا|البونص|اوردارات|الاوردر)/,
 hours:/(?:شيفت|شفت|ورديه|ساعات|الوقت|مواعيد)/,
 documents:/(?:ورق|بطاقه|رخصه|مستند|صورت|صوره|تأمين|تامين)/,
 comparisons:/(?:قارن|مقارنه|افضل|احسن|الفرق|انسب|مميزات)/,
 application:/(?:كمل|نكمل|تقديم|اتقبل|تأهيل|تاهيل|الشروط)/,
 correction:/(?:قصدي|اقصد|مش ده|لا انا|انا قلتلك|قولتلك|تصحيح|غيرت)/,
 support:/(?:موظف|مسؤول|حد من الفريق|مش فاهم|مش واضح|مش عارف|معرفش)/
};
const TOPIC_KEYS=Object.keys(TOPICS);
const MAX_TOPIC_SNIPPET=115;
export const LIFETIME_MEMORY_VERSION=1;
export function emptyLifetimeMemory(){
 return {version:LIFETIME_MEMORY_VERSION,last_sequence:0,message_count:0,topic_counts:{},
  last_user_requests:{},recent_topics:[],corrected_place:null};
}
function cleanSnippet(value){
 return String(value||'').replace(/https?:\/\/\S+/g,'[رابط]')
  .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g,'[بريد]')
  .replace(/(?:\+?2?0?1\d{9,})/g,'[رقم]')
  .replace(/\s+/g,' ').trim().slice(0,MAX_TOPIC_SNIPPET);
}
function roleOf(row){
 return row?.direction==='in'?'applicant':row?.sender==='staff'?'staff':'agent';
}
function correctedPlace(text){
 const n=norm(text);
 // Only explicit correction, never infer an actual home address or work choice.
 if(/(?:المنصوريه.*مش\s+المنصوره|مش\s+المنصوره.*المنصوريه)/.test(n))
  return 'المنصورية (وليس المنصورة)';
 return null;
}
export function accumulateLifetimeMemory(existing,rows=[]){
 const previous=existing?.version===LIFETIME_MEMORY_VERSION?existing:emptyLifetimeMemory();
 const mem={
  ...previous,topic_counts:{...(previous.topic_counts||{})},
  last_user_requests:{...(previous.last_user_requests||{})},
  recent_topics:[...(previous.recent_topics||[])].slice(-8)
 };
 let changed=false;
 const ordered=[...(rows||[])].sort((a,b)=>Number(a.sequence)-Number(b.sequence));
 for(const row of ordered){
  const sequence=Number(row?.sequence);
  if(!Number.isSafeInteger(sequence)||sequence<=mem.last_sequence)continue;
  mem.last_sequence=sequence;
  mem.message_count=Math.min(1000000000,mem.message_count+1);
  changed=true;
  const role=roleOf(row);
  if(role==='agent'&&['failed','uncertain','queued','sending'].includes(row?.status))continue;
  const clean=cleanSnippet(row?.body);
  if(!clean)continue;
  const normalized=norm(clean);
  const tags=TOPIC_KEYS.filter(key=>TOPICS[key].test(normalized));
  if(!tags.length)continue;
  for(const key of tags){
   mem.topic_counts[key]=Math.min(1000000,(mem.topic_counts[key]||0)+1);
   if(role==='applicant')mem.last_user_requests[key]=clean;
  }
  mem.recent_topics.push({role,topics:tags.slice(0,3)});
  mem.recent_topics=mem.recent_topics.slice(-8);
  if(role==='applicant'){
   const correction=correctedPlace(clean);
   if(correction)mem.corrected_place=correction;
  }
 }
 return {memory:mem,changed};
}
export function lifetimeMemoryContext(answers={}){
 const m=answers?.__lifetime_memory;
 if(m?.version!==LIFETIME_MEMORY_VERSION)return null;
 const topicList=Object.entries(m.topic_counts||{}).sort((a,b)=>b[1]-a[1]).slice(0,9);
 return {
  historical_messages_indexed:Number(m.message_count)||0,
  recurring_topics:topicList.map(([topic,count])=>({topic,count})),
  // These are historic *claims/questions*, not verified applicant answers.
  historical_applicant_remarks:Object.fromEntries(topicList
   .filter(([key])=>m.last_user_requests?.[key])
   .map(([key])=>[key,String(m.last_user_requests[key]).slice(0,MAX_TOPIC_SNIPPET)])),
  latest_discussion_topics:(m.recent_topics||[]).slice(-6),
  explicit_location_correction:m.corrected_place||null,
  warning:'التاريخ للمساعدة في فهم السياق فقط. لا تعتبر السكن منطقة عمل، ولا تستخرج منه قبول أو رفض أو حقيقة تشغيلية غير مسجلة في CRM.'
 };
}
/** Read EVERY message once in paginated batches, then just unseen messages.
 * Scoped to an applicant UUID from the server, not a user-supplied query.
 * No new tables, separate API calls or summarizing LLM consumption.
 */
export async function loadLifetimeMemory(db,{applicantId,throughSequence,existing}={}){
 if(typeof applicantId!=='string'||!applicantId.trim())throw Error('missing applicant id');
 const end=Number(throughSequence);
 if(!Number.isSafeInteger(end)||end<1)return {memory:existing||emptyLifetimeMemory(),changed:false};
 let memory=existing?.version===LIFETIME_MEMORY_VERSION?existing:emptyLifetimeMemory();
 let changed=false;
 for(;;){
  const query=db.from('masar_messages')
   .select('sequence,direction,sender,body,status')
   .eq('applicant_id',applicantId).gt('sequence',memory.last_sequence)
   .lte('sequence',end).order('sequence',{ascending:true}).limit(250);
  const {data,error}=await query;
  if(error)throw error;
  const rows=data||[];
  if(!rows.length)break;
  const accumulated=accumulateLifetimeMemory(memory,rows);
  if(!accumulated.changed)break;
  memory=accumulated.memory;changed=true;
  if(rows.length<250)break;
 }
 return {memory,changed};
}
