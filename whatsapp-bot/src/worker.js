import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {must,config} from './db.js';
import {resolvePhone} from './whatsapp.js';
import {planTurn} from './flow.js';
import {interpret} from './ai.js';
export class Worker {
 constructor({db,connection,serial,sessionPath}){Object.assign(this,{db,connection,serial});this.spool=path.join(sessionPath,'inbox');this.ticking=false;this.lastError=null;this.receiveSequence=0;}
 async init(){await fs.mkdir(this.spool,{recursive:true});must(await this.db.from('masar_messages').update({status:'uncertain',error:'الخدمة توقفت أثناء الإرسال؛ راجع واتساب قبل إعادة المحاولة.'}).eq('status','sending'));this.timer=setInterval(()=>this.tick(),2500);this.timer.unref();}
 async receive(client,msg){
  if(msg.fromMe||!/@(c\.us|s\.whatsapp\.net|lid)$/.test(msg.from))return;
  const chat=await msg.getChat();if(chat.isGroup)return;
  const id=msg.id?._serialized;if(!id)return;
  const file=path.join(this.spool,String(Date.now()).padStart(16,'0')+'-'+String(this.receiveSequence++).padStart(8,'0')+'-'+createHash('sha256').update(id).digest('hex')+'.json');
  try{await fs.access(file);return;}catch{}
  let phone=await resolvePhone(client,msg);let media=null,media_error=null;
  if(msg.hasMedia){try{
   if(Number(msg._data?.size)>10485760)throw new Error('too large');
   const d=await msg.downloadMedia();
   if(!d||!['image/jpeg','image/png','image/webp','application/pdf'].includes(d.mimetype)||Buffer.byteLength(d.data,'base64')>10485760)throw new Error('unsupported');
   const bytes=Buffer.from(d.data,'base64');
   const valid=(d.mimetype==='image/jpeg'&&bytes.subarray(0,3).equals(Buffer.from([255,216,255])))||(d.mimetype==='image/png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(d.mimetype==='image/webp'&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')||(d.mimetype==='application/pdf'&&bytes.subarray(0,5).toString()==='%PDF-');
   if(!valid)throw new Error('invalid media');media={data:d.data,type:d.mimetype};
  }catch{media_error='تعذر حفظ المرفق. ابعت صورة JPG/PNG/WebP أو PDF بحجم أقل من 10 ميجا.';}}
  const record={id,contact_id:msg.from,phone,body:String(msg.body||'').slice(0,10000),media,media_error,created_at:new Date((msg.timestamp||Date.now()/1000)*1000).toISOString()};
  await fs.writeFile(file+'.tmp',JSON.stringify(record),{mode:0o600});await fs.rename(file+'.tmp',file);
  this.tick();
 }
 async ingest(record){
  const existing=must(await this.db.from('masar_messages').select('id').eq('wa_id',record.id).maybeSingle());if(existing)return;
  let a=must(await this.db.from('masar_applicants').select('*').eq('contact_id',record.contact_id).maybeSingle());
  if(!a){const alias=must(await this.db.from('masar_contacts').select('applicant_id').eq('contact_id',record.contact_id).maybeSingle());if(alias)a=must(await this.db.from('masar_applicants').select('*').eq('id',alias.applicant_id).single());}
  if(record.phone){const canonical=must(await this.db.from('masar_applicants').select('*').eq('phone',record.phone).maybeSingle());
   if(canonical&&a&&canonical.id!==a.id){must(await this.db.rpc('masar_merge_applicants',{p_source:a.id,p_target:canonical.id}));a=canonical;}
   else if(canonical)a=canonical;
  }
  if(!a)a=must(await this.db.from('masar_applicants').insert({contact_id:record.contact_id,phone:record.phone,last_message_at:record.created_at}).select().single());
  else {const patch={contact_id:record.contact_id,last_message_at:record.created_at,updated_at:new Date().toISOString()};if(record.phone)patch.phone=record.phone;must(await this.db.from('masar_applicants').update(patch).eq('id',a.id));}
  must(await this.db.from('masar_contacts').upsert({contact_id:record.contact_id,applicant_id:a.id},{onConflict:'contact_id'}));
  let media_path=null;
  if(record.media){media_path=`${a.id}/${createHash('sha256').update(record.id).digest('hex')}`;must(await this.db.storage.from('masar-documents').upload(media_path,Buffer.from(record.media.data,'base64'),{contentType:record.media.type,upsert:true}));}
  must(await this.db.from('masar_messages').insert({applicant_id:a.id,wa_id:record.id,direction:'in',sender:'applicant',body:record.body,media_path,media_type:record.media?.type,media_error:record.media_error,created_at:record.created_at}));
 }
 async tick(){
  if(this.ticking)return;this.ticking=true;
  try{await this.serial(async()=>{
   for(const name of (await fs.readdir(this.spool)).filter(n=>n.endsWith('.json')).sort()){const p=path.join(this.spool,name);await this.ingest(JSON.parse(await fs.readFile(p,'utf8')));await fs.unlink(p);}
   const messages=must(await this.db.from('masar_messages').select('*').eq('status','pending').order('sequence').limit(20));
   const blocked=new Set();
   for(const m of messages){if(blocked.has(m.applicant_id))continue;
    const prior=must(await this.db.from('masar_messages').select('id').eq('applicant_id',m.applicant_id).eq('direction','in').eq('status','failed').lte('sequence',m.sequence).limit(1));
    if(prior.length){blocked.add(m.applicant_id);continue;}
    try{
    const a=must(await this.db.from('masar_applicants').select('*').eq('id',m.applicant_id).single());const c=await config(this.db);
    const turn=await planTurn({applicant:a,message:m,...c,interpret});
    must(await this.db.rpc('masar_commit_turn',{p_message:m.id,p_patch:turn.patch,p_reply:turn.reply}));
   }catch(e){blocked.add(m.applicant_id);const attempts=m.attempts+1;must(await this.db.from('masar_messages').update({attempts,status:attempts>=3?'failed':'pending',error:'تعذر معالجة الرسالة؛ أعد المحاولة من ملف المتقدم.'}).eq('id',m.id));this.lastError='توجد رسالة تحتاج مراجعة في ملف المتقدم';}}
   if(this.connection.snapshot().status==='connected'){
    const outgoing=must(await this.db.from('masar_messages').select('*').eq('status','queued').order('sequence').limit(20));
    for(const m of outgoing){const a=must(await this.db.from('masar_applicants').select('contact_id').eq('id',m.applicant_id).single());
     must(await this.db.from('masar_messages').update({status:'sending'}).eq('id',m.id));
     try{const sent=await this.connection.send(a.contact_id,m.body);must(await this.db.from('masar_messages').update({status:'sent',wa_id:sent?.id?._serialized||null,error:null}).eq('id',m.id));}
     catch{must(await this.db.from('masar_messages').update({status:'uncertain',error:'لم نتأكد من وصول الرد. راجع واتساب قبل إعادة إرساله.'}).eq('id',m.id));}
    }
   }
  });}catch(e){this.lastError='تعذر الاتصال بقاعدة البيانات؛ الرسائل المحفوظة محلياً ستُعاد معالجتها.';console.error('Worker:',e.code||e.name);}finally{this.ticking=false;}
 }
 stop(){clearInterval(this.timer);}
}
