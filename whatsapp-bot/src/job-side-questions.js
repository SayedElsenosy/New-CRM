import {norm} from './domain.js';
import {areaPlaceKey,areaMode} from './area-advisor.js';

/** Read-only answers to employment side questions. Never qualify an applicant. */
const SHIFT_INTENT=/(?:شفت|شيفت|الورديه|ورديه|ورديات|مواعيد\s+(?:العمل|عمل|الشغل|شغل)|ساعات\s+(?:العمل|عمل|الشغل|شغل)|من\s+كام\s+(?:ل|الي|الى)?\s*كام)/;
const REQUIREMENT_INTENT=/(?:عربيه|عربيات|موتوسيكل|موتوسكل|موتسيكل|متوسيكل|مكنه|موتور)/;
const REQUIREMENT_QUESTION=/(?:لازم|مطلوب|شرط|ينفع|المميزات|مميزات|هل|ايه|محتاج)/;
const DIGITS='٠١٢٣٤٥٦٧٨٩';
const normalizeText=text=>norm(String(text||'')).replace(/[٠-٩]/g,c=>String(DIGITS.indexOf(c)));
function currentArea(answers,areas){
 const candidates=[
  {id:answers?.__last_area_details?.area_id,at:answers?.__last_area_details?.at},
  {id:answers?.__area_preview?.value,at:answers?.__area_preview?.at}
 ].filter(x=>x.id).sort((a,b)=>Date.parse(b.at||0)-Date.parse(a.at||0));
 for(const ref of candidates){
  const area=(areas||[]).find(x=>x.active===true&&String(x.id)===String(ref.id));
  if(area)return area;
 }
 const key=answers?.__area_context?.place_key;
 if(!key)return null;
 const family=(areas||[]).filter(x=>x.active===true&&norm(areaPlaceKey(x))===norm(key));
 return family.length===1?family[0]:family.length>1?{ambiguous:true,place:key}:null;
}
function shiftFacts(area){
 const source=normalizeText(area?.details||'');
 const duration=source.match(/(?:شفت|شيفت|ساعات?\s+عمل)[\s\S]{0,55}?(\d{1,2})\s*ساع/)
  ||source.match(/(\d{1,2})\s*ساعات?\s*(?:فقط|للشفت|شفت|شيفت)?/);
 const durationHours=duration?Number(duration[1]):null;
 return durationHours>=1&&durationHours<=16?durationHours:null;
}
function requirementFacts(area){
 const source=normalizeText(area?.details||'');
 const moto=/(?:يشترط|مطلوب|لازم)[\s\S]{0,35}?(?:موتوسيكل|موتس?يكل|متوسيكل|موتوسكل)/.test(source);
 const benefits=[];
 if(/تامين\s+اجتماعي/.test(source))benefits.push('تأمين اجتماعي');
 if(/تامين\s+طبي/.test(source))benefits.push('تأمين طبي');
 if(/بونص/.test(source))benefits.push('بونص');
 return {moto,benefits};
}
export function initialApplicantQuestion({text='',areas=[]}={}){
 const n=normalizeText(text);
 if(!REQUIREMENT_INTENT.test(n)||!REQUIREMENT_QUESTION.test(n))return null;
 // Do not generalize from one vacancy to all job locations.
 const row=(areas||[]).find(x=>x.active===true&&requirementFacts(x).moto);
 if(!row)return 'شرط العربية أو الموتوسيكل بيتحدد حسب الوظيفة والمنطقة، ومش عندي تأكيد إن العربية بديل مقبول. أنهي منطقة شغل حابب تعرف شروطها؟';
 const {benefits}=requirementFacts(row);
 return 'بالنسبة للشروط والمميزات: مثلًا في '+row.name
  +' المسجل عندنا إن الشغل محتاج موتوسيكل، ومش مسجل إن العربية بديل مقبول.'
  +(benefits.length?'\nالمميزات هناك: '+benefits.slice(0,3).join('، ')+'.':'')
  +'\n\nإيه منطقة الشغل اللي تقدر تلتزم بيها يوميًا علشان أوضح لك شروطها بالتحديد؟';
}
export function clarifyUnlocatedNearbyRequest(text=''){
 const n=normalizeText(text);
 if(!/(?:اقرب|قريب|القريب)/.test(n)||!/(?:السلام|للسلام|مدينه السلام)/.test(n))return null;
 return {
  action:'clarify_nearby_origin',
  reply:'تقصد مدينة السلام في القاهرة؟ لو أيوه، قولّي أقرب شارع أو معلم عندك علشان أساعدك نقارن المناطق المتاحة. اسم المنطقة لوحده مش كفاية إني أضمن لك أنهي مكان شغل الأقرب من غير عنوان موقع عمل دقيق.'
 };
}
export function contextualShiftQuestion({text='',answers={},areas=[]}={}){
 const n=normalizeText(text);
 if(!SHIFT_INTENT.test(n))return null;
 // Explicit queries such as "الشيفت في ماركت العبور" belong to the existing
 // full job-details advisor. Only short contextual followups use this handler.
 if(/(?:^|\s)(?:ماركت|مطاعم|مطعم)(?:\s|$)/.test(n)
  &&(areas||[]).some(a=>a?.active===true&&n.includes(norm(areaPlaceKey(a)))))
  return null;
 const area=currentArea(answers,areas);
 if(area?.ambiguous)return {
  action:'clarify_context_shift_mode',
  reply:'فاكر إننا بنتكلم عن شغل '+area.place+'، بس فيه أكتر من نظام هناك. تقصد شيفت الماركت ولا المطاعم؟'
 };
 if(!area)return {
  action:'clarify_shift_area',
  reply:'أقدر أقولك ساعات الشيفت من تفاصيل الوظيفة المسجلة، لكن بتختلف حسب المنطقة ونظام الشغل. تقصد أنهي منطقة ونظام: ماركت ولا مطاعم؟'
 };
 const hours=shiftFacts(area);
 const asksClock=/(?:من\s+كام|ل\s+كام|يبدا|تبدأ|صباح|مساء|بالليل|الصبح|مواعيد|ثابت|محدد|شفتات|شيفتات)/.test(n);
 const headline=hours?'بالنسبة لـ'+area.name+': الشيفت المسجل '+hours+' ساعات.':
  'بالنسبة لـ'+area.name+': عدد ساعات الشيفت مش محدد في بيانات الوظيفة.';
 const note=asksClock?' لكن مواعيد البداية والنهاية مش مؤكدة في البيانات، وكمان مش موضح إذا فيه شيفت صباحي أو مسائي؛ وده محتاج تأكيد من مسؤول التشغيل.':'';
 return {action:'answer_contextual_shift',reply:headline+note+
  '\n\nتحب أسأل المسؤول عن مواعيد البداية والنهاية، ولا نكمل تفاصيل الشغل هنا؟'};
}
