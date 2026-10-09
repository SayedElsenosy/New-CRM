import test from 'node:test';
import assert from 'node:assert/strict';
import {PILOT_LIMIT,currentPilot,loadPilotControl,enrollNewInboundApplicant,
 pilotCohortSummary} from '../src/pilot-observation.js';

const account='00000000-0000-4000-a000-000000000001',other='00000000-0000-4000-a000-000000000002';
const startedAt='2026-10-10T09:00:00Z';
const start={id:'pilot-run',kind:'agent_pilot_started',created_at:startedAt,
 detail:{whatsapp_account_id:account,capacity:50,mode:'new_inbound_observation'}};
const stop={id:'pilot-stop',kind:'agent_pilot_stopped',created_at:'2026-10-10T10:00:00Z',
 detail:{whatsapp_account_id:account,run_id:'pilot-run'}};

function fakeDb({events=[start],entries=[]}={}){
 const inserts=[];
 return {
  inserts,
  from(table){
   let rows=table==='masar_events'?events:[];
   let category='controls';
   const builder={
    select(){return builder;},
    in(field){
     if(field==='kind')category='controls';
     return builder;
    },
    eq(field,value){
     if(field==='kind'&&value==='agent_pilot_enrolled')category='enrollments';
     return builder;
    },
    gte(){return builder;},
    order(){return builder;},
    limit(){return Promise.resolve({data:category==='controls'?events:entries,error:null});},
    insert(row){inserts.push(row);entries.push({...row,created_at:'2026-10-10T09:01:00Z'});
     return Promise.resolve({data:null,error:null});
    }
   };
   return builder;
  }
 };
}

test('start/stop pilot events apply only to exact WhatsApp account',()=>{
 assert.equal(currentPilot([start],account).active,true);
 assert.equal(currentPilot([start],account).run_id,'pilot-run');
 assert.equal(currentPilot([start],other).active,false);
 assert.equal(currentPilot([start,stop],account).active,false);
 assert.equal(currentPilot([stop,start],account).active,false);
 assert.equal(currentPilot([{...start,id:'second',created_at:'2026-10-10T11:00:00Z'},stop],account).active,true);
 assert.equal(currentPilot([],account).active,false);
});

test('new inbound contacts are enrolled exactly once with no outbound or personal data',async()=>{
 const db=fakeDb();
 const first=await enrollNewInboundApplicant(db,{accountId:account,applicantId:'candidate-synthetic'});
 assert.deepEqual(first,{enrolled:true,already:false});
 assert.equal(db.inserts.length,1);
 assert.equal(db.inserts[0].kind,'agent_pilot_enrolled');
 assert.equal(db.inserts[0].applicant_id,'candidate-synthetic');
 assert.equal(db.inserts[0].detail.run_id,'pilot-run');
 assert.doesNotMatch(JSON.stringify(db.inserts),/body|phone|message_text|recipient|send_message/);
 const twice=await enrollNewInboundApplicant(db,{accountId:account,applicantId:'candidate-synthetic'});
 assert.equal(twice.already,true);
 assert.equal(db.inserts.length,1);
});

test('pilot never enrolls candidates from another account, or after stop',async()=>{
 const db=fakeDb({events:[start,stop]});
 assert.equal((await loadPilotControl(db,account)).active,false);
 const stopped=await enrollNewInboundApplicant(db,{accountId:account,applicantId:'new'});
 const different=await enrollNewInboundApplicant(db,{accountId:other,applicantId:'new'});
 assert.equal(stopped.enrolled,false);
 assert.equal(different.enrolled,false);
 assert.equal(db.inserts.length,0);
});

test('51st incoming new candidate is excluded; original 50 remain',async()=>{
 const entries=Array.from({length:50},(_,i)=>({applicant_id:'candidate-'+i,
  detail:{run_id:'pilot-run'},created_at:startedAt}));
 const db=fakeDb({events:[start],entries});
 const x=await enrollNewInboundApplicant(db,{accountId:account,applicantId:'candidate-51'});
 assert.deepEqual(x,{enrolled:false,reason:'cohort_full'});
 assert.equal(db.inserts.length,0);
});

test('outcome report returns aggregate-only, not applicant IDs or contact information',()=>{
 const report=pilotCohortSummary({pilot:currentPilot([start],account),
  enrollments:[{applicant_id:'one'},{applicant_id:'two'},{applicant_id:'three'}],
  applicants:[{id:'one',stage:'complete'},{id:'two',stage:'working'},{id:'three',stage:'incomplete'}],
  handoffs:[{applicant_id:'three'},{applicant_id:'three'},{applicant_id:'outside'}]});
 assert.equal(report.active,true);
 assert.equal(report.enrolled,3);
 assert.equal(report.capacity,PILOT_LIMIT);
 assert.equal(report.remaining,47);
 assert.equal(report.form_completed,2);
 assert.equal(report.completion_rate,66.7);
 assert.equal(report.staff_intervention_candidates,1);
 assert.equal(report.unsolicited_messages,false);
 assert.equal(report.existing_office_bot_unchanged,true);
 assert.equal(report.observation_only,true);
 assert.doesNotMatch(JSON.stringify(report),/\"id\":|\"applicant_id\":|\"phone\":|\"body\":|outside/);
});

test('full group does not stop standard office bot and pilot stop is observation-only',()=>{
 const full=pilotCohortSummary({pilot:currentPilot([start],account),
  enrollments:Array.from({length:PILOT_LIMIT},(_,i)=>({applicant_id:String(i)}))});
 assert.equal(full.status,'cohort_full');
 assert.equal(full.remaining,0);
 assert.equal(full.existing_office_bot_unchanged,true);
 const stopped=pilotCohortSummary({pilot:currentPilot([start,stop],account)});
 assert.equal(stopped.status,'stopped');
 assert.equal(stopped.active,false);
});
