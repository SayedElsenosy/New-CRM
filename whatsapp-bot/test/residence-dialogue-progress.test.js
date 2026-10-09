import test from 'node:test';
import assert from 'node:assert/strict';
import {planTurn} from '../src/flow.js';
import {mansouriyaGuidance} from '../src/residence-guidance.js';

const questions=[{id:'q',field_key:'preferred_work_area',kind:'area',required:true,active:true,position:1,label:'أنهي منطقة تقدر تشتغل فيها؟'}];
const areas=[
 {id:'haram',name:'الهرم مطاعم',place_key:'الهرم',work_mode:'restaurants',active:true,recruitment_eligible:true,
  details:'القبض أسبوعي على الفيزا. متوسط الدخل الأسبوعي 4000 جنيه. شيفت 10 ساعات'},
 {id:'hadayek1',name:'حدائق الأهرام ماركت',place_key:'حدائق الاهرام',active:true,recruitment_eligible:true,details:'القبض أسبوعي'},
 {id:'hadayek2',name:'حدايق الاهرام مطاعم',place_key:'حدايق الاهرام',active:true,recruitment_eligible:true,details:'القبض أسبوعي'},
 {id:'zayed',name:'الشيخ زايد ماركت',place_key:'الشيخ زايد',active:true,recruitment_eligible:true,details:'القبض شهري'},
 {id:'unavailable',name:'غير متاح',place_key:'منطقة غير متاحة',active:true,recruitment_eligible:false}
];
const settings={ai_enabled:true,agent_crm_tools_enabled:true,agent_llm_mode:'live',agent_llm_enabled:true};
async function say(body,answers={}){
 return planTurn({applicant:{id:'fake',bot_enabled:true,awaiting_id:'q',stage:'incomplete',answers},
  message:{body},questions,areas,settings,knowledge:[],llmPlan:{action:'clarify',confidence:.99,facts:[]},interpret:async()=>null,
  mapsOptions:{geoapifyApiKey:'test',fetchImpl:()=>{throw Error('must not geocode ambiguous residence');}}});
}
test('Haram repeats from real WhatsApp screenshots move conversation forward, not same paragraph',async()=>{
 let t=await say('انا مش عارف والله ساكن في المنصورية');
 let answers=t.patch.answers;
 assert.equal(t.agent_action,'clarify_residence_location');
 t=await say('أنا مش عارف ايه اقرب حاجه ليا',answers);
 assert.equal(t.agent_action,'clarify_residence_location');
 answers=t.patch.answers;
 t=await say('اه',answers);
 assert.equal(t.agent_action,'residence_reference_options');
 const first=t.reply;
 assert.match(first,/الهرم كمرجع عام/);
 const nearLines=first.split('\n').filter(x=>x.startsWith('• '));
 assert.equal(nearLines.filter(x=>/حدائق|حدايق/.test(x)).length,1,'same area with two spellings must be deduped');
 answers=t.patch.answers;
 t=await say('الهرم',answers);
 assert.equal(t.agent_action,'residence_context_followup');
 assert.match(t.reply,/قلت «الهرم» بالفعل/);
 assert.match(t.reply,/الهرم مطاعم/);
 assert.match(t.reply,/شيفت|القبض/);
 assert.notEqual(t.reply,first);
 assert.doesNotMatch(t.reply,/مناطق شغل ممكن نبدأ نقارنها/);
 answers=t.patch.answers;
 const response=await say('ما انا قولتلك الهرم',answers);
 assert.equal(response.agent_action,'residence_context_followup');
 assert.notEqual(response.reply,t.reply);
 assert.doesNotMatch(response.reply,/مناطق شغل ممكن نبدأ نقارنها|كم بالطريق/);
 assert.equal(response.patch.answers.q,undefined,'residence is not the chosen work area');
 assert.equal(response.patch.awaiting_id,'q');
 answers=response.patch.answers;
 const final=await say('الهرم',answers);
 assert.equal(final.handoff,true,'further unresolved repetition should alert human rather than loop forever');
 assert.equal(final.handoff_reason,'repeated_residence_confusion');
 assert.equal(final.patch.bot_enabled,false);
});
test('distinct work area selection bypasses residence guidance',async()=>{
 const memory={__residence_clarification:{kind:'mansouriya_unverified',phase:'reference_offered'}};
 const g=mansouriyaGuidance({text:'عايز اشتغل في الهرم',previous:memory.__residence_clarification,areas});
 assert.equal(g,null);
 const job=mansouriyaGuidance({text:'تفاصيل شغل الهرم',previous:memory.__residence_clarification,areas});
 assert.equal(job,null);
});
test('same-area spellings, and ineligible areas, are filtered from suggestions',()=>{
 const g=mansouriyaGuidance({text:'المنصورية ناحية الهرم',areas});
 assert.equal(g.action,'residence_reference_options');
 assert.doesNotMatch(g.reply,/غير متاح/);
 const lines=g.reply.split('\n').filter(x=>x.startsWith('• '));
 assert.equal(lines.filter(x=>/حدائق|حدايق/.test(x)).length,1);
});
