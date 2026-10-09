import test from 'node:test';
import assert from 'node:assert/strict';
import {qualityIssueAlertCandidate} from '../src/quality-alerts.js';

const now=Date.parse('2026-10-10T12:00:00Z'), office='private-office-a';
function event(applicant,minute,signals=[],question='area',officeId=office){
 return {kind:'agent_turn',applicant_id:applicant,
  created_at:new Date(now-minute*60000).toISOString(),
  detail:{office_id:officeId,quality_signals:signals,awaiting_before:question,awaiting_after:question}
 };
}
test('warns about the same applicant stuck twice at same question',()=>{
 const data=[event('p',0,['ambiguous_reply']),event('p',2,['ambiguous_reply'])];
 const issue=qualityIssueAlertCandidate(data,{officeId:office,currentApplicantId:'p',now});
 assert.equal(issue.key,'repeated_stall');
 assert.equal(issue.count,2);
 assert.doesNotMatch(JSON.stringify(issue),/applicant_id|private-office-a|"p"/);
});
test('requires sustained office problems from at least two different applicants',()=>{
 const data=[
  ...Array.from({length:5},(_,i)=>event(i%2?'person1':'person2',i,['tool_failure'],'area'+i)),
  ...Array.from({length:7},(_,i)=>event('normal'+i,6+i,[]))
 ];
 const issue=qualityIssueAlertCandidate(data,{officeId:office,currentApplicantId:'person2',now});
 assert.equal(issue.key,'tool_failure');
 assert.equal(issue.count,5);
 assert.equal(issue.sampled_turns,12);
 assert.equal(qualityIssueAlertCandidate(data,{officeId:'another-office',currentApplicantId:'person2',now}),null);
 assert.equal(qualityIssueAlertCandidate(data,{officeId:office,currentApplicantId:'person2',now,partial:true}),null);
});
test('isolated spikes and historic events do not create misleading office alerts',()=>{
 const single=Array.from({length:10},(_,i)=>event('one-person',i,['llm_fallback'],'field'+i));
 assert.equal(qualityIssueAlertCandidate(single,{officeId:office,currentApplicantId:'one-person',now}),null);
 const foreign=[event('p',0,['ambiguous_reply']),event('p',1,['ambiguous_reply'],'area','foreign-office')];
 assert.equal(qualityIssueAlertCandidate(foreign,{officeId:office,currentApplicantId:'p',now}),null);
 const stale=[event('p',0,['ambiguous_reply']),event('p',1500,['ambiguous_reply'])];
 assert.equal(qualityIssueAlertCandidate(stale,{officeId:office,currentApplicantId:'p',now}),null);
});
