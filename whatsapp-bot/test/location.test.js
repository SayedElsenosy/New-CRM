import test from 'node:test';
import assert from 'node:assert/strict';
import {nearestWorkAreas,nearestWorkAreaReply,resolveKnownPlace,asksForNearbyArea} from '../src/location.js';

const areas=[
 {id:'moh',name:'المهندسين مطاعم',active:true,position:1},
 {id:'haram',name:'الهرم مطاعم',active:true,position:2},
 {id:'zayed',name:'الشيخ زايد',active:true,position:3},
 {id:'tag',name:'التجمع',active:true,position:4}
];

test('location resolver understands common Greater Cairo residence wording',()=>{
 assert.equal(resolveKnownPlace('انا ساكن في امبابة')?.key,'imbaba');
 assert.equal(resolveKnownPlace('ساكن في فيصل')?.key,'faisal');
 assert.equal(asksForNearbyArea('ايه اقرب حاجة ليا؟'),true);
});

test('Imbaba recommends Mohandessin before farther work areas',()=>{
 const result=nearestWorkAreas('انا ساكن في امبابة ايه اقرب حاجة ليا',areas,{limit:3});
 assert.equal(result.origin.key,'imbaba');
 assert.equal(result.items[0].area.id,'moh');
 assert.ok(result.items[0].distance_km<result.items[1].distance_km);
 const reply=nearestWorkAreaReply(result);
 assert.match(reply,/المهندسين مطاعم/);
 assert.match(reply,/الأقرب تقريبًا/);
 assert.match(reply,/قولّي اسم المنطقة/);
});

test('nearest recommendation ignores inactive areas',()=>{
 const result=nearestWorkAreas('ساكن في امبابة',[
  {id:'moh',name:'المهندسين مطاعم',active:false},
  {id:'haram',name:'الهرم مطاعم',active:true}
 ]);
 assert.equal(result.items[0].area.id,'haram');
});


test('Sayeda Aisha resolves and recommends nearby work areas without auto-selecting one',()=>{
 const localAreas=[
  {id:'mok',name:'المقطم مطاعم',active:true,position:1},
  {id:'moh',name:'المهندسين مطاعم',active:true,position:2},
  {id:'maadi',name:'المعادي ماركت',active:true,position:3},
  {id:'tag',name:'التجمع',active:true,position:4}
 ];
 assert.equal(resolveKnownPlace('طيب انا ساكن في السيدة عايشة')?.key,'sayeda_aisha');
 const result=nearestWorkAreas('انا ساكن في السيدة عائشة',localAreas,{limit:3});
 assert.equal(result.origin.key,'sayeda_aisha');
 assert.equal(result.items[0].area.id,'mok');
 assert.deepEqual(result.items.map(x=>x.area.id),['mok','moh','maadi']);
 const reply=nearestWorkAreaReply(result);
 assert.match(reply,/السيدة عائشة/);
 assert.match(reply,/المقطم مطاعم/);
 assert.match(reply,/الأقرب تقريبًا/);
});
