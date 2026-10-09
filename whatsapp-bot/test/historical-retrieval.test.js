import test from 'node:test';
import assert from 'node:assert/strict';
import {retrieveHistoricalExcerpts,historicalRecallNeeded,selectHistoricalExcerpts} from '../src/historical-retrieval.js';
import {AgentRuntime} from '../src/agent-runtime.js';

const msg=(sequence,body,applicant_id='office-a-applicant',direction='in')=>
 ({sequence,body,applicant_id,direction,sender:direction==='in'?'applicant':'bot',status:'sent'});
function dbStub(rows){
 const logged=[];
 return {logged,from(table){
  assert.equal(table,'masar_messages');
  let applicantId='',dir='',before=Infinity,pattern='',ascending=false,max=70;
  const chain={
   select(column){assert.equal(column,'sequence,direction,body');return this;},
   eq(field,val){if(field==='applicant_id')applicantId=val;else if(field==='direction')dir=val;else throw Error('unexpected field');return this;},
   lt(field,val){assert.equal(field,'sequence');before=val;return this;},
   or(filter){pattern=filter;return this;},
   order(field,sort){assert.equal(field,'sequence');ascending=sort.ascending;return this;},
   limit(n){max=n;const terms=[...pattern.matchAll(/body\.ilike\.%([^,%]+)%/g)].map(x=>x[1].toLowerCase());
    logged.push({applicantId,dir,before,pattern,ascending,max});
    return Promise.resolve({error:null,data:rows.filter(r=>r.applicant_id===applicantId&&r.direction===dir&&r.sequence<before
     &&terms.some(t=>r.body.toLowerCase().includes(t))).sort((a,b)=>ascending?a.sequence-b.sequence:b.sequence-a.sequence).slice(0,max)});
   }
  };
  return chain;
 }};
}
test('reads full-history edges for a residence correction older than hundreds of messages',async()=>{
 const all=[
  msg(1,'أنا ساكن في المنصورية مش المنصورة'),
  ...Array.from({length:370},(_,i)=>msg(i+2,'عندي شغل قريب من البيت في منطقة الهرم')),
  msg(372,'مش عارف فين الاقرب ليا'),
  msg(373,'ده آخر كلام بعد الشغل'),
  msg(12,'متقدم مختلف ساكن في أسيوط','foreign-applicant')
 ];
 const db=dbStub(all);
 const excerpts=await retrieveHistoricalExcerpts(db,{
  applicantId:'office-a-applicant',currentSequence:374,
  query:'فاكر أنا ساكن فين؟',recentSequences:[372,373]
 });
 assert.equal(db.logged.length,2);
 assert.ok(db.logged.every(x=>x.applicantId==='office-a-applicant'&&x.dir==='in'&&x.before===374));
 assert.ok(db.logged.some(x=>x.ascending)&&db.logged.some(x=>!x.ascending));
 assert.ok(excerpts.some(x=>x.sequence===1&&x.excerpt.includes('المنصورية مش المنصورة')));
 assert.ok(excerpts.every(x=>x.role==='applicant'&&x.unverified===true));
 assert.ok(!excerpts.some(x=>x.sequence===12));
 assert.ok(!excerpts.some(x=>[372,373].includes(x.sequence)));
});
test('only same applicant inbound messages, redact private phone/email and never include assistant text',async()=>{
 const db=dbStub([
  msg(1,'القبض هينزل عندي 01012345678 والبريد test@example.com'),
  msg(2,'معلومة مؤكدة القبض بكرة','office-a-applicant','out'),
  msg(3,'القبض ممكن يكون أسبوعي حسب النظام'),
  msg(4,'عندكم شغل ولا لا','foreign-applicant')
 ]);
 const snippets=await retrieveHistoricalExcerpts(db,{
  applicantId:'office-a-applicant',currentSequence:5,query:'فاكر قولتلك القبض امتى؟'
 });
 assert.ok(snippets.some(x=>x.sequence===1));
 assert.ok(!JSON.stringify(snippets).includes('01012345678'));
 assert.ok(!JSON.stringify(snippets).includes('test@example.com'));
 assert.ok(!JSON.stringify(snippets).includes('معلومة مؤكدة القبض بكرة'));
 assert.ok(!JSON.stringify(snippets).includes('عندكم شغل ولا لا'));
 assert.ok(snippets.length<=5);
});
test('prompt uses retrieved excerpts as unverified context, without any new qualification fact',()=>{
 const runtime=new AgentRuntime({env:{}});
 const pieces=[{sequence:1,role:'applicant',excerpt:'أنا ساكن المنصورية مش المنصورة',unverified:true}];
 const inputs={message:{body:'فاكر قلتلك أنا ساكن فين؟'},questions:[],areas:[],
  applicant:{answers:{}},knowledge:[],settings:{},recentMessages:[],historicalExcerpts:pieces};
 const p=runtime.buildPlannerMessages(inputs);
 const context=JSON.parse(p[1].content.split('\n\n').slice(1).join('\n\n'));
 assert.equal(context.retrieved_historical_applicant_excerpts.length,1);
 assert.equal(context.retrieved_historical_applicant_excerpts[0].verified,false);
 assert.ok(!JSON.stringify(context).includes('preferred_work_area":true'));
 assert.match(p[0].content,/غير موثق/);
 const composer=runtime.buildComposerMessages({...inputs,turn:{reply:'تمام، أي منطقة تقدر تشتغل فيها يوميًا؟'}});
 assert.match(composer[1].content,/retrieved_historical_applicant_excerpts/);
 assert.match(composer[0].content,/draft_reply هو مصدر الحقيقة الوحيد/);
});
test('irrelevant greetings skip retrieval and excessive/sensitive old text stays bounded',async()=>{
 assert.equal(historicalRecallNeeded('أهلاً، صباح الخير'),false);
 assert.equal(historicalRecallNeeded('فاكر أنا ساكن فين؟'),true);
 const db=dbStub([msg(1,'ساكن في الهرم')]);
 assert.deepEqual(await retrieveHistoricalExcerpts(db,{applicantId:'office-a-applicant',currentSequence:2,query:'أهلاً'}),[]);
 assert.equal(db.logged.length,0);
 const selected=selectHistoricalExcerpts([msg(1,'أنا ساكن في الهرم '+'صورة '.repeat(1000))],{query:'فاكر أنا ساكن فين'});
 assert.ok(selected[0].excerpt.length<=190);
});

import {answerHistoricResidenceRecall} from '../src/historical-recall-answer.js';
import {planTurn} from '../src/flow.js';

test('actual chat recall: user asks where they lived 400 turns later; no work choice is saved',async()=>{
 const excerpts=[
  {sequence:1,role:'applicant',unverified:true,excerpt:'أنا ساكن في المنصورية مش المنصورة'}
 ];
 const standalone=answerHistoricResidenceRecall('فاكر أنا ساكن فين؟',excerpts);
 assert.equal(standalone.agent_action,'historical_residence_recall');
 assert.match(standalone.reply,/المنصورية، مش المنصورة/);
 const q={id:'area',field_key:'preferred_work_area',kind:'area',label:'أنهي منطقة تقدر تشتغل فيها؟',active:true,required:true,position:1};
 const area={id:'haram',name:'الهرم مطاعم',place_key:'الهرم',active:true,recruitment_eligible:true};
 const t=await planTurn({
  applicant:{id:'test',bot_enabled:true,answers:{},awaiting_id:'area',stage:'incomplete'},
  message:{body:'فاكر انا ساكن فين؟'},questions:[q],areas:[area],
  settings:{ai_enabled:true},interpret:async()=>null,historicalExcerpts:excerpts
 });
 assert.equal(t.agent_action,'historical_residence_recall');
 assert.equal(t.patch.awaiting_id,'area');
 assert.equal(t.patch.answers.area,undefined);
 assert.match(t.reply,/مش بيحدد منطقة العمل/);
});
test('conflicting recent claim never reuses earlier Mansouriya as certain location',()=>{
 const memory=[
  {sequence:1,role:'applicant',unverified:true,excerpt:'أنا ساكن في المنصورية'},
  {sequence:400,role:'applicant',unverified:true,excerpt:'أنا ساكن في الهرم دلوقتي'}
 ];
 assert.equal(answerHistoricResidenceRecall('فاكر أنا ساكن فين؟',memory),null);
 assert.equal(answerHistoricResidenceRecall('القبض إمتى؟',memory),null);
 assert.equal(answerHistoricResidenceRecall('فاكر أنا ساكن فين؟',[
  {sequence:1,role:'agent',unverified:true,excerpt:'أنا ساكن في المنصورية'}
 ]),null);
});
