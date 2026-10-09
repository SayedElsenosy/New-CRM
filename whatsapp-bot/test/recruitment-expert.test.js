import test from 'node:test';
import assert from 'node:assert/strict';
import {EXPERT_TOPICS,EXPERT_TRAINING_EXAMPLES,expertBrainSummary,matchExpertTopic,expertResponse} from '../src/recruitment-expert.js';
import {planTurn} from '../src/flow.js';

const officeAreas=[
 {id:'market-obour',name:'العبور ماركت',place_key:'العبور',work_mode:'market',zone:'EAST',active:true,recruitment_eligible:true,
  details:'راتب الماركت بالعبور: 5500 جنيه من بيانات المكتب'},
 {id:'restaurants-obour',name:'العبور مطاعم',place_key:'العبور',work_mode:'restaurants',zone:'EAST',active:true,recruitment_eligible:true,
  details:'مرتب المطاعم بالعبور: حسب عدد الأوردرات في سجل المكتب'}
];
const questions=[
 {id:'area',field_key:'preferred_work_area',label:'أنهي منطقة تقدر تشتغل فيها يوميًا؟',kind:'area',required:true,active:true,position:1,confirmation_required:true},
 {id:'bike',field_key:'has_motorcycle',label:'معاك موتوسيكل؟',kind:'yes_no',required:true,active:true,position:2},
 {id:'docs',field_key:'documents',label:'ابعت صورة البطاقة وصورة رخصة الموتوسيكل',kind:'image',required:true,active:true,position:3}
];
const candidate=(extra={})=>({id:'fake-candidate',stage:'incomplete',bot_enabled:true,awaiting_id:'area',answers:{},...extra});
const settings={ai_enabled:true,ai_knowledge_enabled:true,agent_expert_enabled:true,
 ai_confidence_threshold:.65,agent_llm_enabled:false,welcome:'أهلاً بيك',completion:'تم استلام البيانات'};
async function turn(body,extra={},opts={}){
 return planTurn({applicant:candidate(extra),message:{body},questions,areas:officeAreas,
  settings,interpret:async()=>null,knowledge:[],mapsOptions:{env:{}},...opts});
}
test('Expert Brain trains on 435 synthetic questions from 29 curated recruitment domains',()=>{
 const report=expertBrainSummary();
 assert.equal(EXPERT_TOPICS.length,29);
 assert.equal(EXPERT_TRAINING_EXAMPLES.length,435);
 assert.equal(report.synthetic_examples,435);
 assert.equal(report.verified_office_facts,0);
 assert.equal(new Set(EXPERT_TOPICS.map(x=>x.id)).size,29);
 assert.equal(new Set(EXPERT_TRAINING_EXAMPLES.map(x=>x.input.trim().toLowerCase())).size,435);
 assert.ok(EXPERT_TRAINING_EXAMPLES.every(x=>x.origin==='synthetic_curated'&&x.office_facts_allowed===false));
});

test('all 435 phrasings recover the correct expert domain with no model and no private data',()=>{
 const errors=[];
 for(const x of EXPERT_TRAINING_EXAMPLES){
  const matched=matchExpertTopic(x.input);
  if(matched?.topic?.id!==x.intent)errors.push({text:x.input,expected:x.intent,actual:matched?.topic?.id||null});
 }
 assert.deepEqual(errors,[]);
});

test('office knowledge beats general expert advice on pay and insurance',()=>{
 const local=[{id:'official-insurance',question:'هل في تأمين طبي؟',answer:'المنطقة الفعلية توفر تغطية س حسب سياسة المكتب المسجلة',
  active:true,source:'manual',memory_status:'verified',confidence:.99,knowledge_scope:'office'}];
 const answer=expertResponse('هل في تأمين طبي؟',{knowledge:local,knowledgeEnabled:true,minConfidence:.62});
 assert.equal(answer.origin,'office_verified');
 assert.equal(answer.knowledge_id,'official-insurance');
 assert.equal(answer.reply,local[0].answer);
 const fallback=expertResponse('هل في تأمين طبي؟',{knowledge:local,knowledgeEnabled:false});
 assert.equal(fallback.origin,'general_guidance');
 assert.match(fallback.reply,/التفاصيل الرسمية/);
});

test('general guidance never invents employer pay, insurance, deposit, or area availability',()=>{
 for(const question of ['المرتب بيتحسب ازاي؟','القبض كل كام يوم؟','هل في تأمين طبي؟',
  'مطلوب مني أدفع فلوس قبل الشغل؟','مطلوب رخصة قيادة ولا تسيير؟','الشيفت كام ساعة؟']){
  const result=expertResponse(question);
  assert.ok(result,'not matched: '+question);
  assert.equal(result.origin,'general_guidance');
  assert.doesNotMatch(result.reply,/\d{3,}|مضمون 100%|متأكد إنك اتقبلت/);
 }
});

test('protects against non-question commands, WhatsApp applicant PII, and unrelated greetings',()=>{
 for(const message of ['تمام','ايوه','لا','معايا مكنة','اسمي محمد علي','ازيك يا باشا','01 01234567890']){
  assert.equal(matchExpertTopic(message),null,message);
 }
});

test('pending mandatory work area is not answered/qualified by an expert FAQ',async()=>{
 const result=await turn('ممكن أعرف هل في تأمين طبي؟');
 assert.equal(result.agent_action,'expert_general_guidance');
 assert.equal(result.patch.awaiting_id,'area');
 assert.equal(result.patch.answers?.area,undefined);
 assert.equal(result.patch.answers?.__qualification_stop,undefined);
 assert.match(result.reply,/التأمين/);
 assert.equal(result.followup_reply,null);
 assert.equal(result.expert_intent,'insurance');
 assert.equal(result.expert_source,'general_guidance');
 assert.equal(result.expert_grounded,true);
});

test('missing-document handoff takes precedence over expert document advice',async()=>{
 const result=await turn('مش معايا البطاقة',{awaiting_id:'docs'});
 assert.equal(result.handoff,true);
 assert.equal(result.handoff_reason,'documents_unavailable');
 assert.notEqual(result.agent_action,'expert_general_guidance');
});

test('existing area advisor always returns the exact recorded operating details',async()=>{
 const result=await turn('ممكن تفاصيل ماركت العبور؟');
 assert.match(result.reply,/راتب الماركت بالعبور: 5500 جنيه من بيانات المكتب/);
 assert.notEqual(result.agent_action,'expert_general_guidance');
});

test('disabled Expert Brain preserves old deterministic flow',async()=>{
 const result=await turn('هل في تأمين طبي؟',{},{
  settings:{...settings,agent_expert_enabled:false},
 });
 assert.notEqual(result.agent_action,'expert_general_guidance');
 assert.notEqual(result.agent_action,'expert_office_answer');
});

test('the Expert Brain never overrides explicit work-area confirmation',async()=>{
 const first=await turn('area_preview:market-obour');
 assert.equal(first.patch.answers?.area,undefined);
 const next=await turn('confirm_area:market-obour',{
  awaiting_id:'area',answers:first.patch.answers
 });
 assert.equal(next.patch.answers?.area?.value,'market-obour');
 assert.notEqual(next.agent_action,'expert_general_guidance');
});

test('real question with pending motorcycle answer remains a side question',async()=>{
 const result=await turn('هل فيه عقد رسمي قبل الشغل؟',{awaiting_id:'bike'});
 assert.equal(result.agent_action,'expert_general_guidance');
 assert.equal(result.patch.awaiting_id,'bike');
 assert.equal(result.patch.answers?.bike,undefined);
 assert.match(result.reply,/العقد|التعاقد/);
});


test('unseen Egyptian wording generalizes to known expert domains without memorized exact prompts',()=>{
 const novel=[
  ['هو المرتب ثابت ولا بيختلف حسب الشغل؟','salary_structure'],
  ['ممكن أعرف هل الشركة بتدي بدل بنزين؟','fuel_expenses'],
  ['هو التأمين الصحي بيغطي إصابات الشغل؟','insurance'],
  ['هل لازم يكون معايا رخصة قيادة للدليفري؟','driving_license'],
  ['ايه أخبار البونص والخصومات؟','bonuses'],
  ['هو لازم نمضي عقد؟','contract'],
  ['لو عايز أزود ساعاتي، فيه أوفر تايم؟','overtime'],
  ['لو فيه نصب في إعلان الوظيفة أعمل ايه؟','recruitment_scams'],
  ['الموتوسيكل لازم يكون باسمي؟','bike_requirement'],
  ['الشنطة والتجهيزات بتيجي منين؟','equipment']
 ];
 for(const [message,expected] of novel){
  assert.equal(matchExpertTopic(message)?.topic.id,expected,message);
 }
});
