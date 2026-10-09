import {norm} from './domain.js';
import {areaMode,areaPlaceKey} from './area-advisor.js';

// Exact payroll *day* is not available in area details. Only report the
// cadence explicitly approved in the office's own CRM area description.
export function asksPaymentTiming(text){
 const n=norm(text);
 const pay=/(?:قبض|مرتبات?|رواتب|راتب|فلوس|صرف)/.test(n);
 const timing=/(?:امتي|امتى|متي|ميعاد|معاد|موعد|يوم|تاريخ|اسبوعي|اسبوعيا|شهري|بينزل|تنزل|ينزل|هستلم|استلم|اتاكد|اتأكد|تاكد|تاكيد|اعرف|تقول)/.test(n);
 return pay&&timing&&!/(?:القبض كام|الراتب كام|المرتب كام|دخل كام)/.test(n);
}
function schedule(details){
 const d=norm(details);
 if(!/(?:القبض|نظام القبض|صرف المرتب|المرتب|الراتب)/.test(d))return null;
 if(/(?:قبض|القبض|نظام القبض)[\s\S]{0,25}اسبوعي\s+او\s+شهري/.test(d))return 'أسبوعي أو شهري';
 if(/(?:قبض|القبض|نظام القبض)[\s\S]{0,36}اسبوعي/.test(d))return 'أسبوعي';
 if(/(?:قبض|القبض|نظام القبض)[\s\S]{0,36}شهري/.test(d))return 'شهري';
 return null;
}
function targetAreas(areas,answers,text){
 const active=(areas||[]).filter(x=>x.active===true);
 const n=norm(text);
 const byDirect=active.filter(a=>n.includes(norm(a.name)) ||
  (norm(areaPlaceKey(a)).length>=4&&n.includes(norm(areaPlaceKey(a)))));
 const explicit=byDirect[0];
 let place=explicit?areaPlaceKey(explicit):answers?.__area_context?.place_key||null;
 const preview=active.find(a=>String(a.id)===String(answers?.__area_preview?.value||''));
 if(!place&&preview)place=areaPlaceKey(preview);
 if(!place){
  const chosen=Object.values(answers||{}).find(a=>a?.key==='preferred_work_area'&&a.value);
  place=areaPlaceKey(active.find(a=>String(a.id)===String(chosen?.value))||{});
 }
 if(!place)return [];
 let group=active.filter(a=>norm(areaPlaceKey(a))===norm(place));
 const explicitMode=/(?:ماركت|سوبر\s*ماركت)/.test(n)?'market':/(?:مطاعم|مطعم)/.test(n)?'restaurants':null;
 const hintedMode=explicitMode||(preview&&norm(areaPlaceKey(preview))===norm(place)?areaMode(preview):null);
 if(hintedMode&&group.some(a=>areaMode(a)===hintedMode))group=group.filter(a=>areaMode(a)===hintedMode);
 return group.filter(a=>areaMode(a)!=='general'&&schedule(a.details));
}
export function paymentTimingAdvice({text,areas,answers={}}={}){
 if(!asksPaymentTiming(text))return null;
 const selected=targetAreas(areas,answers,text);
 if(!selected.length)return {
  reply:'علشان أقولك نظام القبض من المعلومات المسجلة، تقصد أنهي منطقة شغل، وماركت ولا مطاعم؟',
  hasVerifiedSchedule:false,needsHuman:false
 };
 const lines=[...new Set(selected.map(a=>{
  const cadence=schedule(a.details);
  const card=areaMode(a)==='restaurants'?'مطاعم':areaMode(a)==='market'?'ماركت':'الشغل';
  return '• '+a.name+' ('+card+'): '+cadence+(cadence==='أسبوعي'&&/الفيزا/.test(norm(a.details))?' على الفيزا':'');
 }))];
 const insist=/(?:اتاكد|اتأكد|تاكيد|تأكيد|بالتحديد|بالضبط|يوم ايه|انهي يوم|موعد القبض|ميعاد القبض|معاد القبض|عايز اعرف|عاوز اعرف)/.test(norm(text));
 const needsHuman=insist&&answers?.__payment_schedule_pending?.kind==='payment_schedule_pending';
 return {
  reply:'نظام القبض المسجل عندنا:\n'+lines.join('\n')+
   '\n\nيوم الصرف المحدد مش مسجل عندي، ومش هقولك موعد من غير تأكيد.'+
   (needsHuman?'\nهحوّل سؤالك لمسؤول التوظيف علشان يؤكد لك اليوم بالضبط.':'\nلو محتاج اليوم بالضبط، قولّي وهنراجع مع مسؤول التوظيف.'),
  hasVerifiedSchedule:true,needsHuman,
  markPending:true
 };
}
