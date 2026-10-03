import {allRows,must} from './db.js';
import {legacyPhone} from './domain.js';
export async function legacyImport(db){
 const result={applicants:0,messages:0,areas:0,questions:0,warnings:[]};
 let multi=false,accountId=null;
 try{const account=must(await db.from('masar_whatsapp_accounts').select('id').eq('active',true).order('legacy_session',{ascending:false}).order('created_at',{ascending:true}).limit(1).maybeSingle());if(account){multi=true;accountId=account.id;}}catch(e){if(!['PGRST205','42P01','42703'].includes(e.code))throw e;}
 async function read(table){try{return await allRows(db,table);}catch(e){if(['PGRST205','42P01'].includes(e.code))return [];throw e;}}
 const areas=await read('areas');
 for(const a of areas){if(!a.name)continue;must(await db.from('masar_areas').upsert({name:a.name,details:a.details||[a.description,a.working_hours,a.pickup_points,a.salary_info].filter(Boolean).join('\n'),active:a.is_active??a.active??true,position:a.sort_order||0},{onConflict:'name',ignoreDuplicates:true}));result.areas++;}
 const steps=await read('bot_flow');
 for(const [i,q]of steps.entries()){
  if(!q.question_text)continue;
  let key=String(q.key_to_save||'').trim();if(!/^[a-z][a-z0-9_]{0,39}$/.test(key))key='legacy_'+i;
  const kind=q.is_area_question||/area|zone/.test(key)?'area':/name/.test(key)?'name':/age/.test(key)?'number':/image|document|license_doc|id_doc/.test(key)?'image':/motorcycle|has_license|shift/.test(key)?'yes_no':'text';
  must(await db.from('masar_questions').upsert({label:q.question_text,field_key:key,kind,position:q.step_order||i+1,required:true,active:true},{onConflict:'field_key',ignoreDuplicates:true}));result.questions++;
 }
 const apps=await read('applicants');const byLegacy=new Map(),byPhone=new Map();
 for(const a of apps){
  const raw=String(a.phone_number||a.phone||'');const clean=raw.replace(/@(c\.us|s\.whatsapp\.net)$/,'').replace(/^\+/,'');
  const phone=legacyPhone(raw);
  let existing=must(await db.from('masar_applicants').select('id').eq('legacy_id',String(a.id)).maybeSingle());
  if(!existing&&phone){let q=db.from('masar_applicants').select('id').eq('phone',phone);if(multi)q=q.eq('whatsapp_account_id',accountId);existing=must(await q.maybeSingle());}
  if(!existing){const row={legacy_id:String(a.id),contact_id:phone?phone.slice(1)+'@c.us':raw.endsWith('@lid')?raw:'legacy:'+a.id,phone,display_name:a.whatsapp_name||a.name||'',notes:'مستورد من النسخة القديمة. راجع اكتمال البيانات. الحالة القديمة: '+(a.status||a.state||'غير محددة'),created_at:a.created_at||new Date().toISOString()};if(multi)row.whatsapp_account_id=accountId;existing=must(await db.from('masar_applicants').insert(row).select('id').single());}
  byLegacy.set(String(a.id),existing.id);byPhone.set(raw,existing.id);if(phone)byPhone.set(phone.slice(1),existing.id);result.applicants++;
 }
 for(const m of await read('messages')){
  const id=byLegacy.get(String(m.applicant_id))||byPhone.get(String(m.phone_number));if(!id)continue;
  const outbound=m.direction==='OUTBOUND'||['bot','staff'].includes(m.sender_type||m.sender);
  const row={applicant_id:id,wa_id:'legacy:'+m.id,direction:outbound?'out':'in',sender:outbound?'bot':'applicant',body:m.message_text||m.message||m.body||'',status:outbound?'sent':'processed',created_at:m.created_at||new Date().toISOString()};if(multi)row.whatsapp_account_id=accountId;must(await db.from('masar_messages').upsert(row,{onConflict:multi?'whatsapp_account_id,wa_id':'wa_id',ignoreDuplicates:true}));result.messages++;
 }
 result.warnings.push('الرسائل القديمة مستوردة كسجل فقط؛ الإجابات القديمة غير المنظمة لم تُفترض مكتملة، والمرفقات القديمة لا تُنقل تلقائياً.');
 return result;
}
