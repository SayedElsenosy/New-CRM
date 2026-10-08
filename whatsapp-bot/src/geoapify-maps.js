import {nearestWorkAreas,nearestWorkAreaReply,resolveKnownPlace} from './location.js';
import {extractResidenceLocation,nearestWorkAreasWithGoogleMaps,nearestWorkAreaMapsReply} from './google-maps.js';

// Geoapify's free API can be used without a credit card. Google remains an
// optional legacy provider; absent both keys the CRM's offline advisor works.
// Keep provider-specific caches in memory so candidate location data is never
// added to an applicant's record.
const geocodes=new Map(),matrices=new Map();
let daily={date:'',credits:0};
const bounded=(value,fallback,min,max)=>{
 const n=Number(value);
 return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;
};
const locationText=value=>String(value||'').replace(/\s+/g,' ').trim().slice(0,110);
function point(lat,lon){
 const a=Number(lat),b=Number(lon);
 return Number.isFinite(a)&&Number.isFinite(b)&&a>=22&&a<=32&&b>=24&&b<=37
  ?{lat:a,lng:b}:null;
}
function coordinates(area){
 const configured=point(area?.latitude??area?.lat,area?.longitude??area?.lng);
 if(configured)return configured;
 for(const alias of [area?.name,...(Array.isArray(area?.aliases)?area.aliases:[])]){
  const known=resolveKnownPlace(alias);
  if(known)return point(known.lat,known.lng);
 }
 return null;
}
function areaName(area){
 return locationText(area?.name).replace(/\s+(?:مطاعم|مطعم|ماركت|سوبر\s*ماركت|market|restaurant|restaurants)\s*$/i,'')||null;
}
function haversine(a,b){
 const rad=x=>x*Math.PI/180,dlat=rad(b.lat-a.lat),dlon=rad(b.lng-a.lng);
 return 2*6371*Math.asin(Math.sqrt(Math.sin(dlat/2)**2+
  Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlon/2)**2));
}
function cached(map,key,ttl){
 const row=map.get(key);
 if(!row)return null;
 if(Date.now()-row.at>ttl){map.delete(key);return null;}
 return row.value;
}
function save(map,key,value){
 if(map.size>=500)map.delete(map.keys().next().value);
 map.set(key,{at:Date.now(),value});
}
function quota(cost,maximum){
 const date=new Date().toISOString().slice(0,10);
 if(date!==daily.date)daily={date,credits:0};
 if(daily.credits+cost>maximum)return false;
 daily.credits+=cost; // Reservation; failures still count to avoid call storms.
 return true;
}
function setup(options){
 const env=options.env||process.env;
 return {
  key:String(options.geoapifyApiKey??env.GEOAPIFY_API_KEY??'').trim(),
  routes:options.geoapifyRoutesEnabled??(env.GEOAPIFY_ROUTES_ENABLED==='true'),
  maximum:bounded(options.geoapifyMaxDailyCredits??env.GEOAPIFY_MAX_DAILY_CREDITS,120,1,2800),
  maxAreaLookups:bounded(options.geoapifyMaxAreaLookups??env.GEOAPIFY_MAX_AREA_LOOKUPS_PER_TURN,4,0,12),
  maxDestinations:bounded(options.geoapifyMaxRouteDestinations??env.GEOAPIFY_MAX_ROUTE_DESTINATIONS,5,1,10),
  timeout:bounded(options.geoapifyTimeoutMs??env.GEOAPIFY_TIMEOUT_MS,2400,500,6000),
  fetchImpl:options.geoapifyFetchImpl||options.fetchImpl||fetch
 };
}
async function geocode(query,config){
 const name=locationText(query);
 if(!name)return null;
 const hit=cached(geocodes,name,7*24*60*60*1000);
 if(hit)return hit;
 if(!quota(1,config.maximum))return null;
 try{
  const url=new URL('https://api.geoapify.com/v1/geocode/search');
  url.searchParams.set('text',name);
  url.searchParams.set('filter','countrycode:eg');
  url.searchParams.set('format','json');
  url.searchParams.set('lang','ar');
  url.searchParams.set('limit','3');
  url.searchParams.set('apiKey',config.key);
  const response=await config.fetchImpl(url.toString(),{signal:AbortSignal.timeout(config.timeout)});
  if(!response.ok)return null;
  const data=await response.json();
  if(!Array.isArray(data?.results))return null;
  const match=data.results.find(x=>String(x.country_code).toLowerCase()==='eg'
    && !['country','state'].includes(x.result_type)
    && (x.rank?.confidence===undefined||Number(x.rank.confidence)>=.45)
    && point(x.lat,x.lon));
  if(!match)return null;
  const value={...point(match.lat,match.lon),label:name};
  save(geocodes,name,value);
  return value;
 }catch{return null;}
}
async function routes(origin,locations,config){
 if(!config.routes||locations.length===0)return null;
 const key=[origin,...locations].map(p=>p.lat.toFixed(5)+','+p.lng.toFixed(5)).join('|');
 const hit=cached(matrices,key,30*60*1000);
 if(hit)return hit;
 // A 1 x N basic matrix costs N credits in the Geoapify free-tier model.
 if(!quota(locations.length,config.maximum))return null;
 try{
  const url=new URL('https://api.geoapify.com/v1/routematrix');
  url.searchParams.set('apiKey',config.key);
  const response=await config.fetchImpl(url.toString(),{
   method:'POST',
   headers:{'Content-Type':'application/json'},
   body:JSON.stringify({
    mode:'drive',traffic:'free_flow',
    sources:[{location:[origin.lng,origin.lat]}],
    targets:locations.map(p=>({location:[p.lng,p.lat]}))
   }),
   signal:AbortSignal.timeout(config.timeout)
  });
  if(!response.ok)return null;
  const data=await response.json();
  const row=data?.sources_to_targets?.[0];
  if(!Array.isArray(row))return null;
  const result=new Map();
  for(let i=0;i<Math.min(locations.length,row.length);i++){
   const km=Number(row[i]?.distance)/1000,sec=Number(row[i]?.time);
   if(!Number.isFinite(km)||km<0||row[i]?.distance===null)continue;
   result.set(i,{distance_km:km,duration_min:Number.isFinite(sec)?Math.round(sec/60):null});
  }
  if(!result.size)return null;
  save(matrices,key,result);
  return result;
 }catch{return null;}
}
/**
 * Geoapify is preferred when a free API key is configured; Google is only a
 * secondary legacy option. Never use a residence as confirmed work area.
 */
export async function nearestWorkAreasWithFreeMaps(value,areas,options={}){
 const config=setup(options);
 if(!config.key)return nearestWorkAreasWithGoogleMaps(value,areas,options);
 const local=nearestWorkAreas(value,areas,options);
 const residential=extractResidenceLocation(value);
 const known=resolveKnownPlace(residential||value);
 let origin=known?{key:known.key,label:known.label,...point(known.lat,known.lng)}:null;
 let queried=null;
 if(!origin){
  queried=residential||locationText(options.fallbackOriginQuery)||null;
  if(queried){
   const found=await geocode(queried,config);
   if(found)origin={key:'geoapify_query',label:queried,lat:found.lat,lng:found.lng};
  }
 }
 if(!origin)return local;
 const active=(areas||[]).filter(area=>area?.active===true&&area?.recruitment_eligible!==false);
 const rows=[],missing=new Map();
 for(const area of active){
  const existing=coordinates(area);
  if(existing)rows.push({area,point:existing,distance_km:haversine(origin,existing)});
  else{
   const name=areaName(area);
   if(name){
    if(!missing.has(name))missing.set(name,[]);
    missing.get(name).push(area);
   }
  }
 }
 let newLookups=0;
 for(const [name,group] of missing){
  const existing=cached(geocodes,name,7*24*60*60*1000);
  if(!existing&&newLookups>=config.maxAreaLookups)continue;
  if(!existing)newLookups++;
  const located=existing||await geocode(name,config);
  if(!located)continue;
  for(const area of group)rows.push({area,point:located,distance_km:haversine(origin,located)});
 }
 if(!rows.length)return local;
 rows.sort((a,b)=>a.distance_km-b.distance_km||Number(a.area.position||0)-Number(b.area.position||0));
 const unique=new Map();
 for(const row of rows){
  const key=row.point.lat.toFixed(5)+','+row.point.lng.toFixed(5);
  if(!unique.has(key)&&unique.size<config.maxDestinations)unique.set(key,row.point);
 }
 let ranked=rows,road=false;
 const destinations=[...unique.values()];
 const matrix=await routes(origin,destinations,config);
 if(matrix){
  const byLocation=new Map([...unique.keys()].map((k,i)=>[k,matrix.get(i)]));
  const withRoutes=rows.map(r=>({...r,route:byLocation.get(r.point.lat.toFixed(5)+','+r.point.lng.toFixed(5))}))
   .filter(x=>x.route);
  if(withRoutes.length>=Math.min(3,rows.length)){
   ranked=withRoutes.map(r=>({...r,distance_km:r.route.distance_km,duration_min:r.route.duration_min}))
    .sort((a,b)=>a.distance_km-b.distance_km||Number(a.area.position||0)-Number(b.area.position||0));
   road=true;
  }
 }
 return {
  origin:{key:origin.key,label:origin.label,lat:origin.lat,lng:origin.lng},
  origin_query:queried||null,
  items:ranked.slice(0,bounded(options.limit,3,1,5)),
  distance_source:road?'road':'straight_line',
  geoapify_used:true,source:road?'geoapify_routes':'geoapify_geocoding'
 };
}
export function nearestWorkAreaFreeReply(result){
 if(!result?.geoapify_used)return result?.google_maps_used
  ?nearestWorkAreaMapsReply(result):nearestWorkAreaReply(result);
 if(!result.items?.length)return null;
 const road=result.distance_source==='road';
 const list=result.items.map((r,i)=>'• '+r.area.name
  +(i===0?' — الأقرب تقريبًا':'')
  +(road?' — حوالي '+r.distance_km.toFixed(1)+' كم بالطريق':'')).join('\n');
 return 'تمام، بما إنك في '+result.origin.label+' فأقرب مناطق الشغل المتاحة عندنا تقريبًا هي:\n\n'
  +list+'\n\nتحب أشرح لك تفاصيل أنهي منطقة؟ ولو محتار أقارنهم لك. ولو عايز الاختيارات كأزرار اكتب «الاختيارات».\n\n'
  +(road?'المسافات تقديرية حسب الطرق، مش زحمة الطريق الفعلية. '
   :'الترتيب تقريبي حسب المسافة المباشرة، مش وقت الطريق. ')
  +'بيانات المواقع والطرق: Geoapify / © OpenStreetMap contributors.';
}
