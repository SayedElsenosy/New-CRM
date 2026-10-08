import {norm} from './domain.js';

/**
 * Brain 2.0 memory: stores only explicit, bounded applicant preferences,
 * never raw conversation, precise addresses, inferred eligibility or job terms.
 * It survives worker restarts inside the applicant's existing answers JSON.
 */
const ALLOWED_SHIFTS=new Set(['morning','evening']);
const ALLOWED_INTENTS=new Set(['compare','nearest','job_details','documents','salary','continue','correction']);
const PLAN_STEP_TYPES=new Set(['understand_message','read_office_areas','compare_registered_areas',
 'check_nearest_work_areas','read_verified_knowledge','ask_pending_question',
 'request_confirmation','request_clarification','human_handoff']);

function explicitShift(text){
 const n=norm(text).replace(/[؟?،,.!:؛]/g,' ').replace(/\s+/g,' ');
 const morning=/(?:صباحي|الصبح|الصباح)/.test(n);
 const evening=/(?:مسائي|بالليل|المساء|مساء)/.test(n);
 const context=/(?:شيفت|شفت|ورديه|ورديه|مواعيد|ساعات|اشتغل|شغل|العمل)/.test(n);
 const preference=/(?:عايز|عاوز|افضل|بفضل|مفضل|نفسي|احب|محتاج|يناسبني|مناسب ليا|اقصد|قصدي)/.test(n);
 const negated=/(?:مش عايز|مش عاوز|مش بفضل|مش افضل|مبفضلش|مش مناسب)/.test(n);
 if(!context&&!preference)return null;
 if(!preference)return null;
 // Prefer the explicitly corrected value even if both shifts were mentioned.
 const correction=n.match(/(?:قصدي|اقصد|انا اقصد)\s+(?:الشيفت\s+|الشفت\s+)?(صباحي|الصبح|مسائي|بالليل|المساء)/);
 if(correction)return {op:'set',value:/(?:صباحي|الصبح)/.test(correction[1])?'morning':'evening'};
 if(morning===evening)return null;
 const shift=morning?'morning':'evening';
 if(negated)return {op:'remove',value:shift};
 return {op:'set',value:shift};
}
function multiTopic(text){
 const n=norm(text);
 const intents=[];
 if(/(?:قارن|مقارن|الفرق|احسن|افضل|مميزات.*(?:ماركت|مطاعم)|ماركت.*مطاعم)/.test(n))intents.push('compare');
 if(/(?:اقرب|قريب|المسافه|مسافه|منطقه قريبه|المواصلات)/.test(n))intents.push('nearest');
 if(/(?:تفاصيل|نظام الشغل|طبيعه الشغل)/.test(n))intents.push('job_details');
 if(/(?:بطاقه|رخصه|المستندات|الاوراق|الورق)/.test(n))intents.push('documents');
 if(/(?:مرتب|راتب|دخل|قبض|فلوس)/.test(n))intents.push('salary');
 if(/(?:نكمل|كمل|التقديم|السؤال اللي بعده)/.test(n))intents.push('continue');
 if(/(?:اقصد|قصدي|صحح|غير الاجابه|تعديل)/.test(n))intents.push('correction');
 return intents;
}
export function updateBrainMemory(existing,text,{now=new Date().toISOString()}={}){
 const prev=existing&&existing.version===2?existing:null;
 const oldShift=ALLOWED_SHIFTS.has(prev?.preferred_shift)?prev.preferred_shift:null;
 const next=explicitShift(text);
 let shift=oldShift;
 if(next?.op==='set')shift=next.value;
 if(next?.op==='remove'&&shift===next.value)shift=null;
 // Recent intent categories are navigational hints only, not job facts.
 const intents=multiTopic(text).filter(x=>ALLOWED_INTENTS.has(x)).slice(0,4);
 const prevIntents=Array.isArray(prev?.recent_intents)?prev.recent_intents.filter(x=>ALLOWED_INTENTS.has(x)).slice(0,4):[];
 const nextIntents=intents.length?intents:prevIntents;
 const changed=shift!==oldShift||JSON.stringify(nextIntents)!==JSON.stringify(prevIntents);
 if(!changed)return {changed:false,memory:prev};
 return {
  changed:true,
  memory:{
   version:2,
   preferred_shift:shift,
   recent_intents:nextIntents,
   source:'explicit_applicant_message',
   updated_at:now
  }
 };
}
export function brainMemoryContext(answers={}){
 const memory=answers.__brain_memory||{};
 const recommendation=answers.__recommendation_profile||{};
 const preferences={};
 if(ALLOWED_SHIFTS.has(memory.preferred_shift))preferences.preferred_shift=memory.preferred_shift;
 if(['market','restaurants'].includes(recommendation.preferred_mode))preferences.preferred_work_mode=recommendation.preferred_mode;
 if(['income','stability','benefits','distance','shift'].includes(recommendation.primary))preferences.main_priority=recommendation.primary;
 const recent_intents=Array.isArray(memory.recent_intents)?memory.recent_intents.filter(x=>ALLOWED_INTENTS.has(x)).slice(0,4):[];
 return {preferences,recent_intents};
}

/**
 * Read-only ordered task planning. These are suggestions for which *existing*
 * deterministic CRM capabilities to use, not permission for an LLM to mutate
 * answers, approve/reject an applicant, or execute external tool calls.
 */
export function buildBrainSteps(text,{hasPendingQuestion=false}={}){
 const intents=multiTopic(text);
 const steps=['understand_message'];
 if(intents.includes('nearest'))steps.push('check_nearest_work_areas');
 if(intents.includes('compare')||intents.includes('job_details'))steps.push('read_office_areas');
 if(intents.includes('compare'))steps.push('compare_registered_areas');
 if(intents.includes('salary')&&!intents.includes('compare')&&!intents.includes('job_details'))steps.push('read_verified_knowledge');
 if(intents.includes('documents'))steps.push('request_clarification');
 if(hasPendingQuestion)steps.push('ask_pending_question');
 return [...new Set(steps)].slice(0,6);
}
export function validateBrainSteps(proposed,expected=[]){
 const allowed=new Set([...expected,'request_clarification','request_confirmation','human_handoff']);
 if(!Array.isArray(proposed))return [];
 return [...new Set(proposed.filter(x=>typeof x==='string'&&PLAN_STEP_TYPES.has(x)&&allowed.has(x)))].slice(0,6);
}


// Interactive button payloads and media-only uploads have exact, local CRM
// handlers. Avoid wasting scarce free LLM requests on those turns.
export function needsLlmPlanning(message={}){
 const body=String(message.body||'').trim();
 if(!body)return false;
 if(message.media_path&&!body)return false;
 if(/^(?:area_preview:|confirm_area:|area_page:|choice:)[^\s]{1,180}$/.test(body))return false;
 if(body==='no_work_area')return false;
 return true;
}
