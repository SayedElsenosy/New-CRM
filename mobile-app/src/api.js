import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {createClient} from '@supabase/supabase-js';

const supabaseUrl=process.env.EXPO_PUBLIC_SUPABASE_URL||'';
const supabaseKey=process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY||'';
const rawApiBase=(process.env.EXPO_PUBLIC_BOT_API_URL||'').replace(/\/+$/,'');
const apiBase=rawApiBase.endsWith('/api')?rawApiBase.slice(0,-4):rawApiBase;
const apiPointsToSupabase=/\.supabase\.co(?:$|\/)/i.test(apiBase);

export const configured=Boolean(supabaseUrl&&supabaseKey&&apiBase);
export const supabase=configured?createClient(supabaseUrl,supabaseKey,{
 auth:{storage:AsyncStorage,autoRefreshToken:true,persistSession:true,detectSessionInUrl:false}
}):null;

async function timeoutFetch(url,options,ms=25000){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),ms);
 try{return await fetch(url,{...options,signal:controller.signal});}
 finally{clearTimeout(timer);}
}

let refreshPromise=null;

async function clearExpiredSession(){
 try{await supabase.auth.signOut({scope:'local'});}catch{try{await supabase.auth.signOut();}catch{}}
}

async function refreshAccessToken(){
 if(!refreshPromise){
  refreshPromise=supabase.auth.refreshSession().finally(()=>{refreshPromise=null;});
 }
 const {data,error}=await refreshPromise;
 const token=data?.session?.access_token;
 if(error||!token){
  await clearExpiredSession();
  throw new Error('انتهت الجلسة؛ سجل الدخول مجدداً');
 }
 return token;
}

async function accessToken(){
 const {data,error}=await supabase.auth.getSession();
 const session=data?.session;
 if(error||!session?.access_token)throw new Error('سجل الدخول أولاً');
 const expiresAt=Number(session.expires_at||0)*1000;
 if(expiresAt&&expiresAt<=Date.now()+60000)return refreshAccessToken();
 return session.access_token;
}

async function performRequest(route,options,token){
 try{
  return await timeoutFetch(apiBase+'/api'+route,{
   ...options,
   headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...(options.headers||{})}
  });
 }catch(e){
  if(e?.name==='AbortError')throw new Error('الخدمة استغرقت وقتاً طويلاً في الرد');
  throw new Error('تعذر الوصول إلى السيرفر');
 }
}

export async function api(route,options={}){
 if(!configured)throw new Error('إعدادات التطبيق غير مكتملة');
 if(apiPointsToSupabase)throw new Error('رابط الـBackend مضبوط على Supabase بالخطأ. استخدم رابط الـCRM العام نفسه بدون /api في آخره.');
 let token=await accessToken();
 let response=await performRequest(route,options,token);
 if(response.status===401){
  token=await refreshAccessToken();
  response=await performRequest(route,options,token);
 }
 if(!response.ok){
  const body=await response.json().catch(()=>({}));
  if(response.status===401)await clearExpiredSession();
  throw new Error(body.error||'تعذر إتمام العملية');
 }
 if(options.raw)return response;
 return response.json();
}
export function send(route,body={},method='POST'){
 return api(route,{method,body:JSON.stringify(body)});
}

export const STAGES={
 new:'جديد',
 incomplete:'لم يكمل البيانات',
 complete:'أرسل البيانات بالكامل',
 lecture:'حضر المحاضرة',
 working:'بدأ شغل'
};
export const personName=a=>Object.values(a?.answers||{}).find(v=>v?.kind==='name')?.display||a?.display_name||'متقدم جديد';
export const fmtDate=v=>v?new Date(v).toLocaleString('ar-EG',{dateStyle:'medium',timeStyle:'short'}):'—';
export const can=(bootstrap,permission)=>bootstrap?.role==='admin'||bootstrap?.permissions?.includes(permission);
