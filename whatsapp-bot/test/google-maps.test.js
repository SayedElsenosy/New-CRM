import test from 'node:test';
import assert from 'node:assert/strict';
import {nearestWorkAreasWithGoogleMaps,nearestWorkAreaMapsReply,extractResidenceLocation} from '../src/google-maps.js';
import {planTurn} from '../src/flow.js';

const candidates=[
 {id:'moh',name:'المهندسين مطاعم',active:true,recruitment_eligible:true,position:1},
 {id:'obo',name:'العبور ماركت',active:true,recruitment_eligible:true,position:2},
 {id:'kho',name:'الخصوص ماركت',active:true,recruitment_eligible:true,position:3},
 {id:'mok',name:'المقطم مطاعم',active:true,recruitment_eligible:true,position:4},
 {id:'inactive',name:'شبرا',active:false,recruitment_eligible:false,position:5}
];
function mockGoogle(calls){
 return async (input,init={})=>{
  const url=new URL(input);
  calls.push({url,init});
  if(url.hostname==='maps.googleapis.com'){
   const query=url.searchParams.get('address');
   const points={
    'عزبة النخل':{lat:30.145,lng:31.325},
    'الخصوص':{lat:30.155,lng:31.32}
   };
   const point=points[query];
   return {ok:true,json:async()=>point
    ?{status:'OK',results:[{formatted_address:query+', مصر',address_components:[{short_name:'EG',types:['country']}],geometry:{location:point}}]}
    :{status:'ZERO_RESULTS',results:[]}};
  }
  if(url.hostname==='routes.googleapis.com'){
   const request=JSON.parse(init.body);
   const rows=request.destinations.map((row,index)=>{
    const {latitude,longitude}=row.waypoint.location.latLng;
    // The Obour route ranks first even if it is not the shortest straight line.
    const km=latitude>30.2?4:longitude<31.25?12:longitude>31.30&&latitude<30.05?15:7;
    return {originIndex:0,destinationIndex:index,status:{},condition:'ROUTE_EXISTS',distanceMeters:km*1000,duration:(km*120)+'s'};
   });
   return {ok:true,json:async()=>rows};
  }
  throw new Error('unexpected URL '+url);
 };
}

test('Egyptian residence extraction sends only the named place to Geocoding',()=>{
 assert.equal(extractResidenceLocation('أنا ساكن في عزبة النخل، ايه أقرب منطقة ليا؟'),'عزبة النخل');
 assert.equal(extractResidenceLocation('ما انا مش عارف ايه اقرب حاجة ليا'),null);
 assert.equal(extractResidenceLocation('انا ساكن في السيدة عائشة'),'السيدة عائشة');
});

test('without a Maps key, local recommendations behave exactly as before',async()=>{
 const result=await nearestWorkAreasWithGoogleMaps('انا ساكن في إمبابة',candidates,{env:{},limit:3});
 assert.equal(result.items[0].area.id,'moh');
 assert.equal(result.google_maps_used,undefined);
 assert.match(nearestWorkAreaMapsReply(result),/الأقرب تقريبًا/);
});

test('new residence and work area use Google Geocoding, then driving routes',async()=>{
 const calls=[];
 const result=await nearestWorkAreasWithGoogleMaps('انا ساكن في عزبة النخل، ايه أقرب منطقة شغل ليا؟',candidates,{
  apiKey:'TEST_KEY',routesEnabled:true,fetchImpl:mockGoogle(calls),
  maxDailyCalls:1000,maxNewAreaLookups:8,limit:3
 });
 assert.equal(result.origin.key,'google_query');
 assert.equal(result.origin_query,'عزبة النخل');
 assert.equal(result.source,'google_routes');
 assert.equal(result.distance_source,'road');
 assert.equal(result.items[0].area.id,'obo');
 assert.equal(result.items[0].distance_km,4);
 assert.ok(!result.items.some(x=>x.area.id==='inactive'));
 const queryCalls=calls.filter(x=>x.url.hostname==='maps.googleapis.com');
 assert.deepEqual(queryCalls.map(x=>x.url.searchParams.get('address')).sort(),['الخصوص','عزبة النخل']);
 assert.ok(queryCalls.every(x=>x.url.searchParams.get('components')==='country:EG'));
 assert.equal(calls.filter(x=>x.url.hostname==='routes.googleapis.com').length,1);
 const reply=nearestWorkAreaMapsReply(result);
 assert.match(reply,/Google Maps/);
 assert.match(reply,/كم بالطريق/);
 assert.match(reply,/أقرب اختيارات الشغل المتاحة/);
});

test('an unknown residence can be reused in a follow-up without committing a work area',async()=>{
 const calls=[];
 const settings={ai_enabled:true,ai_knowledge_enabled:false,welcome:'أهلاً'};
 const questions=[
  {id:'q1',field_key:'has_motorcycle',label:'معاك موتوسيكل؟',kind:'yes_no',required:true,active:true,position:1},
  {id:'q2',field_key:'preferred_work_area',label:'أنهي منطقة تقدر تشتغل فيها؟',kind:'area',required:true,active:true,position:2,confirmation_required:true}
 ];
 const applicant={id:'app',stage:'new',recruitment_stage:'new',answers:{},awaiting_id:'q2',bot_enabled:true};
 const mapsOptions={apiKey:'TEST_KEY',routesEnabled:false,fetchImpl:mockGoogle(calls),maxDailyCalls:1000};
 const first=await planTurn({
  applicant,message:{body:'انا ساكن في عزبة النخل، رشحلي أقرب مكان شغل'},
  questions,areas:candidates,settings,interpret:async()=>null,knowledge:[],mapsOptions
 });
 assert.equal(first.agent_action,'recommend_nearest_work_area');
 assert.equal(first.maps_grounded,true);
 assert.equal(first.patch.answers.q2,undefined);
 assert.equal(first.patch.awaiting_id,'q2');
 assert.equal(first.patch.answers.__area_recommendations.origin_query,'عزبة النخل');
 const follow=await planTurn({
  applicant:{...applicant,answers:first.patch.answers},
  message:{body:'طب ايه اقرب مكان ليا؟'},questions,areas:candidates,settings,
  interpret:async()=>null,knowledge:[],mapsOptions
 });
 assert.equal(follow.agent_action,'recommend_nearest_work_area');
 assert.equal(follow.patch.answers.q2,undefined);
 assert.equal(follow.patch.answers.__area_recommendations.origin_query,'عزبة النخل');
});

test('Google errors retain the safe local fallback',async()=>{
 const result=await nearestWorkAreasWithGoogleMaps('انا ساكن في إمبابة',candidates,{
  apiKey:'TEST_KEY',routesEnabled:true,maxDailyCalls:1000,
  fetchImpl:async()=>{throw new Error('Google temporarily unavailable');}
 });
 assert.equal(result.items[0].area.id,'moh');
 assert.notEqual(result.distance_source,'road');
 assert.doesNotMatch(nearestWorkAreaMapsReply(result),/كم بالطريق/);
});
