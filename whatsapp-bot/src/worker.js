import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {must,config} from './db.js';
import {planTurn} from './flow.js';
import {interpret} from './ai.js';
import {loadKnowledge,schemaMissing,createLearningSuggestion} from './knowledge.js';

export class Worker {
 constructor({db,connection,connections,serial,sessionPath,speech=null}){
  Object.assign(this,{db,connection,connections,serial,speech});
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
 async prepareRecordMedia(record,applicantId,accountId){
  let body=String(record.body||''),media_path=null,media_error=record.media_error||null,transcribed=false,transcription_trusted=false,transcription_confidence=null;
  const media=record.media||null;
  if(media){
   const bytes=Buffer.from(media.data,'base64');
   media_path=`${applicantId}/${createHash('sha256').update(String(accountId||'legacy')+':'+record.id).digest('hex')}`;
   try{
    must(await this.db.storage.from('masar-documents').upload(media_path,bytes,{contentType:media.type,upsert:true}));
   }catch(e){
    if(media.kind!=='audio')throw e;
    media_path=null;
    media_error='تم استلام الرسالة الصوتية لكن تعذر حفظ ملف التسجيل في التخزين.';
    console.warn('Voice storage failed:',e.code||e.name||'Error');
   }
   if(media.kind==='audio'&&!body.trim()){
    try{
     if(!this.speech?.available)throw new Error(this.speech?.error||'speech unavailable');
     const transcript=await this.speech.transcribe(bytes,media.type);
     body=transcript.text;
     transcribed=true;
     transcription_trusted=Boolean(transcript.trusted);
     transcription_confidence=Number.isFinite(transcript.confidence)?transcript.confidence:null;
     if(!transcription_trusted){
      const pct=transcription_confidence===null?'':` (ثقة ${Math.round(transcription_confidence*100)}%)`;
      media_error='التفريغ الصوتي غير موثوق'+pct+'؛ لم يستخدمه البوت في الرد أو التعلّم. راجع التسجيل الأصلي.';
     }
    }catch(e){
     body='🎤 رسالة صوتية';
     media_error=media_path?'تم حفظ الرسالة الصوتية لكن تعذر تحويلها إلى نص تلقائياً. يمكن لمسؤول التوظيف تشغيل التسجيل ومراجعته.':'تعذر حفظ الرسالة الصوتية أو تحويلها إلى نص تلقائياً؛ يحتاج مسؤول التوظيف لمراجعتها من واتساب.';
     console.warn('Voice transcription failed:',e.code||e.name||'Error');
    }
   }
  }
  return {body:body.slice(0,10000),media_path,media_type:media?.type||null,media_error,transcribed,transcription_trusted,transcription_confidence,is_audio:media?.kind==='audio'};
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

  const isExternalOutbound=record.direction==='out'||record.from_me===true;
  if(isExternalOutbound){
   const prepared=await this.prepareRecordMedia(record,a.id,accountId);
   const source=must(await this.db.from('masar_messages').select('id,body').eq('applicant_id',a.id).eq('direction','in').order('sequence',{ascending:false}).limit(1).maybeSingle());
   const messageRow={applicant_id:a.id,wa_id:record.id,direction:'out',sender:'staff',body:prepared.body,media_path:prepared.media_path,media_type:prepared.media_type,media_error:prepared.media_error,status:'sent',reply_to:source?.id||null,created_at:record.created_at};
   if(multi)messageRow.whatsapp_account_id=accountId;
   const saved=must(await this.db.from('masar_messages').insert(messageRow).select('id').single());

   let settings=null,runMode='live';
   try{
    settings=must(await this.db.from('masar_settings').select('*').eq('id',true).single());
    runMode=settings.ai_run_mode||'live';
    if(runMode==='training'&&settings.ai_training_until&&Date.parse(settings.ai_training_until)<=Date.now()){
     try{must(await this.db.from('masar_settings').update({ai_run_mode:'paused'}).eq('id',true));}catch(e){if(!schemaMissing(e)&&e.code!=='PGRST204'&&e.code!=='42703')throw e;}
     runMode='paused';
    }
   }catch(e){if(!schemaMissing(e))throw e;}
   if(runMode==='live')must(await this.db.from('masar_applicants').update({bot_enabled:false,updated_at:new Date().toISOString()}).eq('id',a.id));

   let learned=false;
   if(source&&settings?.ai_learning_enabled!==false){
    learned=await createLearningSuggestion(this.db,{
     applicantId:a.id,sourceMessage:source,staffMessageId:saved.id,answer:(prepared.transcribed&&prepared.transcription_trusted)||!prepared.is_audio?prepared.body:'',staffId:null,force:runMode==='training'
    });
   }
   must(await this.db.from('masar_events').insert({applicant_id:a.id,kind:'staff_whatsapp_reply',detail:{message_id:saved.id,source_message_id:source?.id||null,source:'linked_whatsapp_device',learning_suggestion_created:Boolean(learned),run_mode:runMode,voice:Boolean(prepared.is_audio),transcribed:Boolean(prepared.transcribed),transcription_trusted:Boolean(prepared.transcription_trusted),transcription_confidence:prepared.transcription_confidence}}));
   return;
  }

  if(referral){
   must(await this.db.from('masar_events').insert({applicant_id:a.id,kind:'ad_referral',detail:{...referral,whatsapp_account_id:accountId}}));
   try{
    const current=must(await this.db.from('masar_ads').select('*').eq('ad_id',referral.source_id).maybeSingle());
    const metadata={headline:referral.title||current?.headline||'',source_url:referral.source_url||current?.source_url||null,source_app:referral.source_app||current?.source_app||null,source_type:referral.source_type||current?.source_type||'ad',last_seen_at:record.created_at};
    if(current)must(await this.db.from('masar_ads').update(metadata).eq('ad_id',referral.source_id));
    else must(await this.db.from('masar_ads').insert({ad_id:referral.source_id,name:referral.title||'',...metadata,first_seen_at:record.created_at}));
   }catch(e){console.warn('Ad attribution metadata not indexed yet:',e.code||e.name);}
  }

  const prepared=await this.prepareRecordMedia(record,a.id,accountId);
  const messageRow={applicant_id:a.id,wa_id:record.id,direction:'in',sender:'applicant',body:prepared.body,media_path:prepared.media_path,media_type:prepared.media_type,media_error:prepared.media_error,created_at:record.created_at};
  if(prepared.is_audio&&(!prepared.transcribed||!prepared.transcription_trusted))messageRow.status='processed';
  if(multi)messageRow.whatsapp_account_id=accountId;
  const saved=must(await this.db.from('masar_messages').insert(messageRow).select('id').single());
  if(prepared.is_audio){
   must(await this.db.from('masar_events').insert({applicant_id:a.id,kind:'voice_message',detail:{message_id:saved.id,direction:'in',transcribed:Boolean(prepared.transcribed),transcription_trusted:Boolean(prepared.transcription_trusted),transcription_confidence:prepared.transcription_confidence}}));
  }
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
     const c=await config(this.db);
     let runMode=c.settings?.ai_run_mode||'live';
     if(runMode==='training'&&c.settings?.ai_training_until&&Date.parse(c.settings.ai_training_until)<=Date.now()){
      try{must(await this.db.from('masar_settings').update({ai_run_mode:'paused'}).eq('id',true));}catch(e){if(!schemaMissing(e)&&e.code!=='PGRST204'&&e.code!=='42703')throw e;}
      runMode='paused';
     }
     if(runMode!=='live'){
      must(await this.db.from('masar_messages').update({status:'processed',error:null}).eq('id',m.id));
      continue;
     }
     const a=must(await this.db.from('masar_applicants').select('*').eq('id',m.applicant_id).single()),knowledge=await loadKnowledge(this.db);
     const turn=await planTurn({applicant:a,message:m,...c,interpret,knowledge});
     must(await this.db.rpc('masar_commit_turn',{p_message:m.id,p_patch:turn.patch,p_reply:turn.reply}));
     if(turn.knowledge_id){
      try{
       const row=must(await this.db.from('masar_knowledge').select('usage_count').eq('id',turn.knowledge_id).single());
       must(await this.db.from('masar_knowledge').update({usage_count:Number(row.usage_count||0)+1,last_used_at:new Date().toISOString()}).eq('id',turn.knowledge_id));
      }catch(e){if(!schemaMissing(e))throw e;}
     }
     if(turn.handoff){
      must(await this.db.from('masar_events').insert({applicant_id:a.id,kind:'ai_handoff',detail:{message_id:m.id,question:String(m.body||'').slice(0,1000),reason:'low_confidence'}}));
     }
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
