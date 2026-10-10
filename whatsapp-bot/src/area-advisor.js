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
const AREA_MATCH_STOP_WORDS=new Set([
 'مدينه','مدينة','منطقه','منطقة','ماركت','مطاعم','مطعم','سوبر','سوبرماركت','market','restaurant','restaurants'
]);
function tokenKey(value){
 const t=norm(value).replace(/[^\p{L}\p{N}]/gu,'');
 if(!t)return '';
 return t.startsWith('ال')&&t.length>4?t.slice(2):t;
}
function phraseTokens(value){
 return norm(value).split(/\s+/).map(tokenKey).filter(t=>t.length>=2&&!AREA_MATCH_STOP_WORDS.has(t));
}
function familyCandidates(family){
 const values=[];
 for(const area of family){
  values.push(area?.name,areaPlaceKey(area),...(Array.isArray(area?.aliases)?area.aliases:[]));
 }
 return [...new Set(values.filter(Boolean).map(norm).filter(Boolean))];
}
function matchedPlaceKeys(text,areas,limit=4){
 const n=norm(text);
 const active=(areas||[]).filter(a=>a?.active===true);
 const grouped=new Map();
 for(const area of active){
  const key=areaPlaceKey(area);
  if(!key)continue;
  if(!grouped.has(key))grouped.set(key,[]);
  grouped.get(key).push(area);
 }
 const rows=[...grouped.entries()].map(([key,family])=>({key,family,candidates:familyCandidates(family)}));
 const tokenOwners=new Map();
 for(const row of rows){
  const tokens=new Set(row.candidates.flatMap(phraseTokens));
  row.tokens=tokens;
  for(const token of tokens){
   if(!tokenOwners.has(token))tokenOwners.set(token,new Set());
   tokenOwners.get(token).add(row.key);
  }
 }
 const inputTokens=norm(text).split(/\s+/).map((raw,index)=>({raw,key:tokenKey(raw),index}))
  .filter(x=>x.key.length>=2&&!AREA_MATCH_STOP_WORDS.has(x.key));
 const hits=[];
 for(const row of rows){
  let bestIndex=Infinity,bestScore=0;
  for(const phrase of row.candidates){
   const idx=n.indexOf(phrase);
   if(idx>=0){
    const score=1000+phrase.length;
    if(score>bestScore||(score===bestScore&&idx<bestIndex)){bestScore=score;bestIndex=idx;}
   }
  }
  for(const token of inputTokens){
   if(!row.tokens.has(token.key))continue;
   const owners=tokenOwners.get(token.key);
   if(!owners||owners.size!==1)continue;
   const score=100+token.key.length;
   if(score>bestScore||(score===bestScore&&token.index<bestIndex)){bestScore=score;bestIndex=token.index;}
  }
  if(bestScore>0)hits.push({key:row.key,index:bestIndex,score:bestScore});
 }
 return hits.sort((a,b)=>a.index-b.index||b.score-a.score).slice(0,limit).map(x=>x.key);
}
export function resolveAreaReference(text,areas,{contextPlaceKey=null}={}){
 const active=(areas||[]).filter(a=>a?.active===true);
 const keys=matchedPlaceKeys(text,active,4);
 const key=keys[0]||norm(contextPlaceKey||'')||null;
 if(!key)return {matched:false,placeKeys:keys};
 const family=familyByKey(active,key);
 if(!family.length)return {matched:false,placeKeys:keys};
 const requestedModes=[];
 if(hasAny(text,MARKET_WORDS))requestedModes.push('market');
 if(hasAny(text,RESTAURANT_WORDS))requestedModes.push('restaurants');
 const variants=family.filter(a=>areaMode(a)!=='general');
 const general=family.find(a=>areaMode(a)==='general')||null;
 if(requestedModes.length===1){
  const targets=variants.filter(a=>areaMode(a)===requestedModes[0]);
  if(targets.length===1)return {matched:true,key,family,area:targets[0],mode:requestedModes[0],placeKeys:keys};
  if(targets.length>1)return {matched:true,key,family,mode:requestedModes[0],ambiguous:true,reason:'duplicate_mode',placeKeys:keys};
  return {matched:true,key,family,mode:requestedModes[0],missingMode:true,placeKeys:keys};
 }
 if(requestedModes.length>1)return {matched:true,key,family,ambiguous:true,reason:'multiple_modes',placeKeys:keys};
 if(variants.length===1)return {matched:true,key,family,area:variants[0],mode:areaMode(variants[0]),placeKeys:keys};
 if(variants.length>1)return {matched:true,key,family,ambiguous:true,reason:'mode_required',placeKeys:keys};
 return {matched:true,key,family,area:general||family[0],mode:'general',placeKeys:keys};
}

function explicitKeys(text,areas,limit=4){
 return matchedPlaceKeys(text,areas,limit);
}
function explicitKey(text,areas){
 return explicitKeys(text,areas,1)[0]||null;
}
function contextKey(answers,areas){
 if(answers?.__area_context?.place_key){
  const key=norm(answers.__area_context.place_key);
  if((areas||[]).some(a=>a?.active===true&&areaPlaceKey(a)===key))return key;
 }
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
export function availableAreaNames(areas,{limit=18}={}){
 const active=(areas||[]).filter(a=>a?.active===true&&a?.recruitment_eligible!==false);
 const byKey=new Map();
 for(const area of active){
  const key=areaPlaceKey(area)||norm(area?.name||'');
  if(!key)continue;
  if(!byKey.has(key))byKey.set(key,[]);
  byKey.get(key).push(area);
 }
 return [...byKey.values()]
  .map(family=>displayPlace(family))
  .filter(Boolean)
  .filter((name,index,list)=>list.findIndex(x=>norm(x)===norm(name))===index)
  .slice(0,Math.max(1,Number(limit)||18));
}
export function availableAreaListItems(areas,{limit=18}={}){
 const active=(areas||[]).filter(a=>a?.active===true&&a?.recruitment_eligible!==false);
 const byKey=new Map();
 for(const area of active){
  const key=areaPlaceKey(area)||norm(area?.name||'');
  if(!key)continue;
  if(!byKey.has(key))byKey.set(key,[]);
  byKey.get(key).push(area);
 }
 return [...byKey.values()].slice(0,Math.max(1,Number(limit)||18)).map(family=>{
  const place=displayPlace(family);
  const modes=[...new Set(family.map(areaMode).filter(mode=>mode!=='general'))];
  const suffix=modes.includes('market')&&modes.includes('restaurants')
   ?'ماركت / مطاعم'
   :modes.length===1?modeLabel(modes[0]):'';
  return suffix?place+' — '+suffix:place;
 });
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

const PRIORITY_LABELS={
 income:'الدخل',
 stability:'ثبات الدخل',
 benefits:'المميزات',
 distance:'القرب والزون',
 shift:'ساعات الشيفت'
};

function preferenceStrength(text){
 const n=norm(text);
 if(/(?:اهم حاجه|اهم حاجة|الأهم|الاهم|اولويه|أولوية|بالنسبالي|بالنسبة لي)/.test(n))return 3;
 if(/(?:يهمني|مهم عندي|عايز|عاوز|أفضل|افضل|بفضل|محتاج)/.test(n))return 2;
 return 1;
}
function explicitPreference(text,pattern){
 const n=norm(text);
 if(!pattern.test(n))return null;
 const negative=/(?:مش مهم|مش فارق|مش اولوية|مش أولوية|مش فارقه|مش فارقة|مش عايز|مش عاوز)/.test(n);
 return {op:negative?'remove':'set',strength:preferenceStrength(text)};
}
export function extractRecommendationPreferences(text){
 const n=norm(text);
 if(!n)return [];
 const out=[];
 const rules=[
  ['income',/(?:دخل|فلوس|قبض|مرتب|راتب)(?:[\s\S]{0,30})(?:اعلي|أعلى|اكتر|أكتر|مهم|اهم|أهم|يفرق|يهمني)|(?:اهم حاجه|اهم حاجة|الأهم|الاهم|اولويه|أولوية|يهمني|مهم عندي)(?:[\s\S]{0,25})(?:دخل|فلوس|قبض|مرتب|راتب)/],
  ['stability',/(?:ثبات|استقرار|مرتب ثابت|راتب ثابت|دخل ثابت)(?:[\s\S]{0,25})(?:مهم|اهم|أهم|يهمني|عايز|عاوز|أفضل|افضل)?/],
  ['benefits',/(?:مميزات|مزايا|تامين|تأمين|اجازات|إجازات|بونص|اوفر تايم|أوفر تايم)(?:[\s\S]{0,25})(?:مهم|اهم|أهم|يهمني|عايز|عاوز|أفضل|افضل)|(?:اهم حاجه|اهم حاجة|الأهم|الاهم|اولويه|أولوية|يهمني|مهم عندي)(?:[\s\S]{0,25})(?:مميزات|مزايا|تامين|تأمين|اجازات|إجازات|بونص)/],
  ['distance',/(?:قريب|اقرب|أقرب|مسافه|مسافة|زون)(?:[\s\S]{0,25})(?:مهم|اهم|أهم|يهمني|عايز|عاوز|أقل|اقل)|(?:اهم حاجه|اهم حاجة|الأهم|الاهم|اولويه|أولوية|يهمني|مهم عندي)(?:[\s\S]{0,25})(?:قرب|قريب|مسافه|مسافة|زون)/],
  ['shift',/(?:شيفت|شفت|ساعات الشغل|ساعات العمل)(?:[\s\S]{0,25})(?:اقل|أقل|قصير|أقصر|مهم|يهمني)|(?:عايز|عاوز|أفضل|افضل|يهمني)(?:[\s\S]{0,20})(?:شيفت|شفت)(?:[\s\S]{0,15})(?:اقل|أقل|قصير|أقصر)/]
 ];
 for(const [key,pattern] of rules){
  const pref=explicitPreference(text,pattern);
  if(pref)out.push({key,...pref});
 }
 const modeIntent=/(?:أفضل|افضل|بفضل|اميل|أميل|عايز|عاوز|مفضل|مفضّل|أنسب لي|انسب لي)/.test(n);
 if(modeIntent){
  const market=hasAny(text,MARKET_WORDS),restaurants=hasAny(text,RESTAURANT_WORDS);
  if(market!==restaurants)out.push({key:'preferred_mode',value:market?'market':'restaurants',op:'set',strength:2});
 }
 if(/(?:مش عايز|مش عاوز|مش مفضل|مش بفضل)(?:[\s\S]{0,15})(?:ماركت|مطاعم|مطعم|restaurant)/.test(n)){
  const market=hasAny(text,MARKET_WORDS),restaurants=hasAny(text,RESTAURANT_WORDS);
  if(market!==restaurants)out.push({key:'preferred_mode',value:market?'market':'restaurants',op:'remove',strength:2});
 }
 return out;
}
export function mergeRecommendationProfile(current,preferences,now=new Date().toISOString()){
 const base=current&&typeof current==='object'?current:{};
 const priorities={...(base.priorities&&typeof base.priorities==='object'?base.priorities:{})};
 let preferredMode=base.preferred_mode||null;
 let primary=base.primary||null;
 let changed=false;
 let turnPrimary=null,turnStrength=-1;
 for(const pref of preferences||[]){
  if(pref.key==='preferred_mode'){
   if(pref.op==='remove'){
    if(preferredMode===pref.value){preferredMode=null;changed=true;}
   }else if(pref.value&&preferredMode!==pref.value){preferredMode=pref.value;changed=true;}
   continue;
  }
  if(!PRIORITY_LABELS[pref.key])continue;
  if(pref.op==='remove'){
   if(priorities[pref.key]){delete priorities[pref.key];changed=true;}
   if(primary===pref.key){primary=null;changed=true;}
   continue;
  }
  const nextScore=Math.min(5,Math.max(Number(priorities[pref.key]?.score||0),Number(pref.strength||1)));
  if(!priorities[pref.key]||Number(priorities[pref.key].score)!==nextScore){
   priorities[pref.key]={score:nextScore,updated_at:now,source:'explicit'};changed=true;
  }else priorities[pref.key]={...priorities[pref.key],updated_at:now};
  if(Number(pref.strength||1)>turnStrength){turnPrimary=pref.key;turnStrength=Number(pref.strength||1);}
 }
 if(turnPrimary&&primary!==turnPrimary){primary=turnPrimary;changed=true;}
 if(!primary||!priorities[primary]){
  const ranked=Object.entries(priorities).sort((a,b)=>Number(b[1]?.score||0)-Number(a[1]?.score||0)||String(b[1]?.updated_at||'').localeCompare(String(a[1]?.updated_at||'')));
  const next=ranked[0]?.[0]||null;
  if(primary!==next){primary=next;changed=true;}
 }
 return {
  changed,
  profile:{
   priorities,
   primary,
   preferred_mode:preferredMode,
   kind:'recommendation_profile',
   updated_at:changed?now:(base.updated_at||now)
  }
 };
}
export function recommendationPreferenceAck(preferences,profile){
 const setKeys=[...new Set((preferences||[]).filter(x=>x.op!=='remove'&&PRIORITY_LABELS[x.key]).map(x=>x.key))];
 const removed=[...new Set((preferences||[]).filter(x=>x.op==='remove'&&PRIORITY_LABELS[x.key]).map(x=>x.key))];
 const mode=(preferences||[]).find(x=>x.key==='preferred_mode'&&x.op!=='remove')?.value;
 const bits=[];
 if(setKeys.length)bits.push('هراعي '+setKeys.map(k=>PRIORITY_LABELS[k]).join(' و ')+' في الترشيحات الجاية');
 if(mode)bits.push('وسجلت إنك مفضل '+(mode==='market'?'الماركت':'المطاعم'));
 if(removed.length)bits.push('وشلت '+removed.map(k=>PRIORITY_LABELS[k]).join(' و ')+' من أولويات الترشيح');
 if(!bits.length&&profile?.primary)bits.push('هراعي أولويتك الأساسية: '+PRIORITY_LABELS[profile.primary]);
 return bits.length?'تمام، '+bits.join('، ')+'.':'';
}
function recommendationProfile(answers){
 const p=answers?.__recommendation_profile;
 return p&&typeof p==='object'?p:{priorities:{},primary:null,preferred_mode:null};
}

function recommendation(items,text,profile=null){
 const profiles=items.map(area=>({area,profile:areaProfile(area),mode:areaMode(area)}));
 const n=norm(text);
 const explicit=comparisonPriority(text);
 const profilePriority=profile?.primary||null;
 const priority=explicit||profilePriority;
 const incomeIntent=priority==='income'||/(دخل|فلوس|قبض|مرتب|راتب|اوردر|أوردر)/.test(n);
 const stabilityIntent=['stability','benefits'].includes(priority)||/(ثابت|استقرار|تامين|تأمين|اجازات|إجازات|مميزات)/.test(n);
 const distanceIntent=priority==='distance'||/(زون|مسافه|مسافة|قريب|اقرب|أقرب)/.test(n);
 const shiftIntent=priority==='shift';
 let ranked=[...profiles];
 if(incomeIntent)ranked.sort((a,b)=>(b.profile.weeklyMax||b.profile.weeklyAverage||b.profile.fixedSalary||0)-(a.profile.weeklyMax||a.profile.weeklyAverage||a.profile.fixedSalary||0));
 else if(distanceIntent)ranked.sort((a,b)=>(a.profile.zoneKm||999)-(b.profile.zoneKm||999));
 else if(shiftIntent)ranked.sort((a,b)=>(a.profile.shiftHours||999)-(b.profile.shiftHours||999));
 else if(stabilityIntent)ranked.sort((a,b)=>{
  const score=x=>(x.profile.fixedSalary?3:0)+Object.values(x.profile.benefits).filter(Boolean).length;
  return score(b)-score(a);
 });
 else if(profile?.preferred_mode)ranked.sort((a,b)=>Number(b.mode===profile.preferred_mode)-Number(a.mode===profile.preferred_mode));
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
 if(shiftIntent&&winner.profile.shiftHours&&runner.profile.shiftHours&&winner.profile.shiftHours<runner.profile.shiftHours){
  return 'بما إنك مفضل ساعات شغل أقل، '+modeLabel(winner.mode)+' أنسب حسب الشيفت المسجل.';
 }
 if(!explicit&&profile?.preferred_mode&&winner.mode===profile.preferred_mode&&runner.mode!==profile.preferred_mode){
  return 'وبما إنك قلت قبل كده إنك مفضل '+modeLabel(profile.preferred_mode)+'، فهو الأقرب لتفضيلك هنا.';
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
  shiftHours:profiles.map(x=>Number(x.profile.shiftHours||0)).filter(Boolean).sort((a,b)=>a-b)[0]||null,
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
function shortComparisonFacts(area,{max=3}={}){
 const p=areaProfile(area),facts=[];
 if(p.fixedSalary)facts.push('ثابت شهري '+money(p.fixedSalary)+' جنيه');
 if(p.weeklyMin&&p.weeklyMax)facts.push('متوسط أسبوعي '+money(p.weeklyMin)+'–'+money(p.weeklyMax)+' جنيه');
 else if(p.weeklyAverage)facts.push('متوسط أسبوعي '+money(p.weeklyAverage)+' جنيه');
 if(p.orderPrice)facts.push('الأوردر من '+money(p.orderPrice)+' جنيه');
 if(p.shiftHours)facts.push('شيفت '+p.shiftHours+' ساعات');
 const benefits=benefitLabels(p);
 if(benefits.length)facts.push(benefits.slice(0,2).join(' + '));
 // No raw multi-paragraph office descriptions in comparisons. Full details
 // remain available through the explicit details route.
 if(!facts.length){
  const first=String(area?.details||'').split(/\n/).map(x=>x.trim()).find(Boolean)||'';
  return first?first.slice(0,115):'التفاصيل المسجلة غير كافية للمقارنة';
 }
 return facts.slice(0,max).join(' · ');
}
function placeComparisonBlock(family){
 const place=displayPlace(family);
 const detailed=(family||[]).filter(a=>String(a.details||'').trim());
 const variants=detailed.filter(a=>areaMode(a)!=='general');
 const source=variants.length?variants.slice(0,3):detailed.slice(0,1);
 if(!source.length)return '• '+place+': تفاصيل الوظيفة غير مسجلة بما يكفي للمقارنة';
 if(source.length===1){
  return '• '+place+' ('+modeLabel(areaMode(source[0]))+'): '+shortComparisonFacts(source[0]);
 }
 return '• '+place+':\n'+source.map(area=>'  - '+modeLabel(areaMode(area))+': '+shortComparisonFacts(area,{max:2})).join('\n');
}
function comparisonPriority(text){
 const n=norm(text);
 if(/(?:دخل|فلوس|قبض|مرتب|راتب|اوردر|أوردر)/.test(n))return 'income';
 if(/(?:زون|مسافه|مسافة|قريب|اقرب|أقرب)/.test(n))return 'distance';
 if(/(?:ثبات|استقرار|مرتب ثابت|راتب ثابت)/.test(n))return 'stability';
 if(/(?:مميزات|مزايا|تامين|تأمين|اجازات|إجازات|بونص|اوفر تايم|أوفر تايم)/.test(n))return 'benefits';
 return null;
}
function storedComparisonKeys(answers,areas){
 const raw=answers?.__area_comparison?.place_keys;
 if(!Array.isArray(raw))return [];
 const valid=new Set((areas||[]).filter(a=>a?.active===true).map(areaPlaceKey).filter(Boolean));
 return [...new Set(raw.map(x=>norm(x)).filter(x=>valid.has(x)))].slice(0,4);
}
function comparableIncomeWinner(rows){
 // Do not compare a monthly salary with weekly earnings, or a weekly
 // maximum with an average. Only compare the same type of number.
 for(const key of ['weeklyAverage','weeklyMax','fixedSalary']){
  if(rows.every(row=>Number(row.metrics[key])>0)){
   return {winner:uniqueBest(rows,row=>row.metrics[key]),basis:key};
  }
 }
 return {winner:null,basis:null};
}
function crossPlaceRecommendation(families,text,priority=null,profile=null){
 const rows=families.map(family=>({family,place:displayPlace(family),metrics:placeMetrics(family)}));
 const detected=priority||comparisonPriority(text)||profile?.primary||null;
 const benefitsWinner=uniqueBest(rows,x=>x.metrics.benefitsCount*10+(x.metrics.fixedSalary?2:0));
 const income=comparableIncomeWinner(rows);
 if(detected==='distance'){
  return 'الزون المسجل يخص نطاق التوصيل أثناء الشغل، مش مشوارك من البيت. من غير عنوان عمل أو زمن مواصلات موثوق مش هقولك مين الأقرب.';
 }
 if(detected==='shift'){
  const winner=uniqueBest(rows,x=>x.metrics.shiftHours||0,{lowest:true});
  return winner?'أقصر شيفت مسجل ضمن خيارات '+winner.place+'، بس ده ممكن يختلف حسب نظام الشغل.':'مفيش بيانات شيفت قابلة للمقارنة بشكل مؤكد.';
 }
 if(detected==='income'){
  return income.winner?'بالنسبة لنفس نوع الدخل المسجل، '+income.winner.place+' ظاهر أعلى، لكن المبلغ المتوقع مش مضمون.'
   :'مش هقارن مرتب شهري بدخل أسبوعي أو سقف أوردرات؛ دول أرقام مختلفة ومش دليل إن منطقة أحسن في الدخل.';
 }
 if(['benefits','stability'].includes(detected)){
  return benefitsWinner?'لو المميزات أو الثبات أهم عندك، فيه خيار في '+benefitsWinner.place+' ظاهر أقوى في البيانات المسجلة؛ مش شرط كل الأنظمة هناك بنفس الشروط.'
   :'المميزات المسجلة متقاربة، ولازم نحدد نظام الشغل المناسب قبل الترشيح.';
 }
 if(profile?.preferred_mode){
  const modeWinner=uniqueBest(rows,x=>x.metrics.profiles.some(p=>p.mode===profile.preferred_mode)?1:0);
  if(modeWinner)return 'بما إنك مفضل '+modeLabel(profile.preferred_mode)+'، النظام ده موجود في '+modeWinner.place+'، لكن لسه محتاجين نتأكد من ملاءمة المشوار.';
 }
 if(benefitsWinner&&income.winner&&benefitsWinner.place!==income.winner.place){
  return benefitsWinner.place+' فيه خيار أقوى في المميزات، بينما '+income.winner.place+' أعلى في الدخل القابل للمقارنة؛ الاختيار مش محسوم من غير أولويتك.';
 }
 if(benefitsWinner)return 'من ناحية المميزات، فيه خيار في '+benefitsWinner.place+' ظاهر أقوى، بس ما نقدرش نعتبره الأفضل ليك قبل ما نعرف مشوار الشغل وأولوياتك.';
 if(income.winner)return 'في نوع الدخل القابل للمقارنة، '+income.winner.place+' ظاهر أعلى؛ لكن ده لوحده مش كفاية لاختيار الأنسب ليك.';
 return 'البيانات مش كفاية لترشيح منطقة أفضل بشكل مؤكد من غير معرفة أولوياتك.';
}
function comparePlacesReply(keys,areas,text,priority=null,profile=null,answers={}){
 const families=keys.map(key=>familyByKey(areas,key)).filter(x=>x.length);
 if(families.length<2)return null;
 const source=answers?.__residence_clarification;
 const residenceHint=source?.reference_place==='haram'
  ?'\n\nإنت ذكرت المنصورية ناحية الهرم كمرجع لسكنك، لكن ماعنديش زمن مشوار مؤكّد لأي مكان شغل.'
  :'';
 const question=priority==='distance'
  ?'تقدر تتحمل مشوار شغل يومي قد إيه؟'
  :residenceHint?'علشان أرشحلك الأنسب: القرب من البيت أهم عندك ولا ثبات الدخل والمميزات؟'
   :priority?'تحب نركز على '+(PRIORITY_LABELS[priority]||'أولويتك')+'، ولا فيه عامل تاني مهم عندك؟'
    :'إيه الأهم ليك: القرب من البيت ولا ثبات الدخل والمميزات؟';
 return 'مقارنة سريعة حسب بيانات الشغل المسجلة حاليًا:\n\n'
  +families.map(placeComparisonBlock).join('\n')
  +'\n\n'+crossPlaceRecommendation(families,text,priority,profile)
  +residenceHint+'\n\n'+question;
}
function compareReply(items,text,place,profile=null){
 const lines=items.map(area=>'• '+modeLabel(areaMode(area))+': '+compactAreaSummary(area));
 const rec=recommendation(items,text,profile);
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
// Market and restaurant details are official CRM Areas data, never LLM summaries.
function operatingAreaDetailsOrSummary(area){
 return ['market','restaurants'].includes(areaMode(area))
  ?areaDetails(area):compactAreaSummary(area);
}
function requestedOperatingModeDetails(text){
 if(!/(?:تفاصيل|معلومات|نظام|شغل|مرتب|راتب|قبض|دخل|شيفت|شفت|اوردر|أوردر|ساعات|مميزات)/.test(norm(text)))return null;
 const market=hasAny(text,MARKET_WORDS);
 const restaurants=hasAny(text,RESTAURANT_WORDS);
 return market!==restaurants?(market?'market':'restaurants'):null;
}
function asksComparison(text){
 const n=norm(text);
 return /(?:الفرق|فرق|مقارنه|مقارنة|قارن|احسن|افضل|أفضل|انسب|أنسب|ترشح|رشح|اختارلي|اختار لي|تنصحني|مميزات اكتر|مميزاته اكتر)/.test(n)
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
 const profile=recommendationProfile(answers);
 const priority=comparisonPriority(text)||profile.primary||null;
 const storedKeys=storedComparisonKeys(answers,active);
 if((compare||priority)&&explicit.length>=2){
  const reply=comparePlacesReply(explicit,active,text,priority,profile,answers);
  if(reply)return {reply,action:'compare_places',comparisonKeys:explicit,priority};
 }
 if((compare||priority)&&explicit.length<2&&storedKeys.length>=2){
  const rememberedPriority=comparisonPriority(text)||answers?.__area_comparison?.priority||profile.primary||null;
  const reply=comparePlacesReply(storedKeys,active,text,rememberedPriority,profile,answers);
  if(reply)return {reply,action:'compare_places_followup',comparisonKeys:storedKeys,priority:rememberedPriority};
 }
 const key=explicit[0]||contextKey(answers,active);
 if(!key){
  if(compare)return {reply:generalComparison(active),action:'compare_work_modes_general'};
  // When the candidate did not specify a location, do not mix salary/benefits
  // from independent market or restaurant rows.
  const requestedMode=requestedOperatingModeDetails(text);
  if(requestedMode){
   const modeAreas=active.filter(a=>areaMode(a)===requestedMode);
   const modeName=modeLabel(requestedMode);
   if(modeAreas.length===1){
    const area=modeAreas[0];
    return {
     reply:'أكيد، دي تفاصيل شغل '+modeName+' المسجلة عندنا:\n\n'
      +areaDetails(area)+'\n\nلو التفاصيل مناسبة ليك قولّي «مناسبة وكمل».',
     action:'explain_area_mode',previewAreaId:area.id,contextPlaceKey:areaPlaceKey(area)
    };
   }
   if(modeAreas.length>1){
    const places=[...new Set(modeAreas.map(a=>displayPlace(familyByKey(active,areaPlaceKey(a)))))];
    return {
     reply:'تفاصيل شغل '+modeName+' بتختلف حسب المنطقة. '+modeName+' متاح عندنا في:\n'
      +places.map(name=>'• '+name).join('\n')
      +'\n\nقولّي أنهي منطقة تقصدها علشان أبعتلك تفاصيل '+modeName+' المسجلة فيها كاملة.',
     action:requestedMode==='market'?'ask_market_area':'ask_restaurant_area'
    };
   }
  }
  return null;
 }
 const family=familyByKey(active,key);
 if(!family.length)return null;
 const place=displayPlace(family);
 const general=family.find(a=>areaMode(a)==='general')||family[0];
 const variants=family.filter(a=>areaMode(a)!=='general');
 const detailedVariants=variants.filter(a=>String(a.details||'').trim());
 const requestedModes=[];
 if(hasAny(text,MARKET_WORDS))requestedModes.push('market');
 if(hasAny(text,RESTAURANT_WORDS))requestedModes.push('restaurants');

 if(compare){
  const compareItems=detailedVariants.filter(v=>!requestedModes.length||requestedModes.includes(areaMode(v)));
  if(compareItems.length>=2)return {reply:compareReply(compareItems,text,place,profile),action:'compare_area_modes',contextPlaceKey:key};
  if(detailedVariants.length>=2)return {reply:compareReply(detailedVariants.slice(0,3),text,place,profile),action:'compare_area_modes',contextPlaceKey:key};
  if(variants.length===1){
   return {reply:'في '+place+' المسجل عندي حاليًا '+modeLabel(areaMode(variants[0]))+' بس، ومش شايف النوع التاني متاح هناك دلوقتي.\n\n'+operatingAreaDetailsOrSummary(variants[0])+'\n\nلو مناسب ليك قولّي «مناسبة وكمل».',action:'explain_single_area_mode',previewAreaId:variants[0].id,contextPlaceKey:key};
  }
 }
 if(requestedModes.length){
  const target=variants.find(v=>requestedModes.includes(areaMode(v)));
  if(target)return {reply:'أيوه، '+place+' فيها '+modeLabel(areaMode(target))+' حسب المسجل عندنا.\n\n'+operatingAreaDetailsOrSummary(target)+'\n\nلو مناسب ليك قولّي «مناسبة وكمل».',action:'explain_area_mode',previewAreaId:target.id,contextPlaceKey:key};
  return {reply:'بالنسبة لـ'+place+'، مش شايف '+requestedModes.map(modeLabel).join(' أو ')+' مسجل حاليًا. المتاح عندي هو '+(variants.map(v=>modeLabel(areaMode(v))).join(' و ')||'المنطقة نفسها من غير تفاصيل تشغيل كفاية')+'.',action:'missing_area_mode',contextPlaceKey:key};
 }
 if(asksAvailability(text)||explicitKey(text,active)){
  if(variants.length===1){
   return {reply:'أيوه، '+place+' موجودة عندنا. المتاح المسجل حاليًا هناك '+modeLabel(areaMode(variants[0]))+'.\n\n'+operatingAreaDetailsOrSummary(variants[0])+'\n\nلو ده مناسب ليك قولّي «مناسبة وكمل».',action:'explain_area_family',previewAreaId:variants[0].id,contextPlaceKey:key};
  }
  if(variants.length>1){
   return {reply:'أيوه، '+place+' موجودة عندنا، وعندي فيها نظامين منفصلين:\n\n'+variants.slice(0,3).map(v=>'• '+modeLabel(areaMode(v))+': '+compactAreaSummary(v)).join('\n')+'\n\nقولّي «ماركت» أو «مطاعم» علشان أحددلك النظام نفسه وأقولك تفاصيله.',action:'choose_area_mode',contextPlaceKey:key};
  }
  if(String(general?.details||'').trim())return {reply:'أيوه، '+place+' موجودة عندنا.\n\n'+operatingAreaDetailsOrSummary(general)+'\n\nلو مناسبة ليك قولّي «مناسبة وكمل».',action:'explain_area_family',previewAreaId:general?.id||null};
 }
 return null;
}
