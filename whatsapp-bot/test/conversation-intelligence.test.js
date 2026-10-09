import test from 'node:test';
import assert from 'node:assert/strict';
import {turnQualitySignals,conversationIntelligenceMetrics,safeLearningProposal,SIGNAL_TYPES} from '../src/conversation-intelligence.js';
import {promotePendingLearning,learnFromConversation} from '../src/knowledge.js';

const time='2026-10-09T18:00:00.000Z';
const event=(id,signals,{applicant='synthetic',at=time,before='q_area',after='q_area'}={})=>({
 kind:'agent_turn',created_at:at,applicant_id:applicant,
 detail:{action:'flow_turn',quality_signals:signals,awaiting_before:before,awaiting_after:after}
});

test('classifies ambiguities, source gaps, tool outages, handoff, fallback and corrections without storing text',()=>{
 const samples=[
  [{message:'لا قصدي الشيخ زايد مش أكتوبر',reply:'محتاج أوضح إجابتك علشان أسجلها صح.',turn:{agent_action:'clarify'},awaitingBefore:'q_area',awaitingAfter:'q_area'},['ambiguous_reply','correction']],
  [{message:'البنزين على مين',reply:'مش عندي إجابة مؤكدة عن السياسة دي',awaitingBefore:'q_area',awaitingAfter:'q_area'},['knowledge_gap']],
  [{message:'القرب والمقارنة',reply:'بعتلك التفاصيل',turn:{tool_calls:[{tool:'nearest',ok:false},{tool:'compare',ok:true}]},awaitingBefore:'q_area',awaitingAfter:'q_area'},['tool_failure','multiple_intents']],
  [{message:'عندي سؤال',reply:'هحولك لموظف',turn:{handoff:true},llmUnavailable:true},['llm_fallback','handoff']],
  [{message:'هل في تأمين',reply:'وجود التأمين يختلف حسب المنطقة',turn:{expert_source:'general_guidance'}},['domain_guidance']]
 ];
 for(const [input,expected] of samples){
  const actual=turnQualitySignals(input);
  assert.deepEqual(actual,expected);
  const joined=JSON.stringify(actual);
  assert.doesNotMatch(joined,/أكتوبر|التأمين|الشيخ زايد|القرب/);
 }
});

test('cannot tag unclear reply as stalled if candidate moved to another question',()=>{
 assert.deepEqual(turnQualitySignals({
  message:'نعم',reply:'محتاج أوضح إجابتك',turn:{agent_action:'clarify'},
  awaitingBefore:'q1',awaitingAfter:'q2'
 }),[]);
});

test('aggregate patterns over real event metadata while excluding candidate identifiers',()=>{
 const now=Date.parse('2026-10-10T00:00:00.000Z');
 const cases=[
  event('1',['ambiguous_reply'],{applicant:'person-private-1',at:'2026-10-09T12:00:00.000Z'}),
  event('2',['ambiguous_reply'],{applicant:'person-private-1',at:'2026-10-09T12:02:00.000Z'}),
  event('3',['tool_failure','handoff'],{applicant:'person-private-2',at:'2026-10-09T14:00:00.000Z'}),
  event('4',['llm_fallback'],{applicant:'person-private-3',at:'2026-10-09T15:00:00.000Z',before:'q1',after:'q2'}),
  event('5',['unknown_code','ambiguous_reply'],{applicant:'person-private-3',at:'2026-10-09T15:01:00.000Z'}),
  event('old',['handoff'],{applicant:'other',at:'2026-08-01T12:00:00.000Z'})
 ];
 const out=conversationIntelligenceMetrics(cases,{now,days:7});
 assert.equal(out.sampled_turns,5);
 assert.equal(out.flagged_turns,5);
 assert.equal(out.flag_rate,100);
 assert.equal(out.patterns.find(x=>x.key==='repeated_stall').count,1);
 assert.equal(out.patterns.find(x=>x.key==='ambiguous_reply').count,3);
 assert.equal(out.patterns.find(x=>x.key==='tool_failure').count,1);
 assert.equal(out.patterns.find(x=>x.key==='unknown_code'),undefined);
 assert.equal(out.auto_learning,false);
 assert.equal(out.requires_human_approval,true);
 assert.equal(out.day_trend.length,1);
 assert.doesNotMatch(JSON.stringify(out),/person-private|applicant_id|q_area|unknown_code|input_text|01012345678/);
});

test('repeated stall detection is isolated per candidate and question; resets on progress',()=>{
 const now=Date.parse('2026-10-10T00:00:00Z');
 const rows=[
  event('1',['ambiguous_reply'],{applicant:'a',at:'2026-10-09T08:00:00Z'}),
  event('2',['ambiguous_reply'],{applicant:'b',at:'2026-10-09T08:01:00Z'}),
  event('3',['ambiguous_reply'],{applicant:'a',at:'2026-10-09T08:02:00Z',after:'different'}),
  event('4',['ambiguous_reply'],{applicant:'a',at:'2026-10-09T08:03:00Z'}),
  event('5',['ambiguous_reply'],{applicant:'a',at:'2026-10-09T08:04:00Z'})
 ];
 const out=conversationIntelligenceMetrics(rows,{now});
 assert.equal(out.patterns.find(x=>x.key==='repeated_stall').count,1);
});

test('metrics with zero events return unavailable rate instead of invented precision',()=>{
 const result=conversationIntelligenceMetrics([],{days:7});
 assert.equal(result.sampled_turns,0);
 assert.equal(result.flag_rate,null);
 assert.deepEqual(result.patterns,[]);
 assert.ok(result.warning.includes('مش'));
});

test('sensitive messages never become auto-learning proposals',()=>{
 const reject=[
  ['رقمي 01012345678', 'حاضر'],
  ['التقديم في شارع الثورة عمارة 10', 'المكان متاح'],
  ['أنا بطاقة رقم 29810010001234', 'تمام'],
  ['my email is some.person@example.com', 'Done'],
  ['شقة 5 في التحرير', 'ممكن'],
  ['موبايلي الجديد اهو', 'هنرد عليك'],
  ['رقمي ٠١٠١٢٣٤٥٦٧٨', 'القبض يوم الخميس']
 ];
 for(const [q,a] of reject)assert.equal(safeLearningProposal(q,a),false,q);
 for(const [q,a] of [['هل في شيفت مسائي؟','لازم نراجع نظام المنطقة أولًا'],['ايه تفاصيل تأمين المكتب؟','التأمين حسب الاتفاق المكتوب في ملف المكتب']]){
  assert.equal(safeLearningProposal(q,a),true,q);
 }
});

test('legacy background bulk promotion remains a harmless no-op',async()=>{
 const db={from:()=>{throw Error('must never touch production database');}};
 const outcome=await promotePendingLearning(db);
 assert.deepEqual(outcome,{promoted:0,skipped:0,awaiting_human_review:true});
});

test('staff correction produces pending suggestion only, never publishes CRM knowledge',async()=>{
 const updates=[];
 const past=[
  {id:'m1',direction:'in',sender:'applicant',body:'معايا رخصة بس منتهية',sequence:1},
  {id:'m2',direction:'out',sender:'staff',body:'ينفع تكمل التقديم، ومسؤول التوظيف هيراجع حالة الرخصة.',sequence:2}
 ];
 const db={
  from(table){
   return {
    select(){
     const query={
      eq(){return query;},order(){return query;},limit(){return Promise.resolve({data:past,error:null});},
      maybeSingle(){return Promise.resolve({data:{office_id:'office-test'},error:null});}
     };
     return query;
    },
    insert(row){
     updates.push({table,row});
     return {select(){return {maybeSingle:async()=>({data:{id:'review-id'},error:null})}}};
    },
    update(){throw Error('No automatic fact approval allowed')}
   };
  }
 };
 const outcome=await learnFromConversation(db,{applicantId:'candidate-test',officeId:'office-test',staffMessageId:'m2',staffId:'staff-test',force:true});
 assert.equal(outcome.learned,false);
 assert.equal(outcome.action,'awaiting_staff_review');
 assert.equal(updates.filter(x=>x.table==='masar_knowledge').length,0);
 const suggestion=updates.find(x=>x.table==='masar_learning_suggestions')?.row;
 assert.equal(suggestion.status,'pending');
 assert.equal(suggestion.office_id,'office-test');
 assert.equal(suggestion.reviewed_at,null);
 assert.equal(suggestion.reviewed_by,null);
});

test('alerts and quality metadata cannot authorize automatic acceptance',()=>{
 assert.ok(Object.keys(SIGNAL_TYPES).every(x=>/^[a-z_]+$/.test(x)));
 assert.ok(!Object.keys(SIGNAL_TYPES).includes('qualified_candidate'));
 assert.ok(!Object.keys(SIGNAL_TYPES).includes('preferred_work_area'));
});
