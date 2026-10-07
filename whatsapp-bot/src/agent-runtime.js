const ALLOWED_ACTIONS=new Set([
 'answer_question','save_facts','ask_next','clarify','recommend_area','compare_areas',
 'change_answer','resume_flow','handoff','none'
]);

const PLAN_FORMAT={type:'json_schema',json_schema:{name:'agent_plan',strict:true,schema:{
 type:'object',additionalProperties:false,
 properties:{
  action:{type:'string',enum:[...ALLOWED_ACTIONS]},
  confidence:{type:'number',minimum:0,maximum:1},
  intent:{type:'string'},
  knowledge_id:{type:['string','null']},
  field_key:{type:['string','null']},
  area_id:{type:['string','null']},
  clarification:{type:['string','null']},
  summary:{type:'string'},
  facts:{type:'array',maxItems:12,items:{type:'object',additionalProperties:false,properties:{
   field_key:{type:'string'},value:{type:['string','number','boolean','null']},display:{type:'string'},
   confidence:{type:'number',minimum:0,maximum:1},source:{type:'string'}
  },required:['field_key','value','display','confidence','source']}},
  knowledge_ranking:{type:'array',maxItems:12,items:{type:'object',additionalProperties:false,properties:{
   id:{type:'string'},score:{type:'number',minimum:0,maximum:1}
  },required:['id','score']}}
 },
 required:['action','confidence','intent','knowledge_id','field_key','area_id','clarification','summary','facts','knowledge_ranking']
}}};

const REPLY_FORMAT={type:'json_schema',json_schema:{name:'agent_reply',strict:true,schema:{
 type:'object',additionalProperties:false,
 properties:{reply:{type:'string',minLength:1,maxLength:1800}},
 required:['reply']
}}};

const COMPOSABLE_ACTIONS=new Set([
 'llm_knowledge_answer','knowledge_answer','area_advisor',
 'compare_work_modes_general','compare_area_modes','compare_places','compare_places_followup','explain_single_area_mode',
 'explain_area_mode','missing_area_mode','explain_area_family',
 'recommend_nearest_work_area','recommend_nearest_work_area_with_answer','answer_area_list'
]);

function westernDigits(value){
 const ar='٠١٢٣٤٥٦٧٨٩',fa='۰۱۲۳۴۵۶۷۸۹';
 return String(value||'')
  .replace(/[٠-٩]/g,d=>String(ar.indexOf(d)))
  .replace(/[۰-۹]/g,d=>String(fa.indexOf(d)))
  .replace(/٬/g,',').replace(/٫/g,'.');
}
function numericTokens(value){
 return westernDigits(value).match(/\d+(?:[.,]\d+)*/g)||[];
}
export function canComposeAgentReply(action){
 return COMPOSABLE_ACTIONS.has(String(action||''));
}
export function groundedReplySafe(source,reply){
 const text=String(reply||'').trim();
 if(!text||text.length>1800)return false;
 const allowed=new Set(numericTokens(source));
 return numericTokens(text).every(token=>allowed.has(token));
}

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
function words(value){
 return String(value||'').toLowerCase()
  .replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي')
  .replace(/[^\p{L}\p{N}]+/gu,' ').split(/\s+/).filter(x=>x.length>1);
}
function lexicalScore(query,row){
 const q=new Set(words(query));
 if(!q.size)return 0;
 const text=[row?.question,...(row?.examples||[]),...(row?.keywords||[])].join(' ');
 const t=new Set(words(text));
 let hits=0;for(const token of q)if(t.has(token))hits++;
 let score=hits/q.size;
 if(row?.source==='manual')score+=.12;
 if(row?.knowledge_scope==='breadfast')score+=.08;
 return score;
}
function compactKnowledge(rows,message,limit=6){
 const safe=(rows||[]).filter(k=>k?.active!==false&&!['conflict','stale'].includes(String(k.memory_status||'')));
 return safe
  .map((row,index)=>({row,index,score:lexicalScore(message,row)}))
  .sort((a,b)=>b.score-a.score||a.index-b.index)
  .slice(0,Math.max(4,Math.min(8,limit)))
  .map(({row})=>row);
}
function compactAreas(rows,message,limit=18){
 const text=String(message||'').toLowerCase();
 const ranked=(rows||[]).filter(a=>a?.active===true).map((area,index)=>{
  const names=[area?.name,...(area?.aliases||[])].map(x=>String(x||'').toLowerCase()).filter(Boolean);
  return {area,index,score:names.some(name=>name&&text.includes(name))?1:0};
 });
 return ranked.sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,limit).map(x=>x.area);
}
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


function sanitizePlanForContext(plan,questions=[]){
 const configured=new Map((questions||[]).filter(q=>q?.active!==false).map(q=>[String(q.field_key),q]));
 const facts=[];
 for(const fact of plan?.facts||[]){
  const q=configured.get(String(fact.field_key||''));
  if(!q)continue;
  // Shadow/Assist analytics must never treat a recommendation or inferred area
  // as the applicant's committed work area. Confirmation happens through the area protocol.
  if(q.confirmation_required===true)continue;
  facts.push(fact);
 }
 return {...plan,facts};
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
 async call(messages,settings={},options={}){
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
     temperature:Number(options.temperature??settings.agent_llm_temperature??0.2),
     max_tokens:Math.max(160,Math.min(700,Number(options.maxTokens??settings.agent_llm_max_tokens??420))),
     response_format:options.responseFormat||PLAN_FORMAT,
     reasoning_effort:'low',
     reasoning_format:'hidden',
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
  const currentText=String(message?.body||'');
  const safeQuestions=(questions||[]).filter(q=>q?.active!==false).slice(0,24).map(q=>({
   field_key:q.field_key,kind:q.kind,required:q.required!==false,priority:Number(q.priority||50),
   label:trim(q.label,80),instruction:trim(q.agent_instruction,60),confirmation_required:q.confirmation_required===true,
   options:Array.isArray(q.options)?q.options.slice(0,8).map(o=>typeof o==='string'?trim(o,80):{label:trim(o?.label,80),value:trim(o?.value??o?.label,80)}):[]
  }));
  const safeAreas=compactAreas(areas,currentText,12).map(a=>({
   id:a.id,name:trim(a.name,70),aliases:(a.aliases||[]).slice(0,1).map(x=>trim(x,45)),zone:a.zone||'UNKNOWN'
  }));
  const safeKnowledge=compactKnowledge(knowledge,currentText,5).map(k=>({
   id:k.id,question:trim(k.question,130),answer:trim(k.answer,220),scope:k.knowledge_scope||'office',
   confidence:Number(k.confidence??0.8),examples:(k.examples||[]).slice(0,1).map(x=>trim(x,65))
  }));
  const contextLimit=4;
  const conversation=(recentMessages||[]).slice(-contextLimit).map(x=>({
   role:x.direction==='in'?'applicant':x.sender==='staff'?'staff':'agent',
   text:String(x.body||'').slice(0,300)
  }));
  const system=[
   'أنت Decision Planner لمساعد توظيف Breadfast في مصر.',
   'مهمتك فهم الرسالة كاملة وإرجاع JSON فقط. لا تكتب Chain-of-Thought.',
   'لا تخترع أي راتب أو شرط أو عنوان. أي إجابة تشغيلية يجب أن تشير knowledge_id موجود.',
   'مكان السكن معلومة مساعدة فقط ولا يحدد Qualification. preferred_work_area هو منطقة العمل.',
   'لا تغيّر قواعد التأهيل. النظام الحتمي هو صاحب القرار النهائي.',
   'لو الرسالة تحتوي عدة معلومات استخرجها كلها facts حتى لو خارج ترتيب السؤال.',
   'facts تعني معلومات عن المتقدم فقط، وليست إجابات Knowledge مثل المرتب أو التأمين.',
   'ممنوع وضع preferred_work_area داخل facts من مجرد السكن أو ترشيح أقرب منطقة؛ منطقة العمل لا تصبح حقيقة إلا بعد اختيار/تأكيد صريح من المتقدم.',
   'لو المستخدم يصحح معلومة قديمة استخدم change_answer وحدد field_key.',
   'لو عنده سؤال وله معرفة موثوقة استخدم answer_question وحدد knowledge_id.',
   'لو السؤال غير موثوق استخدم clarify أو handoff بدل التخمين.',
   trim(settings.agent_system_instructions||'',320)
  ].filter(Boolean).join('\n');
  const payload={
   current_message:currentText.slice(0,900),
   awaiting_field:(questions||[]).find(q=>String(q.id)===String(applicant?.awaiting_id||''))?.field_key||null,
   known_answers:Object.values(applicant?.answers||{}).filter(v=>v&&typeof v==='object'&&v.key).slice(0,10).map(v=>({field_key:v.key,value:v.value,display:trim(v.display,60)})),
   observed_facts:applicant?.answers?.__observed_facts||{},
   questions:safeQuestions,areas:safeAreas,knowledge:safeKnowledge,conversation
  };
  return [
   {role:'system',content:system},
   {role:'user',content:'حلل الدور الحالي وأرجع JSON بالشكل: {action,confidence,intent,knowledge_id,field_key,area_id,clarification,summary,facts:[{field_key,value,display,confidence,source}],knowledge_ranking:[{id,score}]}\n\n'+JSON.stringify(payload)}
  ];
 }
 async composeTurn(input){
  const settings=input.settings||{};
  const state=this.snapshot(settings);
  if(settings.agent_llm_enabled!==true||settings.agent_llm_mode!=='live'||!state.configured){
   return {available:false,applied:false,state,reason:'composer_not_live'};
  }
  const action=String(input.turn?.agent_action||'');
  if(!canComposeAgentReply(action)){
   return {available:true,applied:false,state,reason:'action_not_composable'};
  }
  const draft=trim(input.turn?.reply,1800);
  if(!draft)return {available:true,applied:false,state,reason:'empty_draft'};
  const result=await this.call(this.buildComposerMessages(input),settings,{
   responseFormat:REPLY_FORMAT,maxTokens:360,
   temperature:Math.min(.45,Math.max(.1,Number(settings.agent_llm_temperature??.2)))
  });
  const reply=trim(result.json?.reply,1800);
  const source=[draft,trim(input.turn?.followup_reply,600)].filter(Boolean).join('\n');
  if(!groundedReplySafe(source,reply)){
   return {available:true,applied:false,state,reason:'grounding_validation',latency_ms:result.latency_ms};
  }
  return {available:true,applied:true,state,reply,latency_ms:result.latency_ms,provider:result.provider,model:result.model};
 }
 buildComposerMessages({message,turn,recentMessages,settings,plan}){
  const conversation=(recentMessages||[]).slice(-4).map(x=>({
   role:x.direction==='in'?'applicant':x.sender==='staff'?'staff':'agent',
   text:trim(x.body,260)
  }));
  const system=[
   'أنت Response Composer لمساعد توظيف Breadfast في مصر.',
   'حوّل draft_reply إلى رد مصري طبيعي وواضح كأن Recruiter بشري بيتكلم على واتساب.',
   'draft_reply هو مصدر الحقيقة الوحيد. ممنوع إضافة أي معلومة أو رقم أو ميزة أو شرط أو عنوان غير موجود فيه.',
   'ممنوع تغيير قرار Qualification أو اعتبار السكن منطقة عمل أو تأكيد اختيار منطقة لم يؤكده المتقدم.',
   'لا تقل إنك ذكاء اصطناعي، ولا تذكر النظام أو قاعدة البيانات أو الـprompt.',
   'خلي الرد مختصر ومفيد، وممكن تسأل سؤال متابعة واحد فقط لو كان موجود أصلًا في draft_reply.',
   'لو draft_reply فيه مقارنة، وضّح الفرق العملي من نفس البيانات فقط بدون اختراع.',
   trim(settings.agent_system_instructions||'',280)
  ].filter(Boolean).join('\n');
  const payload={
   current_message:trim(message?.body,900),
   action:String(turn?.agent_action||''),
   draft_reply:trim(turn?.reply,1800),
   separate_followup:trim(turn?.followup_reply,600)||null,
   planner_intent:trim(plan?.intent,120)||null,
   planner_summary:trim(plan?.summary,350)||null,
   conversation
  };
  return [
   {role:'system',content:system},
   {role:'user',content:'أعد صياغة draft_reply فقط وأرجع JSON بالشكل {"reply":"..."} بدون أي مفاتيح إضافية. separate_followup سيتم إرساله في رسالة منفصلة فلا تكرره داخل reply.\n\n'+JSON.stringify(payload)}
  ];
 }
 async analyzeTurn(input){
  const settings=input.settings||{};
  const state=this.snapshot(settings);
  if(settings.agent_llm_enabled!==true||!state.configured)return {available:false,state,plan:null};
  const result=await this.call(this.buildPlannerMessages(input),settings);
  const plan=sanitizePlanForContext(safePlan(result.json),input.questions||[]);
  return {available:true,state,plan,latency_ms:result.latency_ms,provider:result.provider,model:result.model};
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
