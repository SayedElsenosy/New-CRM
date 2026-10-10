import {norm} from './domain.js';
import {requiresResidenceDisambiguation,nearestWorkAreas,resolveKnownPlace} from './location.js';
import {areaPlaceKey,compactAreaSummary} from './area-advisor.js';

const near=/اقرب|قريب|قريبه|الاقرب|الناحيه|ارشح|ترشح/;
const confused=/مش فاهم|مش فاهمه|مش واضح|وضحلي|وضح لي|قصدك ايه|تقصد ايه|يعني ايه|مش فاهم قصدك/;
const unsure=/مش عارف|معرفش|ماعرفش|مبعرفش|مش متاكد/;
const yes=/^(?:ايوه|اه|نعم|صح|بالضبط|دي|هي|ايوه هي)\s*[.!؟?]*$/;
const notHaram=/(?:مش|موش|غير)\s+(?:ناحيه\s+)?(?:الهرم|الجيزه)|(?:مكان|منطقه)\s+تان(?:ي|يه)/;
const mentionsHaram=/(?:^|\s)الهرم(?:\s|$)/;
const locationTopic=/(?:ساكن|سكن|اقرب|قريب|منصوريه|منصورية|الهرم|الجيزه|جيزه|معلم|حي|فين)/;
const explicitWorkSelection=/(?:عايز|عاوز|حابب)\s+اشتغل\s+في\s+الهرم|(?:هشتغل|اختار|اختياري|ثبت)\s+(?:في\s+)?الهرم/;
const jobDetailsIntent=/(?:تفاصيل|نظام الشغل|مرتب|قبض|مميزات|راتب|شيفت)/;

function canonicalPlace(area){
 const raw=areaPlaceKey(area)||area?.name||'';
 return resolveKnownPlace(raw)?.key||norm(raw).replace(/\s+/g,'');
}
function eligible(areas){
 return (areas||[]).filter(a=>a?.active===true&&a?.recruitment_eligible!==false);
}
function uniqueChoices(areas,limit=6){
 const seen=new Set(),choices=[];
 for(const row of areas){
  const key=canonicalPlace(row);
  if(!key||seen.has(key))continue;
  seen.add(key);
  choices.push(String(areaPlaceKey(row)||row.name).trim());
  if(choices.length>=limit)break;
 }
 return choices;
}
function officeOptions(areas){return uniqueChoices(eligible(areas),7);}
function simpleQuestion(prefix){
 return prefix+'\n\nهل تقصد المنصورية اللي ناحية الهرم في الجيزة؟ رد «أيوه» أو «لا» أو «مش عارف».';
}
function generalOptions(areas){
 const names=officeOptions(areas);
 return 'ولا يهمك، مش لازم تكون عارف اسم أقرب منطقة شغل بنفسك. '
 +'اسم «المنصورية» لوحده مش كفاية أحدد منه المسافة من بيتك بدقة.'
 +(names.length?'\n\nدي بعض مناطق الشغل المتاحة عندنا (مش مترتبة حسب القرب):\n'+names.map(x=>'• '+x).join('\n')
  :'\n\nمش ظاهر لي مناطق مؤكدة متاحة حاليًا.')
 +'\n\nلو تعرف أقرب حي أو شارع رئيسي مشهور جنبك قولّي اسمه، أو قول «عايز موظف» ونساعدك تختار. مش هسجّل منطقة عمل إلا لما تختارها بنفسك.';
}
function haramReference(areas){
 const available=eligible(areas);
 const nearest=nearestWorkAreas('الهرم',available,{limit:5});
 const options=uniqueChoices((nearest?.items||[]).map(r=>r.area),5);
 return 'تمام، فهمت إنك تقصد المنصورية ناحية الهرم في الجيزة. '
 +'هستخدم الهرم كمرجع عام، مش عنوان بيتك بالضبط.'
 +(options.length?'\n\nمناطق شغل ممكن نبدأ نقارنها تقريبًا من ناحية الهرم:\n'+options.map(x=>'• '+x).join('\n')
  :'\n\nمش لاقي اختيارات عمل مؤكدة متاحة من المناطق المسجلة.')
 +'\n\nدي ترشيحات مبدئية، مش مسافات لعنوانك ولا اختيار مؤكد للعمل. تحب أعرفك بتفاصيل شغل الهرم، ولا نقارن منطقتين؟';
}
function haramAreaInfo(areas){
 const rows=eligible(areas).filter(a=>canonicalPlace(a)==='haram');
 if(!rows.length)return 'الهرم وصلني كمرجع لمكان سكنك، بس مش عندي فرصة مؤكدة متاحة في الهرم نفسها حاليًا.';
 return 'بالنسبة لشغل الهرم المسجل عندنا:\n'+rows.slice(0,2).map(a=>
   '• '+a.name+': '+compactAreaSummary(a)).join('\n');
}
function acknowledgedHaram(areas){
 return 'معاك حق، أنت قلت «الهرم» بالفعل وأنا كررت نفس الكلام. '
 +'فهمت إنك بتتكلم عن المنصورية ناحية الهرم، وده مكان سكنك مش اختيارك النهائي للشغل.\n\n'
 +haramAreaInfo(areas)
 +'\n\nلو عايز تشوف تفاصيل شغل الهرم قول «تفاصيل شغل الهرم»، '
 +'ولو عايز تقارنها بمناطق تانية قول «قارن المناطق».';
}
function followupHaram(areas){
 const options=uniqueChoices(eligible(areas),3);
 return 'فاكر إنك قلت «الهرم» ✅. مش هطلب منك مكان سكنك تاني. '
 +haramAreaInfo(areas)
 +(options.length?'\n\nممكن نقارن مع '+options.filter(x=>!mentionsHaram.test(norm(x))).slice(0,2).join(' أو ')+'.':'')
 +'\n\nلو قصدك تشتغل في الهرم نفسها، قول «عايز اشتغل في الهرم» علشان نراجع اختيار العمل بشكل منفصل عن السكن.';
}

/**
 * State-aware read-only residence assistance. A repeated locality must advance
 * the conversation, never resend an identical list. This cannot select a work
 * area, decide eligibility or use uncertain coordinates.
 */
export function mansouriyaGuidance({text='',previous=null,areas=[]}={}){
 const body=String(text||'').trim(),n=norm(body);
 const mentions=requiresResidenceDisambiguation(body);
 // A comparison of job areas is not a request to identify the applicant's
 // residence. Let the CRM comparison advisor handle that intent.
 if(/(?:قارن|مقارن|مقارنه|الفرق|انسب|احسن|افضل)/.test(n)
   &&/(?:شغل|وظيفه|مطاعم|ماركت|زايد|اكتوبر|الهرم)/.test(n))return null;
 const pending=previous?.kind==='mansouriya_unverified';
 if(!mentions&&!pending)return null;

 // An explicit work-area commitment or a new job/pay question must follow the
 // normal verified CRM paths rather than be consumed by residence assistance.
 if(pending&&explicitWorkSelection.test(n))return null;
 if(pending&&jobDetailsIntent.test(n)&&mentionsHaram.test(n))return null;
 if(pending&&!mentions&&!locationTopic.test(n)&&!confused.test(n)&&!unsure.test(n)&&!yes.test(n)&&!notHaram.test(n))return null;

 const phase=previous?.phase||'ask_region';
 if(pending&&notHaram.test(n)){
  return {reply:'تمام، مش هفترض إنها ناحية الهرم. لو تعرف أقرب حي أو مكان كبير مشهور جنبك قولّي. ولو مش عارف قول «مش عارف» وهعرضلك مناطق الشغل المسجلة بدون ما أخمن المسافات.',
   phase:'ask_landmark',action:'clarify_residence_location'};
 }
 const fromHaram=mentionsHaram.test(n);
 if(fromHaram||(pending&&yes.test(n)&&phase==='ask_region')){
  if(pending&&['reference_offered','work_detail_offered','followup_clarified'].includes(phase)){
   if(phase==='followup_clarified')return {
    reply:'إنت قلت الهرم أكتر من مرة وأنا لسه ما ساعدتكش تختار شغل. هحوّل المحادثة لمسؤول التوظيف يساعدك يراجع أقرب منطقة مناسبة من غير تخمين.',
    phase:'handoff',reference_place:'haram',action:'residence_handoff',needsHuman:true
   };
   return {reply:phase==='reference_offered'?acknowledgedHaram(areas):followupHaram(areas),
    phase:phase==='reference_offered'?'work_detail_offered':'followup_clarified',
    reference_place:'haram',action:'residence_context_followup'};
  }
  return {reply:haramReference(areas),phase:'reference_offered',reference_place:'haram',action:'residence_reference_options'};
 }
 if(pending&&unsure.test(n)&&!near.test(n)){
  return {reply:generalOptions(areas),phase:'options_offered',action:'residence_options_without_distance'};
 }
 if(pending&&near.test(n)){
  return {reply:simpleQuestion('فاهمك، أنت بتسأل عن أقرب مكان شغل لبيتك، مش مطلوب منك تكون عارف المنطقة المناسبة. علشان ما أرشحلكش مكان بعيد بالغلط، محتاج أتأكد من أي «منصورية» تقصد.'),
   phase:'ask_region',action:'clarify_residence_location'};
 }
 if(pending&&confused.test(n)){
  return {reply:simpleQuestion('أقصد حاجة بسيطة: عايز أعرف مكان المنصورية اللي ساكن فيها، علشان أساعدك تختار شغل قريب. مش بطلب منك تختار منطقة العمل دلوقتي.'),
   phase:'ask_region',action:'clarify_residence_location'};
 }
 if(mentions){
  return {reply:simpleQuestion('تمام، فهمت إنك تقصد المنصورية مش المنصورة ✅. علشان ما أحسبش مسافات من مكان غلط، خلّيني أتأكد من المنطقة.'),
   phase:'ask_region',action:'clarify_residence_location'};
 }
 return null;
}
