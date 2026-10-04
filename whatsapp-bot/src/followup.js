import {activeQuestions,answered,completion,questionPrompt} from './domain.js';

export function followupDue(applicant,{now=Date.now(),hours=8}={}){
 if(!applicant?.bot_enabled||!['new','incomplete'].includes(applicant.stage))return false;
 const h=Math.max(1,Math.min(72,Number(hours)||8))*60*60*1000;
 const created=Date.parse(applicant.created_at||'')||0;
 const lastMessage=Date.parse(applicant.last_message_at||'')||0;
 const lastFollowup=Date.parse(applicant.followup_last_sent_at||'')||0;
 const base=Math.max(created,lastMessage,lastFollowup);
 return Boolean(base)&&now-base>=h;
}

export function buildFollowupMessage(applicant,questions,areas){
 const answers=applicant?.answers||{};
 if(completion(questions,answers,areas).complete)return null;
 const qs=activeQuestions(questions);
 const pending=qs.filter(q=>!answered(q,answers,areas)&&!(answers[q.id]?.skipped&&!q.required));
 const current=pending.find(q=>q.id===applicant.awaiting_id)||pending[0];
 if(!current)return null;
 const name=Object.values(answers).find(v=>v?.kind==='name'&&v?.value)?.display||
  Object.values(answers).find(v=>v?.kind==='name'&&v?.value)?.value||'';
 const hello=name?'يا '+String(name).trim()+'، ':'';
 return '👋 '+hello+'بنِفكّرك نكمل بيانات التقديم علشان نقدر نراجع فرصتك ونوصلك للشغل أسرع.\n\n'+
  'لسه محتاجين منك:\n'+questionPrompt(current,areas)+'\n\n'+
  'لو في حاجة موقفاك، أو محتاج تعرف تفاصيل عن المنطقة أو المرتب أو المواعيد، ابعت سؤالك هنا وأنا أساعدك.';
}
