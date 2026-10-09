import {areaDetails,norm} from './domain.js';
import {areaPlaceKey} from './area-advisor.js';

const MAX_CONTEXT_AGE_MS=2*60*60*1000;
const SHORT_DETAILS=/^(?:ال)?تفاصيل(?:\s+(?:الشغل|الوظيفه|الوظيفة|بقا|بقي))?$|^(?:عايز|عاوز|محتاج|هات|وريني|قوللي|قولي)\s+(?:ال)?تفاصيل(?:\s+(?:الشغل|الوظيفه|الوظيفة))?$/;
const RESUME=/^(?:(?:تمام|ماشي|حلو)\s+)?(?:كمل|نكمل|يلا نكمل|كمل التقديم|نكمل التقديم)$/;

function recentDetails(answers,now){
 const detail=answers?.__last_area_details;
 if(detail?.kind!=='displayed_work_details')return null;
 const at=Date.parse(detail.at||'');
 if(!Number.isFinite(at)||now-at<0||now-at>MAX_CONTEXT_AGE_MS)return null;
 return detail;
}
function availableFamily(areas,key){
 const normalized=norm(key);
 return (areas||[]).filter(a=>a?.active===true&&a?.recruitment_eligible!==false&&norm(areaPlaceKey(a))===normalized);
}
function statePlace(answers,areas,now){
 const recent=recentDetails(answers,now);
 if(recent?.place_key&&availableFamily(areas,recent.place_key).length)return recent.place_key;
 const hint=answers?.__area_context?.place_key;
 if(hint&&availableFamily(areas,hint).length)return hint;
 const ref=answers?.__residence_clarification?.reference_place;
 if(ref==='haram'&&availableFamily(areas,'الهرم').length)return 'الهرم';
 const preview=areas.find(a=>String(a.id)===String(answers?.__area_preview?.value||'')&&a.active===true);
 return preview?areaPlaceKey(preview):null;
}
function newDetails(area,now){
 return {kind:'displayed_work_details',place_key:areaPlaceKey(area),area_id:area.id,at:new Date(now).toISOString()};
}
export function rememberAreaDetails(answers,areas,{action='',previewAreaId=null,contextPlaceKey=null}={},now=Date.now()){
 if(!['explain_area_mode','explain_area_family','explain_single_area_mode'].includes(action))return false;
 const row=(areas||[]).find(a=>a.active===true&&String(a.id)===String(previewAreaId||''));
 if(!row||row.recruitment_eligible===false)return false;
 answers.__last_area_details=newDetails(row,now);
 return true;
}

/** Handle short follow-ups using only a recorded previously discussed area. */
export function contextualAreaFollowup({text='',answers={},areas=[],current=null,now=Date.now()}={}){
 const message=norm(text),detail=recentDetails(answers,now);
 if(SHORT_DETAILS.test(message)){
  const place=statePlace(answers,areas,now);
  if(!place)return null;
  const family=availableFamily(areas,place);
  const specific=family.find(a=>String(a.id)===String(detail?.area_id||answers?.__area_preview?.value||''));
  const area=specific||(family.length===1?family[0]:null);
  if(!area){
   return {reply:'فاكر إننا بنتكلم عن شغل '+place+'. عندي أكتر من نظام شغل هناك؛ تقصد ماركت ولا مطاعم؟',
    action:'clarify_context_area_mode',patch:{}};
  }
  if(detail?.area_id&&String(detail.area_id)===String(area.id)){
   return {reply:'دي نفس تفاصيل '+area.name+' اللي شرحتهالك. تحب أوضح لك نقطة معينة: الدخل، الشيفت، نظام القبض، ولا شروط الشغل؟',
    action:'clarify_context_details',patch:{}};
  }
  return {reply:'أكيد، دي تفاصيل '+area.name+' المسجلة عندنا:\n\n'+areaDetails(area)
    +'\n\nلو حابب نكمل التقديم اكتب «كمل» وهنأكد مع بعض منطقة الشغل المناسبة ليك.',
   action:'contextual_area_details',
   patch:{__last_area_details:newDetails(area,now),__area_context:{place_key:areaPlaceKey(area),kind:'area_context',at:new Date(now).toISOString()}}};
 }
 if(RESUME.test(message)&&current?.field_key==='preferred_work_area'&&detail){
  const area=(areas||[]).find(a=>String(a.id)===String(detail.area_id)&&a.active===true&&a.recruitment_eligible!==false);
  if(!area)return null;
  const place=areaPlaceKey(area);
  return {reply:'تمام، نكمل التقديم. إنت كنت بتسأل عن شغل '+place
   +'، بس ده لسه مش معناه إنك اخترته للعمل.\n\n'
   +'هل تقدر تلتزم بالشغل يوميًا في '+place+'؟ لو أيوه قول «عايز أشتغل في '+place
   +'»، ولو مش مناسب قولّي منطقة العمل اللي تقدر تروحها كل يوم. مكان سكنك لوحده مش بيحدد التأهيل.',
   action:'contextual_resume_work_area',patch:{}};
 }
 return null;
}
