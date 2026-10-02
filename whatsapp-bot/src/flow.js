import {activeQuestions,answered,completion,computedStage,validateAnswer,questionPrompt,areaInquiry,areaDetails,norm} from './domain.js';
export async function planTurn({applicant:a,message:m,questions,areas,settings,interpret}) {
 if(!a.bot_enabled||['lecture','working'].includes(a.stage))return {patch:{},reply:''};
 const qs=activeQuestions(questions);const answers={...a.answers};
 if(!qs.length)return {patch:{},reply:'التقديم متوقف مؤقتاً لحين تجهيز الأسئلة. مسؤول التوظيف هيتابع معاك.'};
 const pending=qs.filter(q=>!answered(q,answers,areas)&&!(answers[q.id]?.skipped&&!q.required));
 const current=pending.find(q=>q.id===a.awaiting_id)||pending[0];
 const inquiry=areaInquiry(m.body,areas);
 if(inquiry)return {patch:current?{awaiting_id:current.id}:{},reply:areaDetails(inquiry)+(current?'\n\nنكمل التقديم: '+questionPrompt(current,areas):'')};
 const areaQuestion=/(تفاصيل|مرتب|قبض|عنوان|مواعيد|ساعات|بونص|مميزات)/.test(norm(m.body));
 if(areaQuestion){
  let area=null;
  if(settings.ai_enabled){const intent=await interpret(m.body,current,areas);if(intent?.intent==='area_info')area=areas.find(z=>z.active&&z.id===intent.area_id);}
  if(!area){const saved=Object.values(answers).find(v=>v.kind==='area');area=areas.find(z=>z.active&&z.id===saved?.value);}
  const info=area?areaDetails(area):'تقصد أنهي منطقة؟ المناطق المتاحة: '+areas.filter(z=>z.active).map(z=>z.name).join('، ');
  return {patch:current?{awaiting_id:current.id}:{},reply:info+(current?'\n\n'+questionPrompt(current,areas):'')};
 }
 if(!current)return {patch:{stage:computedStage(a,questions,areas),awaiting_id:null},reply:areaQuestion?'اكتب اسم المنطقة علشان أقولك تفاصيلها:\n'+areas.filter(z=>z.active).map(z=>z.name).join('، '):settings.completion};
 if(!a.awaiting_id || a.awaiting_id!==current.id) return {patch:{awaiting_id:current.id},reply:(Object.keys(answers).length?'نكمل بياناتك: ':settings.welcome+'\n')+questionPrompt(current,areas)};
 if(!current.required&&norm(m.body)==='تخطي')answers[current.id]={skipped:true,label:current.label,key:current.field_key,kind:current.kind};
 else {
  let parsed=validateAnswer(current,m.body,areas,m.media_path?{path:m.media_path}:null);
  let ai=null;
  if(!parsed.ok && settings.ai_enabled) ai=await interpret(m.body,current,areas);
  if(ai?.intent==='area_info') {
   const area=areas.find(z=>z.active&&z.id===ai.area_id);
   if(area)return {patch:{},reply:areaDetails(area)+'\n\n'+questionPrompt(current,areas)};
  }
  if(!parsed.ok&&ai?.intent==='answer'&&!String(ai.answer).includes('محجوب')) parsed=validateAnswer(current,ai.answer,areas,null);
  if(!parsed.ok)return {patch:{},reply:(m.media_error?m.media_error+'\n':'محتاج أوضح إجابتك علشان أسجلها صح.\n')+questionPrompt(current,areas)};
  answers[current.id]={value:parsed.value,display:parsed.display,label:current.label,key:current.field_key,kind:current.kind,at:new Date().toISOString()};
 }
 const next=qs.find(q=>!answered(q,answers,areas)&&!(answers[q.id]?.skipped&&!q.required));
 const comp=completion(questions,answers,areas);
 const stage=comp.complete?'complete':Object.keys(answers).length?'incomplete':'new';
 let reply=next?questionPrompt(next,areas):settings.completion;
 if(current.kind==='area'&&answers[current.id]?.value){const area=areas.find(z=>z.id===answers[current.id].value);if(area)reply=areaDetails(area)+'\n\n'+reply;}
 return {patch:{answers,stage,awaiting_id:next?.id||null},reply};
}
