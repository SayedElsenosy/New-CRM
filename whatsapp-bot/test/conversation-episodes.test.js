import test from 'node:test';
import assert from 'node:assert/strict';
import {needsConversationEpisodes,selectEpisodeAnchors,retrieveConversationEpisodes} from '../src/conversation-episodes.js';
import {planTurn} from '../src/flow.js';
import {AgentRuntime} from '../src/agent-runtime.js';
import {mansouriyaGuidance} from '../src/residence-guidance.js';
import {historicalRecallNeeded,selectHistoricalExcerpts} from '../src/historical-retrieval.js';

const old=[
 {sequence:18,role:'applicant',unverified:true,excerpt:'ممكن تقارن لي شغل الهرم والشيخ زايد؟'},
 {sequence:90,role:'applicant',unverified:true,excerpt:'عايز تفاصيل الماركت في الشيخ زايد'},
 {sequence:1,role:'applicant',unverified:true,excerpt:'أنا ساكن في المنصورية مش المنصورة'}
];
function fakeDb(rows=[]){
 const calls=[];
 return {calls,from(table){
  assert.equal(table,'masar_messages');
  let id='',after=0,before=Infinity,asc=true,max=0;
  return {
   select(fields){assert.equal(fields,'sequence,direction,sender,body,status');return this;},
   eq(key,val){assert.equal(key,'applicant_id');id=val;return this;},
   gt(key,val){assert.equal(key,'sequence');after=val;return this;},
   lt(key,val){assert.equal(key,'sequence');before=val;return this;},
   order(key,o){assert.equal(key,'sequence');asc=o.ascending;return this;},
   limit(n){max=n;calls.push({id,after,before,asc,max});
    return Promise.resolve({data:rows.filter(r=>r.applicant_id===id&&r.sequence>after&&r.sequence<before)
     .sort((a,b)=>asc?a.sequence-b.sequence:b.sequence-a.sequence).slice(0,max),error:null});
   }
  };
 }};
}
test('historical comparison intent is retrieved even when query also contains Haram as a residence',()=>{
 assert.equal(historicalRecallNeeded('فاكر لما قارنّا شغل الهرم والشيخ زايد؟'),true);
 assert.equal(needsConversationEpisodes('فاكر لما كنا بنقارن الهرم والشيخ زايد انهو انسب؟'),true);
 assert.equal(needsConversationEpisodes('صباح الخير'),false);
 const found=selectHistoricalExcerpts([
  {sequence:18,direction:'in',body:'ممكن تقارن شغل الهرم والشيخ زايد؟'},
  {sequence:3,direction:'in',body:'ساكن في الهرم'}
 ],{query:'فاكر المقارنة بين الهرم والشيخ زايد؟'});
 assert.ok(found.some(x=>x.sequence===18));
 assert.equal(selectEpisodeAnchors(old,'فاكر لما كنا بنقارن شغل الهرم والشيخ زايد؟')[0].sequence,18);
});
test('old conversation reply stays explicitly unverified and same-applicant scoped',async()=>{
 const db=fakeDb([
  {applicant_id:'a',sequence:19,direction:'out',sender:'bot',body:'زمان كنت رشحت الشيخ زايد وقلت مرتب 99999 جنيه',status:'sent'},
  {applicant_id:'a',sequence:20,direction:'in',sender:'applicant',body:'طيب',status:'sent'},
  {applicant_id:'foreign',sequence:19,direction:'out',sender:'bot',body:'سري',status:'sent'}
 ]);
 const result=await retrieveConversationEpisodes(db,{applicantId:'a',currentSequence:500,
  query:'فاكر لما كنا بنقارن شغل الهرم والشيخ زايد؟',historicalExcerpts:old});
 assert.ok(result.length>0&&result.length<=2);
 assert.equal(result[0].verified,false);
 assert.match(result[0].previous_reply,/99999/);
 assert.ok(db.calls.every(c=>c.id==='a'&&c.before===500&&c.max<=4));
 assert.doesNotMatch(JSON.stringify(result),/سري|foreign/);
});
test('no unrelated outgoing text is attached after a new applicant question',async()=>{
 const db=fakeDb([
  {applicant_id:'a',sequence:19,direction:'in',sender:'applicant',body:'سؤال مختلف',status:'sent'},
  {applicant_id:'a',sequence:20,direction:'out',sender:'bot',body:'جواب السؤال المختلف',status:'sent'}
 ]);
 const result=await retrieveConversationEpisodes(db,{applicantId:'a',currentSequence:500,
  query:'فاكر لما كنا بنقارن شغل الهرم والشيخ زايد؟',historicalExcerpts:[old[0]]});
 assert.equal(result[0].previous_reply,undefined);
});
test('episode-bearing plan and composer stay compact; nothing from previous reply becomes a CRM fact',()=>{
 const runtime=new AgentRuntime({env:{}});
 const inputs={message:{body:'فاكر لما قارنا الهرم والشيخ زايد؟'},questions:[],areas:[],knowledge:[],
  applicant:{answers:{}},settings:{},recentMessages:[],historicalExcerpts:old.slice(0,1),
  conversationEpisodes:[{applicant_excerpt:old[0].excerpt,previous_reply:'وقتها قلت المرتب 99999',
   verified:false}]};
 const planner=runtime.buildPlannerMessages(inputs);
 const data=JSON.parse(planner[1].content.split('\n\n').slice(1).join('\n\n'));
 assert.equal(data.previous_conversation_episodes[0].verified,false);
 assert.match(JSON.stringify(data),/وقتها قلت/);
 const composer=runtime.buildComposerMessages({...inputs,turn:{reply:'مرتب الوظيفة الحالي 2500 جنيه.'}});
 assert.match(composer[1].content,/previous_conversation_episodes/);
 assert.ok(JSON.stringify(data.previous_conversation_episodes).length<850);
});
test('live screenshot scenario: old Haram/Zayed comparison yields current CRM terms without accepting residence as employment',async()=>{
 const areas=[
  {id:'haram-rest',name:'الهرم مطاعم',place_key:'الهرم',work_mode:'restaurants',active:true,recruitment_eligible:true,
   details:'نظام مطاعم. سعر الأوردر 38 جنيه، قبض أسبوعي'},
  {id:'zayed-market',name:'الشيخ زايد ماركت',place_key:'الشيخ زايد',work_mode:'market',active:true,recruitment_eligible:true,
   details:'نظام ماركت. راتب ثابت 5225 جنيه، تأمين اجتماعي'},
 ];
 const prompt='فاكر لما كنا بنقارن شغل الهرم والشيخ زايد؟ انت كنت شايف انهي انسب وليه؟';
 const answers={__residence_clarification:{kind:'mansouriya_unverified',phase:'reference_offered'}};
 assert.equal(mansouriyaGuidance({text:prompt,previous:answers.__residence_clarification,areas}),null);
 const turn=await planTurn({
  applicant:{id:'a',bot_enabled:true,answers,awaiting_id:'q-area',stage:'incomplete'},
  message:{body:prompt},questions:[{id:'q-area',field_key:'preferred_work_area',kind:'area',active:true,required:true,position:1,label:'أنهي منطقة تقدر تشتغل فيها يوميًا؟'}],
  areas,settings:{ai_enabled:true,ai_knowledge_enabled:false},
  interpret:async()=>null,historicalExcerpts:[old[0]],
  conversationEpisodes:[{applicant_excerpt:old[0].excerpt,previous_reply:'وقتها قلت المرتب 99999 جنيه',verified:false}]
 });
 assert.equal(turn.agent_action,'compare_places');
 assert.match(turn.reply,/المقارنة/);
 assert.match(turn.reply,/5225/);
 assert.match(turn.reply,/38/);
 assert.doesNotMatch(turn.reply,/99999/);
 assert.doesNotMatch(turn.reply,/نكمل التقديم: حابب تنزل شغل في أنهي منطقة/);
 assert.equal(turn.patch.awaiting_id,'q-area');
 assert.equal(turn.patch.answers['q-area'],undefined);
});
