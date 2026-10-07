import {norm,digits,areaRejected} from './domain.js';

const INFO_WORDS=['تفاصيل','مرتب','راتب','قبض','عنوان','مكان','مواعيد','ساعات','شفت','شغل','نظام','مميزات','بونص','زون'];
const NEGATIVE=[
 'لا','لاء','لأ','معنديش','ما عنديش','معيش','مش معايا','مش عندي','لسه مجبتش','لسه ما جبتش',
 'مفيش','مش موجود','مش موجوده','مش متاح','من غير','بدون','ماعنديش','مافيش'
];
const POSITIVE=['نعم','ايوه','ايوا','اه','أه','تمام','موافق','عندي','معايا','موجود','متاح','yes','yep','yeah'];

const FRANCO_REPLACEMENTS=[
 [/\b(?:3ayz|3awez|3awz|3ayez)\b/gi,'عايز'],
 [/\b(?:m3aya|ma3aya)\b/gi,'معايا'],
 [/\b(?:m3ndish|ma3ndish|m3andish|ma3andish)\b/gi,'معنديش'],
 [/\b(?:aywa|aiwa|aywah)\b/gi,'ايوه'],
 [/\b(?:la2|laa)\b/gi,'لا'],
 [/\b(?:moto|motorcycle|motosikl|motosikl)\b/gi,'موتوسيكل'],
 [/\b(?:shift)\b/gi,'شيفت'],
 [/\b(?:salary)\b/gi,'مرتب'],
 [/\b(?:kam)\b/gi,'كام'],
 [/\b(?:tamam|tmam)\b/gi,'تمام'],
 [/\b(?:ready)\b/gi,'جاهز'],
 [/\b(?:october|octobr|oktober)\b/gi,'أكتوبر'],
 [/\b(?:tagamo3|tagamoa|tagamo)\b/gi,'التجمع'],
 [/\b(?:nasr\s*city|madinet\s*nasr)\b/gi,'مدينة نصر']
];
function normalizeEgyptianInput(value){
 let s=String(value??'');
 for(const [pattern,replacement] of FRANCO_REPLACEMENTS)s=s.replace(pattern,replacement);
 return s;
}
const clean=v=>norm(digits(normalizeEgyptianInput(v))).replace(/[^\p{L}\p{N}\s?؟]/gu,' ').replace(/\s+/g,' ').trim();
const hasAny=(text,words)=>{const tokens=new Set(text.split(' '));return words.some(w=>{const x=clean(w);return x.includes(' ')?text.includes(x):text===x||tokens.has(x);});};

function areaHits(text,areas){
 const n=clean(text);
 return areas.filter(a=>a.active).filter(a=>{
  const names=[a.name,...(Array.isArray(a.aliases)?a.aliases:[])].map(clean).filter(Boolean);
  return names.some(name=>{
   if(n.includes(name))return true;
   const tokens=name.split(' ').filter(t=>t.length>=3&&!['الشيخ','مدينه','مدينة','منطقه','منطقة'].includes(t));
   return tokens.length>0&&tokens.every(t=>n.includes(t));
  });
 });
}

function directLeadingYesNo(text){
 const first=clean(text).split(' ')[0]||'';
 if(['نعم','ايوه','ايوا','اه','yes','yep','yeah'].map(clean).includes(first))return 'yes';
 if(['لا','لاء','لأ','no'].map(clean).includes(first))return 'no';
 return null;
}

function indirectYesNo(text){
 const n=clean(text);
 // A direct leading answer belongs to the question the bot just asked.
 // This prevents a side clause such as "اه بس مش معايا رخصة" from flipping
 // the current motorcycle answer to "no" just because it contains a later negation.
 const direct=directLeadingYesNo(n);
 if(direct)return direct;
 // Negation wins before positive words because phrases like "مش معايا" contain "معايا".
 if(hasAny(n,NEGATIVE))return 'no';
 if(hasAny(n,POSITIVE))return 'yes';
 return null;
}

function numberAnswer(text){
 const n=clean(text);
 const values=[...n.matchAll(/(?:^|\s)(\d{1,3})(?=\s|$)/g)].map(m=>Number(m[1])).filter(v=>v>=1&&v<=100);
 return values.length===1?String(values[0]):null;
}

function nameAnswer(text){
 const raw=String(text||'').trim();
 const stripped=raw
  .replace(/^(?:انا\s+)?(?:اسمي|إسمي|اسمى|الاسم|الاسم هو)\s*[:\-]?\s*/i,'')
  .trim();
 if(stripped===raw||stripped.length<2||/[?؟]/.test(stripped))return null;
 return stripped;
}

const CHANGE_WORDS=/(?:غيرت رايي|غيرت رأيي|عايز اغير|عاوز اغير|ممكن اغير|عايز اعدل|عاوز اعدل|ممكن اعدل|اصحح|صحح|تعديل)/;
const HUMAN_WORDS=/(?:عايز|عاوز|محتاج|ممكن|اريد|أريد|حولني|حوّلني|وصلني|كلمني).*?(?:موظف|مسؤول توظيف|مسئول توظيف|خدمه العملاء|خدمة العملاء|حد من التوظيف)/;
const CLARIFY_WORDS=/(?:مش فاهم|مش واضح|وضحلي|وضح لي|ممكن توضح|يعني ايه|يعني اي|السؤال ده معناه|السؤال دا معناه)/;
const RESUME_WORDS=/^(?:(?:تمام|ماشي|اوكي|أوكي)\s+)?(?:كمل|نكمل|كمل التقديم|نكمل التقديم|نرجع نكمل|يلا نكمل)$/;

function changeTarget(n){
 if(/(?:منطقه|منطقة|مكان الشغل|مكان العمل)/.test(n))return 'preferred_work_area';
 if(/(?:موتوسيكل|موتسيكل|موتور)/.test(n))return 'has_motorcycle';
 if(/(?:اسمي|الاسم|اسم)/.test(n))return 'full_name';
 if(/(?:شيفت|شفت|ساعات العمل)/.test(n))return 'shift_acceptance';
 if(/(?:ابدا|ابدأ|البدايه|البداية|جاهز ابدا|جاهز أبدأ)/.test(n))return 'ready_to_start';
 return null;
}

/**
 * Conversation-level decision layer.
 * It handles safe navigation/control intents before the flow escalates to a human.
 * It never changes qualification rules; it only decides how to continue the chat.
 */
export function decideConversationAction(text,question,areas=[]){
 const n=clean(text);
 if(!n)return {action:'unknown',confidence:0};

 if(HUMAN_WORDS.test(n)&&!/(?:مش|ما)\s+(?:عايز|عاوز|محتاج)/.test(n)){
  return {action:'handoff',reason:'user_requested_human',confidence:0.99};
 }
 if(CLARIFY_WORDS.test(n)){
  return {action:'clarify_current',confidence:0.98};
 }
 if(RESUME_WORDS.test(n)){
  return {action:'resume_flow',confidence:0.98};
 }
 if(CHANGE_WORDS.test(n)){
  const field_key=changeTarget(n);
  return field_key
   ?{action:'change_answer',field_key,confidence:0.97}
   :{action:'clarify_change_target',confidence:0.9};
 }

 const mentioned=areaHits(text,areas);
 if(question?.field_key==='preferred_work_area'&&mentioned.length===1){
  const residenceOnly=/(?:ساكن|سكني|السكن|انا من|أنا من)/.test(n)
   &&!/(?:عايز|عاوز|حابب|هشتغل|اشتغل|اقدر اشتغل|أقدر اشتغل|التزم|ينفعلي|مناسبه ليا|مناسبة ليا)/.test(n);
  if(!residenceOnly)return {action:'answer_current',field_key:'preferred_work_area',area_id:mentioned[0].id,confidence:0.97};
 }

 return {action:'unknown',confidence:0.5};
}

const MOTORCYCLE_WORDS=/(?:موتوسيكل|موتوسكل|موتسيكل|مكنه|مكنة|موتور)/;
const LICENSE_WORDS=/(?:رخصه|رخصة|الرخصه|الرخصة|license)/;
const AGE_WORDS=/(?:سني|سنى|عمري|العمر|السن|سنه|سنة|عام)/;
const RESIDENCE_WORDS=/(?:ساكن|سكني|السكن|انا من|أنا من)/;
const SHIFT_WORDS=/(?:شيفت|شفت|ورديه|وردية|ساعات الشغل|ساعات العمل|\d+\s*ساع)/;
const READY_WORDS=/(?:ابدا|ابدأ|بدايه|بداية|ابتدي|أبتدي|استلم الشغل|انزل الشغل)/;
const NEGATIVE_INTENT=/(?:مش|ما|معنديش|ماعنديش|مفيش|مينفعش|ماينفعش|مش هقدر|مش قادر|لا|لاء)/;
const POSITIVE_COMMIT=/(?:معايا|عندي|موجود|متاح|تمام|موافق|ينفع|مناسب|اقدر|أقدر|هقدر|جاهز)/;
const AREA_COMMIT=/(?:عايز|عاوز|اختار|اختياري|هشتغل|اشتغل|اقدر اشتغل|أقدر اشتغل|التزم|ينفعلي|مناسبه ليا|مناسبة ليا)/;


const GENERIC_TOPIC_WORDS=new Set(['هل','ايه','إيه','عايز','عاوز','اعرف','أعرف','محتاج','مطلوب','عندك','معاك','معايا','عندي','متاح','مناسب','الحالي','الحالية','الشغل','العمل','الوظيفة','الوظيفه','بيانات','معلومة','المعلومة']);
function topicWords(value){
 return clean(value).split(' ').filter(w=>w.length>=3&&!GENERIC_TOPIC_WORDS.has(w));
}
function topicMentioned(question,text){
 const qWords=topicWords((question?.label||'')+' '+(question?.agent_instruction||''));
 const n=clean(text);
 return qWords.some(w=>n.includes(w));
}
function optionHit(question,text){
 const options=Array.isArray(question?.options)?question.options:[];
 const n=clean(text);
 const hits=options.filter(option=>{
  const values=typeof option==='string'?[option]:[option?.label,option?.value,...(Array.isArray(option?.aliases)?option.aliases:[])];
  return values.filter(Boolean).some(value=>{
   const v=clean(value);
   return v&&(n===v||(' '+n+' ').includes(' '+v+' '));
  });
 });
 if(hits.length!==1)return null;
 const option=hits[0];
 return {
  value:typeof option==='string'?option:(option.value??option.label),
  display:typeof option==='string'?option:(option.label??String(option.value??''))
 };
}
function explicitAge(text){
 const n=clean(text);
 const patterns=[
  /(?:سني|سنى|عمري|العمر|السن)\s*(?:هو|=|:)?\s*(\d{1,2})/,
  /(\d{1,2})\s*(?:سنه|سنة|عام)/
 ];
 for(const pattern of patterns){
  const m=n.match(pattern),age=Number(m?.[1]);
  if(Number.isInteger(age)&&age>=16&&age<=80)return age;
 }
 return null;
}
function explicitResidence(text){
 const raw=String(text||'').trim();
 const m=raw.match(/(?:^|\s)(?:و\s*)?(?:انا\s+)?(?:ساكن(?:\s+حاليا)?\s+في\s+|ساكن\s+|سكني\s+في\s+|انا\s+من\s+|أنا\s+من\s+)[:\-]?\s*([^،,.!?؟؛]{2,80})/u);
 if(!m)return null;
 return m[1].split(/\s+(?:و)?(?:عايز|عاوز|ومعايا|معايا|وعندي|عندي|وهشتغل|هشتغل|بس)(?=\s|$)/u)[0].trim();
}
function explicitFullName(text){
 const raw=String(text||'').trim();
 const start=raw.match(/(?:^|\s)(?:و\s*)?(?:انا\s+)?(?:اسمي|إسمي|اسمى|الاسم\s+هو|الاسم|esmy|esmi)\s*[:\-]?\s*/iu);
 if(!start)return null;
 const rest=raw.slice((start.index||0)+start[0].length)
  .split(/[،,.!?؟؛;]/)[0]
  .split(/\s+(?:و)?(?:معايا|عندي|عايز|عاوز|حابب|ساكن|هشتغل|اشتغل|اقدر|أقدر|محتاج)(?=\s|$)/u)[0]
  .trim();
 const words=rest.split(/\s+/).filter(Boolean);
 if(words.length<2||words.length>5||words.some(w=>/\d/.test(w)))return null;
 return rest;
}
function factPriority(q){
 const key=q?.field_key;
 const special={preferred_work_area:100,has_motorcycle:90,full_name:80,shift_acceptance:70,ready_to_start:60};
 return Number.isFinite(Number(q?.priority))?Number(q.priority):(special[key]||50);
}
export function nextAgentQuestion(questions,answers,areas,answeredFn){
 const pending=(questions||[]).filter(q=>q?.active!==false)
  .filter(q=>!answeredFn(q,answers,areas)&&!(answers?.[q.id]?.skipped&&!q.required));
 return pending.sort((a,b)=>factPriority(b)-factPriority(a)||(a.position||0)-(b.position||0)||String(a.id).localeCompare(String(b.id)))[0]||null;
}

/**
 * Extract several high-confidence facts from one natural Egyptian-Arabic turn.
 * This is deliberately conservative: uncertain implications stay in conversation
 * instead of silently becoming qualification facts.
 */
export function extractConversationObservations(text){
 const n=clean(text);
 const observations=[];
 const licenseMention=/(?:رخصه|رخصة|الرخصه|الرخصة)/.test(n);
 if(licenseMention){
  if(/(?:خلصانه|خلصانة|خلصت|منتهيه|منتهية|منتهي|واقفه|واقفة|مش ساريه|مش سارية)/.test(n)){
   observations.push({key:'motorcycle_license_status',value:'expired',display:'الرخصة منتهية',confidence:.97,source:'explicit'});
  }else if(/(?:ساريه|سارية|شغاله|شغالة|صالحة|تمام)/.test(n)){
   observations.push({key:'motorcycle_license_status',value:'valid',display:'الرخصة سارية',confidence:.94,source:'explicit'});
  }
 }
 return observations;
}

export function extractConversationFacts(text,questions=[],areas=[]){
 const raw=String(text||''),n=clean(raw);
 if(!n)return [];
 const result=[],byKey=new Map((questions||[]).filter(q=>q.active!==false).map(q=>[q.field_key,q]));
 const add=(q,value,display,confidence,source='explicit')=>{
  if(!q||q.allow_inference===false||result.some(x=>x.question_id===q.id))return;
  result.push({question_id:q.id,field_key:q.field_key,kind:q.kind,value,display,confidence,source});
 };

 const motorcycle=byKey.get('has_motorcycle');
 if(motorcycle&&MOTORCYCLE_WORDS.test(n)){
  if(NEGATIVE_INTENT.test(n)&&/(?:معنديش|ماعنديش|مش معايا|مش عندي|مفيش|لسه مجبتش|لسه ما جبتش)/.test(n)){
   add(motorcycle,false,'لا',.97);
  }else if(POSITIVE_COMMIT.test(n)){
   add(motorcycle,true,'نعم',.96);
  }
 }

 const license=byKey.get('motorcycle_license')||byKey.get('has_motorcycle_license')||byKey.get('has_license');
 if(license&&LICENSE_WORDS.test(n)){
  if(/(?:منتهيه|منتهية|مش ساريه|مش سارية|من غير|بدون|معنديش|ماعنديش|مش معايا|مفيش)/.test(n))add(license,false,'لا',.96);
  else if(/(?:معايا|عندي|ساريه|سارية|موجوده|موجودة)/.test(n))add(license,true,'نعم',.95);
 }

 const ageQ=byKey.get('age');
 const age=explicitAge(raw);
 if(ageQ&&age!==null)add(ageQ,age,String(age),.97);

 const residence=byKey.get('residence_area')||byKey.get('residence');
 const residenceValue=explicitResidence(raw);
 if(residence&&residenceValue)add(residence,residenceValue,residenceValue,.94);

 const workArea=byKey.get('preferred_work_area');
 if(workArea){
  const mentioned=areaHits(raw,areas).filter(a=>!areaRejected(raw,a));
  const asksOnlyInfo=hasAny(n,INFO_WORDS)&&(/[?؟]/.test(raw)||/(?:كام|ايه|فين|تفاصيل|مرتب|راتب|قبض|مواعيد)/.test(n));
  const residenceOnly=RESIDENCE_WORDS.test(n)&&!AREA_COMMIT.test(n);
  if(mentioned.length===1&&!residenceOnly&&(!asksOnlyInfo||AREA_COMMIT.test(n))){
   add(workArea,mentioned[0].id,mentioned[0].name,.96);
  }
 }

 const fullName=byKey.get('full_name')||byKey.get('name');
 const name=explicitFullName(raw);
 if(fullName&&name)add(fullName,name,name,.96);

 const shift=byKey.get('shift_acceptance');
 if(shift&&SHIFT_WORDS.test(n)){
  if(/(?:مش مناسب|مش هقدر|مينفعش|ماينفعش|مش قادر|مش موافق)/.test(n))add(shift,false,'لا',.94);
  else if(/(?:مناسب|تمام|موافق|ينفع|اقدر|أقدر|هقدر)/.test(n))add(shift,true,'نعم',.93);
 }

 const ready=byKey.get('ready_to_start');
 if(ready&&READY_WORDS.test(n)){
  if(/(?:مش هقدر|مش جاهز|مش قادر|بعد فتره|بعد فترة)/.test(n))add(ready,false,'لا',.9);
  else if(/(?:بكره|بكرة|فورا|فوراً|حالاً|حالا|النهارده|النهاردة|جاهز|من دلوقتي|من بكرة)/.test(n))add(ready,true,'نعم',.94);
 }

 // Office-defined structured facts can be captured out of order when the user
 // explicitly mentions their topic. This avoids forcing every reply into the
 // currently pending question.
 for(const q of questions||[]){
  if(!q||q.active===false||result.some(x=>x.question_id===q.id)||q.allow_inference===false)continue;
  if(q.kind==='choice'){
   const hit=optionHit(q,raw);
   if(hit)add(q,hit.value,hit.display,.94,'choice_explicit');
   continue;
  }
  if(!topicMentioned(q,raw))continue;
  if(q.kind==='yes_no'){
   const yn=indirectYesNo(raw);
   if(yn)add(q,yn==='yes',yn==='yes'?'نعم':'لا',.91,'topic_explicit');
  }else if(q.kind==='number'){
   const value=numberAnswer(raw);
   if(value!==null)add(q,Number(value),String(value),.9,'topic_explicit');
  }
 }

 return result;
}

/**
 * Local Egyptian-Arabic interpreter.
 * It intentionally handles only the structured intents the recruitment flow needs.
 * No message content leaves the server and no external AI/API key is required.
 */
export async function interpret(text,question,areas){
 if(!text || question?.kind==='image')return null;
 const n=clean(text);
 if(!n)return null;

 const mentioned=areaHits(text,areas);
 const rejected=mentioned.filter(a=>areaRejected(text,a));
 const hits=mentioned.filter(a=>!areaRejected(text,a));
 const asksInfo=hasAny(n,INFO_WORDS) || /[?؟]/.test(String(text));
 if(rejected.length===1&&hits.length===0){
  return {intent:'area_reject',answer:'',area_id:rejected[0].id,confidence:0.99};
 }
 if(asksInfo&&hits.length===1){
  return {intent:'area_info',answer:'',area_id:hits[0].id,confidence:0.98};
 }

 if(question?.kind==='area'&&hits.length===1){
  return {intent:'answer',answer:hits[0].id,area_id:'',confidence:0.98};
 }

 if(question?.kind==='yes_no'){
  const answer=indirectYesNo(text);
  if(answer)return {intent:'answer',answer,area_id:'',confidence:0.96};
 }

 if(question?.kind==='choice'){
  const hit=optionHit(question,text);
  if(hit)return {intent:'answer',answer:hit.value,area_id:'',confidence:0.96};
 }

 if(question?.kind==='number'){
  const answer=numberAnswer(text);
  if(answer)return {intent:'answer',answer,area_id:'',confidence:0.95};
 }

 if(question?.kind==='name'){
  const answer=nameAnswer(text);
  if(answer)return {intent:'answer',answer,area_id:'',confidence:0.92};
 }

 return {intent:'clarify',answer:'',area_id:'',confidence:0.9};
}
