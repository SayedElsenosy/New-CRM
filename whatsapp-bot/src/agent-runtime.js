const ALLOWED_ACTIONS=new Set([
 'answer_question','save_facts','ask_next','clarify','recommend_area','compare_areas',
 'change_answer','resume_flow','handoff','none'
]);

function cleanJson(text){
 const raw=String(text||'').trim();
 const fenced=raw.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i)?.[1]||raw;
 const start=fenced.indexOf('{'),end=fenced.lastIndexOf('}');
 if(start<0||end<start)throw new Error('LLM returned no JSON object');
 return JSON.parse(fenced.slice(start,end+1));
}
function clamp(value,min,max,fallback){
 const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;
}
function trim(value,max=1000){return String(value||'').trim().slice(0,max);}
function safePlan(value){
 const p=value&&typeof value==='object'?value:{};
 const action=ALLOWED_ACTIONS.has(p.action)?p.action:'none';
 return {
  action,
  confidence:clamp(p.confidence,0,1,0),
  intent:trim(p.intent,120),
  knowledge_id:trim(p.knowledge_id,80)||null,
  field_key:trim(p.field_key,80)||null,
  area_id:trim(p.area_id,100)||null,
  clarification:trim(p.clarification,500)||null,
  summary:trim(p.summary,700),
  facts:Array.isArray(p.facts)?p.facts.slice(0,12).map(f=>({
   field_key:trim(f?.field_key,80),
   value:f?.value,
   display:trim(f?.display,250),
   confidence:clamp(f?.confidence,0,1,0),
   source:trim(f?.source||'llm',80)
  })).filter(f=>f.field_key):[],
  knowledge_ranking:Array.isArray(p.knowledge_ranking)?p.knowledge_ranking.slice(0,12).map(x=>({
   id:trim(x?.id,80),score:clamp(x?.score,0,1,0)
  })).filter(x=>x.id):[]
 };
}

export class AgentRuntime{
 constructor({env=process.env}={}){
  this.env=env;
 }
 snapshot(settings={}){
  const model=trim(settings.agent_llm_model||this.env.AGENT_LLM_MODEL,200);
  const url=trim(this.env.AGENT_LLM_API_URL,1000);
  const hasKey=Boolean(this.env.AGENT_LLM_API_KEY);
  return {
   configured:Boolean(url&&hasKey&&model),
   enabled:settings.agent_llm_enabled===true,
   mode:settings.agent_llm_mode||'shadow',
   provider:settings.agent_llm_provider||'openai_compatible',
   model:model||null,
   endpoint_configured:Boolean(url),
   secret_configured:hasKey
  };
 }
 async call(messages,settings={}){
  const state=this.snapshot(settings);
  if(!state.configured)throw Object.assign(new Error('LLM provider is not configured'),{code:'LLM_NOT_CONFIGURED'});
  const controller=new AbortController();
  const timeout=Math.max(1000,Math.min(30000,Number(settings.agent_llm_timeout_ms||8000)));
  const timer=setTimeout(()=>controller.abort(),timeout);
  const started=Date.now();
  try{
   const response=await fetch(this.env.AGENT_LLM_API_URL,{
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.env.AGENT_LLM_API_KEY},
    body:JSON.stringify({
     model:state.model,
     temperature:Number(settings.agent_llm_temperature??0.2),
     max_tokens:Number(settings.agent_llm_max_tokens||800),
     response_format:{type:'json_object'},
     messages
    }),
    signal:controller.signal
   });
   const body=await response.json().catch(()=>({}));
   if(!response.ok)throw Object.assign(new Error(body?.error?.message||body?.message||('LLM HTTP '+response.status)),{code:'LLM_HTTP_'+response.status});
   const text=body?.choices?.[0]?.message?.content;
   if(!text)throw new Error('LLM returned an empty response');
   return {json:cleanJson(text),latency_ms:Date.now()-started,provider:state.provider,model:state.model};
  }finally{clearTimeout(timer);}
 }
 buildPlannerMessages({message,questions,areas,applicant,knowledge,recentMessages,settings}){
  const safeQuestions=(questions||[]).filter(q=>q?.active!==false).map(q=>({
   field_key:q.field_key,kind:q.kind,required:q.required!==false,priority:Number(q.priority||50),
   label:q.label,instruction:q.agent_instruction||'',confirmation_required:q.confirmation_required===true,
   options:Array.isArray(q.options)?q.options.slice(0,10):[]
  }));
  const safeAreas=(areas||[]).filter(a=>a?.active===true).map(a=>({
   id:a.id,name:a.name,aliases:a.aliases||[],zone:a.zone||'UNKNOWN',details:String(a.details||'').slice(0,1200)
  }));
  const safeKnowledge=(knowledge||[]).filter(k=>k?.active!==false&&!['conflict','stale'].includes(String(k.memory_status||''))).slice(0,20).map(k=>({
   id:k.id,question:k.question,answer:String(k.answer||'').slice(0,1200),scope:k.knowledge_scope||'office',
   confidence:Number(k.confidence??0.8),examples:(k.examples||[]).slice(0,8)
  }));
  const conversation=(recentMessages||[]).slice(-Math.max(4,Math.min(30,Number(settings.agent_context_messages||12)))).map(x=>({
   role:x.direction==='in'?'applicant':x.sender==='staff'?'staff':'agent',
   text:String(x.body||'').slice(0,1800)
  }));
  const system=[
   'أنت Decision Planner لمساعد توظيف Breadfast في مصر.',
   'مهمتك فهم الرسالة كاملة وإرجاع JSON فقط. لا تكتب Chain-of-Thought.',
   'لا تخترع أي راتب أو شرط أو عنوان. أي إجابة تشغيلية يجب أن تشير knowledge_id موجود.',
   'مكان السكن معلومة مساعدة فقط ولا يحدد Qualification. preferred_work_area هو منطقة العمل.',
   'لا تغيّر قواعد التأهيل. النظام الحتمي هو صاحب القرار النهائي.',
   'لو الرسالة تحتوي عدة معلومات استخرجها كلها facts حتى لو خارج ترتيب السؤال.',
   'لو المستخدم يصحح معلومة قديمة استخدم change_answer وحدد field_key.',
   'لو عنده سؤال وله معرفة موثوقة استخدم answer_question وحدد knowledge_id.',
   'لو السؤال غير موثوق استخدم clarify أو handoff بدل التخمين.',
   settings.agent_system_instructions||''
  ].filter(Boolean).join('\n');
  const payload={
   current_message:String(message?.body||'').slice(0,4000),
   awaiting_field:(questions||[]).find(q=>String(q.id)===String(applicant?.awaiting_id||''))?.field_key||null,
   known_answers:Object.values(applicant?.answers||{}).filter(v=>v&&typeof v==='object'&&v.key).slice(0,30).map(v=>({field_key:v.key,value:v.value,display:v.display})),
   questions:safeQuestions,areas:safeAreas,knowledge:safeKnowledge,conversation
  };
  return [
   {role:'system',content:system},
   {role:'user',content:'حلل الدور الحالي وأرجع JSON بالشكل: {action,confidence,intent,knowledge_id,field_key,area_id,clarification,summary,facts:[{field_key,value,display,confidence,source}],knowledge_ranking:[{id,score}]}\n\n'+JSON.stringify(payload)}
  ];
 }
 async analyzeTurn(input){
  const settings=input.settings||{};
  const state=this.snapshot(settings);
  if(settings.agent_llm_enabled!==true||!state.configured)return {available:false,state,plan:null};
  const result=await this.call(this.buildPlannerMessages(input),settings);
  return {available:true,state,plan:safePlan(result.json),latency_ms:result.latency_ms,provider:result.provider,model:result.model};
 }
 async testPlan(input){
  const result=await this.analyzeTurn(input);
  if(!result.available)return result;
  return result;
 }
 reorderKnowledge(rows,plan,settings={}){
  if(!settings.agent_hybrid_memory_enabled||!settings.agent_llm_rerank_enabled||!plan?.knowledge_ranking?.length)return rows;
  const scores=new Map(plan.knowledge_ranking.map(x=>[String(x.id),Number(x.score||0)]));
  return [...(rows||[])].map(row=>({...row,_semantic_score:scores.get(String(row.id))||0}))
   .sort((a,b)=>Number(b._semantic_score||0)-Number(a._semantic_score||0));
 }
}

export function plannerFactsForQuestions(plan,questions,areas,settings={}){
 if(!plan||!Array.isArray(plan.facts)||settings.agent_fact_extraction_enabled===false)return [];
 const min=Math.max(.70,Number(settings.agent_planner_confidence_threshold||.72));
 const out=[];
 for(const fact of plan.facts){
  if(Number(fact.confidence||0)<min)continue;
  const q=(questions||[]).find(x=>x.field_key===fact.field_key&&x.active!==false);
  if(!q||q.allow_inference===false||q.confirmation_required===true)continue;
  let value=fact.value,display=fact.display||String(fact.value??'');
  if(q.kind==='yes_no'){
   if(typeof value!=='boolean')continue;display=value?'نعم':'لا';
  }else if(q.kind==='number'){
   value=Number(value);if(!Number.isFinite(value))continue;display=display||String(value);
  }else if(q.kind==='area'){
   const area=(areas||[]).find(a=>a.active&&(
    String(a.id)===String(value)||String(a.name).trim()===String(display).trim()
   ));
   if(!area)continue;value=area.id;display=area.name;
  }else if(q.kind==='choice'){
   const options=Array.isArray(q.options)?q.options:[];
   const match=options.find(o=>{
    const ov=typeof o==='string'?o:(o?.value??o?.label),ol=typeof o==='string'?o:o?.label;
    return String(ov)===String(value)||String(ol)===String(display);
   });
   if(!match)continue;value=typeof match==='string'?match:(match.value??match.label);display=typeof match==='string'?match:(match.label??String(value));
  }else{
   value=String(value??'').trim();if(!value||value.length>1000)continue;display=String(display||value).trim();
  }
  out.push({question_id:q.id,value,display,confidence:Number(fact.confidence||0),source:'llm'});
 }
 return out;
}
