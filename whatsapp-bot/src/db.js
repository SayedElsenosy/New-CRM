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
export async function config(db){const [q,a,s]=await Promise.all([db.from('masar_questions').select('*').order('position'),db.from('masar_areas').select('*').order('position'),db.from('masar_settings').select('*').eq('id',true).single()]);return {questions:must(q),areas:must(a),settings:must(s)};}
