import {norm,digits} from './domain.js';

const QUESTION_WORDS=['ايه','اي','ازاي','فين','كام','امتى','متي','هل','ممكن','عايز اعرف','عاوز اعرف','تفاصيل','مرتب','راتب','قبض','دخل','عنوان','مكان','مواعيد','ميعاد','ساعات','شفت','مميزات','تأمين','تامين','اجازه','اجازة','بونص','تقديم','محاضره','محاضرة','انترفيو'];
const STOP=new Set(['في','من','على','علي','عن','هو','هي','ده','دي','دا','انا','انت','انتم','يا','لو','و','او','ولا','بس','بقى','بقا','كده','كدا','ايه','هل','ممكن','عايز','عاوز','اعرف','تفاصيل']);
const REPLACEMENTS=[
 [/(?:ميعاد|مواعيد|امتي|امتى|متي)/g,'وقت'],
 [/(?:مرتب|راتب|قبض|دخل)/g,'مرتب'],
 [/(?:عنوان|مكان|لوكيشن)/g,'مكان'],
 [/(?:ساعات|ساعه|ساعة|شفت|ورديه|وردية)/g,'شفت'],
 [/(?:اجازه|اجازة|اجازات|إجازة|إجازات)/g,'اجازه'],
 [/(?:تأمين|تامين|التأمين|التامين)/g,'تامين'],
 [/(?:موتوسيكل|موتوسكل|مكنه|مكنة)/g,'موتوسيكل'],
 [/(?:تقديم|اقدم|أقدم|التقديم)/g,'تقديم'],
 [/(?:محاضره|محاضرة|المحاضره|المحاضرة)/g,'محاضره']
];

export const schemaMissing=e=>['PGRST205','42P01','42703'].includes(e?.code);

function canonical(value){
 let s=norm(digits(value)).replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
 for(const [pattern,replacement] of REPLACEMENTS)s=s.replace(pattern,replacement);
 return s;
}
function tokens(value){
 return canonical(value).split(' ').filter(t=>t.length>1&&!STOP.has(t));
}
function trigrams(value){
 const s='  '+canonical(value)+'  ',out=new Set();
 for(let i=0;i<s.length-2;i++)out.add(s.slice(i,i+3));
 return out;
}
function overlap(a,b){
 if(!a.size||!b.size)return 0;let n=0;for(const x of a)if(b.has(x))n++;
 return n;
}
function dice(a,b){const n=overlap(a,b);return a.size+b.size?2*n/(a.size+b.size):0;}
function autoKeywords(question){
 const seen=new Set(tokens(question));
 return [...seen].slice(0,12);
}
export function suggestKeywords(question){return autoKeywords(question);}
export function looksLikeQuestion(text){
 const raw=String(text||'').trim(),n=canonical(raw);
 if(raw.length<4||raw.length>2000)return false;
 if(/[?؟]/.test(raw)&&raw.length>=6)return true;
 const words=n.split(/\s+/).filter(Boolean);
 return QUESTION_WORDS.some(item=>{
  const q=canonical(item);
  if(!q)return false;
  if(q.includes(' '))return (' '+n+' ').includes(' '+q+' ');
  return words.some(word=>word===q||word==='ال'+q||word==='و'+q||word==='وال'+q);
 });
}
function usefulAnswer(answer){
 const a=String(answer||'').trim();if(a.length<3||a.length>4000)return false;
 const n=canonical(a);
 return !['تمام','اوكي','ok','okay','حاضر','شكرا','شكراً','اه','ايوه','لا','لاء'].map(canonical).includes(n);
}
export function isLearnableExchange(question,answer,{force=false}={}){
 const q=String(question||'').trim();
 if(!usefulAnswer(answer))return false;
 if(force)return q.length>=3&&q.length<=2000;
 return looksLikeQuestion(q);
}

const CASE_SPECIFIC_PATTERNS=[
 /(?:هكلمك|هنكلمك|هنتواصل معاك|هتواصل معاك|هرد عليك|هنرد عليك|هقولك|هبعتلك|هنبعتلك)/,
 /(?:موعدك|ميعادك|حجزك|طلبك|ملفك|بياناتك|رقمك|اسمك عندنا)/,
 /(?:تعالي|تعالى|تعال|استني|استنى|انتظر).*(?:بكره|النهارده|اليوم|الساعه|الساعة)/,
 /(?:بكره|غدا|النهارده|اليوم)\s+(?:الساعه|الساعة)?\s*\d{1,2}/,
 /(?:تم حجز|حجزنالك|حجزنا لك|ميعاد الانترفيو|موعد الانترفيو).*(?:\d|بكره|النهارده|اليوم)/
];
const TRIVIAL_CONTEXT=new Set(['تمام','اوكي','ok','okay','حاضر','شكرا','شكراً','اه','ايوه','ايوا','نعم','لا','لاء','ماشي']);
const CORRECTION_WORDS=/(?:الصح|تصحيح|اتغير|اتغيّر|بقي|بقى|حاليا|حاليًا|دلوقتي|تعديل|مش كده|مش كدا|بدل)/;

function meaningfulContext(text){
 const raw=String(text||'').trim();
 const n=canonical(raw);
 return raw.length>=3&&raw.length<=2000&&!TRIVIAL_CONTEXT.has(n);
}
export function isOperationalMemoryCandidate(question,answer,{force=false}={}){
 const q=String(question||'').trim(),a=String(answer||'').trim();
 if(!meaningfulContext(q)||!usefulAnswer(a))return false;
 const normalizedAnswer=norm(digits(a)).replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
 if(CASE_SPECIFIC_PATTERNS.some(pattern=>pattern.test(normalizedAnswer)))return false;
 if(looksLikeQuestion(q))return true;
 if(force)return q.length>=3&&q.length<=2000;
 // Staff often teaches a rule by answering a statement rather than a literal question.
 return tokens(q).length>=2;
}
function messageRole(message){
 if(message?.sender==='staff'||(message?.direction==='out'&&message?.sender!=='bot'))return 'staff';
 if(message?.sender==='applicant'||message?.direction==='in')return 'applicant';
 return message?.sender==='bot'?'bot':'other';
}
export function extractConversationMemory(messages,staffMessageId,{force=false}={}){
 const list=(Array.isArray(messages)?messages:[]).filter(m=>String(m?.body||'').trim());
 let index=staffMessageId?list.findIndex(m=>String(m.id)===String(staffMessageId)):-1;
 if(index<0)index=list.length-1;
 const staff=list[index];
 if(!staff||messageRole(staff)!=='staff'||!usefulAnswer(staff.body))return null;
 const before=list.slice(Math.max(0,index-16),index);
 const applicantMessages=before.filter(m=>messageRole(m)==='applicant'&&meaningfulContext(m.body));
 if(!applicantMessages.length)return null;
 const recent=[...applicantMessages].reverse();
 const source=recent.find(m=>isOperationalMemoryCandidate(m.body,staff.body,{force}));
 if(!source)return null;
 const context=before.slice(-8).map(m=>{
  const role=messageRole(m);
  const label=role==='staff'?'موظف':role==='applicant'?'متقدم':role==='bot'?'بوت':'رسالة';
  return label+': '+String(m.body||'').trim().slice(0,500);
 }).join('\n');
 return {
  question:String(source.body).trim().slice(0,2000),
  answer:String(staff.body).trim().slice(0,4000),
  source_message_id:source.id||null,
  staff_message_id:staff.id||staffMessageId||null,
  context:context.slice(0,4000)
 };
}
function shouldReplaceKnowledgeAnswer(previous,next){
 const oldText=String(previous||'').trim(),newText=String(next||'').trim();
 if(!oldText)return true;
 const oldCanonical=canonical(oldText),newCanonical=canonical(newText);
 if(oldCanonical===newCanonical)return false;
 if(oldCanonical.includes(newCanonical)&&oldText.length>=newText.length)return false;
 if(newCanonical.includes(oldCanonical)&&newText.length>oldText.length)return true;
 if(CORRECTION_WORDS.test(newCanonical))return true;
 return newText.length>=Math.max(20,Math.round(oldText.length*.8));
}
async function insertAuditSuggestion(db,{applicantId,officeId=null,candidate,staffId,status='approved'}){
 const row={
  applicant_id:applicantId,
  ...(officeId?{office_id:officeId}:{}),
  source_message_id:candidate.source_message_id,
  staff_message_id:candidate.staff_message_id,
  question:candidate.question,
  answer:candidate.answer,
  status,
  created_by:staffId||null,
  reviewed_by:staffId||null,
  reviewed_at:new Date().toISOString()
 };
 const result=await db.from('masar_learning_suggestions').insert(row).select('id').maybeSingle();
 if(result&&result.error){
  if(result.error.code==='23505')return null;
  throw result.error;
 }
 return result?.data||null;
}
async function recordMemoryEvent(db,{applicantId,kind,detail}){
 try{
  const result=await db.from('masar_events').insert({applicant_id:applicantId||null,kind,detail});
  if(result.error)throw result.error;
 }catch(e){if(!schemaMissing(e))throw e;}
}
async function upsertOperationalMemory(db,{applicantId,officeId=null,candidate,staffId,suggestionId=null}){
 let knowledgeQuery=db.from('masar_knowledge').select('*').eq('active',true);
 if(officeId)knowledgeQuery=knowledgeQuery.or('office_id.is.null,office_id.eq.'+officeId);
 const knowledgeResult=await knowledgeQuery.order('updated_at',{ascending:false});
 if(knowledgeResult.error)throw knowledgeResult.error;
 const rows=knowledgeResult.data||[];
 const match=findKnowledgeAnswer(candidate.question,rows,.84,{allowStatement:true});
 const now=new Date().toISOString();
 if(match){
  if(match.source==='manual'){
   await recordMemoryEvent(db,{applicantId,kind:'ai_memory_manual_preserved',detail:{knowledge_id:match.id,question:candidate.question,source_message_id:candidate.source_message_id,staff_message_id:candidate.staff_message_id}});
   return {learned:false,action:'manual_preserved',knowledge_id:match.id,question:candidate.question};
  }
  const replace=shouldReplaceKnowledgeAnswer(match.answer,candidate.answer);
  const keywords=[...new Set([...(match.keywords||[]),...autoKeywords(candidate.question)])].slice(0,20);
  const patch={keywords,updated_at:now,active:true};
  if(replace)patch.answer=candidate.answer;
  const update=await db.from('masar_knowledge').update(patch).eq('id',match.id);
  if(update.error)throw update.error;
  await recordMemoryEvent(db,{applicantId,kind:replace?'ai_memory_updated':'ai_memory_reinforced',detail:{knowledge_id:match.id,question:candidate.question,answer:candidate.answer,context:candidate.context||'',source_message_id:candidate.source_message_id,staff_message_id:candidate.staff_message_id}});
  return {learned:true,action:replace?'updated':'reinforced',knowledge_id:match.id,question:candidate.question};
 }
 const row={
  question:candidate.question,
  answer:candidate.answer,
  keywords:autoKeywords(candidate.question),
  active:true,
  source:'staff',
  ...(officeId?{office_id:officeId}:{}),
  created_by:staffId||null,
  ...(suggestionId?{source_suggestion_id:suggestionId}:{})
 };
 const inserted=await db.from('masar_knowledge').insert(row).select().single();
 if(inserted.error)throw inserted.error;
 await recordMemoryEvent(db,{applicantId,kind:'ai_memory_learned',detail:{knowledge_id:inserted.data.id,question:candidate.question,answer:candidate.answer,context:candidate.context||'',source_message_id:candidate.source_message_id,staff_message_id:candidate.staff_message_id}});
 return {learned:true,action:'created',knowledge_id:inserted.data.id,question:candidate.question};
}
export async function learnFromConversation(db,{applicantId,officeId=null,staffMessageId,staffId=null,force=false}){
 try{
  if(!officeId){
   const applicantResult=await db.from('masar_applicants').select('office_id').eq('id',applicantId).maybeSingle();
   if(!applicantResult.error)officeId=applicantResult.data?.office_id||null;
   else if(!schemaMissing(applicantResult.error)&&applicantResult.error.code!=='PGRST204')throw applicantResult.error;
  }
  const messagesResult=await db.from('masar_messages').select('id,direction,sender,body,sequence,created_at').eq('applicant_id',applicantId).order('sequence',{ascending:false}).limit(40);
  if(messagesResult.error)throw messagesResult.error;
  const messages=[...(messagesResult.data||[])].reverse();
  const candidate=extractConversationMemory(messages,staffMessageId,{force});
  if(!candidate){
   await recordMemoryEvent(db,{applicantId,kind:'ai_memory_skipped',detail:{staff_message_id:staffMessageId,reason:'case_specific_or_no_stable_context'}});
   return {learned:false,action:'skipped'};
  }
  let suggestion=null;
  try{suggestion=await insertAuditSuggestion(db,{applicantId,officeId,candidate,staffId,status:'approved'});}catch(e){if(!schemaMissing(e)&&e.code!=='PGRST204')throw e;}
  return await upsertOperationalMemory(db,{applicantId,officeId,candidate,staffId,suggestionId:suggestion?.id||null});
 }catch(e){
  if(schemaMissing(e))return {learned:false,action:'schema_missing'};
  throw e;
 }
}
export async function promotePendingLearning(db,{limit=500}={}){
 try{
  const pendingResult=await db.from('masar_learning_suggestions').select('*').eq('status','pending').order('created_at',{ascending:true}).limit(limit);
  if(pendingResult.error)throw pendingResult.error;
  let promoted=0,skipped=0;
  for(const suggestion of pendingResult.data||[]){
   const candidate={
    question:String(suggestion.question||'').trim(),
    answer:String(suggestion.answer||'').trim(),
    source_message_id:suggestion.source_message_id||null,
    staff_message_id:suggestion.staff_message_id||null,
    context:''
   };
   if(!isOperationalMemoryCandidate(candidate.question,candidate.answer,{force:true})){
    const rejected=await db.from('masar_learning_suggestions').update({status:'rejected',reviewed_at:new Date().toISOString()}).eq('id',suggestion.id);
    if(rejected.error)throw rejected.error;
    skipped++;continue;
   }
   let officeId=suggestion.office_id||null;
   if(!officeId&&suggestion.applicant_id){
    const applicantResult=await db.from('masar_applicants').select('office_id').eq('id',suggestion.applicant_id).maybeSingle();
    if(!applicantResult.error)officeId=applicantResult.data?.office_id||null;
   }
   await upsertOperationalMemory(db,{applicantId:suggestion.applicant_id,officeId,candidate,staffId:suggestion.created_by,suggestionId:null});
   const approved=await db.from('masar_learning_suggestions').update({status:'approved',reviewed_by:suggestion.created_by||null,reviewed_at:new Date().toISOString()}).eq('id',suggestion.id);
   if(approved.error)throw approved.error;
   promoted++;
  }
  return {promoted,skipped};
 }catch(e){if(schemaMissing(e))return {promoted:0,skipped:0};throw e;}
}
function scoreEntry(text,row){
 const q=canonical(text),target=canonical(row.question);
 if(!q||!target)return 0;
 if(q===target)return 1;
 if(q.length>=6&&target.length>=6&&(q.includes(target)||target.includes(q)))return .94;
 const qa=new Set(tokens(q)),ta=new Set(tokens(target)),inter=overlap(qa,ta);
 const union=new Set([...qa,...ta]).size;
 const jaccard=union?inter/union:0,coverage=Math.min(qa.size,ta.size)?inter/Math.min(qa.size,ta.size):0;
 const char=dice(trigrams(q),trigrams(target));
 let score=jaccard*.48+coverage*.32+char*.20;
 const keywordList=[...(row.keywords||[]),...autoKeywords(row.question)].map(canonical).filter(Boolean);
 let keywordHits=0;
 for(const keyword of new Set(keywordList)){
  if(q.includes(keyword))keywordHits++;
 }
 if(keywordHits>=2)score+=.12;
 else if(keywordHits===1)score+=.06;
 return Math.min(1,score);
}
const TOPIC_GENERIC=new Set(['معاك','معايا','عندك','عندي','عنده','عندها','موجود','موجوده','متاح','مطلوب','لازم','عايز','عاوز','اه','ايوه','ايوا','نعم','لا','لاء']);
function topicTokens(value){return tokens(value).filter(t=>!TOPIC_GENERIC.has(t));}
export function sameKnowledgeTopic(left,right){
 const a=new Set(topicTokens(left)),b=new Set(topicTokens(right));
 if(!a.size||!b.size)return false;
 const common=overlap(a,b);
 if(a.size===1||b.size===1)return a.size===b.size&&common===1;
 return common/Math.max(a.size,b.size)>=.75;
}
export function findKnowledgeAnswer(text,rows,threshold=.62,{allowStatement=false}={}){
 if(!allowStatement&&!looksLikeQuestion(text))return null;
 const active=(rows||[]).filter(r=>r.active!==false);
 let best=null;
 for(const row of active){
  const confidence=scoreEntry(text,row);
  if(!best||confidence>best.confidence)best={...row,confidence};
 }
 return best&&best.confidence>=threshold?best:null;
}
export async function loadKnowledge(db,officeId=null){
 try{
  let query=db.from('masar_knowledge').select('*').eq('active',true);
  if(officeId)query=query.or('office_id.is.null,office_id.eq.'+officeId);
  const result=await query.order('updated_at',{ascending:false});
  if(result.error)throw result.error;
  return result.data||[];
 }catch(e){
  if(['42703','PGRST204'].includes(e?.code||'')){
   const legacy=await db.from('masar_knowledge').select('*').eq('active',true).order('updated_at',{ascending:false});
   if(legacy.error){if(schemaMissing(legacy.error))return [];throw legacy.error;}
   return legacy.data||[];
  }
  if(schemaMissing(e))return [];
  throw e;
 }
}
export async function createLearningSuggestion(db,{applicantId,officeId=null,sourceMessage,staffMessageId,answer,staffId,force=false}){
 if(!isLearnableExchange(sourceMessage?.body,answer,{force}))return false;
 try{
  const result=await db.from('masar_learning_suggestions').insert({
   applicant_id:applicantId,
   ...(officeId?{office_id:officeId}:{}),
   source_message_id:sourceMessage.id,
   staff_message_id:staffMessageId,
   question:String(sourceMessage.body).trim().slice(0,2000),
   answer:String(answer).trim().slice(0,4000),
   created_by:staffId
  });
  if(result.error){
   if(result.error.code==='23505')return false;
   throw result.error;
  }
  return true;
 }catch(e){if(schemaMissing(e))return false;throw e;}
}
