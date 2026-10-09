import test from 'node:test';
import assert from 'node:assert/strict';
import {recruitmentPerformance,pilotReadiness} from '../src/recruitment-performance.js';

const NOW=Date.parse('2026-10-09T20:00:00Z');
const created='2026-10-08T10:00:00Z',recent='2026-10-09T18:00:00Z';
const record=(id,stage,extra={})=>({id,stage,created_at:created,last_message_at:recent,...extra});

test('cohort counts form completion, never hiring acceptance',()=>{
 const result=recruitmentPerformance({
  now:NOW,days:7,
  applicants:[
   record('one','complete'),record('two','lecture'),record('three','working'),
   record('four','incomplete'),record('five','new'),
   record('older','complete',{created_at:'2026-09-01T00:00:00Z'})
  ],
  messages:[
   {applicant_id:'one',direction:'in',created_at:recent},
   {applicant_id:'one',direction:'in',created_at:recent},
   {applicant_id:'one',direction:'out',sender:'bot',created_at:recent},
   {applicant_id:'four',direction:'in',created_at:recent},
   {applicant_id:'older',direction:'in',created_at:recent},
   {applicant_id:'five',direction:'out',sender:'staff',created_at:recent}
  ],
  decisions:[{applicant_id:'one',created_at:recent,latency_ms:500},{applicant_id:'two',created_at:recent,latency_ms:300}]
 });
 assert.equal(result.funnel.registered,5);
 assert.equal(result.funnel.form_completed,3);
 assert.equal(result.funnel.completion_rate,60);
 assert.equal(result.funnel.engaged,2);
 assert.equal(result.funnel.engagement_rate,40);
 assert.equal(result.volume.inbound_messages,3);
 assert.equal(result.volume.bot_messages,1);
 assert.equal(result.volume.avg_inbound_per_applicant,.6);
 assert.equal(result.volume.median_planner_latency_ms,400);
 assert.equal(result.volume.completion_duration_minutes,null);
 assert.equal(result.accuracy.accuracy_rate,null);
 assert.match(result.methodology,/لا تمثل قرار قبول/);
 assert.equal(result.privacy.raw_text_used,false);
 assert.doesNotMatch(JSON.stringify(result),/older|applicant_id|one|two|four|private@example|01012345678/);
});

test('inactive incomplete applicants after 24 hours are only review candidates',()=>{
 const x=recruitmentPerformance({
  now:NOW,applicants:[
   record('a','new',{last_message_at:'2026-10-07T01:00:00Z'}),
   record('b','incomplete',{last_message_at:'2026-10-07T02:00:00Z'}),
   record('c','incomplete',{last_message_at:recent}),
   record('d','complete',{last_message_at:'2026-10-07T01:00:00Z'})
  ]
 });
 assert.equal(x.funnel.stalled_24h,2);
 assert.equal(x.funnel.stalled_rate,66.7);
 assert.equal(x.funnel.form_completed,1);
 assert.equal(x.daily_cohort.length,1);
 assert.equal(x.daily_cohort[0].registered,4);
 assert.equal(x.daily_cohort[0].currently_completed,1);
});

test('empty cohort yields unknown rates instead of 0% quality',()=>{
 const x=recruitmentPerformance({now:NOW});
 assert.equal(x.funnel.completion_rate,null);
 assert.equal(x.funnel.engagement_rate,null);
 assert.equal(x.funnel.stalled_rate,null);
 assert.equal(x.volume.avg_inbound_per_applicant,null);
 assert.equal(x.volume.completion_duration_minutes,null);
 assert.equal(x.accuracy.human_verified_responses,0);
 assert.equal(x.accuracy.accuracy_rate,null);
});

test('sampling cap hides rates to prevent false population precision',()=>{
 const x=recruitmentPerformance({now:NOW,applicants:[record('a','complete')],
  messages:[],applicantsTotal:6000,messagesTotal:20000,decisionsTotal:0});
 assert.equal(x.sample.capped.applicants,true);
 assert.equal(x.sample.capped.messages,true);
 assert.equal(x.partial_sample,true);
 assert.equal(x.funnel.completion_rate,null);
 assert.equal(x.funnel.engagement_rate,null);
 assert.equal(x.volume.avg_inbound_per_applicant,null);
});

test('wrong or future dates do not pollute selected period',()=>{
 const x=recruitmentPerformance({now:NOW,days:1,
  applicants:[
   record('old','complete',{created_at:'2026-10-07T01:00:00Z'}),
   record('future','complete',{created_at:'2032-01-01T00:00:00Z'}),
   record('new','new',{created_at:'2026-10-09T19:00:00Z'})
  ]});
 assert.equal(x.funnel.registered,1);
 assert.equal(x.funnel.form_completed,0);
});

test('source messages never leave the backend summary',()=>{
 const x=recruitmentPerformance({now:NOW,applicants:[record('private-name','new')],
  messages:[{applicant_id:'private-name',direction:'in',body:'My phone 01012345678',created_at:recent}]});
 assert.equal(x.volume.inbound_messages,1);
 assert.doesNotMatch(JSON.stringify(x),/private-name|My phone|01012345678/);
});

test('pilot stays blocked regardless of green synthetic suite until backup and human approval',()=>{
 const ready=pilotReadiness({qualitySuitePassed:true});
 assert.equal(ready.status,'blocked');
 assert.equal(ready.pilot_active,false);
 assert.equal(ready.production_cohort_size,0);
 assert.equal(ready.checks.filter(x=>x.ready).length,1);
 assert.equal(ready.ready_for_approval,false);
 const all=pilotReadiness({qualitySuitePassed:true,databaseBackupVerified:true,storageBackupVerified:true,
  recoveryTestVerified:true,humanReviewProcessReady:true});
 assert.equal(all.status,'blocked');
 assert.equal(all.ready_for_approval,true);
 assert.equal(all.pilot_active,false);
 assert.equal(all.proposal.first_cohort_max,100);
});
