import test from 'node:test';
import assert from 'node:assert/strict';
import {updateBrainMemory,brainMemoryContext,buildBrainSteps,validateBrainSteps,needsLlmPlanning} from '../src/brain-memory.js';
import {AgentRuntime} from '../src/agent-runtime.js';

test('candidate shift preference persists across unrelated conversations without raw transcript',()=>{
 const one=updateBrainMemory(null,'أنا بفضل شيفت صباحي لأن عندي ظروف',{now:'2026-10-09T00:00:00Z'});
 assert.equal(one.changed,true);
 assert.equal(one.memory.preferred_shift,'morning');
 assert.ok(!JSON.stringify(one.memory).includes('ظروف'));
 const two=updateBrainMemory(one.memory,'ممكن تفاصيل الماركت؟',{now:'2026-10-09T01:00:00Z'});
 assert.equal(two.memory.preferred_shift,'morning');
 assert.deepEqual(two.memory.recent_intents,['job_details']);
 const three=updateBrainMemory(two.memory,'تمام',{now:'2026-10-09T01:10:00Z'});
 assert.equal(three.changed,false);
 assert.equal(three.memory.preferred_shift,'morning');
});

test('explicit correction replaces preference and negation removes it',()=>{
 const base=updateBrainMemory(null,'عايز شيفت صباحي').memory;
 const changed=updateBrainMemory(base,'قصدي مسائي مش صباحي').memory;
 assert.equal(changed.preferred_shift,'evening');
 const removed=updateBrainMemory(changed,'مش عايز شيفت مسائي').memory;
 assert.equal(removed.preferred_shift,null);
});

test('arbitrary or sensitive content cannot enter persistent Brain memory',()=>{
 const body='أنا ساكن في شارع التحرير عمارة 14 شقة 7 والبطاقة 29812345678901';
 const result=updateBrainMemory(null,body);
 assert.equal(result.changed,true);
 assert.deepEqual(result.memory.recent_intents,['documents']);
 const serialized=JSON.stringify(result.memory);
 assert.doesNotMatch(serialized,/التحرير|29812345678901|عمارة|شارع/);
 const quiet=updateBrainMemory(null,'اسمي محمد أحمد');
 assert.equal(quiet.changed,false);
});

test('memory does not store work-area selection or qualify via home address',()=>{
 const updated=updateBrainMemory(null,'أنا ساكن في إمبابة وأقرب شغل ليا مدينة نصر؟');
 const asText=JSON.stringify(updated.memory||{});
 assert.doesNotMatch(asText,/residence|preferred_work_area|qualified|إمبابة|مدينة نصر/);
});

test('brain merges preexisting office recommendation preferences as read-only context',()=>{
 const context=brainMemoryContext({
  __brain_memory:{version:2,preferred_shift:'morning',recent_intents:['nearest','compare','arbitrary']},
  __recommendation_profile:{primary:'distance',preferred_mode:'market'}
 });
 assert.deepEqual(context,{
  preferences:{preferred_shift:'morning',preferred_work_mode:'market',main_priority:'distance'},
  recent_intents:['nearest','compare']
 });
});

test('read-only multi step plan sees compound recruiting requests',()=>{
 assert.deepEqual(buildBrainSteps('قارن الماركت والمطاعم وقول لي الأقرب للشغل والمرتب كام',{hasPendingQuestion:true}),[
  'understand_message','check_nearest_work_areas','read_office_areas','compare_registered_areas','ask_pending_question'
 ]);
 assert.deepEqual(validateBrainSteps([
  'understand_message','compare_registered_areas','change_qualification','human_handoff','delete_applicant','read_office_areas','compare_registered_areas'
 ],buildBrainSteps('قارن بين الماركت والمطاعم')),[
  'understand_message','compare_registered_areas','human_handoff','read_office_areas'
 ]);
});

test('planner knows correct office, existing memory and ordered subtasks (no Breadfast claim)',()=>{
 const runtime=new AgentRuntime({env:{}});
 const applicant={
  awaiting_id:'qarea',
  answers:{
   __brain_memory:{version:2,preferred_shift:'evening',recent_intents:['compare']},
   __recommendation_profile:{primary:'income',preferred_mode:'restaurants'}
  }
 };
 const messages=runtime.buildPlannerMessages({
  message:{body:'ممكن تقارن المناطق القريبة وتقول المرتبات؟'},
  applicant,office:{name:'الرقم الرئيسي'},
  questions:[{id:'qarea',field_key:'preferred_work_area',kind:'area',active:true,required:true,confirmation_required:true,label:'منطقة الشغل'}],
  areas:[{id:'area1',name:'الشيخ زايد ماركت',zone:'WEST',active:true}],
  knowledge:[],settings:{},
  recentMessages:Array.from({length:9},(_,i)=>({direction:'in',body:'تواصل قبل الرسالة '+i}))
 });
 const planner=JSON.parse(messages[1].content.split('\n\n').at(-1));
 assert.equal(planner.office_name,'الرقم الرئيسي');
 assert.equal(planner.verified_preference_memory.preferences.preferred_shift,'evening');
 assert.equal(planner.verified_preference_memory.preferences.main_priority,'income');
 assert.deepEqual(planner.suggested_readonly_steps,[
  'understand_message','check_nearest_work_areas','read_office_areas','compare_registered_areas','ask_pending_question'
 ]);
 assert.equal(planner.conversation.length,6);
 assert.doesNotMatch(messages[0].content,/Breadfast/);
 const composer=runtime.buildComposerMessages({
  message:{body:'تمام'},turn:{reply:'بياناتك مسجلة'},
  office:{name:'الرقم الرئيسي'},applicant,settings:{},plan:{steps:['understand_message']},recentMessages:[]
 });
 const body=JSON.parse(composer[1].content.split('\n\n').at(-1));
 assert.equal(body.office_name,'الرقم الرئيسي');
 assert.equal(body.verified_preference_memory.preferences.preferred_shift,'evening');
 assert.doesNotMatch(composer[0].content,/Breadfast/);
});

test('planner cannot use output steps to execute unsafe operations',()=>{
 const allowed=buildBrainSteps('قارن مرتب الماركت والمطاعم',{hasPendingQuestion:true});
 const external=['send_whatsapp','accept_candidate','override_area','check_nearest_work_areas'];
 assert.deepEqual(validateBrainSteps(external,allowed),[]);
});


test('cheap local protocol actions skip LLM while rich messages keep planner',()=>{
 for(const body of ['area_preview:x','confirm_area:x','area_page:2','choice:q5:0','no_work_area','']){
  assert.equal(needsLlmPlanning({body}),false,body);
 }
 assert.equal(needsLlmPlanning({body:'',media_path:'files/photo.jpeg'}),false);
 assert.equal(needsLlmPlanning({body:'أنا محتار بين المطاعم والماركت والمرتب يفرق معايا'}),true);
 assert.equal(needsLlmPlanning({body:'مش معايا الرخصة'}),true);
});
