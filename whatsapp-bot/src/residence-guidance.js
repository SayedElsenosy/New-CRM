import {norm} from './domain.js';
import {requiresResidenceDisambiguation,nearestWorkAreas} from './location.js';
import {areaPlaceKey} from './area-advisor.js';

const has=(text,pattern)=>pattern.test(norm(text));
const near=/اقرب|قريب|قريبه|الاقرب|الناحيه|ارْشح|ارشح|ترشح/;
const confused=/مش فاهم|مش فاهمه|مش واضح|وضحلي|وضح لي|قصدك ايه|تقصد ايه|يعني ايه|مش فاهم قصدك/;
const unsure=/مش عارف|معرفش|ماعرفش|معرفش|مبعرفش|مش متاكد|ماعرفش/;
const yes=/^(?:ايوه|اه|نعم|صح|بالضبط|دي|هي|ايوه هي)\s*[.!؟?]*$/;
const notHaram=/(?:مش|موش|غير)\s+(?:ناحيه\s+)?(?:الهرم|الجيزه)|(?:مكان|منطقه)\s+تان(?:ي|يه)/;

function officeOptions(areas){
 const keys=new Map();
 for(const area of areas||[]){
  if(area?.active!==true||area?.recruitment_eligible===false)continue;
  const place=String(areaPlaceKey(area)||area.name||'').trim();
  if(place&&!keys.has(norm(place)))keys.set(norm(place),place);
 }
 return [...keys.values()].slice(0,7);
}
function simpleQuestion(prefix){
 return prefix+'\n\nهل تقصد المنصورية اللي ناحية الهرم في الجيزة؟ رد «أيوه» أو «لا» أو «مش عارف».';
}
function generalOptions(areas){
 const names=officeOptions(areas);
 return 'ولا يهمك، مش لازم تكون عارف اسم أقرب منطقة شغل بنفسك. '
 +'اسم «المنصورية» لوحده مش كفاية أحدد منه المسافة من بيتك بدقة.'
 +(names.length?'\n\nدي بعض مناطق الشغل المتاحة عندنا (مش مترتبة حسب القرب):\n'+names.map(x=>'• '+x).join('\n'):'')
 +'\n\nلو تعرف أقرب حي أو شارع رئيسي مشهور جنبك قولّي اسمه، أو قول «عايز موظف» ونساعدك تختار. مش هسجّل منطقة عمل إلا لما تختارها بنفسك.';
}
function haramReference(areas){
 const eligible=(areas||[]).filter(a=>a?.active===true&&a?.recruitment_eligible!==false);
 const nearest=nearestWorkAreas('الهرم',eligible,{limit:5});
 const seen=new Set(),options=[];
 for(const row of nearest?.items||[]){
  const name=String(row.area.name||'').trim(),key=norm(areaPlaceKey(row.area)||name);
  if(key&&!seen.has(key)){options.push(areaPlaceKey(row.area)||name);seen.add(key);}
 }
 return 'تمام، هستخدم الهرم كمرجع عام لأنك قلت إن المنصورية ناحيته، مش كموقع دقيق لبيتك.'
 +(options.length?'\n\nمناطق شغل ممكن نبدأ نقارنها تقريبًا من ناحية الهرم:\n'+options.map(x=>'• '+x).join('\n')
   :'\n\nقولّي أقرب حي معروف ليك علشان نقارن مناطق الشغل المتاحة.')
 +'\n\nده اقتراح مبدئي من مركز منطقة الهرم، مش مسافات لعنوانك ولا اختيار مؤكد للعمل. تحب تفاصيل أنهي منطقة؟';
}

/**
 * Read-only location assistance while a Mansouriya name remains ambiguous.
 * Does not geocode imprecise residence, save a work-area answer or qualify.
 */
export function mansouriyaGuidance({text='',previous=null,areas=[]}={}){
 const body=String(text||'').trim(),n=norm(body);
 const mentions=requiresResidenceDisambiguation(body);
 const pending=previous?.kind==='mansouriya_unverified';
 if(!mentions&&!pending)return null;
 // Let explicit non-location questions pass to normal HR/office answer flow.
 if(!mentions&&!near.test(n)&&!confused.test(n)&&!unsure.test(n)&&!yes.test(n)
   &&!notHaram.test(n)&&!/(?:الهرم|الجيزه|جيزه)/.test(n))return null;

 const fromHaram=/(?:الهرم|ناحيه الهرم|جنب الهرم)/.test(n)
  &&!notHaram.test(n);
 if(fromHaram||(pending&&yes.test(n))){
  return {reply:haramReference(areas),phase:'reference_offered',action:'residence_reference_options'};
 }
 if(pending&&notHaram.test(n)){
  return {reply:'تمام، مش هفترض إنها ناحية الهرم. لو تعرف أقرب حي أو مكان كبير مشهور جنبك قولّي. ولو مش عارف قول «مش عارف» وهعرضلك مناطق الشغل المتاحة بدون ما أخمن المسافات.',
   phase:'ask_landmark',action:'clarify_residence_location'};
 }
 if(pending&&unsure.test(n)&&!near.test(n)){
  return {reply:generalOptions(areas),phase:'options_offered',action:'residence_options_without_distance'};
 }
 if(pending&&near.test(n)){
  return {reply:simpleQuestion('فاهمك، أنت بتسأل عن أقرب مكان شغل لبيتك، مش مطلوب منك تكون عارف المنطقة المناسبة. علشان ما أرشحلكش مكان بعيد بالغلط، محتاج أتأكد من أي «منصورية» تقصد.'),phase:'ask_region',action:'clarify_residence_location'};
 }
 if(pending&&confused.test(n)){
  return {reply:simpleQuestion('أقصد حاجة بسيطة: عايز أعرف مكان المنصورية اللي ساكن فيها، علشان أساعدك تختار شغل قريب. مش بطلب منك تختار منطقة العمل دلوقتي.'),phase:'ask_region',action:'clarify_residence_location'};
 }
 if(mentions){
  return {reply:simpleQuestion('تمام، فهمت إنك تقصد المنصورية مش المنصورة ✅. علشان ما أحسبش مسافات من مكان غلط، خلّيني أتأكد من المنطقة.'),phase:'ask_region',action:'clarify_residence_location'};
 }
 return null;
}
