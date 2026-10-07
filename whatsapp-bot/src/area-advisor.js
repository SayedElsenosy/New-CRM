import {digits,norm} from './domain.js';

const MARKET_WORDS=['ماركت','سوبرماركت','سوبر ماركت','market'];
const RESTAURANT_WORDS=['مطاعم','مطعم','ريستورانت','restaurant','restaurants'];

function hasAny(text,words){
 const n=norm(text);
 return words.some(word=>n.includes(norm(word)));
}
function stripMode(value){
 let n=norm(value);
 for(const word of [...MARKET_WORDS,...RESTAURANT_WORDS])n=n.replaceAll(norm(word),' ');
 n=n.replace(/^مدينه\s+/,'').replace(/\s+/g,' ').trim();
 return n;
}
export function areaMode(area){
 if(['general','market','restaurants','other'].includes(area?.work_mode))return area.work_mode;
 const source=norm((area?.name||'')+' '+(area?.details||''));
 if(RESTAURANT_WORDS.some(w=>source.includes(norm(w))))return 'restaurants';
 if(MARKET_WORDS.some(w=>source.includes(norm(w))))return 'market';
 return 'general';
}
export function areaPlaceKey(area){
 const stored=norm(area?.place_key||'').trim();
 return stored||stripMode(area?.name||'');
}
function displayPlace(family){
 const general=family.find(x=>areaMode(x)==='general');
 if(general?.name)return String(general.name).replace(/^مدينة\s+/,'').replace(/^مدينه\s+/,'').trim();
 const first=family[0]?.name||'المنطقة';
 return String(first).replace(/\s+(?:ماركت|مطاعم|مطعم)\s*$/,'').replace(/^مدينة\s+/,'').replace(/^مدينه\s+/,'').trim();
}
function areaAliases(area){
 return [area?.name,...(Array.isArray(area?.aliases)?area.aliases:[])].filter(Boolean).map(norm).filter(Boolean);
}
function explicitKey(text,areas){
 const n=norm(text);
 let best=null;
 for(const area of areas||[]){
  if(area?.active!==true)continue;
  for(const alias of areaAliases(area)){
   if(n.includes(alias)&&(!best||alias.length>best.alias.length))best={key:areaPlaceKey(area),alias,area};
  }
  const base=areaPlaceKey(area);
  if(base&&n.includes(base)&&(!best||base.length>best.alias.length))best={key:base,alias:base,area};
 }
 return best?.key||null;
}
function contextKey(answers,areas){
 const ids=[];
 if(answers?.__area_preview?.value)ids.push(answers.__area_preview.value);
 const saved=Object.values(answers||{}).find(v=>v?.kind==='area'&&v?.value&&!String(v.value).startsWith('__'));
 if(saved?.value)ids.push(saved.value);
 const recs=answers?.__area_recommendations?.values;
 if(Array.isArray(recs)&&recs.length===1)ids.push(recs[0]);
 for(const id of ids){
  const area=(areas||[]).find(x=>String(x.id)===String(id));
  if(area)return areaPlaceKey(area);
 }
 return null;
}
function familyByKey(areas,key){
 return (areas||[]).filter(a=>a?.active===true&&areaPlaceKey(a)===key);
}
function numberFrom(value){
 const n=Number(String(value||'').replace(/,/g,''));
 return Number.isFinite(n)?n:null;
}
export function areaProfile(area){
 const raw=digits(String(area?.details||''));
 const n=norm(raw);
 const fixed=n.match(/مرتب\s+(?:شهري\s+)?ثابت\s*[:\/-]?\s*([0-9][0-9,]*)/);
 const weeklyRange=n.match(/متوسط\s+القبض\s+الاسبوعي[\s\S]{0,80}?من\s*([0-9][0-9,]*)\s*(?:ل|لـ|الي|الى|إلى|-)+\s*([0-9][0-9,]*)/);
 const weeklyAverage=n.match(/متوسط\s+الدخل\s+الاسبوعي\s*([0-9][0-9,]*)/);
 const weeklyMax=n.match(/(?:بيوصل|يوصل)\s*(?:لي|ل|الي|الى|إلى)?\s*([0-9][0-9,]*)/);
 const shift=n.match(/(?:الشفت|الشيفت)[\s\S]{0,40}?([0-9]{1,2})\s*ساع/);
 const zone=n.match(/(?:الزون)[\s\S]{0,50}?(?:اقل\s+من|اقصي\s+مسافه\s+للزون\s*:?)\s*([0-9]{1,2})\s*كيلو/);
 const orderPrice=n.match(/(?:سعر\s+الاوردر|الاوردر\s+يبدا\s+من)[^0-9]{0,30}([0-9]{2,4})/);
 const benefits={
  social:/تامين\s+اجتماعي/.test(n),
  medical:/تامين\s+طبي/.test(n),
  bonus:/بونص/.test(n),
  vacation:/اجازه\s+سنويه|21\s*يوم/.test(n),
  overtime:/اوفر\s+تايم/.test(n),
  visa:/فيزا/.test(n)
 };
 return {
  fixedSalary:numberFrom(fixed?.[1]),
  weeklyMin:numberFrom(weeklyRange?.[1]),
  weeklyMax:numberFrom(weeklyRange?.[2])||numberFrom(weeklyMax?.[1]),
  weeklyAverage:numberFrom(weeklyAverage?.[1]),
  shiftHours:numberFrom(shift?.[1]),
  zoneKm:numberFrom(zone?.[1]),
  orderPrice:numberFrom(orderPrice?.[1]),
  benefits
 };
}
function money(value){
 return Number(value||0).toLocaleString('en-US');
}
function benefitLabels(profile){
 const labels=[];
 if(profile.benefits.social)labels.push('تأمين اجتماعي');
 if(profile.benefits.medical)labels.push('تأمين طبي');
 if(profile.benefits.bonus)labels.push('بونص');
 if(profile.benefits.vacation)labels.push('إجازات سنوية');
 if(profile.benefits.overtime)labels.push('أوفر تايم');
 return labels;
}
export function compactAreaSummary(area){
 const p=areaProfile(area),mode=areaMode(area);
 const bits=[];
 if(mode==='market')bits.push('نظام ماركت');
 else if(mode==='restaurants')bits.push('نظام مطاعم');
 if(p.fixedSalary)bits.push('ثابت '+money(p.fixedSalary)+' جنيه');
 if(p.weeklyMin&&p.weeklyMax)bits.push('أسبوعي تقريبًا '+money(p.weeklyMin)+'–'+money(p.weeklyMax));
 else if(p.weeklyAverage)bits.push('متوسط أسبوعي '+money(p.weeklyAverage));
 if(p.weeklyMax&&!p.weeklyMin&&p.weeklyAverage&&p.weeklyMax!==p.weeklyAverage)bits.push('وممكن يوصل '+money(p.weeklyMax));
 if(p.shiftHours)bits.push('شيفت '+p.shiftHours+' ساعات');
 if(p.zoneKm)bits.push('زون حتى '+p.zoneKm+' كم');
 if(p.orderPrice)bits.push('الأوردر من '+money(p.orderPrice)+' جنيه');
 const benefits=benefitLabels(p);
 if(benefits.length)bits.push(benefits.slice(0,3).join(' + '));
 return bits.length?bits.join(' · '):String(area?.details||'').trim().split(/\n+/).slice(0,3).join(' · ');
}
function modeLabel(mode){
 return mode==='market'?'ماركت':mode==='restaurants'?'مطاعم':'تشغيل عام';
}
function recommendation(items,text){
 const profiles=items.map(area=>({area,profile:areaProfile(area),mode:areaMode(area)}));
 const n=norm(text);
 const incomeIntent=/(دخل|فلوس|قبض|مرتب|راتب|اوردر|أوردر)/.test(n);
 const stabilityIntent=/(ثابت|استقرار|تامين|تأمين|اجازات|إجازات|مميزات)/.test(n);
 const distanceIntent=/(زون|مسافه|مسافة|قريب|اقرب|أقرب)/.test(n);
 let ranked=[...profiles];
 if(incomeIntent)ranked.sort((a,b)=>(b.profile.weeklyMax||b.profile.weeklyAverage||b.profile.fixedSalary||0)-(a.profile.weeklyMax||a.profile.weeklyAverage||a.profile.fixedSalary||0));
 else if(distanceIntent)ranked.sort((a,b)=>(a.profile.zoneKm||999)-(b.profile.zoneKm||999));
 else if(stabilityIntent)ranked.sort((a,b)=>{
  const score=x=>(x.profile.fixedSalary?3:0)+Object.values(x.profile.benefits).filter(Boolean).length;
  return score(b)-score(a);
 });
 const winner=ranked[0],runner=ranked[1];
 if(!winner||!runner)return null;
 if(incomeIntent){
  const a=winner.profile.weeklyMax||winner.profile.weeklyAverage||winner.profile.fixedSalary;
  const b=runner.profile.weeklyMax||runner.profile.weeklyAverage||runner.profile.fixedSalary;
  if(a&&b&&a>b)return 'لو أهم حاجة عندك سقف الدخل، '+modeLabel(winner.mode)+' ظاهر أقوى في البيانات المسجلة.';
 }
 if(distanceIntent&&winner.profile.zoneKm&&runner.profile.zoneKm&&winner.profile.zoneKm<runner.profile.zoneKm){
  return 'لو يهمك الزون الأقصر، '+modeLabel(winner.mode)+' أنسب في البيانات المسجلة.';
 }
 const market=profiles.find(x=>x.mode==='market'),restaurants=profiles.find(x=>x.mode==='restaurants');
 if(market&&restaurants){
  const marketStable=(market.profile.fixedSalary?2:0)+Object.values(market.profile.benefits).filter(Boolean).length;
  const restIncome=restaurants.profile.weeklyMax||restaurants.profile.weeklyAverage||0;
  const marketIncome=market.profile.weeklyMax||market.profile.weeklyAverage||market.profile.fixedSalary||0;
  if(marketStable>2&&restIncome>marketIncome)return 'بشكل عملي: الماركت أقوى في الثبات والمميزات، والمطاعم ممكن يكون سقف دخله أعلى. الاختيار يعتمد على اللي أهم بالنسبة لك.';
 }
 return null;
}
function compareReply(items,text,place){
 const lines=items.map(area=>'• '+modeLabel(areaMode(area))+': '+compactAreaSummary(area));
 const rec=recommendation(items,text);
 return 'في '+place+' الفرق كده حسب البيانات المسجلة عندنا:\n\n'+lines.join('\n')+(rec?'\n\n'+rec:'')+'\n\nلو تقولي أهم حاجة عندك إيه — الدخل، ثبات المرتب، الزون، ولا المميزات — أقولك أنهي أنسب ليك.';
}
function generalComparison(areas){
 const market=(areas||[]).find(a=>a.active&&areaMode(a)==='market'&&String(a.details||'').trim());
 const restaurants=(areas||[]).find(a=>a.active&&areaMode(a)==='restaurants'&&String(a.details||'').trim());
 if(!market||!restaurants)return null;
 return 'الفرق بيتغير حسب المنطقة، لكن من البيانات المسجلة عندنا عمومًا:\n\n'
  +'• الماركت: '+compactAreaSummary(market)+'\n'
  +'• المطاعم: '+compactAreaSummary(restaurants)+'\n\n'
  +'الماركت غالبًا أقوى لو عايز دخل ثابت ومميزات واضحة، والمطاعم ممكن يكون دخله أعلى مع الشغل والأوردرات. قولّي المنطقة اللي بتفكر فيها وأنا أقارنها لك بالأرقام.';
}
function asksComparison(text){
 const n=norm(text);
 return /(?:الفرق|فرق|مقارنه|مقارنة|قارن|احسن|افضل|أفضل|مميزات اكتر|مميزاته اكتر)/.test(n)
  ||(hasAny(text,MARKET_WORDS)&&hasAny(text,RESTAURANT_WORDS));
}
function asksAvailability(text){
 const n=norm(text);
 return /(?:ممكن|ينفع|عايز|عاوز|حابب|انزل|أنزل|اشتغل|شغل|متاح)/.test(n);
}
export function conversationalAreaAdvice(text,areas,answers={}){
 const active=(areas||[]).filter(a=>a?.active===true);
 if(!active.length)return null;
 const key=explicitKey(text,active)||contextKey(answers,active);
 const compare=asksComparison(text);
 if(!key){
  if(compare)return {reply:generalComparison(active),action:'compare_work_modes_general'};
  return null;
 }
 const family=familyByKey(active,key);
 if(!family.length)return null;
 const place=displayPlace(family);
 const general=family.find(a=>areaMode(a)==='general')||family[0];
 const variants=family.filter(a=>areaMode(a)!=='general'&&String(a.details||'').trim());
 const requestedModes=[];
 if(hasAny(text,MARKET_WORDS))requestedModes.push('market');
 if(hasAny(text,RESTAURANT_WORDS))requestedModes.push('restaurants');

 if(compare){
  const compareItems=variants.filter(v=>!requestedModes.length||requestedModes.includes(areaMode(v)));
  if(compareItems.length>=2)return {reply:compareReply(compareItems,text,place),action:'compare_area_modes',previewAreaId:general?.id||null};
  if(variants.length>=2)return {reply:compareReply(variants.slice(0,3),text,place),action:'compare_area_modes',previewAreaId:general?.id||null};
  if(variants.length===1){
   return {reply:'في '+place+' المسجل عندي حاليًا '+modeLabel(areaMode(variants[0]))+' بس، ومش شايف النوع التاني متاح هناك دلوقتي.\n\n'+compactAreaSummary(variants[0])+'\n\nلو عايز أقارنه بمنطقة تانية قولّي اسم المنطقة.',action:'explain_single_area_mode',previewAreaId:general?.id||null};
  }
 }
 if(requestedModes.length){
  const target=variants.find(v=>requestedModes.includes(areaMode(v)));
  if(target)return {reply:'أيوه، '+place+' فيها '+modeLabel(areaMode(target))+' حسب المسجل عندنا.\n\n'+compactAreaSummary(target)+'\n\nلو مناسب ليك قولّي «مناسبة وكمل»، ولو عايز أقارنه بنظام تاني أو منطقة تانية قولّي.',action:'explain_area_mode',previewAreaId:general?.id||target.id};
  return {reply:'بالنسبة لـ'+place+'، مش شايف '+requestedModes.map(modeLabel).join(' أو ')+' مسجل حاليًا. المتاح عندي هو '+(variants.map(v=>modeLabel(areaMode(v))).join(' و ')||'المنطقة نفسها من غير تفاصيل تشغيل كفاية')+'.',action:'missing_area_mode',previewAreaId:general?.id||null};
 }
 if(asksAvailability(text)||explicitKey(text,active)){
  if(variants.length===1){
   return {reply:'أيوه، '+place+' موجودة عندنا. المتاح المسجل حاليًا هناك '+modeLabel(areaMode(variants[0]))+'.\n\n'+compactAreaSummary(variants[0])+'\n\nلو ده مناسب ليك قولّي «مناسبة وكمل». ولو عايز تقارنها بمنطقة تانية قولّي اسمها.',action:'explain_area_family',previewAreaId:general?.id||variants[0].id};
  }
  if(variants.length>1){
   return {reply:'أيوه، '+place+' موجودة عندنا، وعندي فيها أكتر من نظام تشغيل:\n\n'+variants.map(v=>'• '+modeLabel(areaMode(v))+': '+compactAreaSummary(v)).join('\n')+'\n\nلو تحب أقولك أنهي أنسب ليك، قولّي إيه أهم حاجة عندك: الدخل، الثبات، الزون، ولا المميزات.',action:'explain_area_family',previewAreaId:general?.id||null};
  }
  if(String(general?.details||'').trim())return {reply:'أيوه، '+place+' موجودة عندنا.\n\n'+compactAreaSummary(general)+'\n\nلو مناسبة ليك قولّي «مناسبة وكمل».',action:'explain_area_family',previewAreaId:general?.id||null};
 }
 return null;
}
