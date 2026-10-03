import {norm,digits} from './domain.js';

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

function indirectYesNo(text){
 const n=clean(text);
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

/**
 * Local Egyptian-Arabic interpreter.
 * It intentionally handles only the structured intents the recruitment flow needs.
 * No message content leaves the server and no external AI/API key is required.
 */
export async function interpret(text,question,areas){
 if(!text || question?.kind==='image')return null;
 const n=clean(text);
 if(!n)return null;

 const hits=areaHits(text,areas);
 const asksInfo=hasAny(n,INFO_WORDS) || /[?؟]/.test(String(text));
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
