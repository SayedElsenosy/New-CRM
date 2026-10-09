import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentTimingAdvice,asksPaymentTiming} from '../src/payment-info.js';
import {requiresResidenceDisambiguation} from '../src/location.js';
import {nearestWorkAreasWithFreeMaps} from '../src/geoapify-maps.js';
import {planTurn} from '../src/flow.js';

const areas=[
 {id:'m',name:'الشيخ زايد ماركت',place_key:'الشيخ زايد',work_mode:'market',active:true,recruitment_eligible:true,details:'نظام القبض/ أسبوعي أو شهري. مرتب ثابت 5225 جنيه'},
 {id:'r',name:'الشيخ زايد مطاعم',place_key:'الشيخ زايد',work_mode:'restaurants',active:true,recruitment_eligible:true,details:'القبض أسبوعي على الفيزا. سعر الأوردر 42 جنيه'}
];
const context={__area_context:{place_key:'الشيخ زايد'}};
const questions=[{id:'q-area',field_key:'preferred_work_area',kind:'area',label:'أنهي منطقة تقدر تشتغل فيها؟',required:true,active:true,position:1}];
const applicant=(answers={})=>({id:'synthetic',stage:'incomplete',bot_enabled:true,awaiting_id:'q-area',answers});

test('payday question answers only verified office cadence and never invents a weekday',()=>{
 assert.equal(asksPaymentTiming('القبض بيكون امتى'),true);
 assert.equal(asksPaymentTiming('القبض كام'),false);
 const reply=paymentTimingAdvice({text:'القبض بيكون امتى',areas,answers:context});
 assert.match(reply.reply,/الشيخ زايد ماركت.*أسبوعي أو شهري/);
 assert.match(reply.reply,/الشيخ زايد مطاعم.*أسبوعي/);
 assert.match(reply.reply,/يوم الصرف المحدد مش مسجل/);
 assert.equal(reply.needsHuman,false);
 const market=paymentTimingAdvice({text:'ميعاد القبض للماركت امتى؟',areas,answers:context});
 assert.match(market.reply,/الشيخ زايد ماركت/);
 assert.doesNotMatch(market.reply,/الشيخ زايد مطاعم/);
});

test('repeated request for exact payroll date must escalate instead of restarting job overview',async()=>{
 const answers={...context,__payment_schedule_pending:{kind:'payment_schedule_pending'}};
 const turn=await planTurn({applicant:applicant(answers),message:{body:'طيب أنا عايز اتأكد من معاد القبض اعرف وتقولي'},
  questions,areas,settings:{ai_enabled:true,ai_knowledge_enabled:false},interpret:async()=>null});
 assert.equal(turn.handoff,true);
 assert.equal(turn.handoff_reason,'payment_day_unverified');
 assert.equal(turn.patch.bot_enabled,false);
 assert.match(turn.reply,/هحوّل سؤالك لمسؤول التوظيف/);
 assert.doesNotMatch(turn.reply,/ابدأ شغلك|مميزات|21 يوم/);
});

test('ambiguous Mansouriya is not treated as Mansoura or passed to maps',async()=>{
 assert.equal(requiresResidenceDisambiguation('أنا ساكن في المنصورية'),true);
 assert.equal(requiresResidenceDisambiguation('لا المنصورية مش المنصورة'),true);
 assert.equal(requiresResidenceDisambiguation('أنا من المنصورة'),false);
 const result=await nearestWorkAreasWithFreeMaps('أنا ساكن في المنصورية',areas,{
  geoapifyApiKey:'dummy',fallbackOriginKey:'obour',
  fetchImpl:()=>{throw Error('must never call remote geocoding with ambiguous place');}
 });
 assert.equal(result,null);
 const turn=await planTurn({applicant:applicant(),message:{body:'لا المنصورية مش المنصورة'},
  questions,areas,settings:{ai_enabled:true,ai_knowledge_enabled:false},interpret:async()=>null});
 assert.equal(turn.agent_action,'clarify_residence_location');
 assert.match(turn.reply,/المنصورية مش المنصورة/);
 assert.doesNotMatch(turn.reply,/كم بالطريق|113\.7|127\.8/);
 assert.equal(turn.patch.answers.__area_recommendations,undefined);
});

test('initial payroll question stores context for an eventual exact-payday handoff',async()=>{
 const turn=await planTurn({applicant:applicant(context),message:{body:'القبض بيكون امتى'},
  questions,areas,settings:{ai_enabled:true,ai_knowledge_enabled:false},interpret:async()=>null});
 assert.equal(turn.agent_action,'payment_schedule_info');
 assert.equal(turn.patch.answers.__payment_schedule_pending?.kind,'payment_schedule_pending');
 assert.equal(turn.handoff,undefined);
 assert.match(turn.reply,/أسبوعي أو شهري/);
});
