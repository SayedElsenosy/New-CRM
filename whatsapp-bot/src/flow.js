import {activeQuestions,answered,completion,computedStage,validateAnswer,questionPrompt,areaInquiry,areaDetails,norm} from './domain.js';
import {findKnowledgeAnswer,looksLikeQuestion,sameKnowledgeTopic} from './knowledge.js';
import {qualificationFor} from './qualification.js';
import {decideConversationAction,extractConversationFacts,extractConversationObservations,nextAgentQuestion} from './ai.js';
import {nearestWorkAreas,nearestWorkAreaReply,asksForNearbyArea,mentionsResidence} from './location.js';
import {plannerFactsForQuestions} from './agent-runtime.js';
import {conversationalAreaAdvice} from './area-advisor.js';

function areaPreviewReply(area,areas){
 const others=areas.filter(z=>z.active&&z.id!==area.id);
 const choices=others.length?'\n\nولو محتار، قولّي اسم منطقة تانية وأنا أقارنهم لك.':'';
 return areaDetails(area)+`\n\nلو تفاصيل ${area.name} مناسبة ليك قولّي «مناسبة وكمل». ولو مش مناسبة قولّي المنطقة اللي بتفكر فيها.`+choices;
}
function realAnswerCount(answers){return Object.keys(answers||{}).filter(k=>!k.startsWith('__')).length;}
function clearAgentState(answers){delete answers.__agent_state;delete answers.__ai_handoff;return answers;}
function applyAgentFacts({facts,questions,areas,answers}){
 const saved=[];
 for(const fact of facts||[]){
  const q=(questions||[]).find(item=>item.id===fact.question_id);
  if(!q||q.active===false||q.confirmation_required===true||answered(q,answers,areas))continue;
  let value=fact.value,display=fact.display;
  if(q.kind==='area'){
   const area=areas.find(z=>z.active&&String(z.id)===String(value));
   if(!area)continue;
   value=area.id;display=area.name;
  }else if(q.kind==='yes_no'){
   value=Boolean(value);display=value?'نعم':'لا';
  }
  answers[q.id]={
   value,display,label:q.label,key:q.field_key,kind:q.kind,at:new Date().toISOString(),
   agent_extracted:true,agent_confidence:Number(fact.confidence||0),agent_source:fact.source||'explicit',
   ...(q.field_key==='preferred_work_area'?{
    work_area_eligible:areas.find(z=>String(z.id)===String(value))?.recruitment_eligible===true,
    work_area_zone:areas.find(z=>String(z.id)===String(value))?.zone||'UNKNOWN'
   }:{})
  };
  saved.push({q,fact});
 }
 if(saved.length)clearAgentState(answers);
 return saved;
}
function nextMissing(qs,answers,areas){return nextAgentQuestion(qs,answers,areas,answered);}
function sideAnswerFollowup(applicant,current,areas){
 if(!current)return null;
 if(String(applicant?.awaiting_id||'')===String(current.id||''))return null;
 return questionPrompt(current,areas);
}
function knowledgeQueryText(answers,text){
 const current=String(text||'').trim();
 const previous=answers?.__agent_state?.kind==='clarification'?String(answers.__agent_state.last_message||'').trim():'';
 if(!previous||norm(previous)===norm(current))return current;
 return (previous+' '+current).trim().slice(0,2000);
}
function explainCurrentQuestion(question,areas){
 if(!question)return 'مفيش سؤال ناقص حاليًا. لو عندك سؤال عن الشغل ابعته بشكل مباشر.';
 if(question.field_key==='has_motorcycle')return 'قصدي: هل عندك موتوسيكل تقدر تستخدمه للشغل يوميًا؟ رد «نعم» أو «لا».';
 if(question.field_key==='preferred_work_area')return 'قصدي منطقة الشغل اللي تقدر تروحها وتلتزم بيها يوميًا، مش مكان سكنك. قولّي اسم المنطقة بطريقتك، ولو محتار أقدر أرشح وأقارن. ولو حابب تشوف القائمة اكتب «وريني المناطق».';
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
function yesNoTopicMentioned(question,text){
 const n=norm(text);
 if(question?.field_key==='has_motorcycle')return /(?:موتوسيكل|موتوسكل|موتسيكل|مكنه|مكنة|موتور)/.test(n);
 if(question?.field_key==='shift_acceptance')return /(?:شيفت|شفت|ورديه|وردية|ساعات الشغل|ساعات العمل)/.test(n);
 if(question?.field_key==='ready_to_start')return /(?:ابدا|ابدأ|بدايه|بداية|جاهز|انزل الشغل|استلم الشغل)/.test(n);
 if(question?.field_key==='motorcycle_license')return /(?:رخصه|رخصة|الرخصه|الرخصة)/.test(n);
 return false;
}
function ambiguousNegativeSideQuestion(question,text){
 if(question?.kind!=='yes_no')return false;
 const n=norm(text);
 const startsNegative=/^(?:لا|لاء|لأ)(?:\s|$)/.test(n);
 const asksSomething=/(?:ايه|إيه|فين|كام|امتى|إمتى|ازاي|إزاي|المتاح|متاح|تفاصيل|معلومات|ليه|لماذا)/.test(n)||/[?؟]/.test(String(text||''));
 return startsNegative&&asksSomething&&!yesNoTopicMentioned(question,text);
}
function residenceOnlyWhileChoosingWorkArea(question,text){
 if(question?.field_key!=='preferred_work_area')return false;
 const n=norm(text);
 const residence=/(?:ساكن|سكني|السكن|انا من|أنا من)/.test(n);
 const workIntent=/(?:عايز|عاوز|حابب|هشتغل|اشتغل|اقدر اشتغل|أقدر اشتغل|التزم|ينفعلي|مناسبه ليا|مناسبة ليا).*(?:شغل|اشتغل|منطقه|منطقة|زون|فرع)/.test(n);
 return residence&&!workIntent;
}
async function parseStructuredPendingAnswer({current,message,areas,settings,interpret}){
 if(!current||!['yes_no','choice','number','name'].includes(current.kind))return null;
 if(ambiguousNegativeSideQuestion(current,message.body))return null;
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
function choiceAction(body){
 const s=String(body||'');
 if(!s.startsWith('choice:'))return null;
 const parts=s.split(':');
 if(parts.length!==3)return null;
 const index=Number(parts[2]);
 return parts[1]&&Number.isInteger(index)&&index>=0?{question_id:parts[1],index}:null;
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
 const names=[...new Set(live.filter(x=>!/(?:ماركت|مطاعم|مطعم)/.test(norm(x.name))).map(x=>x.name))].slice(0,18);
 const list=names.length?names.map(x=>'• '+x).join('\n'):'المناطق متاحة في النظام';
 return 'دي مناطق الشغل المتاحة عندي حاليًا:\n\n'+list+'\n\nاكتب اسم المنطقة اللي بتفكر فيها وأنا أقولك تفاصيلها. ولو حابب أظهرلك أزرار اختيارات اكتب «الاختيارات».';
}
function quickOptionsRequest(text){
 const n=norm(text);
 return /^(?:وريني|اظهر|أظهر)?\s*(?:الاختيارات|اختيارات|الزراير|الأزرار|ازرار)$/.test(n)
  || /(?:وريني|اظهر|أظهر).*(?:الاختيارات|الزراير|الأزرار)/.test(n);
}
function naturalAreaConfirmation(text){
 const n=norm(text);
 if(/(?:مش|لا|لاء)\s+(?:مناسب|مناسبه|كمل)/.test(n))return false;
 return /(?:^|\s)(?:مناسب|مناسبه|تمام|ماشي|اختارها|ثبتها)(?:\s|$)/.test(n)
  &&/(?:كمل|نكمل|ثبت|اختار|مناسب|مناسبه|تمام|ماشي)/.test(n);
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
 const next=nextMissing(qs,answers,areas);
 const comp=completion(questions,answers,areas);
 const qualification=qualificationFlowEnabled?qualificationFor({...applicant,answers},questions,areas,settings):{qualified_candidate:true,reasons:[]};
 if(comp.complete&&qualification.qualified_candidate===false){
  const reason=qualification.reasons[0]||'not_qualified';
  return {patch:stopQualification(answers,reason),reply:stoppedReply(reason)};
 }
 if(comp.complete&&qualification.qualified_candidate===true)completeFlow(answers);
 const stage=comp.complete&&qualification.qualified_candidate===true?'complete':realAnswerCount(answers)?'incomplete':'new';
 const finalReply=next?questionPrompt(next,areas):(qualification.qualified_candidate===true?settings.completion:QUALIFICATION_PENDING_REPLY);
 const prefix=current.field_key==='preferred_work_area'?'تمام، هنكمل على منطقة '+area.name+' ✅':'تم تثبيت منطقة التقديم: '+area.name+' ✅\n\n';
 if(current.field_key==='preferred_work_area'){
  return {
   patch:{answers,stage,awaiting_id:next?.id||null},
   reply:prefix,
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

function jobOverviewIntent(text){
 const n=norm(text);
 if(!n)return false;
 return /(?:تفاصيل|معلومات|نظام|طبيعه|طبيعة|نوع)\s+(?:الشغل|الوظيفه|الوظيفة|العمل)/.test(n)
  || /(?:الشغل|الوظيفه|الوظيفة|العمل)\s+(?:عباره عن ايه|عبارة عن ايه|نظامه ايه|نظامها ايه|تفاصيله|تفاصيلها)/.test(n)
  || /(?:عايز|عاوز|ممكن|حابب)\s+(?:اعرف|أعرف)?\s*(?:كل\s+)?(?:تفاصيل|معلومات)\s+(?:الشغل|الوظيفه|الوظيفة)/.test(n);
}
function trustedOverviewRows(knowledge){
 const rows=(knowledge||[]).filter(row=>row?.active!==false&&row?.source==='manual'
  &&!['conflict','stale'].includes(String(row?.memory_status||''))
  &&String(row?.answer||'').trim());
 const topics=[
  /(?:الشيفت|شيفت|ساعات)/,
  /(?:المرتب|مرتب|راتب)/,
  /(?:الدخل|دخل)/,
  /(?:تأمين|تامين)/,
  /(?:موتوسيكل|موتوسكل|مكنه|مكنة)/,
  /(?:التقديم.*فلوس|فلوس.*التقديم)/
 ];
 const picked=[];
 for(const pattern of topics){
  const row=rows.find(item=>pattern.test(norm(item.question||'')));
  if(row&&!picked.some(x=>x.id===row.id))picked.push(row);
 }
 return picked;
}
function jobOverviewReply(knowledge){
 const rows=trustedOverviewRows(knowledge);
 if(!rows.length)return null;
 const bullets=rows.map(row=>'• '+String(row.answer||'').trim().replace(/\s+/g,' '));
 return 'أكيد 👌 دي أهم تفاصيل الشغل المؤكدة عندنا حاليًا:\n\n'
  +bullets.join('\n')
  +'\n\nتفاصيل المنطقة نفسها ممكن تختلف حسب نظام التشغيل، ولما تختار منطقة العمل هقولك تفاصيلها المسجلة.\n\nلو التفاصيل مناسبة ليك نكمل التقديم من مكان ما وقفنا.';
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

export async function planTurn({applicant:a,message:m,questions,areas,settings,interpret,knowledge=[],llmPlan=null}) {
 if(!a.bot_enabled)return {patch:{},reply:''};
 const qs=activeQuestions(questions);const answers={...a.answers};
 if(!qs.length)return {patch:{},reply:'التقديم متوقف مؤقتاً لحين تجهيز الأسئلة. مسؤول التوظيف هيتابع معاك.'};
 const qualificationFlowEnabled=qs.some(q=>q.field_key==='has_motorcycle')&&qs.some(q=>q.field_key==='preferred_work_area');

 const openingFacts=settings.ai_enabled?extractConversationFacts(m.body,qs,areas):[];
 if(isFreshApplicationStart(a,m)&&openingFacts.length===0){
  const first=nextMissing(qs,answers,areas)||qs[0];
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
 // Interactive button payloads are protocol actions, not natural-language turns.
 // Never feed IDs like area_preview:tagamoa into the Egyptian fact extractor.
 const buttonAction=areaAction(m.body);
 const choiceButton=choiceAction(m.body);
 const protocolAction=buttonAction||choiceButton;
 const observations=settings.ai_enabled&&!protocolAction?extractConversationObservations(m.body):[];
 if(observations.length){
  const existing=answers.__observed_facts&&typeof answers.__observed_facts==='object'?answers.__observed_facts:{};
  for(const observation of observations){
   existing[observation.key]={value:observation.value,display:observation.display,confidence:observation.confidence,source:observation.source,at:new Date().toISOString()};
  }
  answers.__observed_facts=existing;
 }
 const deterministicFacts=settings.ai_enabled&&!protocolAction?extractConversationFacts(m.body,qs,areas):[];
 const llmFacts=settings.agent_llm_enabled===true&&['assist','live'].includes(settings.agent_llm_mode)
  ?plannerFactsForQuestions(llmPlan,qs,areas,settings):[];
 const factsByQuestion=new Map();
 for(const fact of [...deterministicFacts,...llmFacts]){
  const current=factsByQuestion.get(fact.question_id);
  if(!current||Number(fact.confidence||0)>Number(current.confidence||0))factsByQuestion.set(fact.question_id,fact);
 }
 const agentFacts=[...factsByQuestion.values()];
 const savedAgentFacts=applyAgentFacts({facts:agentFacts,questions:qs,areas,answers});
 if(savedAgentFacts.length){
  const motorcycleQuestion=qs.find(q=>q.field_key==='has_motorcycle');
  if(motorcycleQuestion&&answers[motorcycleQuestion.id]?.value===false){
   return {patch:stopQualification(answers,'no_motorcycle'),reply:NO_MOTORCYCLE_REPLY,agent_action:'qualification_fact'};
  }
  const workAreaQuestion=qs.find(q=>q.field_key==='preferred_work_area');
  if(workAreaQuestion&&answers[workAreaQuestion.id]&&answers[workAreaQuestion.id].work_area_eligible===false){
   const areaName=answers[workAreaQuestion.id].display||'';
   return {patch:stopQualification(answers,'no_eligible_work_area',{work_area:areaName}),reply:NO_ELIGIBLE_WORK_AREA_REPLY,agent_action:'qualification_fact'};
  }
 }
 const pending=qs.filter(q=>!answered(q,answers,areas)&&!(answers[q.id]?.skipped&&!q.required));
 const current=pending.find(q=>q.id===a.awaiting_id)||nextMissing(qs,answers,areas);

 if(!protocolAction&&quickOptionsRequest(m.body)&&current){
  if(current.kind==='area'){
   answers.__area_page={value:0,kind:'area_page',at:new Date().toISOString(),eligibility_only:current.field_key==='preferred_work_area'};
   return {patch:{answers,awaiting_id:current.id},reply:'تمام، دي اختيارات سريعة للمناطق 👇\nولو حابب تكتب اسم المنطقة بنفسك عادي.' ,agent_action:'show_area_quick_options'};
  }
  if(current.kind==='yes_no'){
   return {patch:{awaiting_id:current.id},reply:'تمام، دي اختيارات سريعة: نعم / لا 👇\nوتقدر تكتب إجابتك بطريقتك.',agent_action:'show_yes_no_quick_options'};
  }
  if(current.kind==='choice'){
   return {patch:{awaiting_id:current.id},reply:'تمام، دي اختيارات سريعة للسؤال 👇\nوتقدر تكتب اختيارك بطريقتك.',agent_action:'show_choice_quick_options'};
  }
 }

 if(!protocolAction&&current?.kind==='area'&&answers.__area_preview?.value){
  const previewArea=areas.find(z=>z.active&&String(z.id)===String(answers.__area_preview.value));
  if(previewArea&&naturalAreaConfirmation(m.body)){
   return commitAreaChoice({area:previewArea,current,answers,qs,questions,areas,settings,applicant:a,qualificationFlowEnabled});
  }
  const repeated=validateAnswer(current,m.body,areas,null);
  if(previewArea&&repeated.ok&&String(repeated.value)===String(previewArea.id)){
   return commitAreaChoice({area:previewArea,current,answers,qs,questions,areas,settings,applicant:a,qualificationFlowEnabled});
  }
 }

 if(!protocolAction&&!residenceOnlyWhileChoosingWorkArea(current,m.body)){
  const advice=conversationalAreaAdvice(m.body,areas,answers);
  if(advice?.reply){
   if(current?.kind==='area'&&advice.previewAreaId){
    const preview=areas.find(z=>z.active&&String(z.id)===String(advice.previewAreaId));
    if(preview)answers.__area_preview={value:preview.id,display:preview.name,kind:'area_preview',at:new Date().toISOString(),advisor:true};
   }
   let sideMatch=null;
   if(settings.ai_enabled&&settings.ai_knowledge_enabled===true&&looksLikeQuestion(m.body)){
    const candidate=findKnowledgeAnswer(m.body,knowledge,Math.max(.5,Number(settings.ai_confidence_threshold||.62)-.06));
    if(candidate&&!/(منطقة|المناطق|عنوان|مكان|ماركت|مطاعم)/.test(norm(candidate.question||'')))sideMatch=candidate;
   }
   const persistAdvisorAnswers=Boolean((current?.kind==='area'&&advice.previewAreaId)||observations.length||savedAgentFacts.length);
   return {
    patch:current?{...(persistAdvisorAnswers?{answers}:{}),awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'}:{...(persistAdvisorAnswers?{answers}:{}),stage:computedStage({...a,answers},questions,areas),awaiting_id:null},
    reply:(sideMatch?String(sideMatch.answer||'').trim()+'\n\n':'')+advice.reply,
    knowledge_id:sideMatch?.id||null,
    knowledge_confidence:sideMatch?.confidence??null,
    agent_action:advice.action||'area_advisor'
   };
  }
 }

 if(current?.field_key==='preferred_work_area'&&!protocolAction&&(mentionsResidence(m.body)||asksForNearbyArea(m.body))){
  let recommendation=nearestWorkAreas(m.body,areas,{fallbackOriginKey:answers.__area_recommendations?.origin_key||null,limit:3});
  if(!recommendation&&asksForNearbyArea(m.body)){
   const residenceQuestion=qs.find(q=>['residence_area','residence'].includes(q.field_key));
   const storedResidence=residenceQuestion?answers[residenceQuestion.id]?.display||answers[residenceQuestion.id]?.value:null;
   if(storedResidence)recommendation=nearestWorkAreas(String(storedResidence),areas,{limit:3});
  }
  if(recommendation){
   clearAgentState(answers);
   delete answers.__area_preview;
   delete answers.__area_page;
   answers.__area_recommendations={
    values:recommendation.items.map(item=>item.area.id),
    origin_key:recommendation.origin.key,
    origin_label:recommendation.origin.label,
    kind:'area_recommendations',
    at:new Date().toISOString()
   };
   let sideMatch=null;
   if(settings.ai_enabled&&settings.ai_knowledge_enabled===true&&looksLikeQuestion(m.body)){
    const candidate=findKnowledgeAnswer(m.body,knowledge,Math.max(.48,Number(settings.ai_confidence_threshold||.62)-.08));
    if(candidate&&!/(منطقة|المناطق|عنوان|مكان|اقرب|أقرب)/.test(norm(candidate.question||'')))sideMatch=candidate;
   }
   return {
    patch:{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'},
    reply:(sideMatch?String(sideMatch.answer||'').trim()+'\n\n':'')+nearestWorkAreaReply(recommendation).replace('اختار المنطقة من الأزرار علشان أبعتلك تفاصيلها الأول. لو التفاصيل مناسبة ليك أكدها ونكمل التقديم.','قولّي اسم المنطقة اللي حابب تعرف تفاصيلها، ولو محتار بينهم أقدر أقارنهم لك. ولو حابب أزرار اختيارات اكتب «الاختيارات».') ,
    knowledge_id:sideMatch?.id||null,
    knowledge_confidence:sideMatch?.confidence??null,
    agent_action:sideMatch?'recommend_nearest_work_area_with_answer':'recommend_nearest_work_area'
   };
  }
 }

 if(residenceOnlyWhileChoosingWorkArea(current,m.body)){
  clearAgentState(answers);
  return {
   patch:{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'},
   reply:'تمام، فهمت إن ده مكان سكنك. بس اللي محتاج أعرفه هنا هو منطقة الشغل اللي حابب تنزل فيها، مش السكن.\n\n'+questionPrompt(current,areas),
   agent_action:'clarify_work_area_vs_residence'
  };
 }
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
 const livePlanner=settings.agent_llm_enabled===true&&settings.agent_llm_mode==='live'
  &&settings.agent_next_best_action_enabled!==false
  &&Number(llmPlan?.confidence||0)>=Number(settings.agent_planner_confidence_threshold||.72)
  ?llmPlan:null;
 if(livePlanner&&(!decision||decision.action==='unknown')){
  if(livePlanner.action==='change_answer'&&livePlanner.field_key){
   const reopened=reopenAnswer({decision:{action:'change_answer',field_key:livePlanner.field_key,confidence:livePlanner.confidence},answers,questions,areas,applicant:a});
   if(reopened)return {...reopened,agent_action:'llm_change_answer',agent_confidence:livePlanner.confidence};
  }
  if(livePlanner.action==='resume_flow'){
   clearAgentState(answers);
   return {patch:{answers,awaiting_id:current?.id||null},reply:current?questionPrompt(current,areas):postCompletionReply(),agent_action:'llm_resume_flow',agent_confidence:livePlanner.confidence};
  }
  if(livePlanner.action==='clarify'){
   clearAgentState(answers);
   const clarification=current?explainCurrentQuestion(current,areas):String(livePlanner.clarification||'ممكن توضح قصدك أكتر علشان أساعدك بدقة؟').slice(0,500);
   return {patch:{answers,awaiting_id:current?.id||null},reply:clarification,agent_action:'llm_clarify',agent_confidence:livePlanner.confidence};
  }
  if(livePlanner.action==='handoff'){
   return handoffTurn({answers,current,applicant:a,questions,areas,settings,message:m,reason:'llm_low_confidence_or_exception'});
  }
 }
 if(!protocolAction&&decision?.action==='answer_current'&&current?.field_key==='preferred_work_area'&&decision.area_id){
  const area=areas.find(z=>z.active&&String(z.id)===String(decision.area_id));
  if(area){
   answers.__area_preview={value:area.id,display:area.name,kind:'area_preview',at:new Date().toISOString()};
   let sideMatch=null;
   if(settings.ai_enabled&&settings.ai_knowledge_enabled===true&&looksLikeQuestion(m.body)){
    const threshold=Number(settings.ai_confidence_threshold||0.62);
    const candidate=findKnowledgeAnswer(m.body,knowledge,threshold);
    if(candidate&&!/(منطقة|المناطق|عنوان|مكان)/.test(norm(candidate.question||'')))sideMatch=candidate;
   }
   const preview=areaPreviewReply(area,areas);
   return {
    patch:{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'},
    reply:sideMatch?String(sideMatch.answer||'').trim()+'\n\n'+preview:preview,
    agent_action:sideMatch?'preview_work_area_with_answer':'preview_work_area',
    agent_confidence:decision.confidence,
    ...(sideMatch?{knowledge_id:sideMatch.id,knowledge_confidence:sideMatch.confidence}:{})
   };
  }
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
    followup_reply:sideAnswerFollowup(a,current,areas),
    knowledge_id:match.id,
    knowledge_confidence:match.confidence,
    agent_action:'knowledge_answer'
   };
  }
 }

 if(jobOverviewIntent(m.body)&&settings.ai_enabled&&settings.ai_knowledge_enabled===true){
  const overview=jobOverviewReply(knowledge);
  if(overview){
   const hadAgentState=Boolean(answers.__agent_state||answers.__ai_handoff),persistAnswers=hadAgentState||savedAgentFacts.length>0;
   clearAgentState(answers);
   return {
    patch:current?{...(persistAnswers?{answers}:{}),awaiting_id:current.id}:{...(persistAnswers?{answers}:{}),stage:computedStage({...a,answers},questions,areas),awaiting_id:null},
    reply:overview,
    agent_action:savedAgentFacts.length?'job_overview_with_facts':'job_overview'
   };
  }
 }

 if(current?.field_key==='preferred_work_area'&&noWorkAreaAnswer(m.body)){
  saveNoWorkArea(answers,current);
  return {patch:stopQualification(answers,'no_eligible_work_area'),reply:NO_ELIGIBLE_WORK_AREA_REPLY};
 }

 if(choiceButton){
  const q=qs.find(item=>String(item.id)===String(choiceButton.question_id));
  const options=Array.isArray(q?.options)?q.options:[];
  const option=options[choiceButton.index];
  if(!q||q.kind!=='choice'||option===undefined){
   return {patch:current?{awaiting_id:current.id}:{},reply:current?questionPrompt(current,areas):postCompletionReply()};
  }
  const value=typeof option==='string'?option:(option?.value??option?.label);
  const display=typeof option==='string'?option:(option?.label??String(value??''));
  if(value===undefined||!display)return {patch:{awaiting_id:q.id},reply:questionPrompt(q,areas)};
  answers[q.id]={value,display,label:q.label,key:q.field_key,kind:q.kind,at:new Date().toISOString(),button_answer:true};
  clearAgentState(answers);
  const next=nextMissing(qs,answers,areas);
  const comp=completion(questions,answers,areas);
  const qualification=qualificationFlowEnabled?qualificationFor({...a,answers},questions,areas,settings):{qualified_candidate:true,reasons:[]};
  if(comp.complete&&qualification.qualified_candidate===false){
   const reason=qualification.reasons[0]||'not_qualified';
   return {patch:stopQualification(answers,reason),reply:stoppedReply(reason),agent_action:'choice_answer'};
  }
  if(comp.complete&&qualification.qualified_candidate===true)completeFlow(answers);
  const stage=comp.complete&&qualification.qualified_candidate===true?'complete':realAnswerCount(answers)?'incomplete':'new';
  return {
   patch:{answers,stage,awaiting_id:next?.id||null},
   reply:'تمام، سجلت «'+display+'» ✅',
   followup_reply:next?questionPrompt(next,areas):(qualification.qualified_candidate===true?settings.completion:QUALIFICATION_PENDING_REPLY),
   agent_action:'choice_answer'
  };
 }

 const action=buttonAction;
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
  return {patch:{answers,...(current?{awaiting_id:current.id}:{})},reply:'اختيارات سريعة للمناطق 👇\n'+(current?.kind==='area'?questionPrompt(current,areas):areaListReply(areas))+pageNote+continueFlow};
 }
 if(action){
  const area=areas.find(z=>z.active&&z.id===action.id);
  if(!area)return {patch:current?{awaiting_id:current.id}:{},reply:current?.kind==='area'?questionPrompt(current,areas):areaListReply(areas)};
  const preferredQuestion=qs.find(q=>q.field_key==='preferred_work_area');
  if(preferredQuestion&&!answered(preferredQuestion,answers,areas)&&current?.id!==preferredQuestion.id){
   if(action.type==='preview'){
    answers.__area_preview={value:area.id,display:area.name,kind:'area_preview',at:new Date().toISOString()};
    return {patch:{answers,awaiting_id:preferredQuestion.id,stage:realAnswerCount(answers)?'incomplete':'new'},reply:areaPreviewReply(area,areas)};
   }
   if(action.type==='confirm'){
    if(answers.__area_preview?.value!==area.id)return {patch:{answers,awaiting_id:preferredQuestion.id},reply:questionPrompt(preferredQuestion,areas)};
    return commitAreaChoice({area,current:preferredQuestion,answers,qs,questions,areas,settings,applicant:a,qualificationFlowEnabled});
   }
  }
  if(current?.kind==='area'){
   if(current.field_key==='preferred_work_area'){
    if(action.type==='preview'){
     answers.__area_preview={value:area.id,display:area.name,kind:'area_preview',at:new Date().toISOString()};
     return {patch:{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'},reply:areaPreviewReply(area,areas)};
    }
    if(action.type==='confirm'){
     if(answers.__area_preview?.value!==area.id)return {patch:{answers,awaiting_id:current.id},reply:'اختار أو اكتب اسم المنطقة الأول علشان أشوفك تفاصيلها، وبعدها قول «مناسبة وكمل» لو مناسبة.\n\n'+questionPrompt(current,areas)};
     return commitAreaChoice({area,current,answers,qs,questions,areas,settings,applicant:a,qualificationFlowEnabled});
    }
   }
   if(action.type==='preview'){
    answers.__area_preview={value:area.id,display:area.name,kind:'area_preview',at:new Date().toISOString()};
    return {patch:{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'},reply:areaPreviewReply(area,areas)};
   }
   if(action.type==='confirm'){
    if(answers.__area_preview?.value!==area.id)return {patch:{awaiting_id:current.id},reply:'اختار أو اكتب اسم المنطقة الأول علشان أشوفك تفاصيلها، وبعدها أكد اختيارك النهائي.\n\n'+questionPrompt(current,areas)};
    return commitAreaChoice({area,current,answers,qs,questions,areas,settings,applicant:a,qualificationFlowEnabled});
   }
  }
  if(action.type==='preview'){
   const continueFlow=current?'\n\nنكمل التقديم: '+questionPrompt(current,areas):'\n\nلو حابب تقارن قولّي اسم منطقة تانية.';
   return {patch:current?{awaiting_id:current.id}:{},reply:areaDetails(area)+continueFlow};
  }
 }

 const comparedAreas=areaComparison(m.body,areas,answers);
 if(comparedAreas){
  const continueFlow=current?'\n\nنكمل التقديم: '+questionPrompt(current,areas):'';
  return {patch:current?{awaiting_id:current.id}:{stage:computedStage(a,questions,areas),awaiting_id:null},reply:areaComparisonReply(comparedAreas)+continueFlow};
 }

 const committedAreaInTurn=savedAgentFacts.some(x=>x.q.field_key==='preferred_work_area');
 const inquiry=areaInquiry(m.body,areas);
 if(inquiry&&!committedAreaInTurn){
  if(current?.kind==='area'){
   answers.__area_preview={value:inquiry.id,display:inquiry.name,kind:'area_preview',at:new Date().toISOString()};
   return {patch:{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'},reply:areaPreviewReply(inquiry,areas)};
  }
  return {patch:current?{awaiting_id:current.id}:{},reply:areaDetails(inquiry)+(current?'\n\nنكمل التقديم: '+questionPrompt(current,areas):'')};
 }

 if(areaListInquiry(m.body)){
  answers.__area_page={value:0,kind:'area_page',at:new Date().toISOString(),eligibility_only:true};
  return {patch:current?{answers,awaiting_id:current.id}:{answers,stage:computedStage(a,questions,areas),awaiting_id:null},reply:areaListReply(areas),agent_action:'answer_area_list'};
 }

 const turnNorm=norm(m.body);
 const areaQuestion=/(مرتب|قبض|عنوان|مواعيد|ساعات|بونص|مميزات)/.test(turnNorm)
  ||(/تفاصيل/.test(turnNorm)&&(explicitAreaHits(m.body,areas).length>0||/(?:منطقه|منطقة|زون|الزون|فرع|لوكيشن|عنوان)/.test(turnNorm)));
 const compoundStructuredQuestion=current?.kind==='yes_no'
  &&looksLikeQuestion(m.body)
  &&validateAnswer(current,m.body,areas,null).ok;
 if(areaQuestion&&!compoundStructuredQuestion&&settings.ai_enabled&&settings.ai_knowledge_enabled===true&&(explicitAreaHits(m.body,areas).length===0||committedAreaInTurn)){
  const query=knowledgeQueryText(answers,m.body);
  const threshold=Number(settings.ai_confidence_threshold||0.62),match=findKnowledgeAnswer(query,knowledge,threshold,{allowStatement:true});
  if(match){
   const hadAgentState=Boolean(answers.__agent_state||answers.__ai_handoff);
   clearAgentState(answers);
   const persistAnswers=hadAgentState||savedAgentFacts.length>0;
   return {patch:current?{...(persistAnswers?{answers}:{}),awaiting_id:current.id}:{...(persistAnswers?{answers}:{}),stage:computedStage({...a,answers},questions,areas),awaiting_id:null},reply:String(match.answer||'').trim(),followup_reply:sideAnswerFollowup(a,current,areas),knowledge_id:match.id,knowledge_confidence:match.confidence,agent_action:savedAgentFacts.length?'multi_fact_extract':undefined};
  }
 }
 if(areaQuestion&&!compoundStructuredQuestion&&!committedAreaInTurn){
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
  const answeredOtherFact=savedAgentFacts.length>0&&!savedAgentFacts.some(x=>x.q.id===current.id);
  if(answeredOtherFact){
   const factsText=savedAgentFacts.map(x=>x.q.field_key==='preferred_work_area'
    ?'تمام، سجلت منطقة العمل: '+x.fact.display+' ✅'
    :'تمام، سجلت '+x.q.label.replace(/[?؟.]+$/,'')+' ✅').join('\n');
   return {patch:{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'},reply:factsText,followup_reply:questionPrompt(current,areas),agent_action:'out_of_order_fact'};
  }
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
   const next=nextMissing(qs,answers,areas);
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
  const liveThreshold=Number(settings.agent_planner_confidence_threshold||0.72);
  if(settings.agent_llm_enabled===true&&settings.agent_llm_mode==='live'
    &&Number(llmPlan?.confidence||0)>=liveThreshold
    &&llmPlan?.action==='answer_question'&&llmPlan?.knowledge_id){
   const selected=(knowledge||[]).find(row=>String(row.id)===String(llmPlan.knowledge_id)
    &&row.active!==false&&!['conflict','stale'].includes(String(row.memory_status||'')));
   if(selected){
    const hadAgentState=Boolean(answers.__agent_state||answers.__ai_handoff);
    clearAgentState(answers);
    const persistAnswers=hadAgentState||savedAgentFacts.length>0;
    return {
     patch:current?{...(persistAnswers?{answers}:{}),awaiting_id:current.id}:{...(persistAnswers?{answers}:{}),stage:computedStage({...a,answers},questions,areas),awaiting_id:null},
     reply:String(selected.answer||'').trim(),
     followup_reply:sideAnswerFollowup(a,current,areas),
     knowledge_id:selected.id,
     knowledge_confidence:Number(llmPlan.confidence||0),
     agent_action:'llm_knowledge_answer',
     agent_confidence:Number(llmPlan.confidence||0)
    };
   }
  }
  const match=findKnowledgeAnswer(query,knowledge,threshold,{allowStatement:true});
  if(match){
   const hadAgentState=Boolean(answers.__agent_state||answers.__ai_handoff);
   clearAgentState(answers);
   const persistAnswers=hadAgentState||savedAgentFacts.length>0;
   return {
    patch:current?{...(persistAnswers?{answers}:{}),awaiting_id:current.id}:{...(persistAnswers?{answers}:{}),stage:computedStage({...a,answers},questions,areas),awaiting_id:null},
    reply:String(match.answer||'').trim(),
    followup_reply:sideAnswerFollowup(a,current,areas),
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
   return {patch:{answers,stage:computedStage({...a,answers},questions,areas),awaiting_id:null},reply:'اختار المنطقة من الأزرار تحت علشان أقولك تفاصيلها.'};
  }
  if(savedAgentFacts.length){
   const comp=completion(questions,answers,areas);
   const qualification=qualificationFlowEnabled?qualificationFor({...a,answers},questions,areas,settings):{qualified_candidate:true,reasons:[]};
   if(comp.complete&&qualification.qualified_candidate===false){
    const reason=qualification.reasons[0]||'not_qualified';
    return {patch:stopQualification(answers,reason),reply:stoppedReply(reason),agent_action:'multi_fact_extract'};
   }
   if(comp.complete&&qualification.qualified_candidate===true){
    completeFlow(answers);
    return {patch:{answers,stage:'complete',awaiting_id:null},reply:settings.completion,agent_action:'multi_fact_extract'};
   }
  }
  return {patch:{...(savedAgentFacts.length?{answers}:{}),stage:computedStage({...a,answers},questions,areas),awaiting_id:null},reply:postCompletionReply()};
 }
 if(!a.awaiting_id || a.awaiting_id!==current.id){
  const prompt=questionPrompt(current,areas);
  const implicitAreaFact=savedAgentFacts?.find(x=>x.q.field_key==='preferred_work_area');
  if(implicitAreaFact){
   const area=areas.find(z=>String(z.id)===String(implicitAreaFact.fact.value));
   if(area)return {patch:{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'},reply:'تمام، سجلت منطقة العمل: '+area.name+' ✅\n\n'+areaDetails(area),followup_reply:prompt,agent_action:'multi_fact_extract'};
  }
  if(realAnswerCount(answers))return {patch:{...(savedAgentFacts?.length?{answers}:{}),awaiting_id:current.id},reply:'نكمل بياناتك: '+prompt,agent_action:savedAgentFacts?.length?'multi_fact_extract':undefined};
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
 const next=nextMissing(qs,answers,areas);
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
