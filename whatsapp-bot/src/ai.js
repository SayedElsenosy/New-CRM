import {norm,digits,areaRejected} from './domain.js';

const INFO_WORDS=['تفاصيل','مرتب','راتب','قبض','عنوان','مكان','مواعيد','ساعات','شفت','شغل','نظام','مميزات','بونص','زون'];
const NEGATIVE=[
 'لا','لاء','لأ','معنديش','ما عنديش','معيش','مش معايا','مش عندي','لسه مجبتش','لسه ما جبتش',
 'مفيش','مش موجود','مش موجوده','مش متاح','من غير','بدون','ماعنديش','مافيش'
];
const POSITIVE=['نعم','ايوه','ايوا','اه','أه','تمام','موافق','عندي','معايا','موجود','متاح','yes','yep','yeah'];

const clean=v=>norm(digits(v)).replace(/[^\p{L}\p{N}\s?؟]/gu,' ').replace(/\s+/g,' ').trim();
const hasAny=(text,words)=>{const tokens=new Set(text.split(' '));return words.some(w=>{const x=clean(w);return x.includes(' ')?text.includes(x):text===x||tokens.has(x);});};

function areaHits(text,areas){
 const n=clean(text);
 return areas.filter(a=>a.active).filter(a=>{
  const name=clean(a.name);
  if(!name)return false;
  if(n.includes(name))return true;
  const tokens=name.split(' ').filter(t=>t.length>=3&&!['الشيخ','مدينه','مدينة','منطقه','منطقة'].includes(t));
  return tokens.length>0 && tokens.every(t=>n.includes(t));
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
  return {action:'answer_current',field_key:'preferred_work_area',area_id:mentioned[0].id,confidence:0.97};
 }

 return {action:'unknown',confidence:0.5};
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
