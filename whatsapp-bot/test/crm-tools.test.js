import test from 'node:test';
import assert from 'node:assert/strict';
import {CRM_TOOL_NAMES,planCrmToolCalls,runCrmTools} from '../src/crm-tools.js';
import {planTurn} from '../src/flow.js';

const areas=[
 {id:'obm',name:'العبور ماركت',place_key:'العبور',work_mode:'market',active:true,recruitment_eligible:true,
  details:'مرتب ماركت العبور: ۵۲٢٥ جنيه\nشيفت 9 ساعات\nتأمين طبي'},
 {id:'obr',name:'العبور مطاعم',place_key:'العبور',work_mode:'restaurants',active:true,recruitment_eligible:true,
  details:'أجر أوردر مطاعم العبور: 42 جنيه\nالقبض أسبوعي'},
 {id:'zym',name:'الشيخ زايد ماركت',place_key:'الشيخ زايد',work_mode:'market',active:true,recruitment_eligible:true,details:'ماركت زايد: 7000 جنيه'},
 {id:'bad',name:'منطقة غير متاحة',place_key:'منطقة غير متاحة',work_mode:'market',active:false,recruitment_eligible:false,details:'المرتب 99999'}
];
const questions=[
 {id:'qArea',field_key:'preferred_work_area',kind:'area',position:1,active:true,required:true,confirmation_required:true,
 label:'أنهي منطقة تقدر تشتغل فيها يوميًا؟'},
 {id:'qBike',field_key:'has_motorcycle',kind:'yes_no',position:2,active:true,required:true,label:'معاك موتوسيكل؟'},
 {id:'qName',field_key:'full_name',kind:'name',position:3,active:true,required:true,label:'اكتب اسمك بالكامل.'}
];
const applicant={id:'candidate-1',stage:'incomplete',bot_enabled:true,awaiting_id:'qArea',
 answers:{__recommendation_profile:{primary:'income',priorities:{}}}};
const settings={ai_enabled:true,ai_knowledge_enabled:true,ai_confidence_threshold:.6};
const tool=(text,extra={})=>runCrmTools({text,applicant,answers:applicant.answers,questions,areas,settings,...extra});

test('tool plan is strictly limited to read-only registry and true compound turns',()=>{
 assert.deepEqual(CRM_TOOL_NAMES,[
  'read_candidate_progress','read_area_details','compare_registered_areas',
  'find_nearest_work_areas','search_verified_knowledge'
 ]);
 assert.deepEqual(planCrmToolCalls('قارنلي الماركت والمطاعم وقولي الأقرب ليا'),[
  'find_nearest_work_areas','compare_registered_areas'
 ]);
 assert.deepEqual(planCrmToolCalls('عايز تفاصيل ماركت العبور'),[]);
 assert.deepEqual(planCrmToolCalls('حالة طلبي وناقصني إيه؟'),['read_candidate_progress']);
 for(const t of ['confirm_area:obm','area_preview:obm','choice:qBike:0','no_work_area','']){
  assert.deepEqual(planCrmToolCalls(t),[],t);
 }
 assert.ok(!CRM_TOOL_NAMES.includes('update_qualification'));
 assert.ok(!CRM_TOOL_NAMES.includes('send_whatsapp_message'));
});

test('real CRM tools combine Geoapify-ready nearest suggestions with official mode comparison',async()=>{
 const r=await tool('أنا ساكن في عين شمس، قارن الماركت والمطاعم وقولي الأقرب للشغل',{mapsOptions:{env:{}}});
 assert.equal(r.agent_action,'crm_tools_multi_step');
 assert.equal(r.tools.length,2);
 assert.deepEqual(r.tools.map(x=>x.tool),['find_nearest_work_areas','compare_registered_areas']);
 assert.match(r.reply,/الماركت/);
 assert.match(r.reply,/المطاعم/);
 assert.match(r.reply,/عين شمس/);
 assert.doesNotMatch(r.reply,/99999|منطقة غير متاحة/);
 assert.ok(r.context.recommendations?.values?.length>=1);
 assert.ok(!r.context.recommendations.values.includes('bad'));
 assert.equal(r.context.recommendations.kind,'area_recommendations');
});

test('unknown home area produces clarification, never invented distance or route time',async()=>{
 const r=await tool('قارن الماركت والمطاعم وقولي الأقرب ليا',{mapsOptions:{env:{}}});
 assert.match(r.reply,/ساكن في أنهي منطقة/);
 assert.doesNotMatch(r.reply,/دقيقة بالطريق|كيلومتر بالطريق/);
 assert.equal(r.tools[0].ok,false);
});

test('read area details returns official text verbatim when combined with progress',async()=>{
 const r=await tool('عايز تفاصيل ماركت العبور وكمان ناقصني إيه في التقديم؟');
 assert.deepEqual(r.tools.map(x=>x.tool),['read_candidate_progress','read_area_details']);
 assert.ok(r.reply.includes('📍 العبور ماركت\n'+areas[0].details));
 assert.match(r.reply,/اكتمال الأسئلة المطلوبة: 0 من 3/);
 assert.ok(!r.reply.includes('99999'));
 assert.equal(r.context.place_key,'العبور');
});

test('ambiguous family needs operating mode, never picks arbitrary salary',async()=>{
 const r=await tool('تفاصيل شغل العبور وناقصني ايه؟');
 assert.equal(r.tools[1].tool,'read_area_details');
 assert.equal(r.tools[1].ok,false);
 assert.match(r.reply,/الماركت ولا المطاعم/);
 assert.doesNotMatch(r.reply,/۵۲٢٥|42 جنيه/);
});

test('status tool never turns answered or incomplete applicant into hired / approved',async()=>{
 const r=await tool('حالة طلبي وصلت لفين؟');
 assert.equal(r.tools[0].tool,'read_candidate_progress');
 assert.match(r.reply,/لسه في أسئلة مطلوبة/);
 assert.match(r.reply,/أنهي منطقة تقدر تشتغل/);
 assert.doesNotMatch(r.reply,/تم القبول|اتقبلت|تم التعيين/);
});

test('local office isolation: cross-office areas and stale knowledge never leak',async()=>{
 const r=await tool('حالة التقديم وتفاصيل ماركت المنطقة غير متاحة');
 assert.doesNotMatch(r.reply,/99999/);
 const k=await tool('المرتب كام وناقصني إيه؟',{knowledge:[{
  id:'k1',question:'المرتب كام؟',answer:'مرتّب 100000 وهمي',
  active:true,memory_status:'stale'
 }]});
 assert.doesNotMatch(k.reply,/100000/);
});

test('disabled AI or missing intent never executes tool calls',async()=>{
 assert.equal(await tool('حالة طلبي',{settings:{...settings,ai_enabled:false}}),null);
 assert.equal(await tool('أهلاً إزيك؟'),null);
});

test('full WhatsApp flow invokes two CRM tools without advancing qualification',async()=>{
 const r=await planTurn({
  applicant,message:{body:'انا ساكن في عين شمس، قارن الماركت والمطاعم وقولي الأقرب للشغل'},
  questions,areas,settings,interpret:async()=>null,knowledge:[],mapsOptions:{env:{}}
 });
 assert.equal(r.agent_action,'crm_tools_multi_step');
 assert.equal(r.patch.awaiting_id,'qArea');
 assert.equal(r.patch.answers.qArea,undefined);
 assert.equal(r.patch.answers.__qualification_stop,undefined);
 assert.ok(r.patch.answers.__area_recommendations);
 assert.equal(r.tools_grounded,true);
 assert.equal(r.tool_calls.length,2);
 assert.match(r.reply,/نكمل التقديم/);
});

test('full flow retains pending applicant question after status plus registered details',async()=>{
 const r=await planTurn({
  applicant,message:{body:'ممكن تفاصيل ماركت العبور وناقصني ايه في التقديم؟'},
  questions,areas,settings,interpret:async()=>null,knowledge:[]
 });
 assert.equal(r.agent_action,'crm_tools_multi_step');
 assert.equal(r.patch.awaiting_id,'qArea');
 assert.equal(r.patch.answers.qArea,undefined);
 assert.match(r.reply,/مرتب ماركت العبور/);
 assert.match(r.reply,/اكتمال الأسئلة/);
 assert.equal(r.reply.match(/نكمل التقديم:/g),null);
});

test('disabled feature flag uses old deterministic advisor, no CRM tool side effects',async()=>{
 const r=await planTurn({
  applicant,message:{body:'قارن الماركت والمطاعم وقولي الأقرب للشغل'},
  questions,areas,settings:{...settings,agent_crm_tools_enabled:false},interpret:async()=>null,knowledge:[]
 });
 assert.notEqual(r.agent_action,'crm_tools_multi_step');
 assert.equal(r.tool_calls,undefined);
});
