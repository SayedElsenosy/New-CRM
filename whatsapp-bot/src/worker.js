import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {must,config} from './db.js';
import {planTurn} from './flow.js';
import {interpret} from './ai.js';

export class Worker {
 constructor({db,connection,connections,serial,sessionPath}){
  Object.assign(this,{db,connection,connections,serial});
  this.spool=path.join(sessionPath,'inbox');this.ticking=false;this.lastError=null;this.receiveSequence=0;
 }
 multi(){return Boolean(this.connections?.configured);}
 async init(){
  await fs.mkdir(this.spool,{recursive:true});
  must(await this.db.from('masar_messages').update({status:'uncertain',error:'الخدمة توقفت أثناء الإرسال؛ راجع واتساب قبل إعادة المحاولة.'}).eq('status','sending'));
  this.timer=setInterval(()=>this.tick(),2500);this.timer.unref();
 }
 async receive(record){
  if(!record?.id||!record?.contact_id)return;
  const fingerprint=String(record.whatsapp_account_id||'legacy')+':'+record.id;
  const file=path.join(this.spool,String(Date.now()).padStart(16,'0')+'-'+String(this.receiveSequence++).padStart(8,'0')+'-'+createHash('sha256').update(fingerprint).digest('hex')+'.json');
  try{await fs.access(file);return;}catch{}
  await fs.writeFile(file+'.tmp',JSON.stringify(record),{mode:0o600});await fs.rename(file+'.tmp',file);
  this.tick();
 }
 async ingest(record){
  const accountId=record.whatsapp_account_id||null,multi=this.multi();
  let existingQuery=this.db.from('masar_messages').select('id').eq('wa_id',record.id);
  if(multi)existingQuery=existingQuery.eq('whatsapp_account_id',accountId);
  const existing=must(await existingQuery.maybeSingle());if(existing)return;

  let applicantQuery=this.db.from('masar_applicants').select('*').eq('contact_id',record.contact_id);
  if(multi)applicantQuery=applicantQuery.eq('whatsapp_account_id',accountId);
  let a=must(await applicantQuery.maybeSingle());

  if(!a){
   let aliasQuery=this.db.from('masar_contacts').select('applicant_id').eq('contact_id',record.contact_id);
   if(multi)aliasQuery=aliasQuery.eq('whatsapp_account_id',accountId);
   const alias=must(await aliasQuery.maybeSingle());
   if(alias)a=must(await this.db.from('masar_applicants').select('*').eq('id',alias.applicant_id).single());
  }
  if(record.phone){
   let canonicalQuery=this.db.from('masar_applicants').select('*').eq('phone',record.phone);
   if(multi)canonicalQuery=canonicalQuery.eq('whatsapp_account_id',accountId);
   const canonical=must(await canonicalQuery.maybeSingle());
   if(canonical&&a&&canonical.id!==a.id){must(await this.db.rpc('masar_merge_applicants',{p_source:a.id,p_target:canonical.id}));a=canonical;}
   else if(canonical)a=canonical;
  }

  const referral=record.referral?.source_id?record.referral:null;
  if(!a){
   const row={contact_id:record.contact_id,phone:record.phone,last_message_at:record.created_at};
   if(multi)row.whatsapp_account_id=accountId;
   if(referral)row.answers={__attribution:referral};
   a=must(await this.db.from('masar_applicants').insert(row).select().single());
  }else{
   const patch={contact_id:record.contact_id,last_message_at:record.created_at,updated_at:new Date().toISOString()};
   if(record.phone)patch.phone=record.phone;
   if(referral&&!a.answers?.__attribution)patch.answers={...(a.answers||{}),__attribution:referral};
   must(await this.db.from('masar_applicants').update(patch).eq('id',a.id));
   if(patch.answers)a={...a,answers:patch.answers};
  }

  const contactRow={contact_id:record.contact_id,applicant_id:a.id};
  if(multi)contactRow.whatsapp_account_id=accountId;
  must(await this.db.from('masar_contacts').upsert(contactRow,{onConflict:multi?'whatsapp_account_id,contact_id':'contact_id'}));

  if(referral){
   must(await this.db.from('masar_events').insert({applicant_id:a.id,kind:'ad_referral',detail:{...referral,whatsapp_account_id:accountId}}));
   try{
    const current=must(await this.db.from('masar_ads').select('*').eq('ad_id',referral.source_id).maybeSingle());
    const metadata={headline:referral.title||current?.headline||'',source_url:referral.source_url||current?.source_url||null,source_app:referral.source_app||current?.source_app||null,source_type:referral.source_type||current?.source_type||'ad',last_seen_at:record.created_at};
    if(current)must(await this.db.from('masar_ads').update(metadata).eq('ad_id',referral.source_id));
    else must(await this.db.from('masar_ads').insert({ad_id:referral.source_id,name:referral.title||'',...metadata,first_seen_at:record.created_at}));
   }catch(e){console.warn('Ad attribution metadata not indexed yet:',e.code||e.name);}
  }

  let media_path=null;
  if(record.media){
   media_path=`${a.id}/${createHash('sha256').update(String(accountId||'legacy')+':'+record.id).digest('hex')}`;
   must(await this.db.storage.from('masar-documents').upload(media_path,Buffer.from(record.media.data,'base64'),{contentType:record.media.type,upsert:true}));
  }
  const messageRow={applicant_id:a.id,wa_id:record.id,direction:'in',sender:'applicant',body:record.body,media_path,media_type:record.media?.type,media_error:record.media_error,created_at:record.created_at};
  if(multi)messageRow.whatsapp_account_id=accountId;
  must(await this.db.from('masar_messages').insert(messageRow));
 }
 async tick(){
  if(this.ticking)return;this.ticking=true;
  try{await this.serial(async()=>{
   for(const name of (await fs.readdir(this.spool)).filter(n=>n.endsWith('.json')).sort()){
    const p=path.join(this.spool,name);await this.ingest(JSON.parse(await fs.readFile(p,'utf8')));await fs.unlink(p);
   }

   const messages=must(await this.db.from('masar_messages').select('*').eq('status','pending').order('sequence').limit(20));
   const blocked=new Set();
   for(const m of messages){
    if(blocked.has(m.applicant_id))continue;
    const prior=must(await this.db.from('masar_messages').select('id').eq('applicant_id',m.applicant_id).eq('direction','in').eq('status','failed').lte('sequence',m.sequence).limit(1));
    if(prior.length){blocked.add(m.applicant_id);continue;}
    try{
     const a=must(await this.db.from('masar_applicants').select('*').eq('id',m.applicant_id).single()),c=await config(this.db);
     const turn=await planTurn({applicant:a,message:m,...c,interpret});
     must(await this.db.rpc('masar_commit_turn',{p_message:m.id,p_patch:turn.patch,p_reply:turn.reply}));
    }catch(e){
     blocked.add(m.applicant_id);const attempts=m.attempts+1;
     must(await this.db.from('masar_messages').update({attempts,status:attempts>=3?'failed':'pending',error:'تعذر معالجة الرسالة؛ أعد المحاولة من ملف المتقدم.'}).eq('id',m.id));
     this.lastError='توجد رسالة تحتاج مراجعة في ملف المتقدم';
    }
   }

   const outgoing=must(await this.db.from('masar_messages').select('*').eq('status','queued').order('sequence').limit(30));
   const sendConfig=outgoing.length?await config(this.db):null;
   for(const m of outgoing){
    const accountId=this.multi()?m.whatsapp_account_id:this.connections?.defaultAccountId?.()||null;
    const snapshot=this.connections?this.connections.snapshot(accountId):this.connection?.snapshot();
    if(snapshot?.status!=='connected')continue;
    const a=must(await this.db.from('masar_applicants').select('contact_id,awaiting_id,bot_enabled,answers').eq('id',m.applicant_id).single());
    let buttons=[];
    if(m.sender==='bot'&&a.bot_enabled&&sendConfig){
     const q=sendConfig.questions.find(q=>q.active&&q.id===a.awaiting_id);
     if(q?.kind==='area'){
      const activeAreas=sendConfig.areas.filter(area=>area.active);
      const previewId=a.answers?.__area_preview?.value;
      const preview=activeAreas.find(area=>area.id===previewId);
      if(preview)buttons.push({id:'confirm_area:'+preview.id,text:'✅ تأكيد '+preview.name});
      buttons.push(...activeAreas.map(area=>({id:'area_preview:'+area.id,text:area.name})));
     }
    }
    must(await this.db.from('masar_messages').update({status:'sending'}).eq('id',m.id));
    try{
     const sent=this.connections?await this.connections.send(accountId,a.contact_id,m.body,{buttons}):await this.connection.send(a.contact_id,m.body,{buttons});
     must(await this.db.from('masar_messages').update({status:'sent',wa_id:sent?.key?.id||sent?.id?._serialized||null,error:null}).eq('id',m.id));
    }catch{
     must(await this.db.from('masar_messages').update({status:'uncertain',error:'لم نتأكد من وصول الرد. راجع واتساب قبل إعادة إرساله.'}).eq('id',m.id));
    }
   }
  });}catch(e){
   this.lastError='تعذر الاتصال بقاعدة البيانات؛ الرسائل المحفوظة محلياً ستُعاد معالجتها.';
   console.error('Worker:',e.code||e.name);
  }finally{this.ticking=false;}
 }
 stop(){clearInterval(this.timer);}
}
