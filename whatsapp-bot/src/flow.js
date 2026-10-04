import {activeQuestions,answered,completion,computedStage,validateAnswer,questionPrompt,areaInquiry,areaDetails,norm} from './domain.js';
import {findKnowledgeAnswer,looksLikeQuestion} from './knowledge.js';

function areaPreviewReply(area,areas){
 const others=areas.filter(z=>z.active&&z.id!==area.id);
 const choices=others.length?'\n\nولو عايز تقارن بمنطقة تانية اختارها من الأزرار تحت.':'';
 return areaDetails(area)+`\n\nلو ${area.name} هي المنطقة اللي هتنزل فيها اضغط «✅ تأكيد ${area.name}».`+choices;
}
function realAnswerCount(answers){return Object.keys(answers||{}).filter(k=>!k.startsWith('__')).length;}
function areaAction(body){
 const s=String(body||'');
 if(s.startsWith('area_preview:'))return {type:'preview',id:s.slice('area_preview:'.length)};
 if(s.startsWith('confirm_area:'))return {type:'confirm',id:s.slice('confirm_area:'.length)};
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
function areaListReply(areas){
 const live=areas.filter(z=>z.active);
 if(!live.length)return 'مفيش مناطق عمل متاحة مضافة حاليًا. مسؤول التوظيف يقدر يوضح لك آخر الأماكن المتاحة.';
 return 'المناطق المتاحة حاليًا للشغل:\n'+live.map(z=>`• ${z.name}`).join('\n')+'\n\nلو عايز تفاصيل منطقة معينة ابعت اسمها.';
}
function postCompletionReply(){
 return 'بياناتك متسجلة عندنا بالفعل ✅\nلو عندك سؤال عن الشغل، المرتب، المواعيد أو المناطق ابعته وأنا أساعدك.';
}

export async function planTurn({applicant:a,message:m,questions,areas,settings,interpret,knowledge=[]}) {
 if(!a.bot_enabled)return {patch:{},reply:''};
 const qs=activeQuestions(questions);const answers={...a.answers};
 if(!qs.length)return {patch:{},reply:'التقديم متوقف مؤقتاً لحين تجهيز الأسئلة. مسؤول التوظيف هيتابع معاك.'};
 const pending=qs.filter(q=>!answered(q,answers,areas)&&!(answers[q.id]?.skipped&&!q.required));
 const current=pending.find(q=>q.id===a.awaiting_id)||pending[0];

 const action=areaAction(m.body);
 if(current?.kind==='area'&&action){
  const area=areas.find(z=>z.active&&z.id===action.id);
  if(!area)return {patch:{awaiting_id:current.id},reply:questionPrompt(current,areas)};
  if(action.type==='preview'){
   answers.__area_preview={value:area.id,display:area.name,kind:'area_preview',at:new Date().toISOString()};
   return {patch:{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'},reply:areaPreviewReply(area,areas)};
  }
  if(action.type==='confirm'){
   if(answers.__area_preview?.value!==area.id)return {patch:{awaiting_id:current.id},reply:'اختار المنطقة الأول علشان تشوف تفاصيلها، وبعدها أكد اختيارك النهائي.\n\n'+questionPrompt(current,areas)};
   delete answers.__area_preview;
   answers[current.id]={value:area.id,display:area.name,label:current.label,key:current.field_key,kind:current.kind,at:new Date().toISOString()};
   const next=qs.find(q=>!answered(q,answers,areas)&&!(answers[q.id]?.skipped&&!q.required));
   const comp=completion(questions,answers,areas);
   const stage=comp.complete?'complete':realAnswerCount(answers)?'incomplete':'new';
   return {patch:{answers,stage,awaiting_id:next?.id||null},reply:(`تم تثبيت منطقة التقديم: ${area.name} ✅\n\n`)+(next?questionPrompt(next,areas):settings.completion)};
  }
 }

 const inquiry=areaInquiry(m.body,areas);
 if(inquiry){
  if(current?.kind==='area'){
   answers.__area_preview={value:inquiry.id,display:inquiry.name,kind:'area_preview',at:new Date().toISOString()};
   return {patch:{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'},reply:areaPreviewReply(inquiry,areas)};
  }
  return {patch:current?{awaiting_id:current.id}:{},reply:areaDetails(inquiry)+(current?'\n\nنكمل التقديم: '+questionPrompt(current,areas):'')};
 }

 if(areaListInquiry(m.body)){
  const continueFlow=current?'\n\nنكمل التقديم: '+questionPrompt(current,areas):'';
  return {patch:current?{awaiting_id:current.id}:{stage:computedStage(a,questions,areas),awaiting_id:null},reply:areaListReply(areas)+continueFlow};
 }

 const areaQuestion=/(تفاصيل|مرتب|قبض|عنوان|مواعيد|ساعات|بونص|مميزات)/.test(norm(m.body));
 if(areaQuestion){
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
  const info=area?areaDetails(area):'تقصد أنهي منطقة؟ المناطق المتاحة: '+areas.filter(z=>z.active).map(z=>z.name).join('، ');
  return {patch:current?{awaiting_id:current.id}:{},reply:info+(current?'\n\n'+questionPrompt(current,areas):'')};
 }

 if(settings.ai_enabled&&settings.ai_knowledge_enabled===true&&looksLikeQuestion(m.body)){
  const threshold=Number(settings.ai_confidence_threshold||0.62);
  const match=findKnowledgeAnswer(m.body,knowledge,threshold);
  if(match){
   const continueFlow=current?'\n\nنكمل التقديم: '+questionPrompt(current,areas):'';
   return {patch:current?{awaiting_id:current.id}:{stage:computedStage(a,questions,areas),awaiting_id:null},reply:match.answer+continueFlow,knowledge_id:match.id,knowledge_confidence:match.confidence};
  }
  const answersWithHandoff={...answers,__ai_handoff:{question:String(m.body||'').slice(0,1000),at:new Date().toISOString(),reason:'low_confidence'}};
  const fallback=String(settings.ai_fallback||'السؤال ده محتاج تأكيد من مسؤول التوظيف، هحوّل المحادثة للفريق علشان يرد عليك بدقة.').trim();
  return {patch:{answers:answersWithHandoff,awaiting_id:current?.id||null,bot_enabled:false,stage:computedStage({...a,answers:answersWithHandoff},questions,areas)},reply:fallback,handoff:true};
 }

 if(!current)return {patch:{stage:computedStage(a,questions,areas),awaiting_id:null},reply:areaQuestion?'اكتب اسم المنطقة علشان أقولك تفاصيلها:\n'+areas.filter(z=>z.active).map(z=>z.name).join('، '):postCompletionReply()};
 if(!a.awaiting_id || a.awaiting_id!==current.id) return {patch:{awaiting_id:current.id},reply:(realAnswerCount(answers)?'نكمل بياناتك: ':settings.welcome+'\n')+questionPrompt(current,areas)};

 if(!current.required&&norm(m.body)==='تخطي')answers[current.id]={skipped:true,label:current.label,key:current.field_key,kind:current.kind};
 else {
  let parsed=validateAnswer(current,m.body,areas,m.media_path?{path:m.media_path}:null);
  let ai=null;
  if(!parsed.ok && settings.ai_enabled) ai=await interpret(m.body,current,areas);

  if(ai?.intent==='area_info') {
   const area=areas.find(z=>z.active&&z.id===ai.area_id);
   if(area){
    if(current.kind==='area'){
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
    if(answers.__area_preview?.value===area.id){
     delete answers.__area_preview;
     answers[current.id]={value:parsed.value,display:parsed.display,label:current.label,key:current.field_key,kind:current.kind,at:new Date().toISOString()};
    }else{
     answers.__area_preview={value:area.id,display:area.name,kind:'area_preview',at:new Date().toISOString()};
     return {patch:{answers,awaiting_id:current.id,stage:realAnswerCount(answers)?'incomplete':'new'},reply:areaPreviewReply(area,areas)};
    }
   }
  }else{
   answers[current.id]={value:parsed.value,display:parsed.display,label:current.label,key:current.field_key,kind:current.kind,at:new Date().toISOString()};
  }
 }

 const next=qs.find(q=>!answered(q,answers,areas)&&!(answers[q.id]?.skipped&&!q.required));
 const comp=completion(questions,answers,areas);
 const stage=comp.complete?'complete':realAnswerCount(answers)?'incomplete':'new';
 let reply=next?questionPrompt(next,areas):settings.completion;
 if(current.kind==='area'&&answers[current.id]?.value){
  const area=areas.find(z=>z.id===answers[current.id].value);
  if(area)reply=`تم تثبيت منطقة التقديم: ${area.name} ✅\n\n`+reply;
 }
 return {patch:{answers,stage,awaiting_id:next?.id||null},reply};
}
