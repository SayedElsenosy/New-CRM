import test from 'node:test';
import assert from 'node:assert/strict';
import {planTurn} from '../src/flow.js';

const questions=[{id:'q-area',field_key:'preferred_work_area',kind:'area',label:'أنهي منطقة تقدر تشتغل فيها؟',active:true,required:true,position:1}];
const areas=[{id:'haram',name:'الهرم مطاعم',place_key:'الهرم',work_mode:'restaurants',
 active:true,recruitment_eligible:true,details:'شغل مطاعم في الهرم. القبض أسبوعي. سعر الأوردر 38 جنيه.'}];
const settings={ai_enabled:true,welcome:'NEW-APPLICANT-WELCOME',agent_enabled:true};
async function say(answers,text='ممكن تفاصيل شغل الهرم؟'){
 return planTurn({applicant:{id:'test',answers,bot_enabled:true,stage:'new',awaiting_id:null},
  message:{body:text},questions,areas,settings,interpret:async()=>null});
}
test('previously staff-led, approved advertising chat continues without new welcome',async()=>{
 const t=await say({__attribution:{source_id:'ad1'},__history_review:{status:'approved',source:'prior_staff_conversation'}});
 assert.doesNotMatch(t.reply,/NEW-APPLICANT-WELCOME/);
 assert.match(t.reply,/الهرم|تفاصيل/);
 assert.equal(t.patch.answers?.['q-area'],undefined);
});
test('historic imported conversation also must not restart after manual approval',async()=>{
 const t=await say({__attribution:{source_id:'ad1'},__history_review:{status:'approved',source:'imported_whatsapp_history'}});
 assert.doesNotMatch(t.reply,/NEW-APPLICANT-WELCOME/);
});
test('ordinary genuinely new ad lead retains existing onboarding',async()=>{
 const t=await say({__attribution:{source_id:'ad1'}});
 assert.match(t.reply,/NEW-APPLICANT-WELCOME/);
});
