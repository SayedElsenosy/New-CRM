import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentRuntime,plannerFactsForQuestions,canComposeAgentReply,groundedReplySafe} from '../src/agent-runtime.js';

test('LLM runtime stays unavailable without provider secrets',()=>{
 const runtime=new AgentRuntime({env:{}});
 const state=runtime.snapshot({agent_llm_enabled:true,agent_llm_model:'test-model'});
 assert.equal(state.configured,false);
 assert.equal(state.enabled,true);
});

test('planner facts only accept configured fields and valid typed values',()=>{
 const questions=[
  {id:'bike',field_key:'has_motorcycle',kind:'yes_no',active:true,allow_inference:true},
  {id:'age',field_key:'age',kind:'number',active:true,allow_inference:true},
  {id:'area',field_key:'preferred_work_area',kind:'area',active:true,allow_inference:true,confirmation_required:true},
  {id:'shift',field_key:'shift_type',kind:'choice',active:true,allow_inference:true,options:[
   {label:'صباحي',value:'morning'},{label:'مسائي',value:'evening'}
  ]}
 ];
 const plan={facts:[
  {field_key:'has_motorcycle',value:true,display:'نعم',confidence:.94},
  {field_key:'age',value:'24',display:'24',confidence:.95},
  {field_key:'preferred_work_area',value:'fake-area',display:'منطقة وهمية',confidence:.99},
  {field_key:'shift_type',value:'evening',display:'مسائي',confidence:.92},
  {field_key:'unknown_field',value:'x',display:'x',confidence:.99}
 ]};
 const facts=plannerFactsForQuestions(plan,questions,[{id:'oct',name:'أكتوبر',active:true}],{
  agent_fact_extraction_enabled:true,agent_planner_confidence_threshold:.72
 });
 assert.deepEqual(facts.map(x=>x.question_id),['bike','age','shift']);
 assert.equal(facts.find(x=>x.question_id==='bike').value,true);
 assert.equal(facts.find(x=>x.question_id==='age').value,24);
 assert.equal(facts.find(x=>x.question_id==='shift').value,'evening');
});

test('planner facts reject low confidence and confirmation-required fields',()=>{
 const facts=plannerFactsForQuestions({facts:[
  {field_key:'age',value:25,display:'25',confidence:.6},
  {field_key:'preferred_work_area',value:'oct',display:'أكتوبر',confidence:.99}
 ]},[
  {id:'age',field_key:'age',kind:'number',active:true,allow_inference:true},
  {id:'area',field_key:'preferred_work_area',kind:'area',active:true,allow_inference:true,confirmation_required:true}
 ],[{id:'oct',name:'أكتوبر',active:true}],{
  agent_fact_extraction_enabled:true,agent_planner_confidence_threshold:.72
 });
 assert.deepEqual(facts,[]);
});


test('free-tier planner payload stays compact with many areas and knowledge rows',()=>{
 const runtime=new AgentRuntime({env:{}});
 const questions=Array.from({length:18},(_,i)=>({id:'q'+i,field_key:'field_'+i,kind:'text',active:true,required:true,priority:50,label:'معلومة مطلوبة رقم '+i,agent_instruction:'تعليمات طويلة '.repeat(30)}));
 const areas=Array.from({length:93},(_,i)=>({id:'a'+i,name:'منطقة '+i,active:true,aliases:['اسم بديل '+i],zone:'Z',details:'تفاصيل طويلة '.repeat(100)}));
 const knowledge=Array.from({length:33},(_,i)=>({id:'k'+i,question:i===0?'المرتب كام؟':'سؤال '+i,answer:'إجابة '.repeat(300),active:true,memory_status:'verified',source:i===0?'manual':'staff',knowledge_scope:i===0?'breadfast':'office',examples:['صيغة '.repeat(100)]}));
 const messages=runtime.buildPlannerMessages({
  message:{body:'أنا ساكن في إمبابة ومعايا مكنة والرخصة خلصانة والمرتب كام'},
  questions,areas,applicant:{awaiting_id:'q0',answers:{}},knowledge,
  recentMessages:Array.from({length:20},(_,i)=>({direction:i%2?'out':'in',sender:i%2?'bot':'applicant',body:'رسالة طويلة '.repeat(100)})),
  settings:{agent_context_messages:12,agent_system_instructions:'تعليمات '.repeat(500)}
 });
 const size=messages.reduce((n,m)=>n+String(m.content||'').length,0);
 assert.ok(size<10000,'planner prompt too large for free tier: '+size);
 assert.match(messages[1].content,/المرتب كام/);
});


test('response composer is limited to grounded conversational actions',()=>{
 assert.equal(canComposeAgentReply('compare_area_modes'),true);
 assert.equal(canComposeAgentReply('llm_knowledge_answer'),true);
 assert.equal(canComposeAgentReply('qualification_fact'),false);
 assert.equal(canComposeAgentReply('llm_change_answer'),false);
});

test('grounded reply validator rejects invented numbers and accepts Arabic digit rewrites',()=>{
 assert.equal(groundedReplySafe('ثابت 6,000 جنيه وشيفت 8 ساعات','الثابت ٦,٠٠٠ جنيه والشيفت ٨ ساعات.'),true);
 assert.equal(groundedReplySafe('ثابت 6,000 جنيه','الثابت 7,000 جنيه.'),false);
 assert.equal(groundedReplySafe('معلومة من غير أرقام','رد طبيعي من غير أرقام.'),true);
});
