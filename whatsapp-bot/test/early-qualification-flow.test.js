import test from 'node:test';
import assert from 'node:assert/strict';
import {planTurn} from '../src/flow.js';
import {qualificationFor} from '../src/qualification.js';

const questions=[
 {id:'q1',field_key:'has_motorcycle',kind:'yes_no',label:'هل معاك موتوسيكل متاح للشغل يوميًا؟',position:1,active:true,required:true},
 {id:'q2',field_key:'residence_area',kind:'text',label:'ساكن فين حاليًا؟ اكتب اسم المنطقة أو الحي بالتحديد.',position:2,active:true,required:true},
 {id:'q3',field_key:'preferred_work_area',kind:'area',label:'أنهي منطقة تفضل تشتغل فيها؟',position:3,active:true,required:true},
 {id:'q4',field_key:'full_name',kind:'name',label:'اكتب اسمك بالكامل.',position:4,active:true,required:true},
 {id:'q5',field_key:'shift_acceptance',kind:'yes_no',label:'الشيفت 9 ساعات. النظام ده مناسب ليك؟',position:5,active:true,required:true},
 {id:'q6',field_key:'ready_to_start',kind:'yes_no',label:'لو تم قبولك، تقدر تبدأ الشغل قريب؟',position:6,active:true,required:true}
];
const areas=[
 {id:'oct',name:'أكتوبر',aliases:['اكتوبر','6 أكتوبر','6 اكتوبر','السادس من أكتوبر'],active:true,recruitment_eligible:true,zone:'WEST',details:'تفاصيل أكتوبر'},
 {id:'nasr',name:'مدينة نصر',aliases:['مدينه نصر'],active:true,recruitment_eligible:true,zone:'NORTH_CENTRAL',details:'تفاصيل مدينة نصر'},
 {id:'tagamoa',name:'التجمع',aliases:['القاهرة الجديدة','التجمع الخامس'],active:true,recruitment_eligible:true,zone:'EAST',details:'تفاصيل التجمع'}
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

test('welcome starts with motorcycle qualification question',async()=>{
 const r=await call(applicant,'السلام عليكم');
 assert.equal(r.patch.awaiting_id,'q1');
 assert.match(r.reply,/Breadfast/);
 assert.match(r.reply,/هل معاك موتوسيكل متاح للشغل يوميًا/);
});

test('has_motorcycle=no saves answer and stops the application without recruiter rejection',async()=>{
 const attribution={source_id:'1202552915330556',ctwa_clid:'first-touch'};
 const a={...applicant,awaiting_id:'q1',answers:{__attribution:attribution}};
 const r=await call(a,'لا');
 assert.equal(r.patch.answers.q1.value,false);
 assert.equal(r.patch.answers.__qualification_stop.reason,'no_motorcycle');
 assert.equal(r.patch.answers.__application_flow_status.value,'stopped_not_qualified');
 assert.equal(r.patch.awaiting_id,null);
 assert.equal(r.patch.recruitment_stage,undefined);
 assert.equal(r.patch.answers.__attribution.source_id,attribution.source_id);
 assert.match(r.reply,/مش هنقدر نكمل التقديم/);
 assert.doesNotMatch(r.reply,/ساكن فين|اسمك بالكامل|منطقة تفضل/);
});

test('stopped applicant is not asked missing questions again',async()=>{
 const a={...applicant,stage:'incomplete',awaiting_id:null,answers:{
  q1:{value:false,display:'لا',kind:'yes_no',key:'has_motorcycle'},
  __qualification_stop:{reason:'no_motorcycle',at:new Date().toISOString()},
  __application_flow_status:{value:'stopped_not_qualified'}
 }};
 const r=await call(a,'تمام');
 assert.equal(r.patch.awaiting_id,null);
 assert.match(r.reply,/بتشترط وجود موتوسيكل/);
 assert.doesNotMatch(r.reply,/ساكن فين/);
});

test('eligible residence alias continues to preferred work area',async()=>{
 const a={...applicant,stage:'incomplete',awaiting_id:'q2',answers:{q1:{value:true,display:'نعم',kind:'yes_no',key:'has_motorcycle'}}};
 const r=await call(a,'انا ساكن في 6 اكتوبر');
 assert.equal(r.patch.answers.q2.geo_status,'qualified');
 assert.equal(r.patch.answers.q2.matched_area_id,'oct');
 assert.equal(r.patch.awaiting_id,'q3');
 assert.match(r.reply,/أنهي منطقة تفضل تشتغل فيها/);
});

test('first unknown residence asks clarification and remains geo pending',async()=>{
 const a={...applicant,stage:'incomplete',awaiting_id:'q2',answers:{q1:{value:true,display:'نعم',kind:'yes_no',key:'has_motorcycle'}}};
 const r=await call(a,'مكان قريب من الطريق');
 assert.equal(r.patch.answers.q2.geo_status,'unknown');
 assert.equal(r.patch.answers.__residence_clarification.attempts,1);
 assert.equal(r.patch.awaiting_id,'q2');
 const qualification=qualificationFor({...a,answers:r.patch.answers},questions,areas,settings);
 assert.equal(qualification.geo_qualified,null);
 assert.equal(qualification.geo_status,'unknown');
 assert.equal(qualification.overall_status,'pending');
 assert.match(r.reply,/مش قادر أحدد منطقة سكنك بدقة/);
});

test('second unmatched residence stops as outside hiring zones',async()=>{
 const firstAnswers={
  q1:{value:true,display:'نعم',kind:'yes_no',key:'has_motorcycle'},
  q2:{value:'مكان قريب من الطريق',display:'مكان قريب من الطريق',kind:'text',key:'residence_area',geo_status:'unknown'},
  __residence_clarification:{attempts:1,first_value:'مكان قريب من الطريق'}
 };
 const a={...applicant,stage:'incomplete',awaiting_id:'q2',answers:firstAnswers};
 const r=await call(a,'الشرقية');
 assert.equal(r.patch.answers.q2.geo_status,'outside');
 assert.equal(r.patch.answers.q2.geo_confirmed_outside,true);
 assert.equal(r.patch.answers.__qualification_stop.reason,'residence_outside_hiring_zones');
 assert.equal(r.patch.awaiting_id,null);
 assert.equal(r.patch.recruitment_stage,undefined);
 const qualification=qualificationFor({...a,answers:r.patch.answers},questions,areas,settings);
 assert.equal(qualification.geo_qualified,false);
 assert.equal(qualification.qualified_candidate,false);
 assert.ok(qualification.reasons.includes('residence_outside_hiring_zones'));
 assert.match(r.reply,/مش ضمن مناطق التعيين الحالية/);
});

test('preferred work area never overrides residence qualification',()=>{
 const a={answers:{
  q1:{value:true,display:'نعم',kind:'yes_no'},
  q2:{value:'الشرقية',display:'الشرقية',kind:'text',geo_status:'outside',geo_confirmed_outside:true},
  q3:{value:'tagamoa',display:'التجمع',kind:'area'}
 }};
 const q=qualificationFor(a,questions,areas,settings);
 assert.equal(q.geo_qualified,false);
 assert.equal(q.zone,'UNKNOWN');
 assert.equal(q.qualified_candidate,false);
});

test('qualified applicant reaches qualified-only completion message',async()=>{
 const a={...applicant,stage:'incomplete',awaiting_id:'q6',answers:{
  q1:{value:true,display:'نعم',kind:'yes_no',key:'has_motorcycle'},
  q2:{value:'مدينة نصر',display:'مدينة نصر',kind:'text',key:'residence_area',geo_status:'qualified',matched_area_id:'nasr'},
  q3:{value:'tagamoa',display:'التجمع',kind:'area',key:'preferred_work_area'},
  q4:{value:'محمد أحمد علي',display:'محمد أحمد علي',kind:'name',key:'full_name'},
  q5:{value:true,display:'نعم',kind:'yes_no',key:'shift_acceptance'}
 }};
 const r=await call(a,'نعم');
 assert.equal(r.patch.stage,'complete');
 assert.equal(r.patch.awaiting_id,null);
 assert.equal(r.patch.answers.__application_flow_status.value,'completed');
 assert.equal(r.reply,settings.completion);
 assert.doesNotMatch(r.reply,/تم قبولك|تم تعيينك/);
});

test('salary question during flow answers from knowledge then resumes pending question',async()=>{
 const kb=[{id:'salary',question:'المرتب كام؟',answer:'المرتب الثابت 6200 جنيه، بالإضافة لنظام القبض الأسبوعي والحوافز حسب نظام التشغيل.',keywords:['مرتب','6200'],active:true}];
 const a={...applicant,stage:'incomplete',awaiting_id:'q2',answers:{q1:{value:true,display:'نعم',kind:'yes_no',key:'has_motorcycle'}}};
 const r=await planTurn({applicant:a,message:{body:'المرتب كام؟'},questions,areas,settings,interpret:noAi,knowledge:kb});
 assert.equal(r.knowledge_id,'salary');
 assert.equal(r.patch.awaiting_id,'q2');
 assert.match(r.reply,/6200/);
 assert.equal(r.followup_reply,questions[1].label);
});

test('ready_to_start is priority data only and never blocks qualification',()=>{
 const a={answers:{
  q1:{value:true,kind:'yes_no'},
  q2:{value:'أكتوبر',display:'أكتوبر',kind:'text',geo_status:'qualified',matched_area_id:'oct'},
  q6:{value:false,kind:'yes_no'}
 }};
 const q=qualificationFor(a,questions,areas,settings);
 assert.equal(q.qualified_candidate,true);
 assert.deepEqual(q.reasons,[]);
});
