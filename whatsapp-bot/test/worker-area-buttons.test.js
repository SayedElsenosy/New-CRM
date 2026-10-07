import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldBrowseAreaButtons,botAreaChoices,recommendedAreaChoices,shouldOfferYesNoButtons,shouldOfferChoiceButtons,choiceButtons} from '../src/worker.js';
import {normalizeWorkAreas} from '../src/db.js';

test('work-area prompt is conversation-first and does not render buttons automatically',()=>{
 const q={field_key:'preferred_work_area',label:'أنهي منطقة تقدر تشتغل فيها يوميًا؟'};
 assert.equal(shouldBrowseAreaButtons(q,'حابب تنزل شغل في أنهي منطقة؟'),false);
 assert.equal(shouldBrowseAreaButtons(q,'تمام، دي اختيارات سريعة للمناطق 👇'),true);
});

test('knowledge reply while waiting for work area does not attach area buttons',()=>{
 const q={field_key:'preferred_work_area',label:'أنهي منطقة تقدر تشتغل فيها يوميًا؟ اختار المنطقة اللي تقدر تلتزم بالشغل فيها بشكل مستمر.'};
 assert.equal(shouldBrowseAreaButtons(q,'المرتب الثابت 6200 جنيه.'),false);
});

test('legacy area text no longer forces buttons unless quick options are requested',()=>{
 assert.equal(shouldBrowseAreaButtons(null,'المناطق المتاحة موجودة في الأزرار تحت 👇'),false);
 assert.equal(shouldBrowseAreaButtons(null,'اختيارات سريعة للمناطق 👇'),true);
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

test('yes-no buttons are optional and appear only on explicit quick-options request',()=>{
 const q={id:'bike',field_key:'has_motorcycle',kind:'yes_no',label:'هل معاك موتوسيكل متاح للشغل يوميًا؟',active:true,required:true};
 assert.equal(shouldOfferYesNoButtons(q,'هل معاك موتوسيكل متاح للشغل يوميًا؟',[]),false);
 assert.equal(shouldOfferYesNoButtons(q,'تمام، دي اختيارات سريعة: نعم / لا 👇',[]),true);
});


test('choice question renders configured WhatsApp buttons',()=>{
 const q={id:'shift-type',field_key:'shift_type',kind:'choice',label:'أنهي شيفت مناسب ليك؟',required:true,options:[
  {label:'صباحي',value:'morning'},
  {label:'مسائي',value:'evening'},
  {label:'أي شيفت',value:'any'}
 ]};
 const body='أنهي شيفت مناسب ليك؟';
 assert.equal(shouldOfferChoiceButtons(q,body,[]),false);
 assert.equal(shouldOfferChoiceButtons(q,'تمام، دي اختيارات سريعة للسؤال 👇',[]),true);
 assert.deepEqual(choiceButtons(q).map(x=>x.text),['صباحي','مسائي','أي شيفت']);
 assert.deepEqual(choiceButtons(q).map(x=>x.id),['choice:shift-type:0','choice:shift-type:1','choice:shift-type:2']);
});
