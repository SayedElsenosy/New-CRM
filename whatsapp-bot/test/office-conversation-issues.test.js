import test from 'node:test';
import assert from 'node:assert/strict';
import {officeConversationIssues} from '../src/conversation-intelligence.js';

const now=Date.parse('2026-10-10T00:00:00Z');
const event=(applicant,minute,signals=[],question='work_area')=>({
 kind:'agent_turn',applicant_id:applicant,
 created_at:new Date(now-(120-minute)*60000).toISOString(),
 detail:{quality_signals:signals,awaiting_before:question,awaiting_after:question}
});

test('office issues use only whitelisted applicants and never expose identities or question keys',()=>{
 const officeA=[
  ...Array.from({length:4},(_,i)=>event('office-a-private',i,['ambiguous_reply'])),
  ...Array.from({length:8},(_,i)=>event('office-a-private',i+4,[],'other_question'))
 ];
 const foreign=Array.from({length:9},(_,i)=>event('other-office-private',i,['tool_failure','handoff']));
 const out=officeConversationIssues([...officeA,...foreign],{
  applicantIds:['office-a-private'],days:1,now
 });
 assert.equal(out.sampled_turns,12);
 assert.equal(out.flagged_turns,4);
 assert.equal(out.patterns.find(p=>p.key==='repeated_stall')?.count,3);
 assert.equal(out.patterns.find(p=>p.key==='repeated_stall')?.priority,'review');
 assert.equal(out.patterns.find(p=>p.key==='tool_failure'),undefined);
 assert.equal(out.automatic_actions,false);
 assert.equal(out.requires_human_approval,true);
 assert.doesNotMatch(JSON.stringify(out),/office-a-private|other-office-private|applicant_id|work_area|other_question/);
});

test('small or incomplete samples never receive automated review priority or invented rates',()=>{
 const small=officeConversationIssues(Array.from({length:4},(_,i)=>event('p',i,['tool_failure'])),{
  applicantIds:['p'],days:1,now
 });
 assert.equal(small.patterns[0].priority,'watch');
 const many=Array.from({length:12},(_,i)=>event('p',i,i<5?['tool_failure']:[]));
 const partial=officeConversationIssues(many,{applicantIds:['p'],days:1,now,truncated:true});
 assert.equal(partial.partial_sample,true);
 assert.equal(partial.flagged_rate,null);
 assert.equal(partial.patterns[0].rate,null);
 assert.equal(partial.patterns[0].priority,'watch');
});

test('empty office set cannot expose any other office activity',()=>{
 const out=officeConversationIssues([event('foreign',1,['handoff'])],{applicantIds:[],days:1,now});
 assert.equal(out.sampled_turns,0);
 assert.equal(out.flagged_rate,null);
 assert.deepEqual(out.patterns,[]);
});
