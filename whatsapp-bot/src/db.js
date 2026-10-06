import {createClient} from '@supabase/supabase-js';
export function database(env=process.env){
 if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)throw new Error('Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
 return createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
}
export function must(result){if(result.error)throw result.error;return result.data;}
export async function allRows(db,table,select='*'){
 const all=[];for(let page=0;;page++){
  const rows=must(await db.from(table).select(select).order('id').range(page*500,page*500+499));
  all.push(...rows);if(rows.length<500)return all;
 }
}
export function createSerial(){let tail=Promise.resolve();return task=>{const p=tail.then(task);tail=p.catch(()=>{});return p;};}
export function normalizeWorkAreas(areas=[]){
 return areas.map(area=>area?.active===true?{...area,recruitment_eligible:true}:area);
}
export async function config(db,officeId=null){
 const baseSettings=must(await db.from('masar_settings').select('*').eq('id',true).single());
 let q=db.from('masar_questions').select('*').order('position'),a=db.from('masar_areas').select('*').order('position');
 if(officeId){q=q.eq('office_id',officeId);a=a.eq('office_id',officeId);}
 let [qr,ar]=await Promise.all([q,a]);
 // Keep older installations working until migration 012 is applied.
 if(officeId&&['42703','PGRST204'].includes(qr.error?.code||''))qr=await db.from('masar_questions').select('*').order('position');
 if(officeId&&['42703','PGRST204'].includes(ar.error?.code||''))ar=await db.from('masar_areas').select('*').order('position');
 let officeSettings=null;
 if(officeId){
  const r=await db.from('masar_office_settings').select('*').eq('office_id',officeId).maybeSingle();
  if(!r.error)officeSettings=r.data;
  else if(!['PGRST205','42P01','42703','PGRST204'].includes(r.error.code))throw r.error;
 }
 const areas=normalizeWorkAreas(must(ar));
 const settings=officeSettings?{...baseSettings,...officeSettings,id:true,office_id:officeId}:baseSettings;
 // Intelligence policy is global and controlled only by the system owner.
 // Office settings may control office runtime/qualification/messages, but never
 // disable or retune the shared intelligence engine.
 settings.ai_enabled=baseSettings.ai_enabled!==false;
 settings.ai_knowledge_enabled=baseSettings.ai_knowledge_enabled!==false;
 settings.ai_learning_enabled=true;
 settings.ai_confidence_threshold=Number(baseSettings.ai_confidence_threshold||0.62);
 settings.ai_fallback=baseSettings.ai_fallback;
 return {questions:must(qr),areas,settings};
}
