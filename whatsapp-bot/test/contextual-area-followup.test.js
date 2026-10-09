import test from 'node:test';
import assert from 'node:assert/strict';
import {planTurn} from '../src/flow.js';
import {contextualAreaFollowup} from '../src/contextual-area-followup.js';

const question={id:'q-area',field_key:'preferred_work_area',kind:'area',label:'أنهي منطقة تقدر تشتغل فيها؟',active:true,required:true,position:1};
const areas=[
 {id:'haram',name:'الهرم مطاعم',place_key:'الهرم',work_mode:'restaurants',active:true,recruitment_eligible:true,
  details:'شغل الهرم مطاعم. شيفت 10 ساعات. سعر الأوردر 38 جنيه. قبض أسبوعي على الفيزا.'},
 {id:'zayed-m',name:'الشيخ زايد ماركت',place_key:'الشيخ زايد',work_mode:'market',active:true,recruitment_eligible:true,
  details:'ماركت الشيخ زايد: القبض أسبوعي أو شهري'},
 {id:'zayed-r',name:'الشيخ زايد مطاعم',place_key:'الشيخ زايد',work_mode:'restaurants',active:true,recruitment_eligible:true,
  details:'مطاعم الشيخ زايد: قبض أسبوعي'},
 {id:'closed',name:'مكان غير متاح',place_key:'مغلق',active:true,recruitment_eligible:false}
];
const settings={ai_enabled:true,ai_knowledge_enabled:false,agent_crm_tools_enabled:true,
 agent_llm_enabled:true,agent_llm_mode:'live'};
const app=(answers={})=>({id:'test',bot_enabled:true,awaiting_id:'q-area',stage:'incomplete',answers});
async function turn(body,answers={}){
 return planTurn({applicant:app(answers),message:{body},areas,questions:[question],settings,interpret:async()=>null,
  knowledge:[],llmPlan:{action:'clarify',confidence:.99,facts:[]},
  mapsOptions:{geoapifyApiKey:'dummy',fetchImpl:()=>{throw Error('Do not geocode during followups')}}});
}

test('Screenshot reproduction: "التفاصيل" after Haram reference returns exact area details',async()=>{
 const memory={__residence_clarification:{kind:'mansouriya_unverified',phase:'work_detail_offered',reference_place:'haram'}};
 const reply=await turn('التفاصيل',memory);
 assert.equal(reply.agent_action,'contextual_area_details');
 assert.match(reply.reply,/شغل الهرم مطاعم/);
 assert.match(reply.reply,/38 جنيه/);
 assert.doesNotMatch(reply.reply,/مش قادر أحدد|مش عندي إجابة|اكتب كمل علشان/);
 assert.equal(reply.patch.answers['q-area'],undefined);
 assert.equal(reply.patch.awaiting_id,'q-area');
 assert.equal(reply.patch.answers.__last_area_details.area_id,'haram');
 const repeated=await turn('التفاصيل',reply.patch.answers);
 assert.equal(repeated.agent_action,'clarify_context_details');
 assert.doesNotMatch(repeated.reply,/شغل الهرم مطاعم\. شيفت 10 ساعات/);
});

test('User asks full Haram details and then says "كمل": do not restart with ungrounded work-area prompt',async()=>{
 const memory={__residence_clarification:{kind:'mansouriya_unverified',phase:'work_detail_offered',reference_place:'haram'}};
 const full=await turn('عايز تفاصيل الهرم',memory);
 assert.match(full.reply,/الهرم/);
 assert.equal(full.patch.answers.__last_area_details?.area_id,'haram',
  'Normal area advisor must persist last viewed job context');
 const next=await turn('كمل',full.patch.answers);
 assert.equal(next.agent_action,'contextual_resume_work_area');
 assert.match(next.reply,/الهرم/);
 assert.match(next.reply,/هل تقدر تلتزم بالشغل يوميًا/);
 assert.match(next.reply,/عايز أشتغل في الهرم/);
 assert.notEqual(next.reply,'حابب تنزل شغل في أنهي منطقة؟');
 assert.equal(next.patch.answers['q-area'],undefined,'Do not qualify using residence or a generic resume');
 assert.equal(next.patch.awaiting_id,'q-area');
});

test('No previous context or stale details do not make up a job',()=>{
 assert.equal(contextualAreaFollowup({text:'التفاصيل',answers:{},areas,current:question}),null);
 assert.equal(contextualAreaFollowup({text:'كمل',answers:{},areas,current:question}),null);
 const stale={__last_area_details:{kind:'displayed_work_details',place_key:'الهرم',area_id:'haram',at:'2020-01-01T00:00:00Z'}};
 assert.equal(contextualAreaFollowup({text:'كمل',answers:stale,areas,current:question}),null);
});

test('Two job modes on same place require clarification, not guessing a payroll scheme',async()=>{
 const memory={__area_context:{place_key:'الشيخ زايد',kind:'area_context'}};
 const answer=await turn('التفاصيل',memory);
 assert.equal(answer.agent_action,'clarify_context_area_mode');
 assert.match(answer.reply,/ماركت ولا مطاعم/);
 assert.equal(answer.patch.answers['q-area'],undefined);
});

test('An explicit alternative area or other topic is not swallowed by short followup rule',async()=>{
 const memory={__residence_clarification:{kind:'mansouriya_unverified',phase:'reference_offered',reference_place:'haram'}};
 const payment=await turn('القبض بيكون امتى',memory);
 assert.notEqual(payment.agent_action,'contextual_area_details');
 const other=await turn('عايز تفاصيل الشيخ زايد',memory);
 assert.notEqual(other.agent_action,'contextual_area_details');
});
