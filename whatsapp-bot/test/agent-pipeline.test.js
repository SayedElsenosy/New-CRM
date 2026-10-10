import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTurnPipeline,PIPELINE_STAGES,publicPipeline,summarizePipelineEvents,deliveryState} from '../src/agent-pipeline.js';

test('operational pipeline uses only allowlisted stage metadata, no applicant text or hidden chain of thought',()=>{
 const privatePrompt='candidate phone 201234567890 private';
 const pipeline=buildTurnPipeline({
  waitMs:456,memory:{status:'done',ms:12,indexed:true,body:privatePrompt},
  knowledge:{status:'done',ms:18,items:8,excerpts:2,body:privatePrompt},
  understanding:{status:'done',ms:112,engine:'llm',usedLlm:true,thoughts:privatePrompt},
  decision:{status:'done',ms:31,action:'compare_places',secret:privatePrompt},
  response:{status:'done',ms:14,queued:true,reply:privatePrompt}
 });
 assert.deepEqual(pipeline.stages.map(x=>x.key),PIPELINE_STAGES);
 assert.deepEqual(pipeline.stages.map(x=>x.duration_ms),[456,12,18,112,31,14]);
 assert.equal(pipeline.stages[4].action,'compare_places');
 assert.doesNotMatch(JSON.stringify(pipeline),/201234567890|private|thoughts|reply/);
});
test('event-to-admin projection strips all unapproved fields, truncates unsafe action and handles historic traces',()=>{
 const event={id:'event-1',created_at:'2026-10-10T12:00:00Z',detail:{
  message_id:'message-1',action:'ask_next',
  pipeline:{version:1,stages:[{key:'memory',status:'done',duration_ms:17,indexed:true,phone:'+201234567890'},
   {key:'decision',status:'done',duration_ms:25,action:'answer_question',prompt:'DO NOT EXPOSE'},
   {key:'evil',status:'done',duration_ms:1,body:'secret'}]},
  input_text:'secret'}
 };
 const output=summarizePipelineEvents([event],[{reply_to:'message-1',sender:'bot',status:'sent',body:'secret'}]);
 assert.equal(output.length,1);
 assert.equal(output[0].delivery,'sent');
 assert.deepEqual(output[0].stages.map(x=>x.key),['memory','decision']);
 assert.doesNotMatch(JSON.stringify(output),/secret|phone|prompt|input_text|201234567890/);
 assert.equal(publicPipeline({detail:{pipeline:{version:0,stages:[]}}}),null);
 assert.equal(summarizePipelineEvents([{id:'legacy',created_at:'now',detail:{message_id:'old',action:'ask_next'}}])[0].historic_trace,true);
});
test('delivery state reflects actual outbound WhatsApp queue outcome, not imagined delivery',()=>{
 for(const [raw,expected] of Object.entries({
  queued:'queued',sending:'sending',sent:'sent',uncertain:'uncertain',
  processed:'cancelled',failed:'failed'
 })){
  assert.equal(deliveryState(raw),expected);
 }
 const event={id:'e',created_at:'now',detail:{message_id:'m',action:'flow_turn'}};
 const absent=summarizePipelineEvents([event],[])[0];
 assert.equal(absent.delivery,'not_recorded');
 assert.equal(absent.response_count,0);
 const mixed=summarizePipelineEvents([event],[
  {reply_to:'m',sender:'bot',status:'sent'},
  {reply_to:'m',sender:'bot',status:'uncertain'},
  {reply_to:'m',sender:'staff',status:'failed'},
  {reply_to:'x',sender:'bot',status:'failed'}
 ])[0];
 assert.equal(mixed.delivery,'uncertain');
 assert.equal(mixed.response_count,2);
});
test('invalid raw durations and counts cannot poison UI payload',()=>{
 const t=buildTurnPipeline({waitMs:-1,knowledge:{status:'done',ms:Infinity,items:999999,excerpts:-3},
  decision:{action:'<malicious onclick="x">'},response:{queued:false}});
 assert.equal(t.stages[0].duration_ms,0);
 assert.equal(t.stages[2].items,500);
 assert.equal(t.stages[2].historical_excerpts,0);
 assert.doesNotMatch(t.stages[4].action,/[<>"]/);
});
