import test from 'node:test';
import assert from 'node:assert/strict';
import {planTurn} from '../src/flow.js';
import {mansouriyaGuidance} from '../src/residence-guidance.js';

const questions=[{id:'q-area',field_key:'preferred_work_area',kind:'area',label:'أنهي منطقة تقدر تشتغل فيها؟',required:true,active:true,position:1}];
const areas=[
 {id:'zayed-m',name:'الشيخ زايد ماركت',place_key:'الشيخ زايد',work_mode:'market',active:true,recruitment_eligible:true,details:'القبض أسبوعي أو شهري'},
 {id:'zayed-r',name:'الشيخ زايد مطاعم',place_key:'الشيخ زايد',work_mode:'restaurants',active:true,recruitment_eligible:true,details:'القبض أسبوعي'},
 {id:'october',name:'أكتوبر ماركت',place_key:'أكتوبر',active:true,recruitment_eligible:true},
 {id:'unavailable',name:'منطقة مغلقة',place_key:'بعيد',active:true,recruitment_eligible:false}
];
const settings={ai_enabled:true,ai_knowledge_enabled:false,agent_crm_tools_enabled:true};
const interpret=async()=>null;
async function turn(body,answers={},llmPlan=null){
 return planTurn({applicant:{id:'synthetic',answers,bot_enabled:true,stage:'incomplete',awaiting_id:'q-area'},
  message:{body},questions,areas,settings,interpret,llmPlan,
  mapsOptions:{geoapifyApiKey:'dummy',fetchImpl:()=>{throw Error('Mansouriya must not be geocoded');}}});
}
test('full screenshot conversation stays on closest-job help rather than fallback or mandatory area',async()=>{
 let t=await turn('مش عارف والله أنا ساكن في المنصورية');
 assert.equal(t.agent_action,'clarify_residence_location');
 assert.match(t.reply,/المنصورية مش المنصورة/);
 assert.match(t.reply,/الهرم/);
 assert.equal(t.patch.answers['q-area'],undefined);
 let memory=t.patch.answers;
 t=await turn('لا مش فاهم قصدك ايه',memory,{action:'ask_next',confidence:.98,facts:[]});
 assert.equal(t.agent_action,'clarify_residence_location');
 assert.match(t.reply,/مش بطلب منك تختار منطقة العمل/);
 assert.match(t.reply,/أيوه.*لا.*مش عارف/);
 assert.doesNotMatch(t.reply,/قصدي منطقة الشغل اللي تقدر/);
 memory=t.patch.answers;
 t=await turn('انا مش عارف ايه اقرب حاجة ليا',memory);
 assert.equal(t.agent_action,'clarify_residence_location');
 assert.match(t.reply,/أقرب مكان شغل/);
 assert.doesNotMatch(t.reply,/مش عندي إجابة مؤكدة|غير مؤكدة|قولّي اسم المنطقة/);
 memory=t.patch.answers;
 t=await turn('مش عارف',memory);
 assert.equal(t.agent_action,'residence_options_without_distance');
 assert.match(t.reply,/مش مترتبة حسب القرب/);
 assert.match(t.reply,/الشيخ زايد/);
 assert.doesNotMatch(t.reply,/منطقة مغلقة|كم بالطريق|113\.7|127\.8/);
 assert.equal(t.patch.answers['q-area'],undefined);
 assert.equal(t.patch.awaiting_id,'q-area');
 assert.equal(t.patch.answers.__area_recommendations,undefined);
});
test('explicit haram locality gets reference options without claiming exact home distance',async()=>{
 const prior={__residence_clarification:{kind:'mansouriya_unverified',phase:'ask_region'}};
 const response=await turn('أيوه',prior);
 assert.equal(response.agent_action,'residence_reference_options');
 assert.match(response.reply,/الهرم كمرجع عام/);
 assert.match(response.reply,/مش مسافات لعنوانك ولا اختيار مؤكد للعمل/);
 assert.equal(response.patch.answers['q-area'],undefined);
 const explicit=mansouriyaGuidance({text:'أنا في المنصورية ناحية الهرم',areas});
 assert.equal(explicit.action,'residence_reference_options');
});
test('topic changes like pay timing are not swallowed by residence clarification',async()=>{
 const answers={__residence_clarification:{kind:'mansouriya_unverified'},__area_context:{place_key:'الشيخ زايد'}};
 const t=await turn('القبض بيكون امتى',answers);
 assert.equal(t.agent_action,'payment_schedule_info');
 assert.match(t.reply,/أسبوعي/);
});
test('a wrong locality is not silently accepted as Haram',()=>{
 const prior={kind:'mansouriya_unverified'};
 const t=mansouriyaGuidance({text:'لا مش الهرم',previous:prior,areas});
 assert.equal(t.action,'clarify_residence_location');
 assert.doesNotMatch(t.reply,/هستخدم الهرم كمرجع/);
});
