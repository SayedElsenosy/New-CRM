import test from 'node:test';
import assert from 'node:assert/strict';
import {documentAvailabilityDecision,unavailableDocumentNote} from '../src/document-assistance.js';
import {planTurn} from '../src/flow.js';
import {followupDue} from '../src/followup.js';

const areas=[{id:'oct',name:'أكتوبر',active:true,recruitment_eligible:true,zone:'WEST',details:'معلومات أكتوبر'}];
const doc={id:'docs',field_key:'recruitment_documents',kind:'image',required:true,active:true,
 label:'ابعت صورة البطاقة وصورة رخصة الموتوسيكل وحد من المسؤولين هيتواصل معاك',position:3};
const questions=[
 {id:'bike',field_key:'has_motorcycle',kind:'yes_no',label:'معاك موتوسيكل؟',active:true,required:true,position:1},
 {id:'area',field_key:'preferred_work_area',kind:'area',label:'منطقة الشغل؟',active:true,required:true,position:2},
 doc
];
const answers={
 bike:{value:true,key:'has_motorcycle',kind:'yes_no'},
 area:{value:'oct',key:'preferred_work_area',kind:'area',work_area_eligible:true}
};
const applicant={stage:'incomplete',bot_enabled:true,awaiting_id:'docs',answers};
const settings={ai_enabled:true,ai_knowledge_enabled:true,ai_fallback:'مش متأكد؛ لازم مسؤول التوظيف يرد.',completion:'تم التقديم'};
const run=(applicant,body,extras={})=>planTurn({
 applicant,message:{body},questions,areas,settings,interpret:async()=>null,
 knowledge:[],...extras
});

test('unavailable documents without specification clarify once, without claiming an upload',async()=>{
 const r=await run(applicant,'مش معايا');
 assert.equal(r.agent_action,'clarify_unavailable_documents');
 assert.match(r.reply,/البطاقة/);
 assert.match(r.reply,/رخصة الموتوسيكل/);
 assert.match(r.reply,/ولا الاتنين/);
 assert.doesNotMatch(r.reply,/ابعت صورة البطاقة وصورة رخصة الموتوسيكل وحد/);
 assert.equal(r.patch.awaiting_id,'docs');
 assert.equal(r.patch.bot_enabled,undefined);
 assert.equal(r.handoff,undefined);
 assert.equal(r.patch.answers.docs,undefined);
 assert.equal(r.patch.answers.__qualification_stop,undefined);
 assert.equal(r.patch.answers.__document_issue.kind,'document_availability_clarification');
});

test('clarified missing license hands off with a staff-ready alert instead of looping',async()=>{
 const first=await run(applicant,'مش معايا');
 const second=await run({...applicant,answers:first.patch.answers},'الرخصة');
 assert.equal(second.handoff,true);
 assert.equal(second.handoff_reason,'documents_unavailable');
 assert.equal(second.patch.bot_enabled,false);
 assert.equal(second.patch.awaiting_id,'docs');
 assert.equal(second.patch.answers.docs,undefined);
 assert.equal(second.patch.answers.__qualification_stop,undefined);
 assert.equal(second.patch.answers.__document_issue.reported,'license');
 assert.match(second.handoff_note,/رخصة الموتوسيكل/);
 assert.match(second.handoff_note,/السؤال:/);
 assert.match(second.reply,/مسؤول التوظيف/);
 assert.doesNotMatch(second.reply,/ابعت صورة/);
 assert.equal(await run({...applicant,bot_enabled:false},'الرخصة').then(x=>x.reply),'');
});

test('repeating مش معايا after one clarification hands off rather than re-prompting',async()=>{
 const first=await run(applicant,'مش معايا');
 const second=await run({...applicant,answers:first.patch.answers},'مش معايا');
 assert.equal(second.handoff,true);
 assert.equal(second.patch.bot_enabled,false);
 assert.match(second.reply,/مش هكرر عليك طلب الصور/);
 assert.equal(second.patch.answers.docs,undefined);
});

test('explicitly missing ID or license hands off immediately, not automatic disqualification',async()=>{
 for(const body of ['معنديش رخصة الموتوسيكل','مش معايا البطاقة','رخصتي ضاعت']){
  const r=await run(applicant,body);
  assert.equal(r.handoff,true,body);
  assert.equal(r.patch.bot_enabled,false,body);
  assert.equal(r.patch.answers.bike.value,true,body);
  assert.equal(r.patch.answers.__qualification_stop,undefined,body);
  assert.equal(r.patch.answers.docs,undefined,body);
  assert.equal(r.patch.answers.__ai_handoff.reason,'documents_unavailable');
 }
});

test('no motorcycle is different from a missing license: existing eligibility rule still applies',async()=>{
 const r=await run(applicant,'مش معايا موتوسيكل');
 assert.equal(r.patch.answers.__qualification_stop?.reason,'no_motorcycle');
 assert.notEqual(r.handoff_reason,'documents_unavailable');
});

test('the missing-documents branch works even with AI off',async()=>{
 const r=await run(applicant,'معنديش البطاقة',{settings:{...settings,ai_enabled:false}});
 assert.equal(r.handoff,true);
 assert.match(r.handoff_note,/البطاقة/);
});

test('answering clarification with either document is accepted as a problem report',()=>{
 const state={kind:'document_availability_clarification',question_id:'docs'};
 assert.equal(documentAvailabilityDecision('البطاقة',doc,state).document,'id');
 assert.equal(documentAvailabilityDecision('الاتنين',doc,state).document,'both');
 assert.equal(documentAvailabilityDecision('مش معايا',doc,state).action,'handoff');
 assert.equal(documentAvailabilityDecision('المرتب كام؟',doc,state),null);
 assert.equal(documentAvailabilityDecision('أنا معايا صورة البطاقة',doc),null);
 assert.equal(documentAvailabilityDecision('مش معايا موتوسيكل',doc),null);
 assert.match(unavailableDocumentNote(doc,'الرخصة','license'),/رخصة الموتوسيكل/);
});

test('image question requesting one document knows what generic مش معايا refers to',()=>{
 const idOnly={...doc,label:'ابعت صورة البطاقة'};
 const licenseOnly={...doc,label:'ابعت صورة رخصة الموتوسيكل'};
 assert.equal(documentAvailabilityDecision('مش معايا',idOnly).document,'id');
 assert.equal(documentAvailabilityDecision('مش معايا',licenseOnly).document,'license');
});

test('real image upload after clarification is recorded and clears the unresolved issue',async()=>{
 const first=await run(applicant,'مش معايا');
 const uploaded=await run({...applicant,answers:first.patch.answers},'',{
  message:{body:'',media_path:'candidate/attachment1',media_type:'image/jpeg'}
 });
 assert.equal(uploaded.handoff,undefined);
 assert.equal(uploaded.patch.bot_enabled,undefined);
 assert.equal(uploaded.patch.answers.docs.value,'candidate/attachment1');
 assert.equal(uploaded.patch.answers.__document_issue,undefined);
});

test('human handoff prevents 8-hour automated reminders from nagging applicant again',async()=>{
 const r=await run(applicant,'مش معايا البطاقة');
 const moved={...applicant,...r.patch,created_at:'2026-10-01T00:00:00.000Z'};
 assert.equal(followupDue(moved,{now:Date.parse('2026-10-08T20:00:00.000Z')}),false);
});
