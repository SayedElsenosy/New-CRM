import test from 'node:test';
import assert from 'node:assert/strict';
import {planTurn,isApplicationStartMessage} from '../src/flow.js';
import {qualificationFor} from '../src/qualification.js';
import {normalizeWorkAreas} from '../src/db.js';

const questions=[
 {id:'q1',field_key:'has_motorcycle',kind:'yes_no',label:'هل معاك موتوسيكل متاح للشغل يوميًا؟',position:1,active:true,required:true},
 {id:'q2',field_key:'preferred_work_area',kind:'area',label:'أنهي منطقة تقدر تشتغل فيها يوميًا؟ اختار المنطقة اللي تقدر تلتزم بالشغل فيها بشكل مستمر.',position:2,active:true,required:true},
 {id:'q3',field_key:'full_name',kind:'name',label:'اكتب اسمك بالكامل.',position:3,active:true,required:true},
 {id:'q4',field_key:'shift_acceptance',kind:'yes_no',label:'الشيفت 9 ساعات. النظام ده مناسب ليك؟',position:4,active:true,required:true},
 {id:'q5',field_key:'ready_to_start',kind:'yes_no',label:'لو تم قبولك، تقدر تبدأ الشغل قريب؟',position:5,active:true,required:true},
 {id:'res',field_key:'residence_area',kind:'text',label:'ساكن فين؟',position:90,active:false,required:false}
];
const areas=[
 {id:'oct',name:'أكتوبر',aliases:['اكتوبر','6 أكتوبر'],active:true,recruitment_eligible:true,zone:'WEST',details:'تفاصيل أكتوبر'},
 {id:'nasr',name:'مدينة نصر',aliases:['مدينه نصر'],active:true,recruitment_eligible:true,zone:'NORTH_CENTRAL',details:'تفاصيل مدينة نصر'},
 {id:'tagamoa',name:'التجمع',aliases:['القاهرة الجديدة'],active:true,recruitment_eligible:true,zone:'EAST',details:'تفاصيل التجمع'},
 {id:'outside',name:'المنصورة',active:true,recruitment_eligible:false,zone:'UNKNOWN',details:'غير متاحة للتوظيف'}
];
const settings={
 ai_enabled:true,ai_knowledge_enabled:true,ai_confidence_threshold:.55,
 welcome:'أهلاً بيك في التقديم لوظيفة طيار دليفري مع Breadfast 👋🏍️',
 completion:'تمام ✅ بياناتك اتسجلت بنجاح.\n\nأنت خلصت مرحلة التقديم الأولية، وبياناتك هتراجعها إدارة التوظيف لتأكيد استيفاء الشروط وتحديد الخطوة التالية.\n\n📞 خليك متابع واتساب والمكالمات علشان مسؤول التوظيف يقدر يتواصل معاك.\n\nالتقديم مجاني 100% ومفيش أي رسوم للتعيين.',
 qualification_require_shift:false,qualification_require_motorcycle_license:false
};
const applicant={stage:'new',recruitment_stage:'new',answers:{},awaiting_id:null,bot_enabled:true};
const noAi=async()=>null;
const call=(a,body,extra={})=>planTurn({applicant:a,message:{body},questions,areas,settings,interpret:noAi,knowledge:[],...extra});

test('welcome is sent separately before the motorcycle qualification question',async()=>{
 const r=await call(applicant,'السلام عليكم');
 assert.equal(r.patch.awaiting_id,'q1');
 assert.match(r.reply,/Breadfast/);
 assert.doesNotMatch(r.reply,/هل معاك موتوسيكل متاح للشغل يوميًا/);
 assert.match(r.followup_reply,/هل معاك موتوسيكل متاح للشغل يوميًا/);
});

test('Meta ad default opener starts application without knowledge handoff or consuming an answer',async()=>{
 const attribution={source_id:'1202552915330556',ctwa_clid:'first-touch',source_type:'ad'};
 const a={...applicant,answers:{__attribution:attribution}};
 const kb=[{
  id:'generic-info',
  question:'هل يمكنني الحصول على مزيد من المعلومات؟',
  answer:'رد Knowledge لا يجب استخدامه في بداية الإعلان.',
  keywords:['مزيد','المعلومات'],
  active:true
 }];
 const r=await planTurn({
  applicant:a,
  message:{body:'مرحباً! هل يمكنني الحصول على مزيد من المعلومات حول هذا؟'},
  questions,areas,settings,interpret:noAi,knowledge:kb
 });
 assert.equal(r.patch.awaiting_id,'q1');
 assert.equal(r.patch.stage,'new');
 assert.equal(r.patch.bot_enabled,undefined);
 assert.equal(r.patch.answers,undefined);
 assert.equal(r.handoff,undefined);
 assert.equal(r.knowledge_id,undefined);
 assert.match(r.reply,/Breadfast/);
 assert.doesNotMatch(r.reply,/هل معاك موتوسيكل متاح للشغل يوميًا|رد Knowledge/);
 assert.match(r.followup_reply,/هل معاك موتوسيكل متاح للشغل يوميًا/);
 assert.deepEqual(a.answers.__attribution,attribution);
 assert.equal(a.bot_enabled,true);
});

test('clear application openers start the flow even when Meta referral is missing',async()=>{
 const openers=[
  'هل يمكنني الحصول على مزيد من المعلومات؟',
  'عايز أقدم',
  'عاوز أقدم',
  'ممكن أقدم',
  'عايز أقدم على الوظيفة',
  'عايز تفاصيل',
  'ممكن تفاصيل',
  "I'm interested",
  'Can I get more information?'
 ];
 for(const body of openers){
  assert.equal(isApplicationStartMessage(body),true,body);
  const r=await call(applicant,body);
  assert.equal(r.patch.awaiting_id,'q1',body);
  assert.equal(r.handoff,undefined,body);
  assert.equal(r.knowledge_id,undefined,body);
  assert.match(r.reply,/Breadfast/,body);
  assert.doesNotMatch(r.reply,/هل معاك موتوسيكل متاح للشغل يوميًا/,body);
  assert.match(r.followup_reply,/هل معاك موتوسيكل متاح للشغل يوميًا/,body);
 }
});

test('dynamic agent extracts several facts from one Egyptian message and skips duplicate questions',async()=>{
 const a={...applicant,awaiting_id:'q1',answers:{}};
 const r=await call(a,'اه معايا موتوسيكل واسمي محمد احمد وعايز أكتوبر');
 assert.equal(r.patch.answers.q1.value,true);
 assert.equal(r.patch.answers.q2.value,'oct');
 assert.equal(r.patch.answers.q3.value,'محمد احمد');
 assert.equal(r.patch.answers.q1.agent_extracted,true);
 assert.equal(r.patch.awaiting_id,'q4');
 assert.match(r.reply,/سجلت|فهمت|أكتوبر/);
 assert.match(r.followup_reply,/الشيفت 9 ساعات/);
 assert.doesNotMatch(r.followup_reply,/اسمك بالكامل|أنهي منطقة/);
});

test('dynamic agent saves facts and answers a side question in the same turn',async()=>{
 const kb=[{id:'salary',question:'المرتب كام؟',answer:'المرتب الثابت 6200 جنيه.',keywords:['مرتب','6200'],active:true}];
 const a={...applicant,awaiting_id:'q1',answers:{}};
 const r=await planTurn({
  applicant:a,message:{body:'اه معايا مكنة وعايز أكتوبر بس المرتب كام؟'},
  questions,areas,settings,interpret:noAi,knowledge:kb
 });
 assert.equal(r.patch.answers.q1.value,true);
 assert.equal(r.patch.answers.q2.value,'oct');
 assert.equal(r.patch.awaiting_id,'q3');
 assert.equal(r.knowledge_id,'salary');
 assert.match(r.reply,/6200/);
 assert.match(r.followup_reply,/اسمك بالكامل/);
});

test('agent understands work-area aliases while extracting natural replies',async()=>{
 const a={...applicant,awaiting_id:'q2',answers:{q1:{value:true,kind:'yes_no',key:'has_motorcycle'}}};
 const r=await call(a,'عايز اشتغل 6 أكتوبر');
 assert.equal(r.patch.answers.q2.value,'oct');
 assert.equal(r.patch.awaiting_id,'q3');
 assert.match(r.reply,/أكتوبر/);
});

test('has_motorcycle=no saves answer and stops without recruiter rejection',async()=>{
 const attribution={source_id:'1202552915330556',ctwa_clid:'first-touch'};
 const a={...applicant,awaiting_id:'q1',answers:{__attribution:attribution}};
 const r=await call(a,'لا');
 assert.equal(r.patch.answers.q1.value,false);
 assert.equal(r.patch.answers.__qualification_stop.reason,'no_motorcycle');
 assert.equal(r.patch.answers.__application_flow_status.value,'stopped_not_qualified');
 assert.equal(r.patch.awaiting_id,null);
 assert.equal(r.patch.recruitment_stage,undefined);
 assert.equal(r.patch.answers.__attribution.source_id,attribution.source_id);
 assert.doesNotMatch(r.reply,/أنهي منطقة تقدر تشتغل|اسمك بالكامل/);
});

test('motorcycle=yes goes directly to preferred work area, not residence',async()=>{
 const a={...applicant,awaiting_id:'q1',answers:{}};
 const r=await call(a,'أيوه');
 assert.equal(r.patch.answers.q1.value,true);
 assert.equal(r.patch.awaiting_id,'q2');
 assert.match(r.reply,/أنهي منطقة تقدر تشتغل فيها يوميًا/);
 assert.doesNotMatch(r.reply,/ساكن فين/);
});

test('natural motorcycle answer does not trigger an unrelated knowledge reply',async()=>{
 const kb=[{
  id:'license-noise',
  question:'معاك رخصة موتوسيكل؟',
  answer:'مش معاك رخصة شخصية ولا رخصة موتوسيكل',
  keywords:['معاك','معايا','موتوسيكل'],
  active:true
 }];
 const a={...applicant,awaiting_id:'q1',answers:{}};
 const r=await planTurn({applicant:a,message:{body:'اه معايا'},questions,areas,settings,interpret:noAi,knowledge:kb});
 assert.equal(r.patch.answers.q1.value,true);
 assert.equal(r.patch.awaiting_id,'q2');
 assert.equal(r.knowledge_id,undefined);
 assert.match(r.reply,/أنهي منطقة تقدر تشتغل فيها يوميًا/);
 assert.doesNotMatch(r.reply,/رخصة شخصية|رخصة موتوسيكل/);
});

test('answer plus a real question still uses knowledge then resumes the flow',async()=>{
 const kb=[{
  id:'salary',
  question:'المرتب كام؟',
  answer:'المرتب الثابت 6200 جنيه، بالإضافة لنظام القبض الأسبوعي والحوافز حسب نظام التشغيل.',
  keywords:['مرتب','6200'],
  active:true
 }];
 const a={...applicant,awaiting_id:'q1',answers:{}};
 const r=await planTurn({applicant:a,message:{body:'ايوه بس المرتب كام؟'},questions,areas,settings,interpret:noAi,knowledge:kb});
 assert.equal(r.patch.answers.q1.value,true);
 assert.equal(r.patch.awaiting_id,'q2');
 assert.equal(r.knowledge_id,'salary');
 assert.match(r.reply,/6200/);
 assert.match(r.followup_reply,/أنهي منطقة تقدر تشتغل فيها يوميًا/);
});

test('eligible work area button is saved immediately and continues the flow',async()=>{
 const a={...applicant,stage:'incomplete',awaiting_id:'q2',answers:{
  q1:{value:true,display:'نعم',kind:'yes_no',key:'has_motorcycle'}
 }};
 const r=await call(a,'area_preview:tagamoa');
 assert.equal(r.patch.answers.q2.value,'tagamoa');
 assert.equal(r.patch.answers.q2.work_area_eligible,true);
 assert.equal(r.patch.answers.__area_preview,undefined);
 assert.equal(r.patch.awaiting_id,'q3');
 assert.match(r.reply,/سجلت منطقة العمل: التجمع/);
 assert.match(r.reply,/تفاصيل التجمع/);
 assert.doesNotMatch(r.reply,/اكتب اسمك بالكامل|تأكيد التجمع/);
 assert.match(r.followup_reply,/اكتب اسمك بالكامل/);
 const q=qualificationFor({...a,answers:r.patch.answers},questions,areas,settings);
 assert.equal(q.geo_qualified,true);
 assert.equal(q.geo_basis,'preferred_work_area');
 assert.equal(q.zone,'EAST');
});


test('legacy active work area cannot appear in bot and then fail qualification',async()=>{
 const legacyAreas=normalizeWorkAreas([
  ...areas.filter(x=>x.id!=='outside'),
  {id:'hadayek-market',name:'حدائق الأهرام ماركت',active:true,recruitment_eligible:false,zone:'WEST',details:'تفاصيل حدائق الأهرام ماركت'}
 ]);
 const a={...applicant,stage:'incomplete',awaiting_id:'q2',answers:{
  q1:{value:true,display:'نعم',kind:'yes_no',key:'has_motorcycle'}
 }};
 const r=await planTurn({applicant:a,message:{body:'area_preview:hadayek-market'},questions,areas:legacyAreas,settings,interpret:noAi,knowledge:[]});
 assert.equal(r.patch.answers.q2.value,'hadayek-market');
 assert.equal(r.patch.answers.q2.work_area_eligible,true);
 assert.equal(r.patch.awaiting_id,'q3');
 assert.equal(r.patch.answers.__qualification_stop,undefined);
 assert.match(r.reply,/سجلت منطقة العمل: حدائق الأهرام ماركت/);
 assert.match(r.reply,/تفاصيل حدائق الأهرام ماركت/);
 assert.doesNotMatch(r.reply,/اكتب اسمك بالكامل/);
 assert.match(r.followup_reply,/اكتب اسمك بالكامل/);
});

test('typing an eligible area name directly saves it without preview or confirmation',async()=>{
 const a={...applicant,stage:'incomplete',awaiting_id:'q2',answers:{
  q1:{value:true,display:'نعم',kind:'yes_no',key:'has_motorcycle'}
 }};
 const r=await call(a,'مدينة نصر');
 assert.equal(r.patch.answers.q2.value,'nasr');
 assert.equal(r.patch.awaiting_id,'q3');
 assert.match(r.reply,/سجلت منطقة العمل: مدينة نصر/);
 assert.match(r.reply,/تفاصيل مدينة نصر/);
 assert.doesNotMatch(r.reply,/اكتب اسمك بالكامل|تأكيد مدينة نصر/);
 assert.match(r.followup_reply,/اكتب اسمك بالكامل/);
});


test('agent can reopen work-area answer without changing qualification rules',async()=>{
 const a={...applicant,stage:'incomplete',awaiting_id:'q3',answers:{
  q1:{value:true,display:'نعم',kind:'yes_no',key:'has_motorcycle'},
  q2:{value:'oct',display:'أكتوبر',kind:'area',key:'preferred_work_area',work_area_eligible:true,work_area_zone:'WEST'}
 }};
 const r=await planTurn({applicant:a,message:{body:'عايز اغير المنطقة'},questions,areas,settings,interpret:noAi,knowledge:[]});
 assert.equal(r.handoff,undefined);
 assert.equal(r.agent_action,'change_answer');
 assert.equal(r.patch.awaiting_id,'q2');
 assert.equal(r.patch.answers.q2,undefined);
 assert.equal(r.patch.answers.q1.value,true);
 assert.match(r.reply,/أنهي منطقة تقدر تشتغل فيها يوميًا/);
});

test('agent can recover from no-work-area stop when applicant wants to choose again',async()=>{
 const stopped={...applicant,stage:'incomplete',awaiting_id:null,answers:{
  q1:{value:true,display:'نعم',kind:'yes_no',key:'has_motorcycle'},
  q2:{value:'__none__',display:'لا توجد منطقة مناسبة',kind:'area',key:'preferred_work_area',no_eligible_work_area:true,work_area_eligible:false},
  __qualification_stop:{reason:'no_eligible_work_area',at:new Date().toISOString()},
  __application_flow_status:{value:'stopped_not_qualified',reason:'no_eligible_work_area',kind:'flow_status'}
 }};
 const r=await planTurn({applicant:stopped,message:{body:'غيرت رأيي عايز اغير المنطقة'},questions,areas,settings,interpret:noAi,knowledge:[]});
 assert.equal(r.handoff,undefined);
 assert.equal(r.patch.awaiting_id,'q2');
 assert.equal(r.patch.answers.q2,undefined);
 assert.equal(r.patch.answers.__qualification_stop,undefined);
 assert.equal(r.patch.answers.__application_flow_status.value,'active');
 assert.match(r.reply,/أنهي منطقة تقدر تشتغل فيها يوميًا/);
});

test('explicit no available work area stops as not qualified',async()=>{
 const attribution={source_id:'ad-1'};
 const a={...applicant,stage:'incomplete',awaiting_id:'q2',answers:{
  q1:{value:true,display:'نعم',kind:'yes_no',key:'has_motorcycle'},
  __attribution:attribution
 }};
 const r=await call(a,'no_work_area');
 assert.equal(r.patch.answers.q2.no_eligible_work_area,true);
 assert.equal(r.patch.answers.__qualification_stop.reason,'no_eligible_work_area');
 assert.equal(r.patch.awaiting_id,null);
 assert.equal(r.patch.recruitment_stage,undefined);
 assert.equal(r.patch.answers.__attribution.source_id,'ad-1');
 assert.match(r.reply,/مفيش منطقة متاحة تقدر تلتزم بالشغل فيها يوميًا/);
});

test('selecting an ineligible work area stops qualification',async()=>{
 const a={...applicant,stage:'incomplete',awaiting_id:'q2',answers:{
  q1:{value:true,display:'نعم',kind:'yes_no',key:'has_motorcycle'},
  __area_preview:{value:'outside',display:'المنصورة',kind:'area_preview'}
 }};
 const r=await call(a,'confirm_area:outside');
 assert.equal(r.patch.answers.q2.value,'outside');
 assert.equal(r.patch.answers.__qualification_stop.reason,'no_eligible_work_area');
 const q=qualificationFor({...a,answers:r.patch.answers},questions,areas,settings);
 assert.equal(q.geo_qualified,false);
 assert.equal(q.qualified_candidate,false);
 assert.ok(q.reasons.includes('no_eligible_work_area'));
});

test('residence never affects work-area qualification',()=>{
 const withOutsideResidence={answers:{
  q1:{value:true,kind:'yes_no'},
  q2:{value:'tagamoa',display:'التجمع',kind:'area'},
  res:{value:'الشرقية',display:'الشرقية',kind:'text',geo_status:'outside',geo_confirmed_outside:true}
 }};
 const q=qualificationFor(withOutsideResidence,questions,areas,settings);
 assert.equal(q.residence_area,'الشرقية');
 assert.equal(q.preferred_work_area,'التجمع');
 assert.equal(q.geo_qualified,true);
 assert.equal(q.qualified_candidate,true);
 assert.deepEqual(q.reasons,[]);
});

test('qualified applicant reaches completion after work-area qualification',async()=>{
 const a={...applicant,stage:'incomplete',awaiting_id:'q5',answers:{
  q1:{value:true,display:'نعم',kind:'yes_no',key:'has_motorcycle'},
  q2:{value:'nasr',display:'مدينة نصر',kind:'area',key:'preferred_work_area',work_area_eligible:true},
  q3:{value:'محمد أحمد علي',display:'محمد أحمد علي',kind:'name',key:'full_name'},
  q4:{value:true,display:'نعم',kind:'yes_no',key:'shift_acceptance'}
 }};
 const r=await call(a,'نعم');
 assert.equal(r.patch.stage,'complete');
 assert.equal(r.patch.awaiting_id,null);
 assert.equal(r.patch.answers.__application_flow_status.value,'completed');
 assert.equal(r.reply,settings.completion);
 assert.doesNotMatch(r.reply,/تم قبولك|تم تعيينك/);
});

test('salary question during work-area step answers from knowledge then resumes it',async()=>{
 const kb=[{id:'salary',question:'المرتب كام؟',answer:'المرتب الثابت 6200 جنيه، بالإضافة لنظام القبض الأسبوعي والحوافز حسب نظام التشغيل.',keywords:['مرتب','6200'],active:true}];
 const a={...applicant,stage:'incomplete',awaiting_id:'q2',answers:{q1:{value:true,display:'نعم',kind:'yes_no',key:'has_motorcycle'}}};
 const r=await planTurn({applicant:a,message:{body:'المرتب كام؟'},questions,areas,settings,interpret:noAi,knowledge:kb});
 assert.equal(r.knowledge_id,'salary');
 assert.equal(r.patch.awaiting_id,'q2');
 assert.match(r.reply,/6200/);
 assert.match(r.followup_reply,/أنهي منطقة تقدر تشتغل فيها يوميًا/);
});

test('ready_to_start remains priority data only',()=>{
 const a={answers:{
  q1:{value:true,kind:'yes_no'},
  q2:{value:'oct',display:'أكتوبر',kind:'area'},
  q5:{value:false,kind:'yes_no'}
 }};
 const q=qualificationFor(a,questions,areas,settings);
 assert.equal(q.qualified_candidate,true);
 assert.deepEqual(q.reasons,[]);
});
