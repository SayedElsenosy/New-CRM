import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentRuntime,plannerFactsForQuestions} from '../src/agent-runtime.js';

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
