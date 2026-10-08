import {activeQuestions,answered,completion,questionPrompt,norm,areaDetails} from './domain.js';
import {conversationalAreaAdvice,resolveAreaReference,areaMode,areaPlaceKey} from './area-advisor.js';
import {asksForNearbyArea,mentionsResidence} from './location.js';
import {nearestWorkAreasWithFreeMaps,nearestWorkAreaFreeReply} from './geoapify-maps.js';
import {findKnowledgeAnswer} from './knowledge.js';

/**
 * Office-scoped CRM Tools. The LLM is NOT given an unrestricted tool endpoint:
 * tool selection is verified from the candidate's own message, resources are
 * only the already-loaded applicant/office context, and every tool is read-only.
 * Area selection, eligibility, staff changes and message sending stay in flow.js.
 */
export const CRM_TOOL_NAMES=Object.freeze([
 'read_candidate_progress','read_area_details','compare_registered_areas',
 'find_nearest_work_areas','search_verified_knowledge'
]);
const ALLOWED=new Set(CRM_TOOL_NAMES);
const MAX_TOOLS_PER_TURN=3;
const contains=(s,r)=>r.test(norm(s));
const compareIntent=s=>contains(s,/(?:قارن|مقارن|الفرق|احسن|افضل|افضلهم|انسب|أنسب|مميزات.*(?:ماركت|مطاعم)|ماركت.*مطاعم|مطاعم.*ماركت|محتار بين)/);
const progressIntent=s=>contains(s,/(?:حاله طلبي|حاله التقديم|موقف التقديم|ناقصني ايه|فاضل ايه|وصلت لفين|اكملت التقديم|خلصت التقديم|بياناتي اكتملت|ايه اللي ناقص|اتقبلت ولا)/);
const detailsIntent=s=>contains(s,/(?:تفاصيل|نظام|شروط|مميزات|الشيفت|شيفت|مرتب|راتب|دخل).*(?:ماركت|مطاعم|منطقه|منطقة|العبور|زايد)/)
 ||contains(s,/(?:ماركت|مطاعم).*(?:تفاصيل|نظام|مميزات|مرتب|راتب|شيفت)/);
const salaryIntent=s=>contains(s,/(?:المرتب كام|الدخل كام|القبض كام|الراتب كام)/);

/** Plans cannot contain arbitrary IDs, executable strings or unsupported tools. */
export function planCrmToolCalls(text,{hasOrigin=false}={}){
 const body=String(text||'').trim();
 if(!body||body.startsWith('area_preview:')||body.startsWith('confirm_area:')||
    body.startsWith('area_page:')||body.startsWith('choice:')||body==='no_work_area')return [];
 const steps=[];
 const near=asksForNearbyArea(body)||(hasOrigin&&contains(body,/(?:المسافه|مسافة|ايهم اقرب|انهي اقرب)/));
 if(progressIntent(body))steps.push('read_candidate_progress');
 if(near)steps.push('find_nearest_work_areas');
 if(compareIntent(body))steps.push('compare_registered_areas');
 else if(detailsIntent(body))steps.push('read_area_details');
 if(salaryIntent(body)&&!near&&!compareIntent(body)&&!detailsIntent(body))steps.push('search_verified_knowledge');
 // Single-action area queries are handled by existing advisor/protocol. Use
 // orchestration only for multi-part queries, or explicit application progress.
 if(steps.length<2&&!steps.includes('read_candidate_progress'))return [];
 return [...new Set(steps)].slice(0,MAX_TOOLS_PER_TURN);
}

function pendingQuestion(questions,answers,areas,awaitingId){
 const pending=activeQuestions(questions).filter(q=>!answered(q,answers,areas)&&!(answers[q.id]?.skipped&&!q.required));
 return pending.find(q=>String(q.id)===String(awaitingId))||pending[0]||null;
}
function progressTool({applicant,questions,areas,answers}){
 const count=completion(questions,answers,areas);
 const pending=pendingQuestion(questions,answers,areas,applicant.awaiting_id);
 const completed=answers.__application_flow_status?.value==='completed';
 const stopped=Boolean(answers.__qualification_stop);
 const waitingForStaff=applicant.bot_enabled===false||answers.__document_issue?.needs_human===true;
 const status=waitingForStaff?'مسؤول التوظيف بيتابع حالتك'
  :stopped?'التقديم الحالي متوقف وبيحتاج مراجعة'
  :completed?'اكتملت أسئلة التقديم الأولية وبانتظار مراجعة التوظيف'
  :'لسه في أسئلة مطلوبة لاستكمال التقديم';
 const lines=['حالة طلبك حاليًا: '+status+'.','اكتمال الأسئلة المطلوبة: '+count.done+' من '+count.total+'.'];
 if(pending&&!waitingForStaff&&!stopped)lines.push('السؤال التالي: '+questionPrompt(pending,areas));
 else if(waitingForStaff)lines.push('مسؤول التوظيف هيتواصل معاك، ومش مطلوب منك تعيد نفس الإجابات دلوقتي.');
 return {ok:true,reply:lines.join('\n'),meta:{completed_questions:count.done,total_questions:count.total,has_pending:Boolean(pending)}};
}
function areaDetailTool({text,areas,answers}){
 const result=resolveAreaReference(text,areas,{contextPlaceKey:answers.__area_context?.place_key});
 if(!result.matched)return {ok:false,reply:'علشان أبعت تفاصيل المنطقة صح، قولّي اسم منطقة الشغل المقصودة.'};
 if(result.missingMode||result.ambiguous||!result.area){
  return {ok:false,reply:'في '+(result.family?.[0]?.name||'المنطقة')+' أكتر من نظام تشغيل. تقصد تفاصيل الماركت ولا المطاعم؟'};
 }
 if(!String(result.area.details||'').trim())return {ok:false,reply:'تفاصيل المنطقة دي مش مضافة حاليًا؛ مسؤول التوظيف يقدر يوضحها.'};
 return {
  ok:true,reply:areaDetails(result.area),
  meta:{area_id:result.area.id,work_mode:areaMode(result.area)},
  context:{place_key:areaPlaceKey(result.area),preview_area_id:result.area.id}
 };
}
function compareTool({text,areas,answers}){
 const result=conversationalAreaAdvice(text,areas,answers);
 if(result?.action==='compare_work_modes_general')return {ok:false,reply:'الماركت والمطاعم تفاصيلهم بتختلف من منطقة للتانية. قولّي اسم المنطقة علشان أقارن النظامين فيها من البيانات المسجلة بدل ما أخلط شروط مناطق مختلفة.'};
 if(!result?.reply||!['compare_area_modes','compare_places','compare_places_followup'].includes(result.action)){
  return {ok:false,reply:'علشان المقارنة تكون دقيقة، حدّد اسم المنطقة أو المنطقتين اللي عايز تقارن بينهم، أو قولّي «قارن الماركت والمطاعم».'};
 }
 // When comparing market and restaurant systems within a confirmed
 // office place, use the *original two area descriptions* rather than
 // paraphrasing potentially unparseable salary numbers.
 let grounded=result.reply;
 if(result.action==='compare_area_modes'
   &&/(?:ماركت|market)/.test(norm(text))
   &&/(?:مطاعم|مطعم|restaurants)/.test(norm(text))
   &&result.contextPlaceKey){
  const family=areas.filter(a=>a?.active===true
    &&areaPlaceKey(a)===result.contextPlaceKey
    &&['market','restaurants'].includes(areaMode(a))
    &&String(a.details||'').trim());
  const market=family.find(a=>areaMode(a)==='market');
  const restaurants=family.find(a=>areaMode(a)==='restaurants');
  if(market&&restaurants){
   grounded='علشان المقارنة تكون دقيقة، دي التفاصيل المسجلة لنظام الماركت والمطاعم في نفس المنطقة:\n\n'
    +areaDetails(market)+'\n\n────────\n\n'+areaDetails(restaurants)
    +'\n\nلو عايز أرجحلك واحد حسب الدخل أو ساعات الشغل قولّي أولويتك.';
  }
 }
 return {
  ok:true,reply:grounded,
  meta:{comparison_action:result.action},
  context:{
   ...(result.contextPlaceKey?{place_key:result.contextPlaceKey}:{}),
   ...(Array.isArray(result.comparisonKeys)&&result.comparisonKeys.length>=2?{comparison_keys:result.comparisonKeys.slice(0,4)}:{})
  }
 };
}
async function nearestTool({text,areas,answers,mapsOptions}){
 const r=await nearestWorkAreasWithFreeMaps(text,areas,{
  fallbackOriginKey:answers.__area_recommendations?.origin_key||null,
  fallbackOriginQuery:answers.__area_recommendations?.origin_query||null,
  limit:3,...mapsOptions
 });
 if(!r?.items?.length)return {ok:false,reply:'علشان أرشحلك الأقرب بدقة، قولّي أنت ساكن في أنهي منطقة أو حي؟'};
 return {
  ok:true,reply:nearestWorkAreaFreeReply(r),
  meta:{count:r.items.length,distance_source:r.distance_source||'estimated',maps_grounded:Boolean(r.geoapify_used||r.google_maps_used)},
  context:{recommendations:{
   values:r.items.map(item=>item.area.id),origin_key:r.origin.key,
   origin_label:r.origin.label,...(r.origin_query?{origin_query:r.origin_query}:{}),
   kind:'area_recommendations',at:new Date().toISOString()
  }}
 };
}
function knowledgeTool({text,knowledge,settings}){
 if(settings.ai_knowledge_enabled===false)return {ok:false,reply:'المعلومة دي محتاجة تأكيد من مسؤول التوظيف.'};
 const match=findKnowledgeAnswer(text,knowledge,Math.max(.72,Number(settings.ai_confidence_threshold||.62)),{allowStatement:true});
 if(!match)return {ok:false,reply:'المعلومة دي مش مؤكدة في بيانات المكتب الحالية. مسؤول التوظيف يقدر يوضحها.'};
 const source=(knowledge||[]).find(x=>String(x.id)===String(match.id));
 if(!source||source.active===false||['stale','conflict'].includes(source.memory_status))
  return {ok:false,reply:'المعلومة دي محتاجة تأكيد من مسؤول التوظيف.'};
 return {ok:true,reply:String(match.answer||'').trim(),meta:{knowledge_id:match.id,confidence:match.confidence}};
}
const HANDLERS={
 read_candidate_progress:async x=>progressTool(x),
 read_area_details:async x=>areaDetailTool(x),
 compare_registered_areas:async x=>compareTool(x),
 find_nearest_work_areas:nearestTool,
 search_verified_knowledge:async x=>knowledgeTool(x)
};

/**
 * Execute 2–3 bounded, office-scoped read-only tasks. Use deterministic
 * user-intent triggers, NOT model-provided names/arguments/authorization.
 */
export async function runCrmTools({
 text,applicant,answers=applicant?.answers||{},questions=[],areas=[],knowledge=[],
 settings={},mapsOptions={},allow=true
}={}){
 if(!allow||!settings.ai_enabled)return null;
 const toolNames=planCrmToolCalls(text,{hasOrigin:Boolean(answers.__area_recommendations?.origin_key)});
 if(!toolNames.length)return null;
 const context={text,applicant,answers,questions,areas:areas.filter(x=>x?.active===true),knowledge,settings,mapsOptions};
 const outputs=[],trace=[],updates={};
 for(const name of toolNames.slice(0,MAX_TOOLS_PER_TURN)){
  if(!ALLOWED.has(name))continue;
  try{
   const out=await HANDLERS[name](context);
   const ok=out?.ok===true;
   trace.push({tool:name,ok,meta:out?.meta||{}});
   if(out?.reply)outputs.push(out.reply);
   if(ok&&out.context?.place_key)updates.place_key=out.context.place_key;
   if(ok&&out.context?.preview_area_id)updates.preview_area_id=out.context.preview_area_id;
   if(ok&&Array.isArray(out.context?.comparison_keys))updates.comparison_keys=out.context.comparison_keys;
   if(ok&&out.context?.recommendations){
    updates.recommendations=out.context.recommendations;
    // Compare systems within the closest known office place, not a
    // market row from one district against restaurants in another.
    const closest=updates.recommendations.values?.[0];
    const chosen=context.areas.find(a=>String(a.id)===String(closest));
    if(chosen){
     context.answers={...context.answers,__area_context:{place_key:areaPlaceKey(chosen)}};
    }
   }
  }catch{
   trace.push({tool:name,ok:false,reason:'tool_unavailable'});
   outputs.push(name==='find_nearest_work_areas'
    ?'تحديد المسافة مش متاح دلوقتي. ممكن تختار المنطقة من قائمة الشغل المتاحة.'
    :'المعلومة دي مش متاحة حاليًا؛ مسؤول التوظيف يقدر يوضحها.');
  }
 }
 if(!outputs.length)return null;
 const clipped=outputs.slice(0,MAX_TOOLS_PER_TURN);
 return {reply:clipped.join('\n\n────────\n\n'),
  tools:trace,context:updates,maps_grounded:trace.some(x=>x.meta?.maps_grounded),
  agent_action:'crm_tools_multi_step'};
}
