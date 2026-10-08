import test from 'node:test';
import assert from 'node:assert/strict';
import {nearestWorkAreasWithFreeMaps,nearestWorkAreaFreeReply} from '../src/geoapify-maps.js';
import {planTurn} from '../src/flow.js';

const areas=[
 {id:'moh',name:'المهندسين مطاعم',active:true,recruitment_eligible:true,position:1},
 {id:'obour',name:'العبور ماركت',active:true,recruitment_eligible:true,position:2},
 {id:'khusus',name:'الخصوص ماركت',active:true,recruitment_eligible:true,position:3},
 {id:'mok',name:'المقطم مطاعم',active:true,recruitment_eligible:true,position:4},
 {id:'off',name:'شبرا',active:false,recruitment_eligible:false}
];
function mockApi(calls,{fail=false}={}){
 return async(input,options={})=>{
  const url=new URL(input);
  calls.push({url,options});
  if(fail)throw Error('offline');
  if(url.pathname.includes('geocode/search')){
   const name=url.searchParams.get('text');
   const points={'عزبة النخل':{lat:30.145,lon:31.325},'الخصوص':{lat:30.155,lon:31.32}};
   const found=points[name];
   return {ok:true,json:async()=>({results:found?[{...found,formatted:name,rank:{confidence:.95},country_code:'eg',result_type:'suburb'}]:[]})};
  }
  if(url.pathname.includes('routematrix')){
   const data=JSON.parse(options.body);
   const row=data.targets.map(t=>{
    const [lng,lat]=t.location;
    const km=lat>30.2?3:lng<31.25?13:lat<30.05?16:7;
    return {distance:km*1000,time:km*120};
   });
   return {ok:true,json:async()=>({sources_to_targets:[row]})};
  }
  throw Error('unexpected url '+url);
 };
}

test('Geoapify uses free location API with Egypt-only filter and route matrix',async()=>{
 const calls=[],mapsOptions={
  geoapifyApiKey:'FAKE_KEY',geoapifyRoutesEnabled:true,geoapifyMaxDailyCredits:2500,
  geoapifyFetchImpl:mockApi(calls)
 };
 const result=await nearestWorkAreasWithFreeMaps('انا ساكن في عزبة النخل، ايه اقرب منطقة شغل؟',areas,mapsOptions);
 assert.equal(result.origin.key,'geoapify_query');
 assert.equal(result.origin_query,'عزبة النخل');
 assert.equal(result.items[0].area.id,'obour');
 assert.equal(result.items[0].distance_km,3);
 assert.equal(result.distance_source,'road');
 assert.equal(result.geoapify_used,true);
 assert.ok(!result.items.some(x=>x.area.id==='off'));
 const geos=calls.filter(x=>x.url.pathname.includes('geocode/search'));
 assert.deepEqual(geos.map(x=>x.url.searchParams.get('text')).sort(),['الخصوص','عزبة النخل']);
 assert.ok(geos.every(x=>x.url.searchParams.get('filter')==='countrycode:eg'));
 const routing=calls.find(x=>x.url.pathname.includes('routematrix'));
 assert.ok(routing);
 const body=JSON.parse(routing.options.body);
 assert.equal(body.sources.length,1);
 assert.ok(body.targets.length<=5);
 assert.equal(body.mode,'drive');
 assert.ok(body.targets.every(x=>x.location[0]<38&&x.location[0]>24));
 assert.match(nearestWorkAreaFreeReply(result),/Geoapify/);
 assert.match(nearestWorkAreaFreeReply(result),/OpenStreetMap/);
 assert.match(nearestWorkAreaFreeReply(result),/كم بالطريق/);
});

test('common Egyptian phrase انا في resolves unknown neighborhoods safely',async()=>{
 const calls=[];
 const result=await nearestWorkAreasWithFreeMaps('أنا في عزبة النخل، اقرب منطقة فين؟',areas,{
  geoapifyApiKey:'FAKE_KEY',geoapifyRoutesEnabled:false,geoapifyFetchImpl:mockApi(calls),
  geoapifyMaxDailyCredits:2500
 });
 assert.equal(result.origin_query,'عزبة النخل');
 assert.equal(result.geoapify_used,true);
});

test('followup remembers known origin and can calculate roads again',async()=>{
 const calls=[];
 const result=await nearestWorkAreasWithFreeMaps('طب إيه الأقرب ليا؟',areas,{
  fallbackOriginKey:'imbaba',geoapifyApiKey:'FAKE_KEY',
  geoapifyRoutesEnabled:true,geoapifyFetchImpl:mockApi(calls),
  geoapifyMaxDailyCredits:2500
 });
 assert.equal(result.origin.key,'imbaba');
 assert.equal(result.distance_source,'road');
 assert.ok(calls.some(x=>x.url.pathname.includes('routematrix')));
});

test('when there is no key, the free map module retains the offline advisor',async()=>{
 const r=await nearestWorkAreasWithFreeMaps('انا ساكن في إمبابة',areas,{env:{}});
 assert.equal(r.items[0].area.id,'moh');
 assert.equal(r.geoapify_used,undefined);
 assert.match(nearestWorkAreaFreeReply(r),/الأقرب تقريبًا/);
});

test('Geoapify errors fall back to existing local recommendation without inventing route distance',async()=>{
 const knownAreas=[
  {id:'moh',name:'المهندسين مطاعم',active:true,recruitment_eligible:true},
  {id:'zayed',name:'الشيخ زايد ماركت',active:true,recruitment_eligible:true}
 ];
 const r=await nearestWorkAreasWithFreeMaps('انا ساكن في بولاق الدكرور',knownAreas,{
  geoapifyApiKey:'FAKE_KEY',geoapifyRoutesEnabled:true,
  geoapifyMaxDailyCredits:2500,geoapifyFetchImpl:mockApi([],{fail:true})
 });
 assert.equal(r.items[0].area.id,'moh');
 assert.equal(r.distance_source,'straight_line');
 assert.doesNotMatch(nearestWorkAreaFreeReply(r),/كم بالطريق/);
});

test('the agent recommends a free-map area but does not select it for applicant',async()=>{
 const messages=[];
 const questions=[
  {id:'q1',field_key:'has_motorcycle',label:'معاك موتوسيكل؟',kind:'yes_no',active:true,required:true,position:1},
  {id:'q2',field_key:'preferred_work_area',label:'أنهي منطقة تقدر تشتغل فيها؟',kind:'area',active:true,required:true,confirmation_required:true,position:2}
 ];
 const applicant={stage:'new',recruitment_stage:'new',answers:{},awaiting_id:'q2',bot_enabled:true};
 const mapsOptions={geoapifyApiKey:'FAKE_KEY',geoapifyRoutesEnabled:false,
  geoapifyMaxDailyCredits:2500,geoapifyFetchImpl:mockApi(messages)};
 const first=await planTurn({applicant,message:{body:'انا ساكن في عزبة النخل، رشحلي أقرب مكان شغل'},
  questions,areas,settings:{ai_enabled:true,ai_knowledge_enabled:false},
  interpret:async()=>null,knowledge:[],mapsOptions});
 assert.equal(first.agent_action,'recommend_nearest_work_area');
 assert.equal(first.patch.awaiting_id,'q2');
 assert.equal(first.patch.answers.q2,undefined);
 assert.equal(first.patch.answers.__area_recommendations.origin_query,'عزبة النخل');
 assert.equal(first.maps_grounded,true);
 assert.match(first.reply,/Geoapify/);
 const follow=await planTurn({applicant:{...applicant,answers:first.patch.answers},
  message:{body:'طب ايه اقرب منطقة ليا؟'},questions,areas,
  settings:{ai_enabled:true,ai_knowledge_enabled:false},interpret:async()=>null,knowledge:[],mapsOptions});
 assert.equal(follow.patch.answers.q2,undefined);
 assert.equal(follow.patch.answers.__area_recommendations.origin_query,'عزبة النخل');
 assert.equal(follow.agent_action,'recommend_nearest_work_area');
});

test('private house addresses cannot be sent through the location advisor',async()=>{
 const calls=[];
 const r=await nearestWorkAreasWithFreeMaps('أنا ساكن في شارع التحرير عمارة 12',areas,{
  geoapifyApiKey:'FAKE_KEY',geoapifyFetchImpl:mockApi(calls),geoapifyMaxDailyCredits:2500
 });
 assert.equal(r,null);
 assert.equal(calls.length,0);
});
