import test from 'node:test';
import assert from 'node:assert/strict';
import {planTurn} from '../src/flow.js';
import {initialApplicantQuestion,contextualShiftQuestion} from '../src/job-side-questions.js';

const details='🔥 العبور ماركت\nيشترط وجود متوسيكل ✅\nيشترط السن لا يقل عن 18 سنه\n⏰ الشفت\n9 ساعات فقط\n🎁 المميزات\n✅ تأمين اجتماعي من اول ما بتسلم ورقك\n✅ تأمين طبي شامل\n✅ بونص كل 3 شهور';
const areas=[
 {id:'obour-m',name:'العبور ماركت',place_key:'العبور',work_mode:'market',active:true,recruitment_eligible:true,details},
 {id:'nasr-m',name:'مدينه نصر ماركت',place_key:'نصر',work_mode:'market',active:true,recruitment_eligible:true,
  details:'⏰ الشفت\n9 ساعات فقط\nيشترط وجود متوسيكل\n✅ تأمين اجتماعي'},
 {id:'nasr-r',name:'مدينة نصر مطاعم',place_key:'نصر',work_mode:'restaurants',active:true,recruitment_eligible:true,
  details:'سعر الأوردر 40 جنيه. القبض أسبوعي'}
];
const questions=[
 {id:'area',field_key:'preferred_work_area',kind:'area',label:'أنهي منطقة تقدر تشتغل فيها يوميًا؟',position:1,required:true,active:true,confirmation_required:true},
 {id:'full_name',field_key:'full_name',kind:'name',label:'اكتب اسمك بالكامل.',position:4,active:true,required:true}
];
const base={id:'candidate',stage:'new',bot_enabled:true,awaiting_id:'area',answers:{
 __area_preview:{value:'obour-m',display:'العبور ماركت',kind:'area_preview',at:new Date().toISOString()},
 __area_context:{kind:'area_context',place_key:'العبور',at:new Date().toISOString()}
}};
const settings={ai_enabled:true,agent_crm_tools_enabled:false,agent_expert_enabled:false,
 ai_knowledge_enabled:false,welcome:'أهلاً بك في التقديم'};
const run=(a,text)=>planTurn({
 applicant:a,message:{body:text},questions,areas,settings,interpret:async()=>null
});
test('initial ad-led applicant asking vehicle and benefits gets substantive answer instead of canned welcome',async()=>{
 const a={...base,awaiting_id:null,answers:{__attribution:{source_type:'ad',source_id:'ad-verified',ctwa_clid:'click'}},stage:'new'};
 const turn=await run(a,'ايه المميزات لازم يكون في عربيه او موتوسيكل');
 assert.equal(turn.agent_action,'initial_job_requirements');
 assert.match(turn.reply,/العبور ماركت/);
 assert.match(turn.reply,/موتوسيكل/);
 assert.match(turn.reply,/تأمين/);
 assert.doesNotMatch(turn.reply,/أهلاً بك في التقديم/);
 assert.equal(turn.patch.awaiting_id,'area');
 assert.equal(turn.patch.answers,undefined);
});
test('live screenshot: after previewing Obour, ask about fixed schedules',async()=>{
 const turn=await run(base,'في مواعيد عمل محدده');
 assert.equal(turn.agent_action,'answer_contextual_shift');
 assert.match(turn.reply,/العبور ماركت/);
 assert.match(turn.reply,/9 ساعات/);
 assert.match(turn.reply,/البداية والنهاية مش مؤكدة/);
 assert.doesNotMatch(turn.reply,/تقصد أنهي منطقة|حابب تنزل شغل في أنهي منطقة/);
 assert.equal(turn.patch.awaiting_id,'area');
 assert.equal(turn.patch.answers,undefined);
});
test('short followup shiftaat masalan inherits last area without changing qualification',async()=>{
 const turn=await run(base,'شفتات مثلا');
 assert.equal(turn.agent_action,'answer_contextual_shift');
 assert.match(turn.reply,/9 ساعات/);
 assert.doesNotMatch(turn.reply,/مواعيد البداية 9 صباحا|من 9 ل6/);
 assert.equal(turn.patch.answers,undefined);
});
test('a recent new preview takes precedence over an older job details context',()=>{
 const now=new Date().toISOString(),yesterday=new Date(Date.now()-20*60_000).toISOString();
 const t=contextualShiftQuestion({text:'الشفت كام ساعة؟',
  areas,answers:{
   __last_area_details:{area_id:'nasr-r',at:yesterday},
   __area_preview:{value:'obour-m',at:now}
  }});
 assert.match(t.reply,/العبور ماركت/);
 assert.match(t.reply,/9 ساعات/);
});
test('for multiple systems with no specific preview, ask which mode once, not a generic area question',()=>{
 const t=contextualShiftQuestion({text:'شفتات مثلا',areas,answers:{
  __area_context:{place_key:'نصر'}
 }});
 assert.equal(t.action,'clarify_context_shift_mode');
 assert.match(t.reply,/ماركت ولا المطاعم/);
 assert.doesNotMatch(t.reply,/أنهي منطقة تقدر تشتغل فيها/);
});
test('unknown schedule clock is not invented from shift hours',()=>{
 const t=contextualShiftQuestion({text:'الشغل من كام لكام؟',areas,answers:{
  __area_preview:{value:'obour-m',at:new Date().toISOString()}
 }});
 assert.match(t.reply,/9 ساعات/);
 assert.match(t.reply,/مش مؤكدة/);
 assert.doesNotMatch(t.reply,/الساعة (8|9|10)/);
});
test('normal application greeting still starts onboarding without side question',async()=>{
 const a={...base,awaiting_id:null,answers:{__attribution:{source_type:'ad',source_id:'real'}}};
 const t=await run(a,'هل يمكنني الحصول على مزيد من المعلومات حول هذا؟');
 assert.match(t.reply,/أهلاً بك في التقديم/);
 assert.equal(t.patch.awaiting_id,'area');
});
