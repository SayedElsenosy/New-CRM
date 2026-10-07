import test from 'node:test';
import assert from 'node:assert/strict';
import {areaMode,areaPlaceKey,areaProfile,conversationalAreaAdvice,extractRecommendationPreferences,mergeRecommendationProfile,availableAreaNames} from '../src/area-advisor.js';

const areas=[
 {id:'obour',name:'مدينة العبور',aliases:['مدينه العبور','العبور'],active:true,recruitment_eligible:true,place_key:'العبور',work_mode:'general',details:''},
 {id:'obour-market',name:'العبور ماركت',active:true,recruitment_eligible:true,place_key:'العبور',work_mode:'market',details:'الشفت 9 ساعات فقط\nمتوسط القبض الأسبوعي من 3500 لـ 6000 جنيه\nالزون مقفول أقل من 7 كيلو\nمرتب شهري ثابت 5225 جنيه\nتأمين اجتماعي\nتأمين طبي شامل ومجاني\nبونص كل 3 شهور\n21 يوم إجازة سنوية\nأوفر تايم'},
 {id:'zayed',name:'الشيخ زايد',active:true,recruitment_eligible:true,place_key:'الشيخ زايد',work_mode:'general',details:''},
 {id:'zayed-market',name:'الشيخ زايد ماركت',active:true,recruitment_eligible:true,place_key:'الشيخ زايد',work_mode:'market',details:'الشفت 9 ساعات فقط\nمتوسط القبض الأسبوعي من 3500 لـ 6000 جنيه\nالزون مقفول أقل من 7 كيلو\nمرتب شهري ثابت 5225 جنيه\nتأمين اجتماعي\nتأمين طبي شامل ومجاني\nبونص كل 3 شهور\n21 يوم إجازة سنوية\nأوفر تايم'},
 {id:'zayed-rest',name:'الشيخ زايد مطاعم',active:true,recruitment_eligible:true,place_key:'الشيخ زايد',work_mode:'restaurants',details:'متوسط الدخل الاسبوعي 4500 جنيه\nبيوصل لي 8000 جنيه\nالزون أقصى مسافة للزون: 10 كيلو\nسعر الأوردر / 42 جنيه\nالقبض أسبوعي على الفيزا'}
];

test('area identity groups city name with operating-mode rows',()=>{
 assert.equal(areaPlaceKey(areas[0]),'العبور');
 assert.equal(areaPlaceKey(areas[1]),'العبور');
 assert.equal(areaMode(areas[1]),'market');
});

test('مدينة العبور resolves to the available market operation naturally',()=>{
 const r=conversationalAreaAdvice('طيب ممكن انزل مدينة العبور',areas,{});
 assert.equal(r.previewAreaId,'obour');
 assert.equal(r.action,'explain_area_family');
 assert.match(r.reply,/العبور موجودة/);
 assert.match(r.reply,/ماركت/);
 assert.match(r.reply,/5,225/);
 assert.doesNotMatch(r.reply,/اختار.*الأزرار/);
});

test('market versus restaurants comparison explains tradeoffs instead of dumping raw text',()=>{
 const r=conversationalAreaAdvice('انا مش عارف انزل مطاعم ولا ماركت انهي احسن',areas,{__area_preview:{value:'zayed'}});
 assert.equal(r.action,'compare_area_modes');
 assert.match(r.reply,/ماركت:/);
 assert.match(r.reply,/مطاعم:/);
 assert.match(r.reply,/الثبات|الدخل/);
 assert.match(r.reply,/أنهي أنسب ليك|انهي انسب ليك/);
});

test('area profile extracts structured comparison facts from office details',()=>{
 const market=areaProfile(areas[3]),restaurants=areaProfile(areas[4]);
 assert.equal(market.fixedSalary,5225);
 assert.equal(market.weeklyMax,6000);
 assert.equal(market.shiftHours,9);
 assert.equal(market.zoneKm,7);
 assert.equal(restaurants.weeklyAverage,4500);
 assert.equal(restaurants.weeklyMax,8000);
 assert.equal(restaurants.orderPrice,42);
});


test('two named places are compared without committing either work area',()=>{
 const r=conversationalAreaAdvice('العبور ولا الشيخ زايد احسن من ناحية المميزات؟',areas,{});
 assert.equal(r.action,'compare_places');
 assert.equal(r.previewAreaId,undefined);
 assert.match(r.reply,/العبور/);
 assert.match(r.reply,/الشيخ زايد/);
 assert.match(r.reply,/المميزات|الثبات/);
});

test('two named places can be ranked by income from recorded data only',()=>{
 const r=conversationalAreaAdvice('العبور ولا الشيخ زايد احسن في الدخل؟',areas,{});
 assert.equal(r.action,'compare_places');
 assert.match(r.reply,/سقف الدخل|الدخل/);
 assert.match(r.reply,/الشيخ زايد/);
});


test('comparison context remembers the same places for a natural priority follow-up',()=>{
 const first=conversationalAreaAdvice('العبور ولا الشيخ زايد أنهي أحسن؟',areas,{});
 assert.equal(first.action,'compare_places');
 assert.deepEqual(first.comparisonKeys,['العبور','الشيخ زايد']);

 const second=conversationalAreaAdvice('أهم حاجة عندي الدخل',areas,{
  __area_comparison:{place_keys:first.comparisonKeys,kind:'area_comparison'}
 });
 assert.equal(second.action,'compare_places_followup');
 assert.deepEqual(second.comparisonKeys,['العبور','الشيخ زايد']);
 assert.equal(second.priority,'income');
 assert.match(second.reply,/سقف الدخل|الدخل/);
 assert.match(second.reply,/الشيخ زايد/);
});

test('generic recommendation follow-up reuses the last comparison priority',()=>{
 const r=conversationalAreaAdvice('طب ترشحلي أنهي؟',areas,{
  __area_comparison:{place_keys:['العبور','الشيخ زايد'],priority:'income',kind:'area_comparison'}
 });
 assert.equal(r.action,'compare_places_followup');
 assert.equal(r.priority,'income');
 assert.match(r.reply,/سقف الدخل|الدخل/);
});


test('recommendation profile learns only explicit applicant preferences',()=>{
 const prefs=extractRecommendationPreferences('أهم حاجة عندي الدخل وعايز شيفت أقل');
 assert.ok(prefs.some(x=>x.key==='income'&&x.op==='set'));
 assert.ok(prefs.some(x=>x.key==='shift'&&x.op==='set'));
 assert.equal(extractRecommendationPreferences('المرتب كام؟').length,0);
});

test('recommendation profile remembers preferred operating mode',()=>{
 const prefs=extractRecommendationPreferences('أنا أفضل المطاعم');
 const merged=mergeRecommendationProfile(null,prefs,'2026-10-07T20:00:00.000Z');
 assert.equal(merged.changed,true);
 assert.equal(merged.profile.preferred_mode,'restaurants');
});

test('stored recommendation profile personalizes a later comparison without repeating the preference',()=>{
 const answers={__recommendation_profile:{
  priorities:{income:{score:3,source:'explicit',updated_at:'2026-10-07T20:00:00.000Z'}},
  primary:'income',preferred_mode:null,kind:'recommendation_profile'
 }};
 const r=conversationalAreaAdvice('العبور ولا الشيخ زايد أنهي أنسب؟',areas,answers);
 assert.equal(r.action,'compare_places');
 assert.equal(r.priority,'income');
 assert.match(r.reply,/سقف الدخل|الدخل/);
 assert.match(r.reply,/الشيخ زايد/);
});


test('available area names collapse market and restaurant rows into real place names',()=>{
 const names=availableAreaNames([
  {id:'obour-market',name:'العبور ماركت',active:true,recruitment_eligible:true,place_key:'العبور',work_mode:'market',details:'x'},
  {id:'obour-rest',name:'العبور مطاعم',active:true,recruitment_eligible:true,place_key:'العبور',work_mode:'restaurants',details:'x'},
  {id:'zayed-market',name:'الشيخ زايد ماركت',active:true,recruitment_eligible:true,place_key:'الشيخ زايد',work_mode:'market',details:'x'}
 ]);
 assert.deepEqual(names,['العبور','الشيخ زايد']);
});
