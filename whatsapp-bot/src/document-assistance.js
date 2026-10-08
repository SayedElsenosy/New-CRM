import {norm} from './domain.js';

// Pure Egyptian-Arabic parser for a *pending image/document upload question*.
// A missing document is not proof that the applicant lacks a motorcycle and
// must never silently count as an uploaded image or a qualification rejection.
const ID_DOCUMENT=/(?:بطاقه|البطاقه|بطاقتي|البطاقتي|بطاقه شخصيه|البطاق|كارنيه|card\b|id\b)/;
const LICENSE_DOCUMENT=/(?:رخصه|الرخصه|رخصتي|الرخص|license\b)/;
const BOTH_DOCUMENTS=/(?:الاتنين|الاثنين|الاتنين مع بعض|كلهم|كل الورق|ولا واحده|ولا واحده فيهم|كل المستندات)/;
const UNAVAILABLE=/(?:^|\s)(?:مش\s+معايا|مش\s+عندي|مش\s+موجود|معنديش|معيش|ما\s+عنديش|ماعنديش|مافيش|مفيش|مش\s+متوفر|لسه\s+مطلعته|لسه\s+مطلعت|لسه\s+معملت|لسه\s+مجبت|ضاع|ضاعت|مفقود|مش\s+مصور|مش\s+قادر\s+ابعت|مش\s+هقدر\s+ابعت|مش\s+معايا\s+صور|هبعت\s+بعدين|بعدها\s+هبعت|لسه\s+هطلع|مش\s+هاعرف\s+ابعت|لا\s+مش\s+معايا)(?:\s|$)/;
const NO_ALONE=/^(?:لا|لاء|لأ|مش\s+معايا|معنديش|معيش|مفيش|ما\s+عنديش|مش\s+عندي)$/;
const BIKE_WITHOUT_DOCUMENT=/(?:موتوسيكل|موتوسكل|موتسيكل|مكنه|موتور)/;

// Return null for unrelated messages: questions about pay or working areas must
// still be answerable while the applicant is waiting to upload a document.
export function documentAvailabilityDecision(message,question,previous=null){
 if(question?.kind!=='image')return null;
 const text=norm(message).replace(/[؟?.,،؛!:]/g,' ').replace(/\s+/g,' ').trim();
 if(!text)return null;
 const label=norm(question.label||'');
 const mentionsId=ID_DOCUMENT.test(text);
 const mentionsLicense=LICENSE_DOCUMENT.test(text);
 const mentionsBoth=BOTH_DOCUMENTS.test(text);
 const negative=UNAVAILABLE.test(text)||NO_ALONE.test(text);
 const activeClarification=previous?.kind==='document_availability_clarification'
  &&String(previous.question_id)===String(question.id);
 // If they explicitly say they don't have a motorcycle, allow the standard
 // motorcycle eligibility logic to handle this instead.
 if(negative&&BIKE_WITHOUT_DOCUMENT.test(text)&&!mentionsLicense&&!mentionsId)return null;
 if(!negative&&!(activeClarification&&(mentionsId||mentionsLicense||mentionsBoth)))return null;
 const hasId=ID_DOCUMENT.test(label),hasLicense=LICENSE_DOCUMENT.test(label);
 const type=mentionsBoth||(mentionsId&&mentionsLicense)?'both'
  :mentionsLicense?'license':mentionsId?'id':'unspecified';
 if(activeClarification){
  if(negative||mentionsId||mentionsLicense||mentionsBoth){
   return {action:'handoff',document:type==='unspecified'?'unspecified':type,reason:'documents_unavailable'};
  }
  return null;
 }
 if(type==='unspecified'&&hasId&&hasLicense){
  return {
   action:'clarify',
   reply:'تمام، فهمت إن في مستند مش متوفر معاك. تقصد صورة البطاقة، ولا رخصة الموتوسيكل، ولا الاتنين؟\nقولّي أي واحدة ناقصة علشان أبلّغ مسؤول التوظيف، ومش هكرر عليك نفس الطلب.'
  };
 }
 // When only one document is being requested, "مش معايا" is unambiguous.
 return {action:'handoff',document:type==='unspecified'?(hasLicense?'license':hasId?'id':'unspecified'):type,reason:'documents_unavailable'};
}

export function unavailableDocumentNote(question,message,document='unspecified'){
 const what=document==='both'?'البطاقة ورخصة الموتوسيكل'
  :document==='license'?'رخصة الموتوسيكل'
  :document==='id'?'البطاقة':'المستند المطلوب (يحتاج تحديد)';
 const request=String(question?.label||'').trim().slice(0,190);
 const response=String(message||'').trim().slice(0,180);
 return 'مراجعة مستندات: المتقدم أبلغ بعدم توفر '+what+'. السؤال: '+request+'. رد المتقدم: '+response;
}
