import test from 'node:test';
import assert from 'node:assert/strict';
import {
 PILOT_LIMIT,PILOT_MAX,PILOT_SIZES,validPilotSize,currentPilot,currentOfficePilot,
 loadPilotControl,loadPilotEnrollments,enrollNewInboundApplicant,pilotCohortSummary
} from '../src/pilot-observation.js';

const account='00000000-0000-4000-a000-000000000001',other='00000000-0000-4000-a000-000000000002',
 office='00000000-0000-4000-a000-000000000011',officeB='00000000-0000-4000-a000-000000000022';
const startedAt='2026-10-10T09:00:00Z';
const start={id:'pilot-run',kind:'agent_pilot_started',created_at:startedAt,
 detail:{office_id:office,whatsapp_account_id:account,capacity:50,mode:'new_inbound_observation'}};
const stop={id:'pilot-stop',kind:'agent_pilot_stopped',created_at:'2026-10-10T10:00:00Z',
 detail:{office_id:office,whatsapp_account_id:account,run_id:'pilot-run',capacity:50,started_at:startedAt}};
const secondStart={id:'office-b-run',kind:'agent_pilot_started',created_at:'2026-10-10T09:02:00Z',
 detail:{office_id:officeB,whatsapp_account_id:other,capacity:100,mode:'new_inbound_observation'}};

function fakeDb({events=[start],entries=[]}={}){
 const inserts=[];
 return {
  inserts,
  from(table){
   const state={kind:'controls',target:null,run:null};
   const builder={
    select(){return builder;},
    in(field){if(field==='kind')state.kind='controls';return builder;},
    eq(field,value){
     if(field==='kind'&&value==='agent_pilot_enrolled')state.kind='enrollments';
     return builder;
    },
    contains(field,detail){
     if(detail.office_id)state.target=detail.office_id;
     if(detail.whatsapp_account_id)state.target=detail.whatsapp_account_id;
     if(detail.run_id)state.run=detail.run_id;
     return builder;
    },
    order(){return builder;},
    limit(n){
     if(state.kind==='controls'){
      const subset=events.filter(e=>!state.target||String(e.detail?.office_id)===state.target
        ||String(e.detail?.whatsapp_account_id)===state.target)
       .sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
      return Promise.resolve({data:subset.slice(0,n),error:null});
     }
     return Promise.resolve({data:entries.filter(e=>!state.run||e.detail?.run_id===state.run).slice(0,n),error:null});
    },
    insert(row){inserts.push(row);entries.push({...row,created_at:'2026-10-10T09:01:00Z'});
     return Promise.resolve({data:null,error:null});
    }
   };
   return builder;
  }
 };
}

test('legacy account pilot continues using its original run and account matching',()=>{
 assert.equal(currentPilot([start],account).active,true);
 assert.equal(currentPilot([start],account).run_id,'pilot-run');
 assert.equal(currentPilot([start],other).active,false);
 assert.equal(currentPilot([start,stop],account).active,false);
 assert.equal(currentPilot([stop,start],account).active,false);
 assert.equal(currentPilot([],account).active,false);
});

test('office pilot is off by default, cannot inherit another office run',()=>{
 assert.equal(currentOfficePilot([],officeB).active,false);
 assert.equal(currentOfficePilot([start],office).active,true);
 assert.equal(currentOfficePilot([start],officeB).active,false);
 assert.equal(currentOfficePilot([start,secondStart],officeB).active,true);
 assert.equal(currentOfficePilot([start,secondStart],office).max,50);
 assert.equal(currentOfficePilot([start,secondStart],officeB).max,100);
});

test('stopping office A never stops B and preserves A completed cohort summary',()=>{
 const x=currentOfficePilot([start,secondStart,stop],office);
 const y=currentOfficePilot([start,secondStart,stop],officeB);
 assert.equal(x.active,false);
 assert.equal(x.run_id,'pilot-run');
 assert.equal(x.max,50);
 assert.equal(x.started_at,startedAt);
 assert.equal(y.active,true);
 assert.equal(y.run_id,'office-b-run');
});

test('allowed sizes are validated centrally',()=>{
 assert.deepEqual(PILOT_SIZES,[10,25,50,100,200]);
 assert.equal(PILOT_MAX,200);
 for(const n of PILOT_SIZES)assert.equal(validPilotSize(n),true);
 for(const n of [0,-1,9,26,99,201,999,null,NaN])assert.equal(validPilotSize(n),false);
});

test('inbound candidate enrolls only in selected office once; no raw message fields',async()=>{
 const db=fakeDb();
 const first=await enrollNewInboundApplicant(db,{officeId:office,accountId:account,applicantId:'candidate-synthetic'});
 assert.deepEqual(first,{enrolled:true,already:false});
 assert.equal(db.inserts.length,1);
 assert.equal(db.inserts[0].kind,'agent_pilot_enrolled');
 assert.equal(db.inserts[0].applicant_id,'candidate-synthetic');
 assert.equal(db.inserts[0].detail.office_id,office);
 assert.equal(db.inserts[0].detail.run_id,'pilot-run');
 assert.doesNotMatch(JSON.stringify(db.inserts),/body|phone|message_text|recipient|send_message/);
 const twice=await enrollNewInboundApplicant(db,{officeId:office,accountId:account,applicantId:'candidate-synthetic'});
 assert.equal(twice.already,true);
 assert.equal(db.inserts.length,1);
});

test('new office not manually started cannot enter pilot; previous A remains intact',async()=>{
 const db=fakeDb({events:[start]});
 const result=await enrollNewInboundApplicant(db,{officeId:officeB,accountId:other,applicantId:'new'});
 assert.deepEqual(result,{enrolled:false,reason:'not_active'});
 assert.equal(db.inserts.length,0);
 const original=await loadPilotControl(db,office,{officeId:true});
 assert.equal(original.active,true);
});

test('two WhatsApp accounts in same office share single 100-person capacity',async()=>{
 const db=fakeDb({events:[secondStart]});
 const a=await enrollNewInboundApplicant(db,{officeId:officeB,accountId:other,applicantId:'candidate-1'});
 const b=await enrollNewInboundApplicant(db,{officeId:officeB,accountId:account,applicantId:'candidate-2'});
 assert.equal(a.enrolled,true);
 assert.equal(b.enrolled,true);
 assert.equal(db.inserts.length,2);
 assert.equal(db.inserts[0].detail.run_id,db.inserts[1].detail.run_id);
 assert.equal((await loadPilotEnrollments(db,currentOfficePilot([secondStart],officeB))).length,2);
});

test('51st on A is excluded while B can still enroll its first candidate',async()=>{
 const entries=Array.from({length:50},(_,i)=>({applicant_id:'candidate-'+i,
  detail:{run_id:'pilot-run'},created_at:startedAt}));
 const db=fakeDb({events:[start,secondStart],entries});
 const x=await enrollNewInboundApplicant(db,{officeId:office,accountId:account,applicantId:'candidate-51'});
 const y=await enrollNewInboundApplicant(db,{officeId:officeB,accountId:other,applicantId:'new-b'});
 assert.deepEqual(x,{enrolled:false,reason:'cohort_full'});
 assert.equal(y.enrolled,true);
 assert.equal(db.inserts.length,1);
 assert.equal(db.inserts[0].detail.office_id,officeB);
});

test('stopped pilot never enrolls, but its report remains readable',async()=>{
 const entries=[{applicant_id:'existing',detail:{run_id:'pilot-run'},created_at:startedAt}];
 const db=fakeDb({events:[start,stop],entries});
 const pilot=await loadPilotControl(db,office,{officeId:true});
 assert.equal(pilot.active,false);
 const loaded=await loadPilotEnrollments(db,pilot);
 assert.equal(loaded.length,1);
 const result=await enrollNewInboundApplicant(db,{officeId:office,accountId:account,applicantId:'new'});
 assert.equal(result.enrolled,false);
 assert.equal(db.inserts.length,0);
});

test('aggregate remains private with dynamic capacity and human handoff count',()=>{
 const pilot=currentOfficePilot([secondStart],officeB);
 const report=pilotCohortSummary({
  pilot,
  enrollments:[{applicant_id:'one'},{applicant_id:'two'},{applicant_id:'three'}],
  applicants:[{id:'one',stage:'complete'},{id:'two',stage:'working'},{id:'three',stage:'incomplete'}],
  handoffs:[{applicant_id:'three'},{applicant_id:'three'},{applicant_id:'outside'}]
 });
 assert.equal(report.active,true);
 assert.equal(report.enrolled,3);
 assert.equal(report.capacity,100);
 assert.equal(report.remaining,97);
 assert.equal(report.form_completed,2);
 assert.equal(report.completion_rate,66.7);
 assert.equal(report.staff_intervention_candidates,1);
 assert.equal(report.unsolicited_messages,false);
 assert.equal(report.existing_office_bot_unchanged,true);
 assert.equal(report.observation_only,true);
 assert.doesNotMatch(JSON.stringify(report),/\"id\":|\"applicant_id\":|\"phone\":|\"body\":|outside/);
});

test('full cohort is tracking-only; never pauses baseline office agent',()=>{
 const full=pilotCohortSummary({pilot:currentOfficePilot([start],office),
  enrollments:Array.from({length:PILOT_LIMIT},(_,i)=>({applicant_id:String(i)}))});
 assert.equal(full.status,'cohort_full');
 assert.equal(full.remaining,0);
 assert.equal(full.existing_office_bot_unchanged,true);
 const stopped=pilotCohortSummary({pilot:currentOfficePilot([start,stop],office)});
 assert.equal(stopped.status,'stopped');
 assert.equal(stopped.active,false);
});
