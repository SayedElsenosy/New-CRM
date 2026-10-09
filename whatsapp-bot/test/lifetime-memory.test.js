import test from 'node:test';
import assert from 'node:assert/strict';
import {accumulateLifetimeMemory,emptyLifetimeMemory,loadLifetimeMemory,lifetimeMemoryContext} from '../src/lifetime-memory.js';
import {AgentRuntime} from '../src/agent-runtime.js';

function dbStub(all){
 const logs=[];
 return {
  logs,
  from(table){
   assert.equal(table,'masar_messages');
   let applicant='',after=0,before=Infinity,limit=250;
   const builder={
    select(columns){assert.equal(columns,'sequence,direction,sender,body,status');return this;},
    eq(field,value){assert.equal(field,'applicant_id');applicant=value;return this;},
    gt(field,value){assert.equal(field,'sequence');after=value;return this;},
    lte(field,value){assert.equal(field,'sequence');before=value;return this;},
    order(field,{ascending}={}){assert.equal(field,'sequence');assert.equal(ascending,true);return this;},
    limit(value){limit=value;return Promise.resolve({
      data:all.filter(x=>x.applicant_id===applicant&&x.sequence>after&&x.sequence<=before)
       .sort((a,b)=>a.sequence-b.sequence).slice(0,limit),error:null
     }).then(x=>{logs.push({applicant,after,before,limit});return x;});}
   };
   return builder;
  }
 };
}
const msg=(sequence,body,applicant_id='office-a-applicant',direction='in')=>({
 sequence,body,applicant_id,direction,sender:direction==='in'?'candidate':'bot',
 status:direction==='in'?'pending':'sent'
});
test('indexes all 604 messages, not the most recent 6/12/30; applicant scoped only',async()=>{
 const all=[
  msg(1,'في البداية قلت انا ساكن في المنصورية مش المنصورة'),
  ...Array.from({length:603},(_,i)=>msg(i+2,i%3===0?'المرتب والقبض الاسبوعي':'عايز تفاصيل الشغل في الهرم')),
  ...Array.from({length:12},(_,i)=>msg(i+1,'رقم 01012345678 بيانات خارج المكتب','foreign-office'))
 ];
 const db=dbStub(all);
 const result=await loadLifetimeMemory(db,{applicantId:'office-a-applicant',throughSequence:604});
 assert.equal(result.changed,true);
 assert.equal(result.memory.message_count,604);
 assert.equal(result.memory.last_sequence,604);
 assert.equal(result.memory.corrected_place,'المنصورية (وليس المنصورة)');
 assert.ok(result.memory.topic_counts.payroll>150);
 assert.ok(result.memory.topic_counts.location>100);
 assert.equal(db.logs.length,3,'pages entire history before persisting');
 assert.deepEqual(db.logs.map(x=>x.after),[0,250,500]);
 assert.ok(!JSON.stringify(result.memory).includes('01012345678'));
 assert.ok(JSON.stringify(result.memory).length<4500,'memory is bounded regardless of transcript size');
 const context=lifetimeMemoryContext({__lifetime_memory:result.memory});
 assert.equal(context.historical_messages_indexed,604);
 assert.match(context.warning,/لا تعتبر السكن منطقة عمل/);
});
test('next turn reads only unseen history and does not double-count retries',async()=>{
 const rows=[msg(1,'شغل الهرم'),msg(2,'المرتب كام'),msg(3,'القبض امتى')],db=dbStub(rows);
 const first=await loadLifetimeMemory(db,{applicantId:'office-a-applicant',throughSequence:2});
 const second=await loadLifetimeMemory(db,{applicantId:'office-a-applicant',throughSequence:3,existing:first.memory});
 assert.equal(second.memory.message_count,3);
 assert.equal(second.memory.topic_counts.payroll,2);
 const retry=await loadLifetimeMemory(db,{applicantId:'office-a-applicant',throughSequence:3,existing:second.memory});
 assert.equal(retry.changed,false);
 assert.deepEqual(retry.memory,second.memory);
 assert.equal(db.logs.at(-1).after,3);
});
test('corrections and last discussed topics are labelled unverified, never a hiring choice',()=>{
 const data=accumulateLifetimeMemory(emptyLifetimeMemory(),[
  msg(1,'انا ساكن في المنصورية مش المنصورة'),
  msg(2,'عايز تفاصيل شغل الهرم'),
  msg(3,'اختيارات الشغل في الشيخ زايد')
 ]);
 const context=lifetimeMemoryContext({__lifetime_memory:data.memory});
 assert.ok(context.historical_applicant_remarks.location);
 assert.equal(context.explicit_location_correction,'المنصورية (وليس المنصورة)');
 assert.equal(JSON.stringify(context).includes('work_area_eligible'),false);
});
test('planner gets durable lifetime overview alongside recent conversation, keeping conversation window compact',()=>{
 const runtime=new AgentRuntime({env:{}});
 const rows=Array.from({length:78},(_,i)=>msg(i+1,i===0?'انا ساكن المنصورية مش المنصورة':'القبض امتى'));
 const {memory}=accumulateLifetimeMemory(null,rows);
 const messages=runtime.buildPlannerMessages({
  message:{body:'فاكر قلتلك انا ساكن فين'},applicant:{answers:{__lifetime_memory:memory}},
  questions:[],areas:[],knowledge:[],settings:{},recentMessages:rows.map(r=>({...r,body:r.body}))
 });
 const content=messages[1].content;
 assert.match(content,/lifetime_conversation_memory/);
 assert.match(content,/historical_messages_indexed/);
 assert.match(content,/المنصورية \(وليس المنصورة\)/);
 assert.equal((content.match(/"role":"applicant"/g)||[]).length,6,'recent turns stay bounded');
});
