import {digits,norm,areaDetails} from './domain.js';

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
function explicitKeys(text,areas,limit=4){
 const n=norm(text);
 const byKey=new Map();
 for(const area of areas||[]){
  if(area?.active!==true)continue;
  const key=areaPlaceKey(area);
  if(!key)continue;
  const candidates=[...areaAliases(area),key];
  for(const alias of candidates){
   const index=n.indexOf(alias);
   if(index<0)continue;
   const current=byKey.get(key);
   if(!current||index<current.index||(index===current.index&&alias.length>current.alias.length)){
    byKey.set(key,{key,index,alias});
   }
  }
 }
 return [...byKey.values()].sort((a,b)=>a.index-b.index||b.alias.length-a.alias.length).slice(0,limit).map(x=>x.key);
}
function explicitKey(text,areas){
 return explicitKeys(text,areas,1)[0]||null;
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
 const weeklyAverage=n.match(/متوسط\s+الدخل(?:\s+الاسبوعي)?\s*([0-9][0-9,]*)/);
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
function placeMetrics(family){
 const variants=(family||[]).filter(a=>areaMode(a)!=='general'&&String(a.details||'').trim());
 const source=variants.length?variants:(family||[]).filter(a=>String(a.details||'').trim());
 const profiles=source.map(area=>({area,profile:areaProfile(area),mode:areaMode(area)}));
 const max=key=>profiles.reduce((v,x)=>Math.max(v,Number(x.profile[key]||0)),0)||null;
 const zones=profiles.map(x=>Number(x.profile.zoneKm||0)).filter(Boolean);
 const benefits={social:false,medical:false,bonus:false,vacation:false,overtime:false,visa:false};
 for(const row of profiles)for(const key of Object.keys(benefits))benefits[key]=benefits[key]||Boolean(row.profile.benefits?.[key]);
 return {
  profiles,
  fixedSalary:max('fixedSalary'),
  weeklyMax:max('weeklyMax'),
  weeklyAverage:max('weeklyAverage'),
  zoneKm:zones.length?Math.min(...zones):null,
  benefits,
  benefitsCount:Object.values(benefits).filter(Boolean).length,
  modeCount:new Set(profiles.map(x=>x.mode).filter(x=>x!=='general')).size
 };
}
function uniqueBest(rows,scoreFn,{lowest=false}={}){
 const scored=rows.map(row=>({row,score:Number(scoreFn(row)||0)})).filter(x=>x.score>0)
  .sort((a,b)=>lowest?a.score-b.score:b.score-a.score);
 if(!scored.length)return null;
 if(scored[1]&&scored[0].score===scored[1].score)return null;
 return scored[0].row;
}
function placeComparisonBlock(family){
 const place=displayPlace(family);
 const variants=(family||[]).filter(a=>areaMode(a)!=='general'&&String(a.details||'').trim());
 const detailed=(family||[]).filter(a=>String(a.details||'').trim());
 const source=variants.length?variants:detailed.slice(0,1);
 if(!source.length){
  const general=(family||[]).find(a=>areaMode(a)==='general')||family?.[0];
  const fallback=general?areaDetails(general).replace(/^📍\s*/,''):(place+'\nتفاصيل المنطقة لسه مش مضافة. مسؤول التوظيف يقدر يوضحها ليك.');
  return '• '+fallback;
 }
 if(source.length===1){
  const raw=areaDetails(source[0]).replace(/^📍\s*/,'');
  return '• '+raw;
 }
 return '• '+place+':\n'+source.slice(0,3).map(v=>'  - '+modeLabel(areaMode(v))+': '+compactAreaSummary(v)).join('\n');
}
function crossPlaceRecommendation(families,text){
 const rows=families.map(family=>({family,place:displayPlace(family),metrics:placeMetrics(family)}));
 const n=norm(text);
 const asksBenefits=/(مميزات|مزايا|تامين|تأمين|اجازات|إجازات|ثبات|استقرار)/.test(n);
 const asksIncome=/(دخل|فلوس|قبض|مرتب|راتب|اوردر|أوردر)/.test(n);
 const asksDistance=/(زون|مسافه|مسافة|قريب|اقرب|أقرب)/.test(n);
 if(asksBenefits){
  const winner=uniqueBest(rows,x=>x.metrics.benefitsCount*10+(x.metrics.fixedSalary?2:0));
  if(winner)return 'لو تركيزك على المميزات والثبات، '+winner.place+' ظاهر أقوى في البيانات المسجلة عندنا.';
  const optionsWinner=uniqueBest(rows,x=>x.metrics.modeCount);
  if(optionsWinner)return 'المميزات الأساسية المسجلة متقاربة، لكن '+optionsWinner.place+' عنده خيارات تشغيل أكتر حاليًا.';
  return 'من ناحية المميزات والثبات، البيانات المسجلة متقاربة بين المناطق دي.';
 }
 if(asksIncome){
  const winner=uniqueBest(rows,x=>x.metrics.weeklyMax||x.metrics.weeklyAverage||x.metrics.fixedSalary||0);
  if(winner)return 'لو أهم حاجة عندك سقف الدخل، '+winner.place+' ظاهر أقوى في الأرقام المسجلة.';
  return 'من ناحية الدخل، الأرقام المسجلة متقاربة ومفيش فائز واضح.';
 }
 if(asksDistance){
  const winner=uniqueBest(rows,x=>x.metrics.zoneKm||0,{lowest:true});
  if(winner)return 'لو يهمك الزون الأقصر، '+winner.place+' ظاهر أنسب من البيانات المسجلة.';
  return 'من ناحية الزون، البيانات المسجلة متقاربة ومفيش فرق واضح.';
 }
 const benefitsWinner=uniqueBest(rows,x=>x.metrics.benefitsCount*10+(x.metrics.fixedSalary?2:0));
 const incomeWinner=uniqueBest(rows,x=>x.metrics.weeklyMax||x.metrics.weeklyAverage||x.metrics.fixedSalary||0);
 if(benefitsWinner&&incomeWinner){
  if(benefitsWinner.place===incomeWinner.place)return 'بشكل عام من البيانات المسجلة، '+benefitsWinner.place+' ظاهر أقوى في المميزات وكمان الدخل، لكن القرار النهائي يعتمد على النظام المتاح هناك.';
  return benefitsWinner.place+' أقوى في المميزات والثبات، بينما '+incomeWinner.place+' أقوى في سقف الدخل.';
 }
 if(benefitsWinner)return benefitsWinner.place+' ظاهر أقوى من ناحية المميزات المسجلة.';
 if(incomeWinner)return incomeWinner.place+' ظاهر أقوى من ناحية الدخل المسجل.';
 return 'مفيش منطقة أقدر أقول إنها أحسن مطلقًا من غير ما تحدد أولويتك.';
}
function comparePlacesReply(keys,areas,text){
 const families=keys.map(key=>familyByKey(areas,key)).filter(x=>x.length);
 if(families.length<2)return null;
 return 'لو بنقارن '+families.map(displayPlace).join(' و ')+' حسب البيانات المسجلة عندنا:\n\n'
  +families.map(placeComparisonBlock).join('\n\n')
  +'\n\n'+crossPlaceRecommendation(families,text)
  +'\n\nلو تقولي أهم حاجة عندك إيه — الدخل، المميزات، ثبات المرتب، ولا الزون — أقولك اختياري ليك بشكل أدق.';
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
 const textNorm=norm(text);
 if(/(?:^|\s)(?:مش|ما)\s+(?:عايز|عاوز|حابب|موافق|ناوي)(?:[\s\S]{0,30})(?:اشتغل|انزل|أنزل|المنطقه|المنطقة)/.test(textNorm)
   ||/(?:مش\s+مناسب|مش\s+مناسبه|ماينفعش|مينفعش)/.test(textNorm))return null;
 const active=(areas||[]).filter(a=>a?.active===true);
 if(!active.length)return null;
 const explicit=explicitKeys(text,active);
 const compare=asksComparison(text);
 if(compare&&explicit.length>=2){
  const reply=comparePlacesReply(explicit,active,text);
  if(reply)return {reply,action:'compare_places'};
 }
 const key=explicit[0]||contextKey(answers,active);
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
