import {createClient} from '@supabase/supabase-js';
const url=import.meta.env.VITE_SUPABASE_URL,key=import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured=!!(url&&key);
export const supabase=configured?createClient(url,key):null;
const base=(import.meta.env.VITE_BOT_API_URL||'http://localhost:3001').replace(/\/$/,'');
export async function api(route,options={}){
 const {data}=await supabase.auth.getSession();
 const response=await fetch(base+'/api'+route,{...options,headers:{'Content-Type':'application/json',Authorization:`Bearer ${data.session?.access_token||''}`,...options.headers},signal:options.signal||AbortSignal.timeout(25000)});
 if(!response.ok){const e=await response.json().catch(()=>({}));throw new Error(e.error||'تعذر الوصول للخدمة');}
 return options.raw?response:response.json();
}
export const send=(route,body={},method='POST')=>api(route,{method,body:JSON.stringify(body)});
export const STAGES={new:'جديد',incomplete:'لم يكمل البيانات',complete:'أرسل البيانات بالكامل',lecture:'حضر المحاضرة',working:'بدأ شغل'};
export const KINDS={name:'الاسم الكامل',number:'العمر (1–100)',area:'منطقة العمل',yes_no:'نعم / لا',text:'نص حر',image:'صورة أو مستند PDF'};
export const personName=a=>Object.values(a.answers||{}).find(v=>v.kind==='name')?.display||a.display_name||'متقدم جديد';
export const date=v=>v?new Date(v).toLocaleString('ar-EG',{timeZone:'Africa/Cairo',dateStyle:'medium',timeStyle:'short'}):'—';
function cairoMidnight(day) {
 const noon=new Date(day+'T12:00:00Z');
 const offset=new Intl.DateTimeFormat('en',{timeZone:'Africa/Cairo',timeZoneName:'shortOffset'}).formatToParts(noon).find(p=>p.type==='timeZoneName').value;
 const hours=Number(offset.match(/GMT([+-]\d+)/)?.[1]||0);
 return new Date(Date.parse(day+'T00:00:00Z')-hours*3600000);
}
export function dateParams(from,to){const p=new URLSearchParams();if(from)p.set('from',cairoMidnight(from).toISOString());if(to){const next=new Date(to+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);p.set('to',cairoMidnight(next.toISOString().slice(0,10)).toISOString());}return p;}
