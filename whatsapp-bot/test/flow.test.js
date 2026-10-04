import test from 'node:test';import assert from 'node:assert/strict';
import {phoneFromId,validateAnswer,computedStage,completion,csvCell,redactForAI,areaRejected,areaInquiry,questionPrompt} from '../src/domain.js';
import {planTurn} from '../src/flow.js';import {interpret} from '../src/ai.js';import {findKnowledgeAnswer,isLearnableExchange} from '../src/knowledge.js';
const areas=[{id:'oct',name:'أكتوبر',active:true,details:'الشفت 9 ساعات. نقطة التجمع: المكتب.'},{id:'zayed',name:'الشيخ زايد',active:false,details:'تفاصيل متوقفة'}];
const questions=[{id:'name',field_key:'name',kind:'name',label:'اسمك بالكامل؟',position:1,active:true,required:true},{id:'area',field_key:'area',kind:'area',label:'أنهي منطقة؟',position:2,active:true,required:true},{id:'bike',field_key:'bike',kind:'yes_no',label:'معاك موتوسيكل؟',position:3,active:true,required:true}];
const settings={ai_enabled:true,welcome:'أهلاً',completion:'تم الاستلام'};
const applicant={stage:'new',answers:{},awaiting_id:null,bot_enabled:true};
const run=(a,text,extra={})=>planTurn({applicant:a,message:{body:text},questions,areas,settings,interpret:async()=>null,...extra});
test('LID is never displayed as a phone',()=>{assert.equal(phoneFromId('123456789012345@lid'),null);assert.equal(phoneFromId('201012345678@c.us'),'+201012345678');assert.equal(phoneFromId('123@g.us'),null);});
test('Arabic age and negative replies are validated',()=>{assert.equal(validateAnswer({kind:'number'},'عندي ٢٨ سنة',areas).value,28);assert.equal(validateAnswer({kind:'number'},'عندي ١٢٠ سنة',areas).ok,false);assert.equal(validateAnswer({kind:'yes_no'},'معنديش',areas).value,false);});
test('initial greeting asks first question without saving greeting',async()=>{const r=await run(applicant,'السلام عليكم');assert.equal(r.patch.awaiting_id,'name');assert.equal(r.patch.answers,undefined);});
test('answers are saved to their question with field key and progress',async()=>{const r=await run({...applicant,awaiting_id:'name'},'سيد محمد');assert.equal(r.patch.answers.name.value,'سيد محمد');assert.equal(r.patch.answers.name.key,'name');assert.equal(r.patch.stage,'incomplete');assert.equal(r.patch.awaiting_id,'area');});
test('area inquiry does not consume the pending answer',async()=>{const r=await run({...applicant,awaiting_id:'name'},'تفاصيل الشغل في اكتوبر؟');assert.match(r.reply,/الشفت 9 ساعات/);assert.equal(r.patch.answers,undefined);assert.equal(r.patch.awaiting_id,'name');});
test('first area inquiry remembers question to accept the next answer',async()=>{const r=await run(applicant,'تفاصيل اكتوبر');assert.equal(r.patch.awaiting_id,'name');});
test('unknown details never become free text answer',async()=>{const r=await run({...applicant,awaiting_id:'name'},'القبض كام؟');assert.match(r.reply,/تقصد أنهي منطقة/);assert.ok(Object.keys(r.patch.answers||{}).every(k=>k.startsWith('__')));});
test('disabled areas cannot be selected',()=>assert.equal(validateAnswer({kind:'area'},'الشيخ زايد',areas).ok,false));
test('AI can interpret indirect negative but cannot mark attendance',async()=>{const a={...applicant,awaiting_id:'bike',answers:{name:{value:'سيد محمد'},area:{value:'oct'}}};const r=await run(a,'لسه مجبتش موتوسيكل',{interpret:async()=>({intent:'answer',answer:'no',confidence:0.96})});assert.equal(r.patch.answers.bike.value,false);assert.equal(r.patch.stage,'complete');assert.equal(r.patch.awaiting_id,null);});
test('AI failure asks clarification without advancing',async()=>{const a={...applicant,awaiting_id:'bike',answers:{name:{value:'سيد محمد'},area:{value:'oct'}}};const r=await run(a,'رد مش مفهوم');assert.equal(r.patch.answers,undefined);assert.match(r.reply,/محتاج أوضح/);});
test('fake AI area IDs are rejected',async()=>{const a={...applicant,awaiting_id:'area',answers:{name:{value:'سيد محمد'}}};const r=await run(a,'مكان بعيد',{interpret:async()=>({intent:'answer',answer:'invented'})});assert.equal(r.patch.answers,undefined);});
test('stored false is a complete valid answer',()=>{const a={...applicant,answers:{name:{value:'سيد محمد'},area:{value:'oct'},bike:{value:false}}};assert.equal(completion(questions,a.answers,areas).complete,true);assert.equal(computedStage(a,questions,areas),'complete');});
test('changed question type invalidates stale answer without deleting it',()=>{const a={bike:{value:false,kind:'yes_no'}};assert.equal(completion([{...questions[2],kind:'image'}],a,areas).complete,false);});
test('manual stages stay protected while reply control follows bot_enabled',async()=>{for(const stage of ['lecture','working']){const a={...applicant,stage,bot_enabled:false};assert.equal(computedStage(a,questions,areas),stage);assert.equal((await run(a,'اهلا')).reply,'');}});
test('human pause suppresses all bot responses',async()=>assert.equal((await run({...applicant,bot_enabled:false},'تفاصيل اكتوبر')).reply,''));
test('documents must have a stored attachment',()=>{assert.equal(validateAnswer({kind:'image'},'بعت الورق',areas).ok,false);assert.equal(validateAnswer({kind:'image'},'',areas,{path:'a/doc'}).value,'a/doc');});
test('optional question skip does not block completion',async()=>{const qs=[{...questions[0],required:false},questions[2]];const r=await run({...applicant,awaiting_id:'name'},'تخطي',{questions:qs});assert.equal(r.patch.answers.name.skipped,true);assert.equal(r.patch.awaiting_id,'bike');});
test('required question cannot be skipped',async()=>{const r=await run({...applicant,awaiting_id:'name'},'تخطي');assert.equal(r.patch.answers,undefined);});
test('CSV protects against spreadsheet formulas',()=>{assert.equal(csvCell('=1+1'),'"\'=1+1"');assert.equal(csvCell('سيد "محمد"'),'"سيد ""محمد"""');});
test('privacy helper still redacts long phone/ID strings',()=>assert.ok(!redactForAI('رقمي ٠١٠١٢٣٤٥٦٧٨').includes('01012345678')));
test('local interpreter understands indirect Egyptian replies without external AI',async()=>{assert.equal((await interpret('لسه مجبتش موتوسيكل',questions[2],areas)).answer,'no');assert.equal((await interpret('اه معايا الحمد لله',questions[2],areas)).answer,'yes');assert.equal((await interpret('انا عندي ٢٨ سنة',{kind:'number'},areas)).answer,'28');});
test('local interpreter resolves active areas and rejects unknown text',async()=>{assert.equal((await interpret('تفاصيل الشغل في أكتوبر؟',questions[0],areas)).area_id,'oct');assert.equal((await interpret('عايز الشيخ زايد',questions[1],areas)).intent,'clarify');assert.equal((await interpret('كلام مش واضح',questions[2],areas)).intent,'clarify');});
test('negative area wording is treated as rejection, never a selection',async()=>{
 const liveAreas=[areas[0],{id:'zayed',name:'الشيخ زايد',active:true,details:'تفاصيل الشيخ زايد'}];
 assert.equal(areaRejected('لا مش عاوز اشتغل في الشيخ زايد',liveAreas[1]),true);
 assert.equal(areaInquiry('مش عايز تفاصيل الشغل في الشيخ زايد',liveAreas),null);
 const intent=await interpret('لا مش عاوز اشتغل في الشيخ زايد',questions[1],liveAreas);
 assert.equal(intent.intent,'area_reject');assert.equal(intent.area_id,'zayed');
 const a={...applicant,awaiting_id:'area',answers:{name:{value:'سيد محمد',kind:'name'}}};
 const r=await planTurn({applicant:a,message:{body:'لا مش عاوز اشتغل في الشيخ زايد'},questions,areas:liveAreas,settings,interpret});
 assert.equal(r.patch.answers,undefined);assert.equal(r.patch.awaiting_id,'area');assert.match(r.reply,/مش هختار الشيخ زايد/);assert.doesNotMatch(r.reply,/تفاصيل الشيخ زايد/);
});
test('a rejected area plus a positive alternative selects only the alternative',async()=>{
 const liveAreas=[areas[0],{id:'zayed',name:'الشيخ زايد',active:true,details:'تفاصيل الشيخ زايد'}];
 const intent=await interpret('مش عايز الشيخ زايد، عايز أكتوبر',questions[1],liveAreas);
 assert.equal(intent.intent,'answer');assert.equal(intent.answer,'oct');
});

test('old bare LIDs are not migrated as phone numbers',async()=>{const {legacyPhone}=await import('../src/domain.js');assert.equal(legacyPhone('123456789012345'),null);assert.equal(legacyPhone('201012345678'),'+201012345678');});
test('previously skipped question is asked if changed to required',async()=>{const r=await run({...applicant,answers:{name:{skipped:true}},awaiting_id:null},'أهلا');assert.equal(r.patch.awaiting_id,'name');});


test('area button previews details without saving the final area',async()=>{
 const liveAreas=[areas[0],{id:'zayed',name:'الشيخ زايد',active:true,details:'تفاصيل الشيخ زايد'}];
 const a={...applicant,awaiting_id:'area',answers:{name:{value:'سيد محمد',kind:'name'}}};
 const r=await planTurn({applicant:a,message:{body:'area_preview:zayed'},questions,areas:liveAreas,settings,interpret});
 assert.equal(r.patch.awaiting_id,'area');
 assert.equal(r.patch.answers.area,undefined);
 assert.equal(r.patch.answers.__area_preview.value,'zayed');
 assert.match(r.reply,/تفاصيل الشيخ زايد/);
 assert.match(r.reply,/تأكيد الشيخ زايد/);
});

test('applicant can preview multiple areas before confirming one',async()=>{
 const liveAreas=[areas[0],{id:'zayed',name:'الشيخ زايد',active:true,details:'تفاصيل الشيخ زايد'}];
 const base={...applicant,awaiting_id:'area',answers:{name:{value:'سيد محمد',kind:'name'},__area_preview:{value:'zayed',kind:'area_preview'}}};
 const r=await planTurn({applicant:base,message:{body:'area_preview:oct'},questions,areas:liveAreas,settings,interpret});
 assert.equal(r.patch.answers.area,undefined);
 assert.equal(r.patch.answers.__area_preview.value,'oct');
 assert.match(r.reply,/الشفت 9 ساعات/);
});

test('final area is saved only after explicit confirmation',async()=>{
 const liveAreas=[areas[0],{id:'zayed',name:'الشيخ زايد',active:true,details:'تفاصيل الشيخ زايد'}];
 const a={...applicant,awaiting_id:'area',answers:{name:{value:'سيد محمد',kind:'name'},__area_preview:{value:'zayed',display:'الشيخ زايد',kind:'area_preview'}}};
 const r=await planTurn({applicant:a,message:{body:'confirm_area:zayed'},questions,areas:liveAreas,settings,interpret});
 assert.equal(r.patch.answers.area.value,'zayed');
 assert.equal(r.patch.answers.__area_preview,undefined);
 assert.equal(r.patch.awaiting_id,'bike');
 assert.match(r.reply,/تم تثبيت منطقة التقديم: الشيخ زايد/);
});

test('forged confirmation without matching preview cannot choose an area',async()=>{
 const liveAreas=[areas[0],{id:'zayed',name:'الشيخ زايد',active:true,details:'تفاصيل الشيخ زايد'}];
 const a={...applicant,awaiting_id:'area',answers:{name:{value:'سيد محمد',kind:'name'}}};
 const r=await planTurn({applicant:a,message:{body:'confirm_area:zayed'},questions,areas:liveAreas,settings,interpret});
 assert.equal(r.patch.answers,undefined);
 assert.equal(r.patch.awaiting_id,'area');
 assert.match(r.reply,/اختار المنطقة الأول/);
});

test('plain text fallback previews first and confirms when repeated',async()=>{
 const liveAreas=[areas[0],{id:'zayed',name:'الشيخ زايد',active:true,details:'تفاصيل الشيخ زايد'}];
 const a={...applicant,awaiting_id:'area',answers:{name:{value:'سيد محمد',kind:'name'}}};
 const first=await planTurn({applicant:a,message:{body:'أكتوبر'},questions,areas:liveAreas,settings,interpret});
 assert.equal(first.patch.answers.area,undefined);
 assert.equal(first.patch.answers.__area_preview.value,'oct');
 const second=await planTurn({applicant:{...a,answers:first.patch.answers},message:{body:'أكتوبر'},questions,areas:liveAreas,settings,interpret});
 assert.equal(second.patch.answers.area.value,'oct');
 assert.equal(second.patch.awaiting_id,'bike');
});


test('knowledge matcher understands Egyptian wording variants',()=>{
 const rows=[{id:'k1',question:'ميعاد بداية التأمين الطبي امتى؟',answer:'من أول يوم',keywords:['تأمين طبي'],active:true}];
 const match=findKnowledgeAnswer('التأمين الطبي بيبدأ امتى؟',rows,.5);
 assert.equal(match.id,'k1');assert.ok(match.confidence>=.5);
});

test('approved knowledge answers side questions then resumes the pending application question',async()=>{
 const kb=[{id:'k1',question:'التأمين الطبي بيبدأ امتى؟',answer:'التأمين الطبي يبدأ بعد استكمال إجراءات التعيين.',keywords:['تأمين طبي'],active:true}];
 const a={...applicant,awaiting_id:'name'};
 const r=await planTurn({applicant:a,message:{body:'التأمين الطبي بيبدأ امتى؟'},questions,areas,settings:{...settings,ai_knowledge_enabled:true,ai_confidence_threshold:.6,ai_fallback:'هحوّلك للفريق'},interpret,knowledge:kb});
 assert.equal(r.knowledge_id,'k1');assert.equal(r.patch.awaiting_id,'name');assert.equal(r.patch.bot_enabled,undefined);
 assert.match(r.reply,/التأمين الطبي يبدأ/);assert.match(r.reply,/اسمك بالكامل/);
});

test('unknown side question hands off safely instead of inventing an answer',async()=>{
 const a={...applicant,awaiting_id:'name'};
 const r=await planTurn({applicant:a,message:{body:'الإجازات الرسمية بتتحسب ازاي؟'},questions,areas,settings:{...settings,ai_knowledge_enabled:true,ai_confidence_threshold:.6,ai_fallback:'هحوّل سؤالك لمسؤول التوظيف'},interpret,knowledge:[]});
 assert.equal(r.handoff,true);assert.equal(r.patch.bot_enabled,false);assert.equal(r.patch.awaiting_id,'name');
 assert.match(r.reply,/مسؤول التوظيف/);assert.equal(r.patch.answers.__ai_handoff.reason,'low_confidence');
});

test('only useful staff answers become learning candidates',()=>{
 assert.equal(isLearnableExchange('التأمين الطبي بيبدأ امتى؟','بيبدأ بعد استكمال إجراءات التعيين.'),true);
 assert.equal(isLearnableExchange('اسمي سيد احمد','تمام'),false);
 assert.equal(isLearnableExchange('المحاضرة امتى؟','تمام'),false);
});


test('training mode can collect useful staff answers even when the applicant phrased a statement',()=>{
 assert.equal(isLearnableExchange('معايا رخصة بس منتهية','ينفع تكمل التقديم ومسؤول التوظيف هيراجع حالة الرخصة.',{force:true}),true);
 assert.equal(isLearnableExchange('معايا رخصة بس منتهية','تمام',{force:true}),false);
});


test('explicitly re-enabled bot can reply even after lecture or working stage',async()=>{
 const a={...applicant,stage:'working',bot_enabled:true,awaiting_id:null,answers:{
  name:{value:'سيد محمد',display:'سيد محمد',kind:'name'},
  area:{value:'oct',display:'أكتوبر',kind:'area'},
  bike:{value:true,display:'نعم',kind:'yes_no'}
 }};
 const r=await run(a,'السلام عليكم');
 assert.match(r.reply,/بياناتك متسجلة عندنا بالفعل/);
});

test('disabled applicant bot stays silent until explicitly re-enabled',async()=>{
 const r=await run({...applicant,bot_enabled:false,awaiting_id:'name'},'سيد محمد');
 assert.equal(r.reply,'');assert.deepEqual(r.patch,{});
});


test('generic available-areas question is answered directly instead of handed off',async()=>{
 const liveAreas=[areas[0],{id:'zayed',name:'الشيخ زايد',active:true,details:'تفاصيل الشيخ زايد'}];
 const r=await planTurn({
  applicant:{...applicant,awaiting_id:'name'},
  message:{body:'ممكن تقولي المناطق المتاحة للشغل'},
  questions,areas:liveAreas,
  settings:{...settings,ai_knowledge_enabled:true,ai_confidence_threshold:.6,ai_fallback:'هحوّلك للفريق'},
  interpret,knowledge:[]
 });
 assert.match(r.reply,/المناطق المتاحة موجودة في الأزرار/);
 assert.doesNotMatch(r.reply,/• أكتوبر/);
 assert.doesNotMatch(r.reply,/• الشيخ زايد/);
 assert.match(r.reply,/اسمك بالكامل/);
 assert.equal(r.handoff,undefined);
});

test('short "المناطق" message after completion returns area list, not completion receipt',async()=>{
 const liveAreas=[areas[0],{id:'zayed',name:'الشيخ زايد',active:true,details:'تفاصيل الشيخ زايد'}];
 const completeApplicant={...applicant,stage:'complete',awaiting_id:null,answers:{
  name:{value:'سيد محمد',display:'سيد محمد',kind:'name'},
  area:{value:'oct',display:'أكتوبر',kind:'area'},
  bike:{value:true,display:'نعم',kind:'yes_no'}
 }};
 const r=await planTurn({applicant:completeApplicant,message:{body:'المناطق'},questions,areas:liveAreas,settings,interpret,knowledge:[]});
 assert.match(r.reply,/المناطق المتاحة موجودة في الأزرار/);
 assert.doesNotMatch(r.reply,/تم الاستلام/);
});

test('unrecognized message after completion does not repeat the completion receipt',async()=>{
 const completeApplicant={...applicant,stage:'complete',awaiting_id:null,answers:{
  name:{value:'سيد محمد',display:'سيد محمد',kind:'name'},
  area:{value:'oct',display:'أكتوبر',kind:'area'},
  bike:{value:true,display:'نعم',kind:'yes_no'}
 }};
 const r=await run(completeApplicant,'تمام يا باشا');
 assert.match(r.reply,/بياناتك متسجلة عندنا بالفعل/);
 assert.doesNotMatch(r.reply,/تم الاستلام/);
});


test('area question text never lists area names because choices are buttons only',()=>{
 const liveAreas=[areas[0],{id:'zayed',name:'الشيخ زايد',active:true,details:'تفاصيل الشيخ زايد'}];
 const text=questionPrompt(questions[1],liveAreas);
 assert.match(text,/اختار المنطقة من الأزرار/);
 assert.doesNotMatch(text,/• أكتوبر/);
 assert.doesNotMatch(text,/• الشيخ زايد/);
});

test('completed applicant can browse area details from area buttons without changing application data',async()=>{
 const liveAreas=[areas[0],{id:'zayed',name:'الشيخ زايد',active:true,details:'تفاصيل الشيخ زايد'}];
 const completeApplicant={...applicant,stage:'complete',awaiting_id:null,answers:{
  name:{value:'سيد محمد',display:'سيد محمد',kind:'name'},
  area:{value:'oct',display:'أكتوبر',kind:'area'},
  bike:{value:true,display:'نعم',kind:'yes_no'}
 }};
 const r=await planTurn({applicant:completeApplicant,message:{body:'area_preview:zayed'},questions,areas:liveAreas,settings,interpret,knowledge:[]});
 assert.match(r.reply,/تفاصيل الشيخ زايد/);
 assert.match(r.reply,/اختار منطقة تانية من الأزرار/);
 assert.equal(r.patch.answers,undefined);
});


test('area button pagination changes page without listing names in message text',async()=>{
 const manyAreas=Array.from({length:15},(_,i)=>({id:'a'+i,name:'منطقة '+(i+1),active:true,details:'تفاصيل '+(i+1)}));
 const a={...applicant,awaiting_id:'area',answers:{name:{value:'سيد محمد',kind:'name'}}};
 const r=await planTurn({applicant:a,message:{body:'area_page:1'},questions,areas:manyAreas,settings,interpret,knowledge:[]});
 assert.equal(r.patch.answers.__area_page.value,1);
 assert.match(r.reply,/صفحة 2 من 3/);
 assert.match(r.reply,/اختار المنطقة من الأزرار/);
 assert.doesNotMatch(r.reply,/منطقة 8/);
});


test('unknown side question while previewing an area produces a handoff reply and preserves the area preview',async()=>{
 const liveAreas=[
  {id:'zayed-market',name:'الشيخ زايد',active:true,details:'تفاصيل ماركت'},
  {id:'zayed-rest',name:'الشيخ زايد مطاعم',active:true,details:'تفاصيل مطاعم'}
 ];
 const a={...applicant,awaiting_id:'area',answers:{
  name:{value:'سيد محمد',kind:'name'},
  __area_preview:{value:'zayed-rest',display:'الشيخ زايد مطاعم',kind:'area_preview'}
 }};
 const r=await planTurn({
  applicant:a,
  message:{body:'طيب ايه الفرق بين المطاعم والماركت'},
  questions,areas:liveAreas,
  settings:{...settings,ai_knowledge_enabled:true,ai_confidence_threshold:.62,ai_fallback:'السؤال ده محتاج تأكيد من مسؤول التوظيف، هحوّل المحادثة للفريق.'},
  interpret,knowledge:[]
 });
 assert.equal(r.handoff,true);
 assert.equal(r.patch.bot_enabled,false);
 assert.equal(r.patch.answers.__area_preview.value,'zayed-rest');
 assert.equal(r.patch.answers.__ai_handoff.question,'طيب ايه الفرق بين المطاعم والماركت');
 assert.match(r.reply,/هحوّل المحادثة للفريق/);
});
