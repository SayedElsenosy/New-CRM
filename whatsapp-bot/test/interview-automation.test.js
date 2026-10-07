import test from 'node:test';
import assert from 'node:assert/strict';
import {extractInterviewSchedule,extractInterviewLocation,interviewSignalFromStaffMessages} from '../src/interview-automation.js';

function cairoParts(value){
 const parts=new Intl.DateTimeFormat('en-CA',{
  timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',hourCycle:'h23'
 }).formatToParts(new Date(value));
 const out={};
 for(const p of parts)if(p.type!=='literal')out[p.type]=Number(p.value);
 return out;
}

test('Arabic lecture date and time are parsed in Cairo local time',()=>{
 const r=extractInterviewSchedule('ميعاد المحاضرة يوم 10/10/2026 الساعة ٢ م',{
  reference:new Date('2026-10-08T18:00:00.000Z')
 });
 assert.ok(r);
 const p=cairoParts(r.scheduled_at);
 assert.deepEqual({year:p.year,month:p.month,day:p.day,hour:p.hour,minute:p.minute},{year:2026,month:10,day:10,hour:14,minute:0});
});

test('tomorrow and half-hour expressions are supported',()=>{
 const r=extractInterviewSchedule('المحاضرة بكرة الساعة ٢ ونص',{
  reference:new Date('2026-10-08T18:00:00.000Z')
 });
 assert.ok(r);
 const p=cairoParts(r.scheduled_at);
 assert.deepEqual({year:p.year,month:p.month,day:p.day,hour:p.hour,minute:p.minute},{year:2026,month:10,day:9,hour:14,minute:30});
});

test('map links and labelled addresses are extracted as interview locations',()=>{
 const link=extractInterviewLocation('اللوكيشن: https://maps.app.goo.gl/AbCd123');
 assert.equal(link.url,'https://maps.app.goo.gl/AbCd123');
 const address=extractInterviewLocation('المكان: مكتب Speed - شارع التسعين، التجمع');
 assert.match(address.text,/مكتب Speed/);
});

test('lecture appointment and location can arrive in two separate staff messages',()=>{
 const r=interviewSignalFromStaffMessages([
  {id:'m1',body:'ميعاد المحاضرة يوم 10/10/2026 الساعة 2 م',created_at:'2026-10-08T18:00:00.000Z'},
  {id:'m2',body:'اللوكيشن https://maps.app.goo.gl/lecture123',created_at:'2026-10-08T18:03:00.000Z'}
 ]);
 assert.ok(r);
 assert.deepEqual(r.source_message_ids,['m1','m2']);
 assert.equal(r.location.url,'https://maps.app.goo.gl/lecture123');
 const p=cairoParts(r.scheduled_at);
 assert.equal(p.hour,14);
 assert.equal(p.day,10);
});

test('location first and appointment second are combined too',()=>{
 const r=interviewSignalFromStaffMessages([
  {id:'m1',body:'المكان: مكتب مدينة نصر',created_at:'2026-10-08T18:00:00.000Z'},
  {id:'m2',body:'ميعادك للمحاضرة بكرة الساعة 11 ص',created_at:'2026-10-08T18:05:00.000Z'}
 ]);
 assert.ok(r);
 assert.match(r.location.display,/مكتب مدينة نصر/);
});

test('ordinary time plus map link does not create an interview without lecture intent',()=>{
 const r=interviewSignalFromStaffMessages([
  {id:'m1',body:'التسليم بكرة الساعة 2',created_at:'2026-10-08T18:00:00.000Z'},
  {id:'m2',body:'https://maps.app.goo.gl/dropoff123',created_at:'2026-10-08T18:02:00.000Z'}
 ]);
 assert.equal(r,null);
});

test('old unrelated staff messages are not combined with a new appointment',()=>{
 const r=interviewSignalFromStaffMessages([
  {id:'old',body:'اللوكيشن https://maps.app.goo.gl/old123',created_at:'2026-10-08T10:00:00.000Z'},
  {id:'new',body:'ميعاد المحاضرة بكرة الساعة 12',created_at:'2026-10-08T18:00:00.000Z'}
 ]);
 assert.equal(r,null);
});
