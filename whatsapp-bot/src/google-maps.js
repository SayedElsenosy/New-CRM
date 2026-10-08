import {asksForNearbyArea,mentionsResidence,nearestWorkAreas,nearestWorkAreaReply,resolveKnownPlace} from './location.js';

// Optional Google Maps integration. No key means the existing free local advisor stays intact.
// Google-derived coordinates are held in memory briefly, never written to the CRM database.
const geocodeCache=new Map();
const routeCache=new Map();
let dailyCalls={date:'',count:0};

function bounded(value,fallback,min,max){
 const n=Number(value);
 return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;
}
function coordinates(lat,lng){
 const latitude=Number(lat),longitude=Number(lng);
 if(!Number.isFinite(latitude)||!Number.isFinite(longitude))return null;
 // Reject invalid/non-Egyptian coordinates, including missing values coerced to 0.
 if(latitude<22||latitude>32||longitude<24||longitude>37)return null;
 return {lat:latitude,lng:longitude};
}
function haversine(a,b){
 const rad=n=>n*Math.PI/180,R=6371;
 const dLat=rad(b.lat-a.lat),dLng=rad(b.lng-a.lng);
 const v=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2;
 return 2*R*Math.asin(Math.sqrt(v));
}
function trimLocation(value){
 return String(value||'').replace(/\s+/g,' ').trim().slice(0,110);
}
export function extractResidenceLocation(value){
 const text=trimLocation(value);
 if(!text||text.length>110)return null;
 // Prefer the place after a residence phrase, not the surrounding recruiting question.
 const match=text.match(/(?:^|\s)(?:(?:انا|أنا)\s+)?(?:ساكنة?|عايشة?|سكني|السكن|مقيم|من)\s+(?:في\s+|ب\s+)?(.+)/i);
 let place=match?.[1]||null;
 if(!place&&!mentionsResidence(text)&&!asksForNearbyArea(text)&&!/[؟?]/.test(text))place=text;
 if(!place)return null;
 place=place.split(/[،,؛.!؟?]|\s+(?:وعايز|وعاوز|وايه|وإيه|ايه|إيه|فين|ازاي|ازاى|بس|اقرب|أقرب|عشان|علشان|محتاج|قولي|قولّي|ورشح)/i)[0];
 place=trimLocation(place).replace(/^(?:في|ب|من|منطقة|المنطقة|حي|الحي)\s+/,'');
 if(place.length<3||place.length>85||/^(?:ايه|إيه|فين|اقرب|أقرب|الاختيارات|ممكن|انا|أنا)/i.test(place))return null;
 return place;
}
function areaQuery(area){
 const base=trimLocation(area?.name).replace(/\s+(?:ماركت|مطاعم|مطعم|سوبر\s*ماركت|restaurant|restaurants|market)\s*$/i,'');
 return base||null;
}
function fixedAreaCoordinates(area){
 const given=coordinates(area?.latitude??area?.lat,area?.longitude??area?.lng);
 if(given)return given;
 for(const name of [area?.name,...(Array.isArray(area?.aliases)?area.aliases:[])]){
  const known=resolveKnownPlace(name);
  if(known)return coordinates(known.lat,known.lng);
 }
 return null;
}
function consumeQuota(maxDailyCalls){
 const date=new Date().toISOString().slice(0,10);
 if(dailyCalls.date!==date)dailyCalls={date,count:0};
 if(dailyCalls.count>=maxDailyCalls)return false;
 dailyCalls.count++;
 return true;
}
function cached(cache,key,ttl){
 const row=cache.get(key);
 if(!row)return null;
 if(Date.now()-row.at>ttl){cache.delete(key);return null;}
 return row.value;
}
function setCached(cache,key,value){
 if(cache.size>=200)cache.delete(cache.keys().next().value);
 cache.set(key,{value,at:Date.now()});
}
function requestConfig(options){
 const env=options.env||process.env;
 return {
  key:String(options.apiKey??env.GOOGLE_MAPS_API_KEY??'').trim(),
  routesEnabled:options.routesEnabled??(env.GOOGLE_MAPS_ROUTES_ENABLED==='true'),
  maxDailyCalls:bounded(options.maxDailyCalls??env.GOOGLE_MAPS_MAX_REQUESTS_PER_DAY,75,1,10000),
  maxNewAreaLookups:bounded(options.maxNewAreaLookups??env.GOOGLE_MAPS_MAX_AREA_LOOKUPS_PER_TURN,8,0,25),
  timeoutMs:bounded(options.timeoutMs??env.GOOGLE_MAPS_REQUEST_TIMEOUT_MS,2400,500,6000),
  fetchImpl:options.fetchImpl||fetch
 };
}
async function geocode(query,config){
 const value=trimLocation(query);
 if(!value)return null;
 const hit=cached(geocodeCache,value,60*60*1000);
 if(hit)return hit;
 if(!consumeQuota(config.maxDailyCalls))return null;
 try{
  const url=new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address',value);
  url.searchParams.set('components','country:EG');
  url.searchParams.set('region','eg');
  url.searchParams.set('language','ar');
  url.searchParams.set('key',config.key);
  const response=await config.fetchImpl(url.toString(),{signal:AbortSignal.timeout(config.timeoutMs)});
  if(!response.ok)return null;
  const body=await response.json();
  if(body?.status!=='OK'||!Array.isArray(body.results))return null;
  const result=body.results.find(r=>!r.partial_match&&r.address_components?.some(c=>c.types?.includes('country')&&c.short_name==='EG'));
  const point=coordinates(result?.geometry?.location?.lat,result?.geometry?.location?.lng);
  if(!point)return null;
  const item={...point,label:trimLocation(result.formatted_address||value)};
  setCached(geocodeCache,value,item);
  return item;
 }catch{return null;}
}
function waypoint(point){
 return {waypoint:{location:{latLng:{latitude:point.lat,longitude:point.lng}}}};
}
async function roadMatrix(origin,destinations,config){
 if(!destinations.length||!config.routesEnabled)return null;
 const cacheKey=[origin.lat.toFixed(5),origin.lng.toFixed(5),...destinations.map(d=>d.lat.toFixed(5)+','+d.lng.toFixed(5))].join('|');
 const hit=cached(routeCache,cacheKey,10*60*1000);
 if(hit)return hit;
 if(!consumeQuota(config.maxDailyCalls))return null;
 try{
  const response=await config.fetchImpl('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',{
   method:'POST',
   headers:{
    'Content-Type':'application/json',
    'X-Goog-Api-Key':config.key,
    'X-Goog-FieldMask':'originIndex,destinationIndex,status,condition,distanceMeters,duration'
   },
   body:JSON.stringify({
    origins:[waypoint(origin)],
    destinations:destinations.map(waypoint),
    travelMode:'DRIVE',
    routingPreference:'TRAFFIC_UNAWARE'
   }),
   signal:AbortSignal.timeout(config.timeoutMs)
  });
  if(!response.ok)return null;
  const body=await response.json();
  if(!Array.isArray(body))return null;
  const results=new Map();
  for(const row of body){
   const index=Number(row?.destinationIndex),meters=Number(row?.distanceMeters);
   if(!Number.isInteger(index)||index<0||index>=destinations.length||!(meters>=0))continue;
   if(row?.condition!=='ROUTE_EXISTS'||(row?.status?.code&&Number(row.status.code)!==0))continue;
   const seconds=Number(String(row.duration||'').replace(/s$/,''));
   results.set(index,{distance_km:meters/1000,duration_min:Number.isFinite(seconds)?Math.max(1,Math.round(seconds/60)):null});
  }
  if(!results.size)return null;
  setCached(routeCache,cacheKey,results);
  return results;
 }catch{return null;}
}
/**
 * Rank active CRM work areas near the *residence* without committing preferred_work_area.
 * Google Maps is optional. On API errors/quota failures use the original local heuristic.
 * Routing requests use <=8 distinct nearby destinations (billing is per matrix element).
 */
export async function nearestWorkAreasWithGoogleMaps(value,areas,options={}){
 const local=nearestWorkAreas(value,areas,options);
 const config=requestConfig(options);
 if(!config.key)return local;
 const explicit=resolveKnownPlace(value);
 const fallbackKnown=options.fallbackOriginKey?resolveKnownPlace(
  // Existing key stays in the local advisor; derive its origin when user follows up.
  local?.origin?.label||''
 ):null;
 let origin=explicit||fallbackKnown||null;
 let source='local';
 let query=null;
 if(!explicit){
  const supplied=extractResidenceLocation(value);
  query=supplied||trimLocation(options.fallbackOriginQuery||'')||null;
  if(query){
   const found=await geocode(query,config);
   if(found){
    origin={...found,key:'google_query',label:query};
    source='google_geocoding';
   }
  }
 }
 if(!origin)return local;
 const start=coordinates(origin.lat,origin.lng);
 if(!start)return local;
 const active=(areas||[]).filter(a=>a?.active===true&&a?.recruitment_eligible!==false);
 const rows=[];
 const missing=new Map();
 for(const area of active){
  const point=fixedAreaCoordinates(area);
  if(point)rows.push({area,point,distance_km:haversine(start,point)});
  else{
   const name=areaQuery(area);
   if(name){
    if(!missing.has(name))missing.set(name,[]);
    missing.get(name).push(area);
   }
  }
 }
 // Avoid geocoding an entire office's catalog on each message: use cached
 // locations first, then a strictly limited number of new Google lookups.
 let newLookups=0;
 for(const [name,group] of missing){
  const exists=Boolean(cached(geocodeCache,name,60*60*1000));
  if(!exists&&newLookups>=config.maxNewAreaLookups)continue;
  if(!exists)newLookups++;
  const point=await geocode(name,config);
  if(!point)continue;
  source='google_geocoding';
  for(const area of group)rows.push({area,point,distance_km:haversine(start,point)});
 }
 if(!rows.length)return local;
 rows.sort((a,b)=>a.distance_km-b.distance_km||(Number(a.area.position)||0)-(Number(b.area.position)||0));
 let ranked=rows;
 const distinct=new Map();
 for(const row of rows){
  const key=row.point.lat.toFixed(5)+','+row.point.lng.toFixed(5);
  if(!distinct.has(key)&&distinct.size<8)distinct.set(key,row.point);
 }
 if(config.routesEnabled){
  const destinations=[...distinct.values()];
  const routes=await roadMatrix(start,destinations,config);
  if(routes){
   const lookup=new Map([...distinct.keys()].map((key,index)=>[key,routes.get(index)]));
   const eligible=rows.map(row=>({...row,route:lookup.get(row.point.lat.toFixed(5)+','+row.point.lng.toFixed(5))}))
    .filter(row=>row.route);
   if(eligible.length>=Math.min(3,rows.length)){
    ranked=eligible.map(row=>({...row,distance_km:row.route.distance_km,duration_min:row.route.duration_min}))
     .sort((a,b)=>a.distance_km-b.distance_km||(Number(a.area.position)||0)-(Number(b.area.position)||0));
    source='google_routes';
   }
  }
 }
 const limit=bounded(options.limit,3,1,5);
 // Even a Google-based recommendation is only advice, never the committed work area.
 return {
  origin:{key:origin.key,label:origin.label,lat:origin.lat,lng:origin.lng},
  origin_query:origin.key==='google_query'?query:null,
  items:ranked.slice(0,limit),
  distance_source:source==='google_routes'?'road':'straight_line',
  google_maps_used:source!=='local',
  source
 };
}
export function nearestWorkAreaMapsReply(recommendation){
 if(!recommendation?.google_maps_used)return nearestWorkAreaReply(recommendation);
 if(!recommendation?.items?.length)return null;
 const road=recommendation.distance_source==='road';
 const lines=recommendation.items.map((item,index)=>{
  const suffix=road?' — حوالي '+item.distance_km.toFixed(1)+' كم بالطريق':'';
  return '• '+item.area.name+(index===0?' — الأقرب تقريبًا':'')+suffix;
 });
 return 'تمام، بما إنك في '+recommendation.origin.label+' فأقرب اختيارات الشغل المتاحة عندي تقريبًا هي:\n\n'
  +lines.join('\n')
  +'\n\nقولّي اسم المنطقة اللي حابب تعرف تفاصيلها، ولو محتار بينهم أقارنهم لك. ولو عايز أزرار اكتب «الاختيارات».'
  +'\n\n'+(road
   ?'المسافات تقديرية حسب طرق القيادة، ومش بتعكس الزحمة الحالية. المصدر: Google Maps.'
   :'الترشيح تقريبي على أساس المسافة الجغرافية المباشرة، مش وقت الطريق أو المواصلات. تحديد المواقع بمساعدة Google Maps.');
}
