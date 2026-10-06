import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldBrowseAreaButtons,botAreaChoices,recommendedAreaChoices,shouldOfferYesNoButtons} from '../src/worker.js';
import {normalizeWorkAreas} from '../src/db.js';

test('work-area qualification prompt renders area buttons',()=>{
 const q={field_key:'preferred_work_area',label:'أنهي منطقة تقدر تشتغل فيها يوميًا؟ اختار المنطقة اللي تقدر تلتزم بالشغل فيها بشكل مستمر.'};
 const body=q.label+'\nاختار منطقة العمل من الأزرار تحت. أول ما تختارها هنسجلها ونكمل التقديم.';
 assert.equal(shouldBrowseAreaButtons(q,body),true);
});

test('knowledge reply while waiting for work area does not attach area buttons',()=>{
 const q={field_key:'preferred_work_area',label:'أنهي منطقة تقدر تشتغل فيها يوميًا؟ اختار المنطقة اللي تقدر تلتزم بالشغل فيها بشكل مستمر.'};
 assert.equal(shouldBrowseAreaButtons(q,'المرتب الثابت 6200 جنيه.'),false);
});

test('legacy area browser prompts still render area buttons',()=>{
 assert.equal(shouldBrowseAreaButtons(null,'المناطق المتاحة موجودة في الأزرار تحت 👇'),true);
});


test('bot area choices come directly from active Areas-section rows',()=>{
 const areas=[
  {id:'oct',name:'أكتوبر',active:true,recruitment_eligible:true},
  {id:'nasr',name:'مدينة نصر',active:true,recruitment_eligible:false},
  {id:'zayed',name:'الشيخ زايد',active:false,recruitment_eligible:true}
 ];
 assert.deepEqual(botAreaChoices(areas).map(x=>x.id),['oct','nasr']);
});

test('deleted area disappears from bot choices because it is no longer in Areas source',()=>{
 const before=[
  {id:'oct',name:'أكتوبر',active:true},
  {id:'nasr',name:'مدينة نصر',active:true}
 ];
 const after=before.filter(x=>x.id!=='nasr');
 assert.deepEqual(botAreaChoices(before).map(x=>x.id),['oct','nasr']);
 assert.deepEqual(botAreaChoices(after).map(x=>x.id),['oct']);
});


test('active legacy areas are normalized as recruitment eligible before bot use',()=>{
 const normalized=normalizeWorkAreas([
  {id:'hadayek-market',name:'حدائق الأهرام ماركت',active:true,recruitment_eligible:false},
  {id:'paused',name:'منطقة متوقفة',active:false,recruitment_eligible:false}
 ]);
 assert.equal(normalized[0].recruitment_eligible,true);
 assert.equal(normalized[1].recruitment_eligible,false);
 assert.deepEqual(botAreaChoices(normalized).map(x=>x.id),['hadayek-market']);
});


test('nearest-area recommendation renders only recommended work-area buttons first',()=>{
 const areas=[
  {id:'moh',name:'المهندسين مطاعم',active:true},
  {id:'haram',name:'الهرم مطاعم',active:true},
  {id:'tag',name:'التجمع مطاعم',active:true}
 ];
 const answers={__area_recommendations:{values:['moh','haram']}};
 const body='تمام، أقرب اختيارات الشغل المتاحة عندي تقريبًا هي:\nاختار المنطقة من الأزرار';
 assert.deepEqual(recommendedAreaChoices(areas,answers,body).map(x=>x.id),['moh','haram']);
});

test('yes-no recruitment question gets quick reply buttons only when its prompt is being sent',()=>{
 const q={id:'bike',field_key:'has_motorcycle',kind:'yes_no',label:'هل معاك موتوسيكل متاح للشغل يوميًا؟',active:true,required:true};
 assert.equal(shouldOfferYesNoButtons(q,'هل معاك موتوسيكل متاح للشغل يوميًا؟',[]),true);
 assert.equal(shouldOfferYesNoButtons(q,'المرتب الثابت 6200 جنيه.',[]),false);
});
