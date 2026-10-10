import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationalAreaAdvice} from '../src/area-advisor.js';
import {planTurn} from '../src/flow.js';

const restaurantStory=[
 'شغل الهرم مطاعم.',
 'سعر الأوردر 38 جنيه.',
 'متوسط الدخل الأسبوعي 4000 جنيه.',
 'القبض أسبوعي على الفيزا.',
 ...Array.from({length:70},(_,i)=>'هذه فقرة طويلة في تفاصيل النظام رقم '+i)
].join('\n');
const areas=[
 {id:'haram-rest',name:'الهرم مطاعم',place_key:'الهرم',work_mode:'restaurants',
  active:true,recruitment_eligible:true,details:restaurantStory},
 {id:'zayed-market',name:'الشيخ زايد ماركت',place_key:'الشيخ زايد',work_mode:'market',
  active:true,recruitment_eligible:true,
  details:'نظام ماركت. مرتب شهري ثابت 5225 جنيه، شيفت 9 ساعات، تأمين اجتماعي وتأمين طبي'},
 {id:'zayed-rest',name:'الشيخ زايد مطاعم',place_key:'الشيخ زايد',work_mode:'restaurants',
  active:true,recruitment_eligible:true,
  details:'سعر الأوردر 42 جنيه. متوسط الدخل الأسبوعي 4800 جنيه.'}
];
const q={id:'q-area',field_key:'preferred_work_area',kind:'area',label:'أنهي منطقة تقدر تشتغل فيها يوميًا؟',
 active:true,required:true,position:1};
const query='فاكر لما اتكلمنا عن شغل الهرم والشيخ زايد؟ انت شايف انهي انسب ليا وليه؟';

test('Screenshot: condensed Haram vs Sheikh Zayed answer with one next question and no 70-line job dump',()=>{
 const answers={__residence_clarification:{kind:'mansouriya_unverified',phase:'work_detail_offered',reference_place:'haram'}};
 const a=conversationalAreaAdvice(query,areas,answers);
 assert.equal(a.action,'compare_places');
 assert.ok(a.reply.length<1050,'short WhatsApp-friendly response; actual length '+a.reply.length);
 assert.match(a.reply,/الهرم/);
 assert.match(a.reply,/الشيخ زايد/);
 assert.match(a.reply,/38/);
 assert.match(a.reply,/5,225/);
 assert.match(a.reply,/المنصورية ناحية الهرم/);
 assert.match(a.reply,/ما(عنديش| عنديش) زمن مشوار/);
 assert.doesNotMatch(a.reply,/فقرة طويلة|هذه فقرة|آخر النظام/);
 assert.equal((a.reply.match(/؟/g)||[]).length,1);
 assert.match(a.reply,/القرب من البيت أهم/);
 assert.doesNotMatch(a.reply,/أفضل ليك على الإطلاق|أقرب منطقة لبيتك/);
});
test('Never equate delivery zones with home-to-work commuting distance',()=>{
 const data=[
  {...areas[0],details:'الزون حتى 10 كيلو. شيفت 8 ساعات'},
  {...areas[1],details:'الزون حتى 7 كيلو. مرتب شهري ثابت 5225 جنيه'}
 ];
 const r=conversationalAreaAdvice('مين الاقرب لبيتي الهرم ولا الشيخ زايد من ناحية المسافة؟',data,{});
 assert.equal(r.action,'compare_places');
 assert.match(r.reply,/الزون.*مش مشوارك/);
 assert.doesNotMatch(r.reply,/الشيخ زايد أقرب لبيتك|الهرم أقرب لبيتك/);
});
test('Monthly fixed salary vs weekly delivery earnings is not a direct income ranking',()=>{
 const r=conversationalAreaAdvice('الهرم ولا الشيخ زايد انهي احسن من ناحية المرتب؟',areas,{});
 assert.equal(r.action,'compare_places');
 assert.match(r.reply,/مرتب شهري بدخل أسبوعي|أرقام مختلفة/);
 assert.doesNotMatch(r.reply,/الشيخ زايد.*أعلى في الدخل|الهرم.*أعلى في الدخل/);
});
test('Existing office details route remains full and unedited when explicitly requested',()=>{
 const r=conversationalAreaAdvice('ممكن تفاصيل مطاعم الهرم؟',areas,{});
 assert.equal(r.action,'explain_area_mode');
 assert.ok(r.reply.includes(restaurantStory));
});
test('End-to-end: pending work area is not committed and comparison never appends a generic application prompt',async()=>{
 const answers={__residence_clarification:{kind:'mansouriya_unverified',phase:'work_detail_offered',reference_place:'haram'}};
 const r=await planTurn({
  applicant:{id:'t',bot_enabled:true,stage:'incomplete',awaiting_id:'q-area',answers},
  message:{body:query},questions:[q],areas,settings:{ai_enabled:true},
  interpret:async()=>null,knowledge:[],
  conversationEpisodes:[{applicant_excerpt:'قارن الهرم والشيخ زايد',verified:false}]
 });
 assert.equal(r.agent_action,'compare_places');
 assert.equal(r.patch.awaiting_id,'q-area');
 assert.equal(r.patch.answers['q-area'],undefined);
 assert.doesNotMatch(r.reply,/نكمل التقديم:/);
 assert.ok(r.reply.length<1200);
});
