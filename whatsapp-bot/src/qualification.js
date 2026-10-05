import {norm} from './domain.js';

export const RECRUITMENT_ZONES=['WEST','EAST','NORTH_CENTRAL','UNKNOWN'];
const TRUE_VALUES=new Set(['true','1','yes','y','نعم','ايوه','ايوا','اه','عندي','معايا','موافق','تمام']);
const FALSE_VALUES=new Set(['false','0','no','n','لا','لاء','معنديش','ما عنديش','مش عندي','مش معايا']);
const KEY_ALIASES={
 residence_area:['residence_area','residence_zone'],
 preferred_work_area:['preferred_work_area','work_area','area'],
 has_motorcycle:['has_motorcycle','motorcycle'],
 motorcycle_license:['motorcycle_license','license'],
 shift_acceptance:['shift_acceptance']
};
const STAGE_ORDER={new:0,review:1,interview:2,accepted:3,hired:4};

const cleanText=value=>norm(value)
 .replace(/^(?:انا\s+)?(?:ساكن|مقيم)\s+(?:في|ب)?\s*/,'')
 .replace(/^(?:منطقه|منطقة|حي)\s+/,'')
 .replace(/^من\s+/,'')
 .trim();

function questionCandidates(questions,key){
 const aliases=KEY_ALIASES[key]||[key];
 return (questions||[]).filter(q=>aliases.includes(q.field_key))
  .sort((a,b)=>Number(b.field_key===key)-Number(a.field_key===key)||Number(b.active)-Number(a.active)||a.position-b.position);
}
function answerFor(applicant,questions,key){
 const answers=applicant?.answers||{};
 const candidates=questionCandidates(questions,key);
 for(const q of candidates){
  const answer=answers[q.id];
  if(answer&&answer.value!==null&&answer.value!==undefined&&answer.value!=='')return {question:q,answer};
 }
 return {question:candidates[0]||null,answer:null};
}
function booleanValue(answer){
 if(!answer)return null;
 if(typeof answer.value==='boolean')return answer.value;
 const raw=cleanText(answer.value??answer.display??'');
 if(TRUE_VALUES.has(raw))return true;
 if(FALSE_VALUES.has(raw))return false;
 return null;
}
function areaMatch(value,areas){
 const text=cleanText(value);
 if(!text)return null;
 const ranked=(areas||[]).map(area=>{
  const name=cleanText(area.name);
  let score=0;
  if(text===name)score=10000+name.length;
  else if(name.length>=3&&text.includes(name))score=5000+name.length;
  else if(text.length>=3&&name.includes(text))score=1000+text.length;
  return {area,score};
 }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
 return ranked[0]?.area||null;
}
function residenceInfo(applicant,questions,areas){
 const {answer}=answerFor(applicant,questions,'residence_area');
 if(!answer)return {answered:false,name:null,area:null,zone:null,geo_qualified:null,status:'unknown'};
 const raw=String(answer.display||answer.value||'').trim();
 if(answer.archived_area===true){
  const zone=RECRUITMENT_ZONES.includes(answer.archived_area_zone)?answer.archived_area_zone:'UNKNOWN';
  const eligible=answer.archived_area_recruitment_eligible===true;
  return {answered:true,name:answer.archived_area_name||raw,area:null,zone,geo_qualified:eligible,status:eligible?'qualified':'outside'};
 }
 let matched=null;
 if(answer.kind==='area'||answer.kind==='area_preview')matched=(areas||[]).find(a=>String(a.id)===String(answer.value))||null;
 if(!matched)matched=areaMatch(raw,areas);
 if(!matched)return {answered:true,name:raw,area:null,zone:'UNKNOWN',geo_qualified:false,status:'outside'};
 const eligible=matched.recruitment_eligible===true;
 return {answered:true,name:matched.name||raw,area:matched,zone:RECRUITMENT_ZONES.includes(matched.zone)?matched.zone:'UNKNOWN',geo_qualified:eligible,status:eligible?'qualified':'outside'};
}
function requiredBooleanCondition(applicant,questions,key,reason){
 const activeRequired=questionCandidates(questions,key).find(q=>q.active&&q.required);
 if(!activeRequired)return {required:false,value:true,reason:null,pending:false};
 const answer=applicant?.answers?.[activeRequired.id];
 const value=booleanValue(answer);
 if(value===null)return {required:true,value:null,reason:null,pending:true};
 if(value===false)return {required:true,value:false,reason,pending:false};
 return {required:true,value:true,reason:null,pending:false};
}

export function qualificationFor(applicant,questions=[],areas=[]){
 const motorcycle=answerFor(applicant,questions,'has_motorcycle');
 const motorcycleValue=booleanValue(motorcycle.answer);
 const residence=residenceInfo(applicant,questions,areas);
 const license=requiredBooleanCondition(applicant,questions,'motorcycle_license','no_motorcycle_license');
 const shift=requiredBooleanCondition(applicant,questions,'shift_acceptance','shift_not_accepted');
 const reasons=[];
 if(motorcycleValue===false)reasons.push('no_motorcycle');
 if(residence.geo_qualified===false)reasons.push('residence_outside_hiring_zones');
 if(license.reason)reasons.push(license.reason);
 if(shift.reason)reasons.push(shift.reason);
 const pending=motorcycleValue===null||residence.geo_qualified===null||license.pending||shift.pending;
 const qualified=reasons.length?false:pending?null:true;
 return {
  motorcycle_qualified:motorcycleValue,
  motorcycle_status:motorcycleValue===true?'qualified':motorcycleValue===false?'not_qualified':'unknown',
  residence_area:residence.name,
  residence_area_id:residence.area?.id||null,
  zone:residence.zone,
  geo_qualified:residence.geo_qualified,
  geo_status:residence.status,
  qualified_candidate:qualified,
  overall_status:qualified===true?'qualified':qualified===false?'not_qualified':'pending',
  reasons,
  checks:{
   motorcycle:{required:true,value:motorcycleValue},
   residence:{required:true,value:residence.geo_qualified},
   motorcycle_license:{required:license.required,value:license.value},
   shift_acceptance:{required:shift.required,value:shift.value}
  }
 };
}

export function stageReached(current,target){
 if(target==='rejected')return current==='rejected';
 if(current==='rejected')return false;
 return (STAGE_ORDER[current]??0)>=(STAGE_ORDER[target]??0);
}
export const ratio=(num,den)=>den>0?Math.round(num/den*10000)/100:null;
export const cost=(spend,count)=>Number(spend)>0&&count>0?Math.round(Number(spend)/count*100)/100:null;

export function funnelFor(rows=[],spend=0){
 const applicants=rows.length;
 const motorcycle_qualified=rows.filter(a=>a.qualification?.motorcycle_qualified===true).length;
 const geo_qualified=rows.filter(a=>a.qualification?.geo_qualified===true).length;
 const qualified=rows.filter(a=>a.qualification?.qualified_candidate===true).length;
 const interview=rows.filter(a=>stageReached(a.recruitment_stage,'interview')).length;
 const accepted=rows.filter(a=>stageReached(a.recruitment_stage,'accepted')).length;
 const hired=rows.filter(a=>a.recruitment_stage==='hired').length;
 const rejected=rows.filter(a=>a.recruitment_stage==='rejected').length;
 return {
  applicants,motorcycle_qualified,geo_qualified,qualified,interview,accepted,hired,rejected,
  rates:{
   applicant_to_motorcycle:ratio(motorcycle_qualified,applicants),
   motorcycle_to_geo:ratio(geo_qualified,motorcycle_qualified),
   geo_to_qualified:ratio(qualified,geo_qualified),
   qualified_to_interview:ratio(interview,qualified),
   interview_to_accepted:ratio(accepted,interview),
   accepted_to_hired:ratio(hired,accepted),
   qualified_rate:ratio(qualified,applicants),
   hire_rate:ratio(hired,applicants),
   qualified_to_hire_rate:ratio(hired,qualified)
  },
  costs:{
   per_applicant:cost(spend,applicants),
   per_motorcycle_qualified:cost(spend,motorcycle_qualified),
   per_geo_qualified:cost(spend,geo_qualified),
   per_qualified:cost(spend,qualified),
   per_interview:cost(spend,interview),
   per_accepted:cost(spend,accepted),
   per_hired:cost(spend,hired)
  }
 };
}

export function qualificationReasonLabels(reasons=[]){
 const labels={
  no_motorcycle:'لا يوجد موتوسيكل متاح للشغل',
  residence_outside_hiring_zones:'السكن خارج مناطق التوظيف المعتمدة',
  no_motorcycle_license:'لا توجد رخصة موتوسيكل سارية',
  shift_not_accepted:'لم يوافق على نظام الشيفت المطلوب'
 };
 return reasons.map(x=>labels[x]||x);
}
