import {activeQuestions,answered,completion,computedStage,validateAnswer,questionPrompt,areaInquiry,areaDetails,norm} from './domain.js';
import {findKnowledgeAnswer,looksLikeQuestion,sameKnowledgeTopic} from './knowledge.js';
import {qualificationFor} from './qualification.js';
import {decideConversationAction} from './ai.js';

function areaPreviewReply(area,areas){
 const others=areas.filter(z=>z.active&&z.id!==area.id);
 const choices=others.length?'\n\nولو عايز تقارن بمنطقة تانية اختارها من الأزرار تحت.':'';
 return areaDetails(area)+`\n\nلو ${area.name} هي المنطقة اللي هتنزل فيها اضغط «✅ تأكيد ${area.name}».`+choices;
}
function realAnswerCount(answers){return Object.keys(answers||{}).filter(k=>!k.startsWith('__')).length;}
function clearAgentState(answers){delete answers.__agent_state;delete answers.__ai_handoff;return answers;}
function knowledgeQueryText(answers,text){
 const current=String(text||'').trim();
 const previous=answers?.__agent_state?.kind==='clarification'?String(answers.__agent_state.last_message||'').trim():'';
 if(!previous||norm(previous)===norm(current))return current;
 return (previous+' '+current).trim().slice(0,2000);
}
function explainCurrentQuestion(question,areas){
 if(!question)return 'مفيش سؤال ناقص حاليًا. لو عندك سؤال عن الشغل ابعته بشكل مباشر.';
 if(question.field_key==='has_motorcycle')return 'قصدي: هل عندك موتوسيكل تقدر تستخدمه للشغل يوميًا؟ رد «نعم» أو «لا».';
 if(question.field_key==='preferred_work_area')return 'قصدي منطقة الشغل اللي تقدر تروحها وتلتزم بيها يوميًا، مش مكان سكنك. اختار منطقة من الأزرار، ولو مفيش منطقة مناسبة اختار «❌ ولا منطقة مناسبة».';
 if(question.field_key==='full_name')return 'قصدي اكتب اسمك بالكامل علشان يتسجل في طلب التقديم، ويفضل اسمين أو أكتر.';
 if(question.field_key==='shift_acceptance')return 'قصدي هل نظام الشيفت المذكور في السؤال مناسب ليك وتقدر تلتزم بيه؟ رد «نعم» أو «لا».';
 if(question.field_key==='ready_to_start')return 'قصدي لو تم قبولك، هل تقدر تبدأ الشغل قريب؟ رد «نعم» أو «لا».';
 if(question.kind==='yes_no')return question.label+'\nرد «نعم» أو «لا».';
 if(question.kind==='area')return questionPrompt(question,areas);
 if(question.kind==='number')return question.label+'\nاكتب الرقم فقط أو اكتبه في جملة قصيرة.';
 return questionPrompt(question,areas);
}
function handoffTurn({answers,current,applicant,questions,areas,settings,message,reason='low_confidence'}){
 const handoffAnswers={...answers,__ai_handoff:{question:String(message?.body||'').slice(0,1000),at:new Date().toISOString(),reason}};
 delete handoffAnswers.__agent_state;
 const fallback=reason==='user_requested_human'
  ?'تمام، هحوّل المحادثة لمسؤول التوظيف علشان يكمل معاك.'
  :String(settings.ai_fallback||'السؤال ده محتاج تأكيد من مسؤول التوظيف، هحوّل المحادثة للفريق علشان يرد عليك بدقة.').trim();
 return {patch:{answers:handoffAnswers,awaiting_id:current?.id||null,bot_enabled:false,stage:computedStage({...applicant,answers:handoffAnswers},questions,areas)},reply:fallback,handoff:true,handoff_reason:reason};
}
function agentClarificationTurn({answers,current,applicant,questions,areas,message}){
 const previous=answers.__agent_state;
 const sameContext=previous?.kind==='clarification'&&String(previous.awaiting_id||'')===String(current?.id||'');
 const attempts=(sameContext?Number(previous.attempts||0):0)+1;
 if(attempts>2)return null;
 answers.__agent_state={kind:'clarification',attempts,awaiting_id:current?.id||null,last_message:String(message?.body||'').slice(0,500),at:new Date().toISOString()};
 const first='مش عندي إجابة مؤكدة للسؤال ده بالشكل الحالي، ومش هخمن عليك أو أوقف التقديم. اكتب سؤالك بتفصيل أكتر، أو اكتب النقطة اللي تقصدها زي «المرتب»، «الشيفت»، «المناطق» أو «شروط التقديم».';
 const second='لسه مش قادر أحدد معلومة مؤكدة للسؤال ده. تقدر تعيد صياغته مرة أخيرة، أو تكتب «كمل» علشان نكمل التقديم، ولو محتاج شخص من الفريق اكتب «عايز موظف».';
 return {patch:{answers,awaiting_id:current?.id||null,stage:computedStage({...applicant,answers},questions,areas)},reply:attempts===1?first:second,agent_action:'clarify_unknown',agent_confidence:0.5};
}
function reopenAnswer({decision,answers,questions,areas,applicant}){
 const q=activeQuestions(questions).find(item=>item.field_key===decision.field_key);
 if(!q)return null;
 delete answers[q.id];
 delete answers.__qualification_stop;
 delete answers.__area_preview;
 delete answers.__area_page;
 clearAgentState(answers);
 activeFlow(answers);
 return {patch:{answers,awaiting_id:q.id,stage:computedStage({...applicant,answers},questions,areas)},reply:'تمام، نعدّل الإجابة دي.\n\n'+questionPrompt(q,areas),agent_action:'change_answer',agent_confidence:decision.confidence};
}
function startText(text){
 return norm(String(text||'').replace(/[’']/g,'')).replace(/[!?؟.,،؛:"“”‘’…]/g,' ').replace(/\s+/g,' ').trim();
}
export function isApplicationStartMessage(text){
 const n=startText(text);
 if(!n)return false;
 if(/^(?:مرحبا\s+)?هل يمكنني الحصول علي مزيد من المعلومات(?: حول هذا)?$/.test(n))return true;
 if(/^(?:عايز|عاوز|ممكن|حابب|اريد)\s+(?:اقدم|التقديم)(?:\s+علي\s+(?:الوظيفه|الشغل))?$/.test(n))return true;
 if(/^(?:عايز|عاوز|ممكن|حابب)\s+تفاصيل(?:\s+(?:عن|عن الشغل|عن الوظيفه))?$/.test(n))return true;
 if(/^im interested(?: in (?:this|the job|the position))?$/.test(n))return true;
 if(/^can i get more information(?: about this)?$/.test(n))return true;
 return false;
}
function hasMetaAdAttribution(answers){
 const attribution=answers?.__attribution;
 return Boolean(attribution&&(attribution.source_id||attribution.ad_id||attribution.ctwa_clid||norm(attribution.source_type)==='ad'));
}
function isFreshApplicationStart(applicant,message){
 return !applicant?.awaiting_id
  &&realAnswerCount(applicant?.answers)===0
  &&(!applicant?.stage||applicant.stage==='new')
  &&(hasMetaAdAttribution(applicant?.answers)||isApplicationStartMessage(message?.body));
}
async function parseStructuredPendingAnswer({current,message,areas,settings,interpret}){
 if(!current||!['yes_no','number','name'].includes(current.kind))return null;
 let parsed=validateAnswer(current,message.body,areas,message.media_path?{path:message.media_path}:null);
 if(parsed.ok)return parsed;
 if(!settings.ai_enabled)return null;
 const ai=await interpret(message.body,current,areas);
 if(ai?.intent!=='answer'||String(ai.answer).includes('محجوب'))return null;
 parsed=validateAnswer(current,ai.answer,areas,null);
 return parsed.ok?parsed:null;
}
function areaAction(body){
 const s=String(body||'');
 if(s==='no_work_area')return {type:'no_work_area'};
 if(s.startsWith('area_preview:'))return {type:'preview',id:s.slice('area_preview:'.length)};
 if(s.startsWith('confirm_area:'))return {type:'confirm',id:s.slice('confirm_area:'.length)};
 if(s.startsWith('area_page:'))return {type:'page',page:Number(s.slice('area_page:'.length))};
 return null;
}
function rejectedAreaReply(area,current,areas){
 const alternatives=areas.filter(z=>z.active&&z.id!==area.id);
 const intro=`تمام، مش هختار ${area.name}.`;
 if(!current)return intro;
 if(current.kind==='area'){
  const options=alternatives.length?'\n'+alternatives.map(z=>`• ${z.name}`).join('\n'):'\nمفيش مناطق بديلة متاحة حالياً، ومسؤول التوظيف هيتابع معاك.';
  return intro+'\n'+current.label+options;
 }
 return intro+'\n\nنكمل التقديم: '+questionPrompt(current,areas);
}

function areaListInquiry(text){
 const n=norm(text);
 return /(?:^|\s)(?:المناطق|مناطق|الاماكن|اماكن)(?:\s|$)/.test(n)
  && /(?:متاح|متاحه|الشغل|العمل|التعيين|اشتغل|اقدم|التقديم|فين|ايه|اي|كل)/.test(n)
  || ['المناطق','مناطق الشغل','اماكن الشغل','الاماكن المتاحه'].includes(n);
}
function recruitmentAreas(areas){
 return areas.filter(z=>z.active);
}
function areaListReply(areas){
 const live=recruitmentAreas(areas);
 if(!live.length)return 'مفيش مناطق توظيف متاحة مضافة حاليًا. مسؤول التوظيف يقدر يوضح لك آخر الأماكن المتاحة.';
 return 'المناطق المتاحة موجودة في الأزرار تحت 👇\nاختار المنطقة من الأزرار علشان تشوف تفاصيلها.';
}
function noWorkAreaAnswer(text){
 const n=norm(text);
 return ['مفيش','لا يوجد','ولا منطقه','ولا منطقة','مفيش منطقه','مفيش منطقة','ولا واحده','ولا واحدة','ولا واحد','مش هقدر في اي منطقه','مش هقدر في اي منطقة'].includes(n)
  || /(?:مفيش|لا يوجد|ولا)\s+(?:منطقه|منطقة|مكان)/.test(n);
}
function saveNoWorkArea(answers,current){
 answers[current.id]={value:'__none__',display:'لا توجد منطقة مناسبة',label:current.label,key:current.field_key,kind:current.kind,at:new Date().toISOString(),no_eligible_work_area:true,work_area_eligible:false};
 return answers;
}
const NO_MOTORCYCLE_REPLY='شكرًا ليك 🙏\n\nالوظيفة المتاحة حاليًا في Breadfast بتشترط وجود موتوسيكل متاح للشغل يوميًا، لذلك مش هنقدر نكمل التقديم على الوظيفة دي حاليًا.\n\nلو توفر معاك موتوسيكل بعد كده تقدر ترجع تقدم من جديد.';
const NO_ELIGIBLE_WORK_AREA_REPLY='شكرًا ليك 🙏\n\nالتعيين الحالي متاح في مناطق تشغيل محددة، وبما إن مفيش منطقة متاحة تقدر تلتزم بالشغل فيها يوميًا، مش هنقدر نكمل التقديم على الوظيفة دي حاليًا.\n\nلو قدرت تلتزم بمنطقة تشغيل متاحة بعد كده تقدر ترجع تقدم من جديد.';
const SHIFT_STOP_REPLY='تمام، سجلت إجابتك.\n\nنظام الشيفت الحالي شرط للتقديم على الوظيفة دي، لذلك مش هنكمل باقي خطوات التقديم حاليًا.';
const QUALIFICATION_PENDING_REPLY='تمام، سجلت بياناتك الحالية. في شرط تأهيل لسه محتاج تأكيد قبل إنهاء التقديم، ومسؤول التوظيف يقدر يراجعه.';
function stopQualification(answers,reason,extra={}){
 const at=new Date().toISOString();
 answers.__qualification_stop={reason,at,...extra};
 answers.__application_flow_status={value:'stopped_not_qualified',reason,at,kind:'flow_status'};
 delete answers.__residence_clarification;
 return {answers,stage:realAnswerCount(answers)?'incomplete':'new',awaiting_id:null};
}
function completeFlow(answers){
 answers.__application_flow_status={value:'completed',at:new Date().toISOString(),kind:'flow_status'};
 delete answers.__qualification_stop;
 delete answers.__residence_clarification;
 return answers;
}
function commitAreaChoice({area,current,answers,qs,questions,areas,settings,applicant,qualificationFlowEnabled}){
 clearAgentState(answers);
 delete answers.__area_preview;
 delete answers.__area_page;
 answers[current.id]={
  value:area.id,display:area.name,label:current.label,key:current.field_key,kind:current.kind,
  at:new Date().toISOString(),
  ...(current.field_key==='preferred_work_area'?{work_area_eligible:area.recruitment_eligible===true,work_area_zone:area.zone||'UNKNOWN'}:{})
 };
 if(current.field_key==='preferred_work_area'&&area.recruitment_eligible!==true){
  return {patch:stopQualification(answers,'no_eligible_work_area',{work_area:area.name}),reply:NO_ELIGIBLE_WORK_AREA_REPLY};
 }
 const next=qs.find(q=>!answered(q,answers,areas)&&!(answers[q.id]?.skipped&&!q.required));
 const comp=completion(questions,answers,areas);
 const qualification=qualificationFlowEnabled?qualificationFor({...applicant,answers},questions,areas,settings):{qualified_candidate:true,reasons:[]};
 if(comp.complete&&qualification.qualified_candidate===false){
  const reason=qualification.reasons[0]||'not_qualified';
  return {patch:stopQualification(answers,reason),reply:stoppedReply(reason)};
 }
 if(comp.complete&&qualification.qualified_candidate===true)completeFlow(answers);
 const stage=comp.complete&&qualification.qualified_candidate===true?'complete':realAnswerCount(answers)?'incomplete':'new';
 const finalReply=next?questionPrompt(next,areas):(qualification.qualified_candidate===true?settings.completion:QUALIFICATION_PENDING_REPLY);
 const prefix=current.field_key==='preferred_work_area'?'تمام، سجلت منطقة العمل: '+area.name+' ✅\n\n':'تم تثبيت منطقة التقديم: '+area.name+' ✅\n\n';
 if(current.field_key==='preferred_work_area'){
  return {
   patch:{answers,stage,awaiting_id:next?.id||null},
   reply:prefix+areaDetails(area),
   followup_reply:finalReply
  };
 }
 return {patch:{answers,stage,awaiting_id:next?.id||null},reply:prefix+finalReply};
}
function activeFlow(answers){
 if(!answers.__application_flow_status||answers.__application_flow_status.value!=='active'){
  answers.__application_flow_status={value:'active',at:new Date().toISOString(),kind:'flow_status'};
 }
 return answers;
}
function stoppedReply(reason){
 if(reason==='no_motorcycle')return NO_MOTORCYCLE_REPLY;
 if(reason==='no_eligible_work_area')return NO_ELIGIBLE_WORK_AREA_REPLY;
 if(reason==='shift_not_accepted')return SHIFT_STOP_REPLY;
 return 'بياناتك متسجلة عندنا، والتقديم متوقف حاليًا لأن شروط الوظيفة الحالية مش مكتملة.';
}
function postCompletionReply(){
 return 'بياناتك متسجلة عندنا بالفعل ✅\nلو عندك سؤال عن الشغل، المرتب، المواعيد أو المناطق ابعته وأنا أساعدك.';
}

const RESTAURANT_WORDS=['مطاعم','مطعم','ريستورانت','restaurant','restaurants'];
const MARKET_WORDS=['ماركت','سوبرماركت','سوبر ماركت','متجر','market'];
function hasWord(text,words){
 const n=norm(text);
 return words.some(w=>n.includes(norm(w)));
}
function baseAreaName(name){
 let n=norm(name);
 for(const word of [...RESTAURANT_WORDS,...MARKET_WORDS])n=n.replaceAll(norm(word),' ');
 return n.replace(/\s+/g,' ').trim();
}
function areaCategory(area){
 const source=norm((area?.name||'')+' '+(area?.details||''));
 if(RESTAURANT_WORDS.some(w=>source.includes(norm(w))))return 'restaurant';
 if(MARKET_WORDS.some(w=>source.includes(norm(w))))return 'market';
 return 'base';
}
function explicitAreaHits(text,areas){
 const n=norm(text);
 return areas.filter(a=>a.active&&norm(a.name)&&n.includes(norm(a.name)));
}
function areaComparison(text,areas,answers){
 const n=norm(text);
 const compareIntent=/(?:الفرق|فرق|مقارنه|مقارنة|قارن|الاختلاف|احسن|افضل|أفضل)/.test(n);
 if(!compareIntent)return null;
 const active=areas.filter(a=>a.active),found=[];
 const add=area=>{if(area&&!found.some(x=>x.id===area.id))found.push(area);};
 explicitAreaHits(text,active).forEach(add);

 const previewId=answers?.__area_preview?.value;
 const saved=Object.values(answers||{}).find(v=>v?.kind==='area');
 const context=active.find(a=>a.id===previewId)||active.find(a=>a.id===saved?.value)||found[0]||null;
 const base=context?baseAreaName(context.name):'';
 const siblings=base?active.filter(a=>baseAreaName(a.name)===base):active;

 if(hasWord(text,RESTAURANT_WORDS)){
  add(siblings.find(a=>areaCategory(a)==='restaurant')||active.find(a=>areaCategory(a)==='restaurant'&&(!base||baseAreaName(a.name)===base)));
 }
 if(hasWord(text,MARKET_WORDS)){
  add(siblings.find(a=>areaCategory(a)==='market')||siblings.find(a=>areaCategory(a)==='base')||active.find(a=>areaCategory(a)==='market'&&(!base||baseAreaName(a.name)===base)));
 }
 if(found.length===1&&context&&context.id!==found[0].id)add(context);
 if(found.length<2)return null;
 return found.slice(0,3);
}
function areaComparisonReply(items){
 const blocks=items.map(area=>areaDetails(area));
 return 'دي مقارنة من التفاصيل المسجلة عندنا فقط 👇\n\n'+blocks.join('\n\n────────\n\n')+'\n\nلو عايز تقارن نقطة محددة زي المرتب أو الشيفت أو مكان الاستلام قولّي.';
}

export async function planTurn({applicant:a,message:m,questions,areas,settings,interpret,knowledge=[]}) {
 if(!a.bot_enabled)return {patch:{},reply:''};
 const qs=activeQuestions(questions);const answers={...a.answers};
 if(!qs.length)return {patch:{},reply:'التقديم متوقف مؤقتاً لحين تجهيز الأسئلة. مسؤول التوظيف هيتابع معاك.'};
 const qualificationFlowEnabled=qs.some(q=>q.field_key==='has_motorcycle')&&qs.some(q=>q.field_key==='preferred_work_area');

 if(isFreshApplicationStart(a,m)){
  const first=qs[0];
  const welcome=String(settings.welcome||'').trim();
  const firstQuestion=questionPrompt(first,areas);
  return welcome
   ?{patch:{awaiting_id:first.id,stage:'new'},reply:welcome,followup_reply:firstQuestion}
   :{patch:{awaiting_id:first.id,stage:'new'},reply:firstQuestion};
 }

 const earlyDecision=settings.ai_enabled?decideConversationAction(m.body,null,areas):null;
 const earlyCurrent=qs.find(q=>q.id===a.awaiting_id)||null;
 if(earlyDecision?.action==='handoff'){
  return handoffTurn({answers,current:earlyCurrent,applicant:a,questions,areas,settings,message:m,reason:earlyDecision.reason});
 }
 if(earlyDecision?.action==='change_answer'){
  const reopened=reopenAnswer({decision:earlyDecision,answers,questions,areas,applicant:a});
  if(reopened)return reopened;
 }
 if(earlyDecision?.action==='clarify_change_target'){
  return {patch:{answers,awaiting_id:a.awaiting_id||null},reply:'تمام، تقدر تعدّل إجابة سابقة. عايز تغيّر إيه: الموتوسيكل، منطقة العمل، الاسم، الشيفت، ولا جاهزية البداية؟',agent_action:'clarify_change_target',agent_confidence:earlyDecision.confidence};
 }

 if(answers.__qualification_stop){
  if(areaListInquiry(m.body)){
   answers.__area_page={value:0,kind:'area_page',at:new Date().toISOString(),eligibility_only:true};
   return {patch:{answers,awaiting_id:null},reply:areaListReply(areas)};
  }
  if(settings.ai_enabled&&settings.ai_knowledge_enabled===true){
   const query=knowledgeQueryText(answers,m.body);
   const threshold=Number(settings.ai_confidence_threshold||0.62),match=findKnowledgeAnswer(query,knowledge,threshold,{allowStatement:true});
   if(match){const hadAgentState=Boolean(answers.__agent_state||answers.__ai_handoff);clearAgentState(answers);return {patch:{...(hadAgentState?{answers}:{}),awaiting_id:null},reply:String(match.answer||'').trim(),knowledge_id:match.id,knowledge_confidence:match.confidence};}
  }
  return {patch:{awaiting_id:null},reply:stoppedReply(answers.__qualification_stop.reason)};
 }

 activeFlow(answers);
 const pending=qs.filter(q=>!answered(q,answers,areas)&&!(answers[q.id]?.skipped&&!q.required));
 const current=pending.find(q=>q.id===a.awaiting_id)||pending[0];

 const decision=settings.ai_enabled?decideConversationAction(m.body,current,areas):null;
 if(decision?.action==='handoff'){
  return handoffTurn({answers,current,applicant:a,questions,areas,settings,message:m,reason:decision.reason});
 }
 if(decision?.action==='change_answer'){
  const reopened=reopenAnswer({decision,answers,questions,areas,applicant:a});
  if(reopened)return reopened;
 }
 if(decision?.action==='clarify_change_target'){
  clearAgentState(answers);
  return {patch:{answers,awaiting_id:current?.id||null},reply:'تمام، عايز تغيّر إجابة أنهي جزء: الموتوسيكل، منطقة العمل، الاسم، الشيفت، ولا جاهزية البداية؟',agent_action:'clarify_change_target',agent_confidence:decision.confidence};
 }
 if(decision?.action==='clarify_current'){
  clearAgentState(answers);
  return {patch:{answers,awaiting_id:current?.id||null},reply:explainCurrentQuestion(current,areas),agent_action:'clarify_current',agent_confidence:decision.confidence};
 }
 if(decision?.action==='resume_flow'){
  clearAgentState(answers);
  return {patch:{answers,awaiting_id:current?.id||null},reply:current?questionPrompt(current,areas):postCompletionReply(),agent_action:'resume_flow',agent_confidence:decision.confidence};
 }

 if(answers.__agent_state?.kind==='clarification'&&settings.ai_enabled&&settings.ai_knowledge_enabled===true){
  const query=knowledgeQueryText(answers,m.body);
  const threshold=Number(settings.ai_confidence_threshold||0.62);
  const match=findKnowledgeAnswer(query,knowledge,threshold,{allowStatement:true});
  if(match){
   clearAgentState(answers);
   return {
    patch:{answers,awaiting_id:current?.id||null},
    reply:String(match.answer||'').trim(),
    followup_reply:current?questionPrompt(current,areas):null,
    knowledge_id:match.id,
    knowledge_confidence:match.confidence
   };
  }
 }

 if(current?.field_key==='preferred_work_area'&&noWorkAreaAnswer(m.body)){
  saveNoWorkArea(answers,current);
  return {patch:stopQualification(answers,'no_eligible_work_area'),reply:NO_ELIGIBLE_WORK_AREA_REPLY};
 }

 const action=areaAction(m.body);
 if(action?.type==='no_work_area'&&current?.field_key==='preferred_work_area'){
  saveNoWorkArea(answers,current);
  return {patch:stopQualification(answers,'no_eligible_work_area'),reply:NO_ELIGIBLE_WORK_AREA_REPLY};
 }
 if(action?.type==='page'){
  const eligibilityOnly=current?.field_key==='preferred_work_area'||answers.__area_page?.eligibility_only===true;
  const activeAreas=eligibilityOnly?recruitmentAreas(areas):areas.filter(z=>z.active),pages=Math.max(1,Math.ceil(activeAreas.length/7));
  const page=Math.max(0,Math.min(pages-1,Number.isInteger(action.page)?action.page:0));
  answers.__area_page={value:page,kind:'area_page',at:new Date().toISOString(),...(eligibilityOnly?{eligibility_only:true}:{})};
  const pageNote=pages>1?'\nصفحة '+(page+1)+' من '+pages:'';
  const continueFlow=current&&current.kind!=='area'?'\n\nنكمل التقديم: '+questionPrompt(current,areas):'';
  return {patch:{answers,...(current?{awaiting_id:current.id}:{})},reply:(current?.kind==='area'?questionPrompt(current,areas):areaListReply(areas))+pageNote+continueFlow};
 }
 if(action){
  const area=areas.find(z=>z.active&&z.id===action.id);
  if(!area)return {patch:current?{awaiting_id:current.id}:{},reply:current?.kind==='area'?questionPrompt(current,areas):areaListReply(areas)};
  if(current?.kind==='area'){
   if(current.field_key==='preferred_work_area'&&(action.type==='preview'||action.type==='confirm')){
    return commitAreaChoice({area,current,answers,qs,questions,areas,settings,applicant:a,qualificationFlowEnabled});
   }
   if(action.type==='preview'){
    answers.__area_preview={value:area.id,display:area.name,kind:'area_preview',at:new Date().toISOString()};
    return {patch:{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'},reply:areaPreviewReply(area,areas)};
   }
   if(action.type==='confirm'){
    if(answers.__area_preview?.value!==area.id)return {patch:{awaiting_id:current.id},reply:'اختار المنطقة الأول علشان تشوف تفاصيلها، وبعدها أكد اختيارك النهائي.\n\n'+questionPrompt(current,areas)};
    return commitAreaChoice({area,current,answers,qs,questions,areas,settings,applicant:a,qualificationFlowEnabled});
   }
  }
  if(action.type==='preview'){
   const continueFlow=current?'\n\nنكمل التقديم: '+questionPrompt(current,areas):'\n\nاختار منطقة تانية من الأزرار لو حابب تقارن.';
   return {patch:current?{awaiting_id:current.id}:{},reply:areaDetails(area)+continueFlow};
  }
 }

 const comparedAreas=areaComparison(m.body,areas,answers);
 if(comparedAreas){
  const continueFlow=current?'\n\nنكمل التقديم: '+questionPrompt(current,areas):'';
  return {patch:current?{awaiting_id:current.id}:{stage:computedStage(a,questions,areas),awaiting_id:null},reply:areaComparisonReply(comparedAreas)+continueFlow};
 }

 const inquiry=areaInquiry(m.body,areas);
 if(inquiry){
  if(current?.kind==='area'){
   if(current.field_key==='preferred_work_area'){
    return commitAreaChoice({area:inquiry,current,answers,qs,questions,areas,settings,applicant:a,qualificationFlowEnabled});
   }
   answers.__area_preview={value:inquiry.id,display:inquiry.name,kind:'area_preview',at:new Date().toISOString()};
   return {patch:{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'},reply:areaPreviewReply(inquiry,areas)};
  }
  return {patch:current?{awaiting_id:current.id}:{},reply:areaDetails(inquiry)+(current?'\n\nنكمل التقديم: '+questionPrompt(current,areas):'')};
 }

 if(areaListInquiry(m.body)){
  answers.__area_page={value:0,kind:'area_page',at:new Date().toISOString(),eligibility_only:true};
  const continueFlow=current?'\n\nنكمل التقديم: '+questionPrompt(current,areas):'';
  return {patch:current?{answers,awaiting_id:current.id}:{answers,stage:computedStage(a,questions,areas),awaiting_id:null},reply:areaListReply(areas)+continueFlow};
 }

 const areaQuestion=/(تفاصيل|مرتب|قبض|عنوان|مواعيد|ساعات|بونص|مميزات)/.test(norm(m.body));
 const compoundStructuredQuestion=current?.kind==='yes_no'
  &&looksLikeQuestion(m.body)
  &&validateAnswer(current,m.body,areas,null).ok;
 if(areaQuestion&&!compoundStructuredQuestion&&settings.ai_enabled&&settings.ai_knowledge_enabled===true&&explicitAreaHits(m.body,areas).length===0){
  const query=knowledgeQueryText(answers,m.body);
  const threshold=Number(settings.ai_confidence_threshold||0.62),match=findKnowledgeAnswer(query,knowledge,threshold,{allowStatement:true});
  if(match){
   const hadAgentState=Boolean(answers.__agent_state||answers.__ai_handoff);
   clearAgentState(answers);
   return {patch:current?{...(hadAgentState?{answers}:{}),awaiting_id:current.id}:{...(hadAgentState?{answers}:{}),stage:computedStage(a,questions,areas),awaiting_id:null},reply:String(match.answer||'').trim(),followup_reply:current?questionPrompt(current,areas):null,knowledge_id:match.id,knowledge_confidence:match.confidence};
  }
 }
 if(areaQuestion&&!compoundStructuredQuestion){
  let area=null,intent=null;
  if(settings.ai_enabled){intent=await interpret(m.body,current,areas);if(intent?.intent==='area_info')area=areas.find(z=>z.active&&z.id===intent.area_id);}
  if(intent?.intent==='area_reject'){
   const rejected=areas.find(z=>z.active&&z.id===intent.area_id);
   if(rejected){
    const cleared=answers.__area_preview?.value===rejected.id;
    if(cleared)delete answers.__area_preview;
    const patch=current
     ?(cleared?{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'}:{awaiting_id:current.id})
     :(cleared?{answers}:{});
    return {patch,reply:rejectedAreaReply(rejected,current,areas)};
   }
  }
  if(!area){const saved=Object.values(answers).find(v=>v.kind==='area');area=areas.find(z=>z.active&&z.id===saved?.value);}
  const info=area?areaDetails(area):'تقصد أنهي منطقة؟ اختار المنطقة من الأزرار تحت علشان تشوف تفاصيلها.';
  if(!area)answers.__area_page={value:0,kind:'area_page',at:new Date().toISOString()};
  return {patch:current?(area?{awaiting_id:current.id}:{answers,awaiting_id:current.id}):(area?{}:{answers}),reply:info+(current?'\n\n'+questionPrompt(current,areas):'')};
 }

 if(current&&a.awaiting_id===current.id&&norm(m.body)!=='تخطي'){
  const parsed=await parseStructuredPendingAnswer({current,message:m,areas,settings,interpret});
  if(parsed){
   clearAgentState(answers);
   answers[current.id]={value:parsed.value,display:parsed.display,label:current.label,key:current.field_key,kind:current.kind,at:new Date().toISOString()};
   if(current.field_key==='has_motorcycle'&&parsed.value===false){
    return {patch:stopQualification(answers,'no_motorcycle'),reply:NO_MOTORCYCLE_REPLY};
   }
   if(current.field_key==='shift_acceptance'&&parsed.value===false&&settings.qualification_require_shift===true){
    return {patch:stopQualification(answers,'shift_not_accepted'),reply:SHIFT_STOP_REPLY};
   }
   const next=qs.find(q=>!answered(q,answers,areas)&&!(answers[q.id]?.skipped&&!q.required));
   const comp=completion(questions,answers,areas);
   const qualification=qualificationFlowEnabled?qualificationFor({...a,answers},questions,areas,settings):{qualified_candidate:true,reasons:[]};
   if(comp.complete&&qualification.qualified_candidate===false){
    const reason=qualification.reasons[0]||'not_qualified';
    return {patch:stopQualification(answers,reason),reply:stoppedReply(reason)};
   }
   if(comp.complete&&qualification.qualified_candidate===true)completeFlow(answers);
   const stage=comp.complete&&qualification.qualified_candidate===true?'complete':realAnswerCount(answers)?'incomplete':'new';
   let match=null;
   if(settings.ai_enabled&&settings.ai_knowledge_enabled===true&&looksLikeQuestion(m.body)){
    const threshold=Number(settings.ai_confidence_threshold||0.62);
    const candidate=findKnowledgeAnswer(m.body,knowledge,threshold);
    if(candidate&&!sameKnowledgeTopic(current.label,candidate.question))match=candidate;
   }
   const continuation=next?questionPrompt(next,areas):(qualification.qualified_candidate===true?settings.completion:QUALIFICATION_PENDING_REPLY);
   let reply=continuation,followup_reply=null;
   if(match){
    reply=String(match.answer||'').trim();
    followup_reply=continuation;
   }
   const result={patch:{answers,stage,awaiting_id:next?.id||null},reply};
   if(match){
    result.knowledge_id=match.id;
    result.knowledge_confidence=match.confidence;
    result.followup_reply=followup_reply;
   }
   return result;
  }
 }

 if(settings.ai_enabled&&settings.ai_knowledge_enabled===true){
  const query=knowledgeQueryText(answers,m.body);
  const threshold=Number(settings.ai_confidence_threshold||0.62);
  const match=findKnowledgeAnswer(query,knowledge,threshold,{allowStatement:true});
  if(match){
   const hadAgentState=Boolean(answers.__agent_state||answers.__ai_handoff);
   clearAgentState(answers);
   return {
    patch:current?{...(hadAgentState?{answers}:{}),awaiting_id:current.id}:{...(hadAgentState?{answers}:{}),stage:computedStage(a,questions,areas),awaiting_id:null},
    reply:String(match.answer||'').trim(),
    followup_reply:current?questionPrompt(current,areas):null,
    knowledge_id:match.id,
    knowledge_confidence:match.confidence
   };
  }
  if(looksLikeQuestion(m.body)||answers.__agent_state?.kind==='clarification'){
   const clarification=agentClarificationTurn({answers,current,applicant:a,questions,areas,message:m});
   if(clarification)return clarification;
   return handoffTurn({answers,current,applicant:a,questions,areas,settings,message:m,reason:'repeated_unknown_question'});
  }
 }

 if(!current){
  if(areaQuestion){
   answers.__area_page={value:0,kind:'area_page',at:new Date().toISOString()};
   return {patch:{answers,stage:computedStage(a,questions,areas),awaiting_id:null},reply:'اختار المنطقة من الأزرار تحت علشان أقولك تفاصيلها.'};
  }
  return {patch:{stage:computedStage(a,questions,areas),awaiting_id:null},reply:postCompletionReply()};
 }
 if(!a.awaiting_id || a.awaiting_id!==current.id){
  const prompt=questionPrompt(current,areas);
  if(realAnswerCount(answers))return {patch:{awaiting_id:current.id},reply:'نكمل بياناتك: '+prompt};
  const welcome=String(settings.welcome||'').trim();
  return welcome
   ?{patch:{awaiting_id:current.id},reply:welcome,followup_reply:prompt}
   :{patch:{awaiting_id:current.id},reply:prompt};
 }

 if(!current.required&&norm(m.body)==='تخطي')answers[current.id]={skipped:true,label:current.label,key:current.field_key,kind:current.kind};
 else {
  let parsed=validateAnswer(current,m.body,areas,m.media_path?{path:m.media_path}:null);
  let ai=null;
  if(!parsed.ok && settings.ai_enabled) ai=await interpret(m.body,current,areas);

  if(ai?.intent==='area_info') {
   const area=areas.find(z=>z.active&&z.id===ai.area_id);
   if(area){
    if(current.kind==='area'){
     if(current.field_key==='preferred_work_area'){
      return commitAreaChoice({area,current,answers,qs,questions,areas,settings,applicant:a,qualificationFlowEnabled});
     }
     answers.__area_preview={value:area.id,display:area.name,kind:'area_preview',at:new Date().toISOString()};
     return {patch:{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'},reply:areaPreviewReply(area,areas)};
    }
    return {patch:{},reply:areaDetails(area)+'\n\n'+questionPrompt(current,areas)};
   }
  }

  if(ai?.intent==='area_reject'){
   const rejected=areas.find(z=>z.active&&z.id===ai.area_id);
   if(rejected){
    const cleared=answers.__area_preview?.value===rejected.id;
    if(cleared)delete answers.__area_preview;
    return {patch:cleared?{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'}:{awaiting_id:current.id},reply:rejectedAreaReply(rejected,current,areas)};
   }
  }

  if(!parsed.ok&&ai?.intent==='answer'&&!String(ai.answer).includes('محجوب')) parsed=validateAnswer(current,ai.answer,areas,null);
  if(!parsed.ok)return {patch:{},reply:(m.media_error?m.media_error+'\n':'محتاج أوضح إجابتك علشان أسجلها صح.\n')+questionPrompt(current,areas)};

  if(current.kind==='area'){
   const area=areas.find(z=>z.active&&z.id===parsed.value);
   if(area){
    if(current.field_key==='preferred_work_area'){
     return commitAreaChoice({area,current,answers,qs,questions,areas,settings,applicant:a,qualificationFlowEnabled});
    }
    if(answers.__area_preview?.value===area.id){
     delete answers.__area_preview;
     answers[current.id]={value:parsed.value,display:parsed.display,label:current.label,key:current.field_key,kind:current.kind,at:new Date().toISOString()};
    }else{
     answers.__area_preview={value:area.id,display:area.name,kind:'area_preview',at:new Date().toISOString()};
     return {patch:{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'},reply:areaPreviewReply(area,areas)};
    }
   }
  }else{
   clearAgentState(answers);
   answers[current.id]={value:parsed.value,display:parsed.display,label:current.label,key:current.field_key,kind:current.kind,at:new Date().toISOString()};
  }
 }

 if(current.field_key==='has_motorcycle'&&answers[current.id]?.value===false){
  return {patch:stopQualification(answers,'no_motorcycle'),reply:NO_MOTORCYCLE_REPLY};
 }
 if(current.field_key==='shift_acceptance'&&answers[current.id]?.value===false&&settings.qualification_require_shift===true){
  return {patch:stopQualification(answers,'shift_not_accepted'),reply:SHIFT_STOP_REPLY};
 }
 const next=qs.find(q=>!answered(q,answers,areas)&&!(answers[q.id]?.skipped&&!q.required));
 const comp=completion(questions,answers,areas);
 const qualification=qualificationFlowEnabled?qualificationFor({...a,answers},questions,areas,settings):{qualified_candidate:true,reasons:[]};
 if(comp.complete&&qualification.qualified_candidate===false){
  const reason=qualification.reasons[0]||'not_qualified';
  return {patch:stopQualification(answers,reason),reply:stoppedReply(reason)};
 }
 if(comp.complete&&qualification.qualified_candidate===true)completeFlow(answers);
 const stage=comp.complete&&qualification.qualified_candidate===true?'complete':realAnswerCount(answers)?'incomplete':'new';
 let reply=next?questionPrompt(next,areas):(qualification.qualified_candidate===true?settings.completion:QUALIFICATION_PENDING_REPLY);
 if(current.kind==='area'&&answers[current.id]?.value){
  const area=areas.find(z=>z.id===answers[current.id].value);
  if(area)reply=`تم تثبيت منطقة التقديم: ${area.name} ✅\n\n`+reply;
 }
 return {patch:{answers,stage,awaiting_id:next?.id||null},reply};
}
