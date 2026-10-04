import test from 'node:test';
import assert from 'node:assert/strict';
import {followupDue,buildFollowupMessage} from '../src/followup.js';

const areas=[{id:'oct',name:'أكتوبر',active:true,details:'تفاصيل أكتوبر'}];
const questions=[
 {id:'name',field_key:'name',kind:'name',label:'اسمك بالكامل؟',position:1,active:true,required:true},
 {id:'area',field_key:'area',kind:'area',label:'أنهي منطقة؟',position:2,active:true,required:true},
 {id:'bike',field_key:'bike',kind:'yes_no',label:'معاك موتوسيكل؟',position:3,active:true,required:true}
];

test('follow-up becomes due eight hours after the latest activity',()=>{
 const now=Date.parse('2026-10-04T12:00:00Z');
 const a={stage:'incomplete',bot_enabled:true,created_at:'2026-10-04T00:00:00Z',last_message_at:'2026-10-04T03:59:59Z',followup_last_sent_at:null};
 assert.equal(followupDue(a,{now,hours:8}),true);
 assert.equal(followupDue({...a,last_message_at:'2026-10-04T04:00:01Z'},{now,hours:8}),false);
});

test('latest reminder resets the eight-hour clock',()=>{
 const now=Date.parse('2026-10-04T20:00:00Z');
 const a={stage:'incomplete',bot_enabled:true,created_at:'2026-10-04T00:00:00Z',last_message_at:'2026-10-04T02:00:00Z',followup_last_sent_at:'2026-10-04T13:00:00Z'};
 assert.equal(followupDue(a,{now,hours:8}),false);
 assert.equal(followupDue({...a,followup_last_sent_at:'2026-10-04T11:59:59Z'},{now,hours:8}),true);
});

test('completed, paused, lecture and working applicants are never due',()=>{
 const base={created_at:'2026-10-03T00:00:00Z',last_message_at:'2026-10-03T00:00:00Z',bot_enabled:true};
 const now=Date.parse('2026-10-04T20:00:00Z');
 for(const stage of ['complete','lecture','working'])assert.equal(followupDue({...base,stage},{now,hours:8}),false);
 assert.equal(followupDue({...base,stage:'incomplete',bot_enabled:false},{now,hours:8}),false);
});

test('follow-up message repeats the exact missing question and offers help',()=>{
 const applicant={stage:'incomplete',bot_enabled:true,awaiting_id:'area',answers:{name:{value:'سيد أحمد',display:'سيد أحمد',kind:'name'}}};
 const body=buildFollowupMessage(applicant,questions,areas);
 assert.match(body,/يا سيد أحمد/);
 assert.match(body,/أنهي منطقة/);
 assert.match(body,/اختار المنطقة من الأزرار/);
 assert.doesNotMatch(body,/• أكتوبر/);
 assert.match(body,/لو في حاجة موقفاك/);
 assert.match(body,/المرتب أو المواعيد/);
});

test('no follow-up message is built after required data is complete',()=>{
 const applicant={stage:'complete',bot_enabled:true,answers:{
  name:{value:'سيد أحمد',kind:'name'},
  area:{value:'oct',kind:'area'},
  bike:{value:true,kind:'yes_no'}
 }};
 assert.equal(buildFollowupMessage(applicant,questions,areas),null);
});
