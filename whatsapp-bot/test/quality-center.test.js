import test from 'node:test';
import assert from 'node:assert/strict';
import {BUILTIN_QUALITY_COUNT,qualityMetrics,runBuiltInQualitySuite} from '../src/quality-center.js';

test('synthetic QA suite covers 105 Egyptian recruitment scenarios with zero real candidate data',async()=>{
 assert.equal(BUILTIN_QUALITY_COUNT,560);
 const report=await runBuiltInQualitySuite();
 assert.equal(report.dataset,'synthetic');
 assert.equal(report.external_llm_calls,0);
 assert.equal(report.real_applicant_messages_used,0);
 assert.equal(report.total,BUILTIN_QUALITY_COUNT);
 assert.equal(report.failed,0,JSON.stringify(report.results.filter(x=>!x.passed)));
 assert.equal(report.pass_rate,100);
 assert.ok(report.results.some(x=>x.category==='docs'));
 assert.ok(report.results.some(x=>x.category==='office'));
 assert.ok(report.results.some(x=>x.category==='multi_tool'));
 assert.ok(report.results.some(x=>x.category==='privacy'));
 assert.equal(report.results.filter(x=>x.category==='expert').length,435);
 assert.equal(report.results.filter(x=>x.category==='conversation').length,12);
 assert.equal(report.results.filter(x=>x.category==='privacy').length>=18,true);
});

test('quality metrics distinguish verified test pass, fallback, handoff, tool success and LLM usage',()=>{
 const now=Date.parse('2026-10-09T08:00:00.000Z');
 const recent='2026-10-09T07:00:00.000Z';
 const old='2026-09-01T07:00:00.000Z';
 const metrics=qualityMetrics({now,days:7,events:[
  {kind:'agent_turn',created_at:recent,detail:{action:'crm_tools_multi_step',crm_tools:[{name:'read_area_details',ok:true},{name:'find_nearest_work_areas',ok:false}],handoff:false,
   llm_usage:{calls:2,prompt_tokens:400,completion_tokens:50,tokens_reported_calls:2}}},
  {kind:'agent_turn',created_at:recent,detail:{action:'handoff',crm_tools:[],handoff:true,handoff_reason:'documents_unavailable'}},
  {kind:'agent_turn',created_at:old,detail:{action:'outdated',crm_tools:[{name:'read_area_details',ok:true}]}}
 ],decisions:[
  {created_at:recent,planner_mode:'llm_live',fallback_used:false},
  {created_at:recent,planner_mode:'fallback',fallback_used:true}
 ],runs:[
  {created_at:recent,passed:true},{created_at:recent,passed:false},{created_at:recent,passed:null},{created_at:old,passed:false}
 ]});
 assert.equal(metrics.operational.turns,2);
 assert.equal(metrics.operational.tool_calls,2);
 assert.equal(metrics.operational.tool_success_rate,50);
 assert.equal(metrics.operational.handoffs,1);
 assert.equal(metrics.expert.answers,0);
 assert.equal(metrics.expert.office_verified,0);
 assert.equal(metrics.operational.handoff_rate,50);
 assert.equal(metrics.operational.fallback_rate,50);
 assert.equal(metrics.operational.llm_decisions,1);
 assert.equal(metrics.evaluation.pass_rate,50);
 assert.equal(metrics.evaluation.evaluated,2);
 assert.equal(metrics.usage.prompt_tokens_observed,400);
 assert.equal(metrics.usage.completion_tokens_observed,50);
 assert.equal(metrics.usage.cost,null);
 assert.equal(metrics.daily.length,1);
 assert.deepEqual(metrics.handoff_reasons,[{reason:'documents_unavailable',count:1}]);
});

test('quality metrics never claim precision from no data or unknown provider pricing',()=>{
 const empty=qualityMetrics({events:[],decisions:[],runs:[]});
 assert.equal(empty.operational.tool_success_rate,null);
 assert.equal(empty.operational.handoff_rate,null);
 assert.equal(empty.operational.fallback_rate,null);
 assert.equal(empty.evaluation.pass_rate,null);
 assert.equal(empty.usage.cost,null);
 assert.equal(empty.sample.turns,0);
});


test('Expert Brain telemetry counts only safe topic metadata, no source message',()=>{
 const now=Date.parse('2026-10-09T19:00:00Z');
 const report=qualityMetrics({now,events:[
  {kind:'agent_turn',created_at:'2026-10-09T18:50:00Z',detail:{action:'expert_general_guidance',expert_topic:'insurance',expert_source:'general_guidance'}},
  {kind:'agent_turn',created_at:'2026-10-09T18:52:00Z',detail:{action:'expert_office_answer',expert_topic:'insurance',expert_source:'office_verified'}},
  {kind:'agent_turn',created_at:'2026-10-09T18:53:00Z',detail:{action:'expert_general_guidance',expert_topic:'salary_structure',expert_source:'general_guidance'}}
 ]});
 assert.equal(report.expert.answers,3);
 assert.equal(report.expert.office_verified,1);
 assert.equal(report.expert.general_guidance,2);
 assert.deepEqual(report.expert.top_topics[0],{topic:'insurance',count:2});
 assert.equal(JSON.stringify(report).includes('candidate_id'),false);
});
