import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldBrowseAreaButtons} from '../src/worker.js';

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
