import {createClient} from '@supabase/supabase-js';
const url=import.meta.env.VITE_SUPABASE_URL,key=import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured=!!(url&&key);
export const supabase=configured?createClient(url,key,{
 auth:{autoRefreshToken:true,persistSession:true,detectSessionInUrl:true}
}):null;
const base=(import.meta.env.VITE_BOT_API_URL||window.location.origin).replace(/\/$/,'');
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

async function request(route,options,token){
 return fetch(base+'/api'+route,{
  ...options,
  headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...options.headers},
  signal:options.signal||AbortSignal.timeout(25000)
 });
}

export async function api(route,options={}){
 let token=await accessToken();
 let response=await request(route,options,token);
 if(response.status===401){
  token=await refreshAccessToken();
  response=await request(route,options,token);
 }
 if(!response.ok){
  const e=await response.json().catch(()=>({}));
  if(response.status===401)await clearExpiredSession();
  throw new Error(e.error||'تعذر الوصول للخدمة');
 }
 return options.raw?response:response.json();
}
export const send=(route,body={},method='POST')=>api(route,{method,body:JSON.stringify(body)});
export const STAGES={new:'جديد',incomplete:'لم يكمل البيانات',complete:'أرسل البيانات بالكامل',lecture:'حضر المحاضرة',working:'بدأ شغل'};
export const RECRUITMENT_STAGES={new:'جديد',review:'قيد المراجعة',interview:'في المقابلة',accepted:'تم القبول',hired:'تم التعيين',rejected:'مرفوض'};
export const INTERVIEW_STATUSES={scheduled:'مجدولة',completed:'تمت',cancelled:'ملغاة',no_show:'لم يحضر'};
export const KINDS={name:'الاسم الكامل',number:'رقم',area:'منطقة العمل',yes_no:'نعم / لا',choice:'اختيارات بأزرار',text:'نص حر',image:'صورة أو مستند PDF'};
export const personName=a=>Object.values(a.answers||{}).find(v=>v.kind==='name')?.display||a.display_name||'متقدم جديد';
export const date=v=>v?new Date(v).toLocaleString('ar-EG',{timeZone:'Africa/Cairo',dateStyle:'medium',timeStyle:'short'}):'—';
function cairoMidnight(day) {
 const noon=new Date(day+'T12:00:00Z');
 const offset=new Intl.DateTimeFormat('en',{timeZone:'Africa/Cairo',timeZoneName:'shortOffset'}).formatToParts(noon).find(p=>p.type==='timeZoneName').value;
 const hours=Number(offset.match(/GMT([+-]\d+)/)?.[1]||0);
 return new Date(Date.parse(day+'T00:00:00Z')-hours*3600000);
}
export function dateParams(from,to){const p=new URLSearchParams();if(from)p.set('from',cairoMidnight(from).toISOString());if(to){const next=new Date(to+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);p.set('to',cairoMidnight(next.toISOString().slice(0,10)).toISOString());}return p;}
