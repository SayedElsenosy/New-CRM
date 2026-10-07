import {norm} from './domain.js';

const PLACES=[
 {key:'imbaba',label:'إمبابة',lat:30.077,lng:31.210,aliases:['امبابه','امبابة','إمبابة']},
 {key:'mohandessin',label:'المهندسين',lat:30.057,lng:31.200,aliases:['المهندسين','مهندسين']},
 {key:'agouza',label:'العجوزة',lat:30.053,lng:31.214,aliases:['العجوزه','العجوزة']},
 {key:'dokki',label:'الدقي',lat:30.038,lng:31.212,aliases:['الدقي']},
 {key:'kitkat',label:'الكيت كات',lat:30.067,lng:31.214,aliases:['الكيت كات','كيت كات']},
 {key:'warraq',label:'الوراق',lat:30.102,lng:31.205,aliases:['الوراق']},
 {key:'ard_ellewa',label:'أرض اللواء',lat:30.064,lng:31.185,aliases:['ارض اللواء','أرض اللواء']},
 {key:'bulaq_dakrour',label:'بولاق الدكرور',lat:30.035,lng:31.188,aliases:['بولاق الدكرور','بولاق دكرور']},
 {key:'giza',label:'الجيزة',lat:30.013,lng:31.209,aliases:['الجيزه','الجيزة','ميدان الجيزه','ميدان الجيزة']},
 {key:'faisal',label:'فيصل',lat:30.004,lng:31.168,aliases:['فيصل']},
 {key:'haram',label:'الهرم',lat:29.997,lng:31.164,aliases:['الهرم']},
 {key:'hadayek_ahram',label:'حدائق الأهرام',lat:29.976,lng:31.130,aliases:['حدائق الاهرام','حدايق الاهرام','حدائق الأهرام','حدايق الأهرام']},
 {key:'october',label:'أكتوبر',lat:29.973,lng:30.944,aliases:['6 اكتوبر','6 أكتوبر','٦ اكتوبر','٦ أكتوبر','السادس من اكتوبر','السادس من أكتوبر','اكتوبر','أكتوبر']},
 {key:'zayed',label:'الشيخ زايد',lat:30.014,lng:30.976,aliases:['الشيخ زايد','شيخ زايد','زايد']},
 {key:'ferdous',label:'الفردوس',lat:29.957,lng:30.949,aliases:['الفردوس']},
 {key:'hadayek_october',label:'حدائق أكتوبر',lat:29.900,lng:30.973,aliases:['حدائق اكتوبر','حدايق اكتوبر','حدائق أكتوبر','حدايق أكتوبر']},
 {key:'maadi',label:'المعادي',lat:29.960,lng:31.257,aliases:['المعادي']},
 {key:'zahraa_maadi',label:'زهراء المعادي',lat:29.969,lng:31.304,aliases:['زهراء المعادي','الزهراء المعادي','زهراء المعادى']},
 {key:'mokattam',label:'المقطم',lat:30.011,lng:31.304,aliases:['المقطم']},
 {key:'nasr_city',label:'مدينة نصر',lat:30.056,lng:31.330,aliases:['مدينه نصر','مدينة نصر','نصر سيتي','نصر سيتى']},
 {key:'heliopolis',label:'مصر الجديدة',lat:30.091,lng:31.323,aliases:['مصر الجديده','مصر الجديدة','هليوبوليس']},
 {key:'nozha',label:'النزهة',lat:30.111,lng:31.344,aliases:['النزهه','النزهة']},
 {key:'abbassia',label:'العباسية',lat:30.071,lng:31.284,aliases:['العباسيه','العباسية']},
 {key:'shubra',label:'شبرا',lat:30.092,lng:31.245,aliases:['شبرا','شبرا مصر']},
 {key:'ain_shams',label:'عين شمس',lat:30.130,lng:31.319,aliases:['عين شمس']},
 {key:'matariya',label:'المطرية',lat:30.122,lng:31.312,aliases:['المطريه','المطرية']},
 {key:'marg',label:'المرج',lat:30.153,lng:31.337,aliases:['المرج']},
 {key:'tagamoa',label:'التجمع',lat:30.008,lng:31.429,aliases:['القاهره الجديده','القاهرة الجديدة','التجمع الاول','التجمع الأول','التجمع الثالث','التجمع الخامس','التجمع']},
 {key:'rehab',label:'الرحاب',lat:30.061,lng:31.493,aliases:['الرحاب']},
 {key:'madinaty',label:'مدينتي',lat:30.082,lng:31.637,aliases:['مدينتي','مدينتى']},
 {key:'shorouk',label:'الشروق',lat:30.119,lng:31.605,aliases:['الشروق']},
 {key:'obour',label:'العبور',lat:30.228,lng:31.479,aliases:['مدينه العبور','مدينة العبور','العبور']},
 {key:'helwan',label:'حلوان',lat:29.849,lng:31.334,aliases:['حلوان']}
];

const clean=value=>norm(String(value||''))
 .replace(/[،,.!?؟؛:()[\]{}"']/g,' ')
 .replace(/\b(?:ماركت|مطاعم|مطعم|restaurant|restaurants|market)\b/g,' ')
 .replace(/\s+/g,' ').trim();

const ALIASES=PLACES.flatMap(place=>place.aliases.map(alias=>({place,alias:clean(alias)})))
 .filter(x=>x.alias)
 .sort((a,b)=>b.alias.length-a.alias.length);

export function resolveKnownPlace(value){
 const text=clean(value);
 if(!text)return null;
 for(const item of ALIASES){
  if(text.includes(item.alias))return item.place;
 }
 return null;
}

function areaPlace(area){
 const sources=[area?.name,...(Array.isArray(area?.aliases)?area.aliases:[])].filter(Boolean);
 for(const source of sources){
  const hit=resolveKnownPlace(source);
  if(hit)return hit;
 }
 return null;
}

function distanceKm(a,b){
 const rad=x=>x*Math.PI/180,R=6371;
 const dLat=rad(b.lat-a.lat),dLng=rad(b.lng-a.lng);
 const s=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2;
 return 2*R*Math.asin(Math.sqrt(s));
}

export function asksForNearbyArea(value){
 const n=clean(value);
 return /(?:اقرب|أقرب|قريب|قريبه|قريبة|الناحيه|الناحية|ناحيه|ناحية|جنب|حوالي|حول|المتاح عندي|المتاح ليا)/.test(n);
}

export function mentionsResidence(value){
 const n=clean(value);
 return /(?:ساكن|سكني|السكن|انا من|أنا من|انا في|أنا في)/.test(n);
}

export function nearestWorkAreas(value,areas,{fallbackOriginKey=null,limit=3}={}){
 let origin=resolveKnownPlace(value);
 if(!origin&&fallbackOriginKey)origin=PLACES.find(x=>x.key===fallbackOriginKey)||null;
 if(!origin)return null;
 const ranked=(areas||[])
  .filter(area=>area?.active===true)
  .map(area=>{
   const place=areaPlace(area);
   return place?{area,place,distance_km:distanceKm(origin,place)}:null;
  })
  .filter(Boolean)
  .sort((a,b)=>a.distance_km-b.distance_km||(Number(a.area.position)||0)-(Number(b.area.position)||0));

 if(!ranked.length)return null;

 // Keep distinct job-area rows because the same geographic place can have
 // different operating systems/details (e.g. Market vs Restaurants).
 const items=ranked.slice(0,Math.max(1,Math.min(5,Number(limit)||3)));
 return {origin,items};
}

export function nearestWorkAreaReply(result){
 if(!result?.items?.length)return null;
 const lines=result.items.map((item,index)=>{
  if(index===0)return '• '+item.area.name+' — الأقرب تقريبًا';
  return '• '+item.area.name;
 });
 return 'تمام، بما إنك في '+result.origin.label+' فأقرب اختيارات الشغل المتاحة عندي تقريبًا هي:\n\n'
  +lines.join('\n')
  +'\n\nقولّي اسم المنطقة اللي حابب تعرف تفاصيلها. ولو محتار بينهم أقدر أقارنهم لك، ولو حابب أزرار اختيارات اكتب «الاختيارات».'
  +'\n\nملحوظة: الترشيح تقريبي حسب موقع المناطق، ومش بيحسب زحمة الطريق أو وقت المواصلات.';
}
