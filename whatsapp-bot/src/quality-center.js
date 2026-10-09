import {planTurn} from './flow.js';
import {runCrmTools} from './crm-tools.js';
import {updateBrainMemory} from './brain-memory.js';

/**
 * Counts are observational telemetry, not an accuracy estimate.
 * All metrics are computed server-side from bounded audit data.
 * Never send applicant messages, names, phone numbers or IDs to the UI.
 */
const boundedInt=(value,def,min,max)=>{
 const n=Number(value);
 return Number.isInteger(n)?Math.max(min,Math.min(max,n)):def;
};
export function qualityMetrics({events=[],decisions=[],runs=[],days=7,now=Date.now(),truncated=false}={}){
 const windowDays=boundedInt(days,7,1,30),since=now-windowDays*86400000;
 const recent=items=>(Array.isArray(items)?items:[]).filter(x=>Date.parse(x.created_at)>=since);
 const turns=recent(events).filter(x=>x.kind==='agent_turn');
 const aiHandoffs=recent(events).filter(x=>x.kind==='ai_handoff');
 const recentDecisions=recent(decisions);
 const evalRuns=recent(runs);
 let toolCount=0,toolSuccess=0,llmCalls=0,promptTokens=0,completionTokens=0,usageCovered=0,toolTurns=0;
 const actions={},handoffReasons={},tools={},daily={};
 for(const row of turns){
  const detail=row.detail&&typeof row.detail==='object'?row.detail:{};
  const date=String(row.created_at||'').slice(0,10);
  if(date){
   daily[date]??={day:date,turns:0,handoffs:0,tools:0};
   daily[date].turns++;
   if(detail.handoff===true)daily[date].handoffs++;
  }
  const action=String(detail.action||'unknown').slice(0,60);
  actions[action]=(actions[action]||0)+1;
  if(detail.handoff)handoffReasons[String(detail.handoff_reason||'unknown').slice(0,60)]=(handoffReasons[String(detail.handoff_reason||'unknown').slice(0,60)]||0)+1;
  const calls=Array.isArray(detail.crm_tools)?detail.crm_tools.slice(0,6):[];
  if(calls.length)toolTurns++;
  for(const tool of calls){
   const name=String(tool?.name||'unknown').slice(0,70);
   if(!/^[a-z_]{1,70}$/.test(name))continue;
   toolCount++;
   if(tool.ok===true)toolSuccess++;
   tools[name]??={name,total:0,success:0};
   tools[name].total++;
   if(tool.ok===true)tools[name].success++;
   if(date)daily[date].tools++;
  }
  const usage=detail.llm_usage;
  if(usage&&typeof usage==='object'){
   const count=boundedInt(usage.calls,0,0,10);
   const prompt=boundedInt(usage.prompt_tokens,0,0,1000000);
   const completion=boundedInt(usage.completion_tokens,0,0,1000000);
   llmCalls+=count;
   promptTokens+=prompt;
   completionTokens+=completion;
   if(count>0)usageCovered++;
  }
 }
 for(const row of aiHandoffs){
  const reason=String(row.detail?.reason||'unknown').slice(0,60);
  handoffReasons[reason]=(handoffReasons[reason]||0)+1;
 }
 // AI handoff events and turn.handoff can describe the SAME case; use
 // turn flags for the rate and reason counts from explicit handoff events.
 const handoffCount=turns.filter(x=>x.detail?.handoff===true).length;
 const fallback=recentDecisions.filter(x=>x.fallback_used===true).length;
 const llmDecisions=recentDecisions.filter(x=>String(x.planner_mode||'').startsWith('llm_')).length;
 const scored=evalRuns.filter(x=>typeof x.passed==='boolean');
 const evalPassed=scored.filter(x=>x.passed===true).length;
 const pct=(num,den)=>den?Math.round(num/den*1000)/10:null;
 return {
  window_days:windowDays,window_start:new Date(since).toISOString(),
  sample:{turns:turns.length,decisions:recentDecisions.length,eval_runs:evalRuns.length,truncated},
  operational:{
   turns:turns.length,handoffs:handoffCount,handoff_rate:pct(handoffCount,turns.length),
   tool_turns:toolTurns,tool_calls:toolCount,tool_success:toolSuccess,
   tool_success_rate:pct(toolSuccess,toolCount),
   fallback_count:fallback,fallback_rate:pct(fallback,recentDecisions.length),
   llm_decisions:llmDecisions
  },
  evaluation:{evaluated:scored.length,passed:evalPassed,pass_rate:pct(evalPassed,scored.length)},
  usage:{
   llm_calls_observed:llmCalls,prompt_tokens_observed:promptTokens,
   completion_tokens_observed:completionTokens,
   turns_with_token_telemetry:usageCovered,
   cost:null,currency:null,
   note:'التوكنز مُسجّلة فقط لو المزود رجّع usage. التكلفة غير متاحة بدون سعر موثوق للموديل، ومش بنقدر نخمنها.'
  },
  actions:Object.entries(actions).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([action,count])=>({action,count})),
  tools:Object.values(tools).sort((a,b)=>b.total-a.total),
  handoff_reasons:Object.entries(handoffReasons).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([reason,count])=>({reason,count})),
  daily:Object.values(daily).sort((a,b)=>a.day.localeCompare(b.day))
 };
}

const officeAreas=[
 {id:'obm',name:'العبور ماركت',place_key:'العبور',work_mode:'market',active:true,recruitment_eligible:true,zone:'NORTH_CENTRAL',
  details:'مرتب ماركت العبور: 5225 جنيه\nشيفت 9 ساعات\nتأمين طبي'},
 {id:'obr',name:'العبور مطاعم',place_key:'العبور',work_mode:'restaurants',active:true,recruitment_eligible:true,zone:'NORTH_CENTRAL',
  details:'الأوردر في مطاعم العبور: 42 جنيه\nالقبض أسبوعي'},
 {id:'oct',name:'أكتوبر ماركت',place_key:'أكتوبر',work_mode:'market',active:true,recruitment_eligible:true,zone:'WEST',
  details:'ماركت أكتوبر: الشيفت 8 ساعات\nالمرتب حسب نظام المكتب'},
 {id:'off',name:'المنصورة',place_key:'المنصورة',work_mode:'market',active:false,recruitment_eligible:false,zone:'UNKNOWN',
  details:'بيانات مكان غير متاح 99999'}
];
const officeQuestions=[
 {id:'area',field_key:'preferred_work_area',kind:'area',label:'أنهي منطقة تقدر تشتغل فيها يوميًا؟',position:1,active:true,required:true,confirmation_required:true},
 {id:'bike',field_key:'has_motorcycle',kind:'yes_no',label:'هل عندك موتوسيكل تشتغل بيه يوميًا؟',position:2,active:true,required:true},
 {id:'docs',field_key:'documents',kind:'image',label:'ابعت صورة البطاقة وصورة رخصة الموتوسيكل',position:3,active:true,required:true}
];
const app=(patch={})=>({id:'synthetic-candidate',office_id:'synthetic-office',stage:'incomplete',recruitment_stage:'new',bot_enabled:true,awaiting_id:'area',answers:{},...patch});
const settings={ai_enabled:true,ai_knowledge_enabled:true,agent_llm_enabled:false,agent_crm_tools_enabled:true,
 ai_confidence_threshold:.65,welcome:'مرحبًا بك، نكمل التقديم.',completion:'تم استلام التقديم للمراجعة'};
async function simulate(body,applicant=app(),extra={}){
 return planTurn({applicant,message:{body},questions:officeQuestions,areas:officeAreas,
  settings,knowledge:[],interpret:async()=>null,mapsOptions:{env:{},geoapifyApiKey:''},...extra});
}
function checks({action=null,includes=[],excludes=[],noAutoArea=true,awaiting=null,handoff=null,mutate=null}={}){
 return async result=>{
  const problems=[];
  if(action&&result.agent_action!==action)problems.push('الإجراء المتوقع: '+action);
  for(const text of includes)if(!String(result.reply||'').includes(text))problems.push('الرد لا يحتوي على معلومة مطلوبة: '+text);
  for(const text of excludes)if(String(result.reply||'').includes(text))problems.push('الرد يحتوي على معلومة غير مسموحة: '+text);
  if(noAutoArea&&result.patch?.answers?.area?.value)problems.push('تم اختيار منطقة عمل تلقائيًا بدون تأكيد');
  if(awaiting&&result.patch?.awaiting_id!==awaiting)problems.push('السؤال المعلّق اتغيّر');
  if(handoff!==null&&Boolean(result.handoff)!==handoff)problems.push('حالة التحويل البشري غير متوقعة');
  if(result.patch?.answers?.__qualification_stop&&noAutoArea)problems.push('تم التأهيل/الرفض من غير إجابة مؤهلة');
  if(mutate)problems.push(...mutate(result));
  return problems;
 };
}

/** Synthetic office, synthetic candidates, no network or messages sent. */
const qualityScenarios=[
 ['basic','تحية بداية محادثة',async()=>simulate('السلام عليكم',app({stage:'new',awaiting_id:null})),checks({includes:['نكمل التقديم','منطقة'],noAutoArea:true})],
 ['details','تفاصيل ماركت بنفس النص',async()=>simulate('عايز تفاصيل ماركت العبور'),checks({action:'explain_area_mode',includes:[officeAreas[0].details],noAutoArea:true})],
 ['details','تفاصيل مطاعم بنفس النص',async()=>simulate('عايز تفاصيل مطاعم العبور'),checks({action:'explain_area_mode',includes:[officeAreas[1].details]})],
 ['compare','مقارنة الماركت والمطاعم في العبور',async()=>simulate('قارن الماركت والمطاعم في العبور'),checks({action:'compare_area_modes',includes:['ماركت','مطاعم'],excludes:['99999']})],
 ['multi_tool','تفاصيل المنطقة وحالة الطلب معًا',async()=>simulate('تفاصيل ماركت العبور وناقصني ايه في التقديم؟'),checks({action:'crm_tools_multi_step',includes:[officeAreas[0].details,'اكتمال الأسئلة'],awaiting:'area'})],
 ['multi_tool','القرب والمقارنة في سؤال واحد',async()=>simulate('أنا ساكن في عين شمس، قارن الماركت والمطاعم وقولي الأقرب للشغل'),checks({action:'crm_tools_multi_step',includes:['عين شمس','ماركت','مطاعم'],excludes:['99999']})],
 ['progress','حالة الطلب من معلومات فعلية',async()=>simulate('حالة طلبي وصلت لفين؟'),checks({action:'crm_tools_multi_step',includes:['حالة طلبك','السؤال التالي'],excludes:['تم التعيين']})],
 ['progress','الأسئلة الناقصة بدون قبول آلي',async()=>simulate('ناقصني ايه في التقديم؟'),checks({action:'crm_tools_multi_step',includes:['اكتمال الأسئلة'],excludes:['اتقبلت']})],
 ['privacy','السكن ليس منطقة العمل',async()=>simulate('انا ساكن في عين شمس، فين أقرب منطقة شغل؟'),checks({excludes:['99999'],noAutoArea:true})],
 ['privacy','تأكيد مزوّر لا يختار منطقة',async()=>simulate('confirm_area:obm'),checks({noAutoArea:true})],
 ['privacy','تفاصيل منطقة غير مفعلة غير مرشحة',async()=>simulate('المنصورة',app({awaiting_id:'area'})),checks({excludes:['99999'],noAutoArea:true})],
 ['flow','زر معاينة المنطقة لا يختار تلقائيًا',async()=>simulate('area_preview:obm'),checks({includes:[officeAreas[0].details],noAutoArea:true})],
 ['flow','تأكيد المعاينة بعد طلب المرشح فقط',async()=>{
  const first=await simulate('area_preview:obm');
  return simulate('confirm_area:obm',app({answers:first.patch.answers,awaiting_id:'area'}));
 },checks({noAutoArea:false,mutate:res=>res.patch?.answers?.area?.value==='obm'?[]:['تأكيد المنطقة الصريح لم يحفظ المنطقة المطلوبة']})],
 ['docs','عدم توفر المستند يطلب تحديده مرة واحدة',async()=>simulate('مش معايا',app({awaiting_id:'docs'})),checks({action:'clarify_unavailable_documents',includes:['البطاقة','رخصة الموتوسيكل'],awaiting:'docs'})],
 ['docs','عدم توفر البطاقة يحوّل لمسؤول',async()=>simulate('مش معايا البطاقة',app({awaiting_id:'docs'})),checks({handoff:true,includes:['مسؤول التوظيف'],awaiting:'docs'})],
 ['docs','رد مكرر على المستند ينتقل للبشر',async()=>{
  const first=await simulate('مش معايا',app({awaiting_id:'docs'}));
  return simulate('مش معايا',app({awaiting_id:'docs',answers:first.patch.answers}));
 },checks({handoff:true,includes:['مسؤول التوظيف']})],
 ['safety','البوت الموقوف لا يرسل ردًا',async()=>simulate('قارن الماركت والمطاعم',app({bot_enabled:false})),checks({includes:[],mutate:x=>x.reply===''?[]:['المساعد رد رغم إيقافه']})],
 ['safety','معلومات منطقة غير متاحة لا تُخترع',async()=>simulate('ممكن تفاصيل المنصورة؟'),checks({excludes:['99999']})],
 ['memory','تفضيل صباحي موثوق',async()=>{
  const r=updateBrainMemory(null,'أنا بفضل شيفت صباحي');
  return {reply:'',patch:{},memory:r.memory};
 },checks({mutate:r=>r.memory?.preferred_shift==='morning'?[]:['التفضيل الصريح لم يُحفظ']})],
 ['memory','تصحيح الشيفت لا يكرر القديم',async()=>{
  const first=updateBrainMemory(null,'أنا بفضل شيفت صباحي');
  const second=updateBrainMemory(first.memory,'قصدي مسائي مش صباحي');
  return {reply:'',patch:{},memory:second.memory};
 },checks({mutate:r=>r.memory?.preferred_shift==='evening'?[]:['تصحيح الشيفت لم يغير التفضيل']})],
 ['office','أداة لا تعرض بيانات مكتب آخر',async()=>{
  const result=await runCrmTools({text:'تفاصيل ماركت الدقي وناقصني إيه في التقديم؟',applicant:app(),
   areas:[...officeAreas.map(a=>({...a,office_id:'synthetic-office'})),{id:'foreign',office_id:'foreign-office',name:'الدقي ماركت',place_key:'الدقي',work_mode:'market',active:true,details:'راتب سري 99999'}],
   answers:{},questions:officeQuestions,settings,knowledge:[],mapsOptions:{env:{},geoapifyApiKey:''}});
  return {reply:result?.reply||'',patch:{}};
 },checks({excludes:['99999','راتب سري']})]
];
export const BUILTIN_QUALITY_COUNT=qualityScenarios.length;
export async function runBuiltInQualitySuite(){
 const started=Date.now(),results=[];
 for(let i=0;i<qualityScenarios.length;i++){
  const [category,title,run,assertions]=qualityScenarios[i];
  try{
   const result=await run();
   const problems=await assertions(result);
   results.push({id:i+1,category,title,passed:problems.length===0,problems:problems.slice(0,4)});
  }catch(e){
   results.push({id:i+1,category,title,passed:false,problems:['تعذر تشغيل الحالة: '+String(e?.code||e?.name||'Error')]});
  }
 }
 const passed=results.filter(x=>x.passed).length;
 return {version:'3.0',dataset:'synthetic',external_llm_calls:0,real_applicant_messages_used:0,
  total:results.length,passed,failed:results.length-passed,
  pass_rate:results.length?Math.round(passed/results.length*1000)/10:null,
  duration_ms:Date.now()-started,results};
}
