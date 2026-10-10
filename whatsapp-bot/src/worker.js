import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {must,config} from './db.js';
import {planTurn} from './flow.js';
import {updateBrainMemory,needsLlmPlanning} from './brain-memory.js';
import {loadLifetimeMemory} from './lifetime-memory.js';
import {retrieveHistoricalExcerpts,historicalRecallNeeded} from './historical-retrieval.js';
import {retrieveConversationEpisodes,needsConversationEpisodes} from './conversation-episodes.js';
import {turnQualitySignals} from './conversation-intelligence.js';
import {qualityIssueAlertCandidate} from './quality-alerts.js';
import {enrollNewInboundApplicant} from './pilot-observation.js';
import {interpret} from './ai.js';
import {loadKnowledge,schemaMissing,learnFromConversation} from './knowledge.js';
import {followupDue,buildFollowupMessage} from './followup.js';
import {sendHumanInterventionPush,sendOfficeQualityPush} from './push.js';
import {syncRecruitmentStageFromConversation} from './conversation-stage.js';
import {withFirstAttribution} from './attribution.js';
import {accountCanReply,hasVerifiedAdReferral,historyReviewRequired,shouldCreateHistoryReviewAlert,initialHistoryReview,historicalChatMark,eligibleForAutoAdStart,automaticAdReview,pauseOnHistoricalStaffReply} from './reply-scope.js';
import {questionPrompt,areaDetails} from './domain.js';
import {syncInterviewFromStaffMessages,reconcileRecentStaffInterviews} from './interview-automation.js';

export function shouldBrowseAreaButtons(_question,body){
 const text=String(body||'');
 return text.includes('اختيارات سريعة للمناطق');
}

// The office's Areas field is authoritative. LLM composition must not change
// its wording, omit lines, or silently change any salary or other conditions.
export function replyContainsVerbatimAreaDetails(reply,areas=[]){
 const text=String(reply||'');
 return (areas||[]).some(area=>area?.active===true
  &&String(area?.details||'').trim().length>0
  &&text.includes(areaDetails(area)));
}

export function botAreaChoices(areas){
 return (areas||[]).filter(area=>area?.active===true);
}

export function recommendedAreaChoices(areas,answers,body=''){
 const text=String(body||'');
 if(!text.includes('أقرب اختيارات الشغل المتاحة'))return [];
 const ids=Array.isArray(answers?.__area_recommendations?.values)?answers.__area_recommendations.values:[];
 const active=botAreaChoices(areas);
 return ids.map(id=>active.find(area=>String(area.id)===String(id))).filter(Boolean);
}

export function shouldOfferYesNoButtons(question,body,_areas=[]){
 if(question?.kind!=='yes_no')return false;
 return String(body||'').includes('اختيارات سريعة: نعم / لا');
}

export function shouldOfferChoiceButtons(question,body,_areas=[]){
 if(question?.kind!=='choice'||!Array.isArray(question.options)||!question.options.length)return false;
 return String(body||'').includes('اختيارات سريعة للسؤال');
}

export function choiceButtons(question){
 if(question?.kind!=='choice'||!Array.isArray(question.options))return [];
 return question.options.slice(0,10).map((option,index)=>{
  const label=typeof option==='string'?option:(option?.label??String(option?.value??''));
  return {id:'choice:'+question.id+':'+index,text:String(label).slice(0,80)};
 }).filter(x=>x.text);
}

export class Worker {
 constructor({db,connection,connections,serial,sessionPath,speech=null,agentRuntime=null}){
  Object.assign(this,{db,connection,connections,serial,speech,agentRuntime});
  this.spool=path.join(sessionPath,'inbox');this.ticking=false;this.lastError=null;this.receiveSequence=0;this.lastFollowupSweep=0;this.lastInterviewReconcile=0;this.officeQualityChecks=new Map();
 }
 multi(){return Boolean(this.connections?.configured);}

 async maybeOfficeQualityAlert({applicant,message,signals}){
  if(!applicant?.office_id||!applicant?.whatsapp_account_id||!Array.isArray(signals)||
   !signals.some(s=>['ambiguous_reply','tool_failure','llm_fallback','knowledge_gap'].includes(s)))return;
  const now=Date.now(),officeId=applicant.office_id;
  // Bounded sampling; check at most every 2 minutes per office.
  if(now-(this.officeQualityChecks.get(officeId)||0)<120000)return;
  this.officeQualityChecks.set(officeId,now);
  const since=new Date(now-86400000).toISOString();
  const response=await this.db.from('masar_events')
   .select('kind,detail,applicant_id,created_at',{count:'exact'})
   .eq('kind','agent_turn').contains('detail',{office_id:officeId})
   .gte('created_at',since).order('created_at',{ascending:false}).limit(240);
  if(response.error)throw response.error;
  const recent=response.data||[];
  const issue=qualityIssueAlertCandidate(recent,{
   officeId,currentApplicantId:applicant.id,now,partial:Number(response.count)>recent.length
  });
  if(!issue)return;
  const existing=must(await this.db.from('masar_events').select('id')
   .eq('kind','agent_quality_alert').contains('detail',{office_id:officeId,issue:issue.key})
   .gte('created_at',since).limit(1));
  if(existing.length)return;
  const title='تنبيه جودة الـAI Agent';
  const body=issue.title+' — رُصدت '+issue.count+' حالات في آخر 24 ساعة. راجع المحادثات الخاصة بالمكتب.';
  const created=await this.db.from('masar_alerts').upsert({
   applicant_id:applicant.id,whatsapp_account_id:applicant.whatsapp_account_id,
   source_message_id:message.id,kind:'agent_quality_issue',title,body,
   status:'open',updated_at:new Date(now).toISOString()
  },{onConflict:'source_message_id',ignoreDuplicates:true});
  if(created.error)throw created.error;
  const logged=await this.db.from('masar_events').insert({
   applicant_id:applicant.id,kind:'agent_quality_alert',
   detail:{office_id:officeId,issue:issue.key,count:issue.count,sampled_turns:issue.sampled_turns}
  });
  if(logged.error)throw logged.error;
  sendOfficeQualityPush(this.db,{whatsappAccountId:applicant.whatsapp_account_id,title:body})
   .catch(e=>console.warn('Agent quality push failed:',e.code||e.name||'Error'));
 }

 async init(){
  await fs.mkdir(this.spool,{recursive:true});
  // Pending staff corrections are never auto-approved or shared at startup.
  try{await reconcileRecentStaffInterviews(this.db,{hours:36,source:'worker_startup_reconcile'});}catch(e){console.warn('Interview reconciliation failed:',e.code||e.name||'Error');}
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
     const reason=this.speech?.classifyError?.(e)||'transcription_failed';
     const detail=reason==='resource_limit'?'الموديل الصوتي احتاج موارد أعلى من المتاحة على السيرفر.':reason==='timeout'?'تحويل الرسالة الصوتية استغرق وقتاً أطول من الحد المسموح.':'تعذر فهم التسجيل تلقائياً.';
     media_error=media_path?'تم حفظ الرسالة الصوتية لكن تعذر تحويلها إلى نص تلقائياً. '+detail+' يمكن لمسؤول التوظيف تشغيل التسجيل ومراجعته.':'تعذر حفظ الرسالة الصوتية أو تحويلها إلى نص تلقائياً؛ يحتاج مسؤول التوظيف لمراجعتها من واتساب.';
     console.warn('Voice transcription failed:',reason,e.code||e.name||'Error');
    }
   }
  }
  return {body:body.slice(0,10000),media_path,media_type:media?.type||null,media_error,transcribed,transcription_trusted,transcription_confidence,is_audio:media?.kind==='audio'};
 }
 async resetCutoff(record,accountId){
  if(!this.multi()||!accountId)return null;
  try{
   let row=must(await this.db.from('masar_applicant_resets').select('reset_at').eq('whatsapp_account_id',accountId).eq('contact_id',record.contact_id).order('reset_at',{ascending:false}).limit(1).maybeSingle());
   if(!row&&record.phone)row=must(await this.db.from('masar_applicant_resets').select('reset_at').eq('whatsapp_account_id',accountId).eq('phone',record.phone).order('reset_at',{ascending:false}).limit(1).maybeSingle());
   return row?.reset_at||null;
  }catch(e){if(schemaMissing(e))return null;throw e;}
 }
 async ingest(record){
  const accountId=record.whatsapp_account_id||null,multi=this.multi();
  const historic=historicalChatMark(record);
  const cutoff=await this.resetCutoff(record,accountId);
  if(cutoff){
   // Old history must never recreate a deliberately deleted/reset contact.
   const received=Date.parse(historic?record.created_at:(record.received_at||record.created_at||0)),reset=Date.parse(cutoff);
   if(Number.isFinite(received)&&Number.isFinite(reset)&&received<=reset)return;
  }
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

  // Keep new candidates in the office associated with the receiving
  // WhatsApp account. The office's questions/areas must not cross tenants.
  const linkedAccount=accountId?must(await this.db.from('masar_whatsapp_accounts')
   .select('office_id,active,reply_mode,review_new_contacts').eq('id',accountId).maybeSingle()):null;
  const referral=hasVerifiedAdReferral(record.referral)?record.referral:null;
  const external=record.direction==='out'||record.from_me===true;
  let applicantWasCreated=false;
  if(!a){
   // New, verified click-to-ad leads start instantly. A record of old staff
   // conversation or absent/uncertain attribution still requires review.
   const autoStart=eligibleForAutoAdStart({
    historical:historic,outbound:external,account:linkedAccount,referral
   });
   const requireReview=linkedAccount?.review_new_contacts===true&&!autoStart;
   const row={contact_id:record.contact_id,phone:record.phone,last_message_at:record.created_at,
    ...(autoStart?{bot_enabled:true,answers:{__history_review:automaticAdReview()}}:
       requireReview?{bot_enabled:false,answers:{__history_review:initialHistoryReview({source:historic?'imported_whatsapp_history':'first_seen_after_link'})}}:{})};
   if(multi)row.whatsapp_account_id=accountId;
   if(linkedAccount?.office_id)row.office_id=linkedAccount.office_id;
   if(referral)row.answers=withFirstAttribution(row.answers,referral);
   a=must(await this.db.from('masar_applicants').insert(row).select().single());
   applicantWasCreated=true;
  }else{
   const patch={contact_id:record.contact_id,updated_at:new Date().toISOString()};
   if(!historic)patch.last_message_at=record.created_at;
   if(record.phone)patch.phone=record.phone;
   if(referral){const nextAnswers=withFirstAttribution(a.answers,referral);if(nextAnswers!==a.answers)patch.answers=nextAnswers;}
   if(eligibleForAutoAdStart({
    historical:historic,outbound:external,account:linkedAccount,referral,
    answers:patch.answers||a.answers,existing:true
   })){
    // A paused contact imported under the older policy may resume only if
    // the saved conversation contains no human outbound messages. Never
    // override an explicitly stopped or staff-taken-over conversation.
    const staff=must(await this.db.from('masar_messages').select('id')
     .eq('applicant_id',a.id).eq('direction','out').eq('sender','staff').limit(1));
    if(eligibleForAutoAdStart({
      historical:historic,outbound:external,account:linkedAccount,referral,
      answers:patch.answers||a.answers,existing:true,hasStaffHistory:staff.length>0
    })){
     patch.bot_enabled=true;
     patch.answers={...(patch.answers||a.answers||{}),__history_review:automaticAdReview()};
     try{
      const alerts=this.db.from('masar_alerts').update({
       status:'resolved',resolution:'verified_campaign_auto_start',
       resolved_at:new Date().toISOString(),updated_at:new Date().toISOString()
      }).eq('applicant_id',a.id).eq('kind','history_review').eq('status','open');
      const result=await alerts;
      if(result.error)throw result.error;
     }catch(error){console.warn('Auto-start alert cleanup failed:',error.code||error.name||'Error');}
    }else{
     // State imported history explicitly as staff-led; keep bot paused.
     patch.bot_enabled=false;
     patch.answers={...(patch.answers||a.answers||{}),
      __history_review:initialHistoryReview({source:'prior_staff_conversation'})};
    }
   }
   must(await this.db.from('masar_applicants').update(patch).eq('id',a.id));
   a={...a,...patch};
  }

  const contactRow={contact_id:record.contact_id,applicant_id:a.id};
  if(multi)contactRow.whatsapp_account_id=accountId;
  must(await this.db.from('masar_contacts').upsert(contactRow,{onConflict:multi?'whatsapp_account_id,contact_id':'contact_id'}));

  const isExternalOutbound=external;
  // Enroll only brand-new, inbound WhatsApp contacts. This is audit-only:
  // don't send anything, edit answers, or change the existing bot behavior.
  if(applicantWasCreated&&!historic&&!isExternalOutbound&&accountId){
   try{
    // Link to the WhatsApp account's CURRENT office, not the applicant's
    // optional office_id (which can be null for new inbound contacts).
    if(linkedAccount?.active===true&&linkedAccount.office_id){
     const [officeRow,officeCfg]=await Promise.all([
      this.db.from('masar_offices').select('active').eq('id',linkedAccount.office_id).maybeSingle(),
      this.db.from('masar_office_settings').select('agent_enabled').eq('office_id',linkedAccount.office_id).maybeSingle()
     ]);
     if(officeRow.error)throw officeRow.error;
     if(officeCfg.error)throw officeCfg.error;
     if(officeRow.data?.active===true&&officeCfg.data?.agent_enabled!==false)
      await enrollNewInboundApplicant(this.db,{
       applicantId:a.id,accountId,officeId:linkedAccount.office_id
      });
    }
   }catch(error){console.warn('Office pilot enrollment failed:',error?.code||error?.name||'Error');}
  }
  if(isExternalOutbound){
   const prepared=historic?{body:String(record.body||'').slice(0,10000),media_path:null,media_type:null,media_error:null,is_audio:false}:await this.prepareRecordMedia(record,a.id,accountId);
   const source=must(await this.db.from('masar_messages').select('id,body').eq('applicant_id',a.id).eq('direction','in').order('sequence',{ascending:false}).limit(1).maybeSingle());
   const messageRow={applicant_id:a.id,wa_id:record.id,direction:'out',sender:'staff',body:prepared.body,media_path:prepared.media_path,media_type:prepared.media_type,media_error:prepared.media_error,status:'sent',reply_to:source?.id||null,created_at:record.created_at};
   if(multi)messageRow.whatsapp_account_id=accountId;
   const saved=must(await this.db.from('masar_messages').insert(messageRow).select('id').single());
   if(historic){
    // Imported device-side outgoing messages are prior human history, not
    // real-time staff replies. They should never trigger staff learning,
    // alerts resolution or fresh outbound sends.
    if(pauseOnHistoricalStaffReply({
      historical:historic,outbound:external,account:linkedAccount,answers:a.answers
    })){
     must(await this.db.from('masar_applicants').update({
      bot_enabled:false,
      answers:{...(a.answers||{}),__history_review:initialHistoryReview({source:'prior_staff_conversation'})},
      updated_at:new Date().toISOString()
     }).eq('id',a.id));
    }
    return;
   }

   let settings=null;
   try{settings=must(await this.db.from('masar_settings').select('*').eq('id',true).single());}
   catch(e){if(!schemaMissing(e))throw e;}
   const officeConfig=await config(this.db,a.office_id||null);
   if(officeConfig.settings?.agent_enabled!==false){
    must(await this.db.from('masar_applicants').update({bot_enabled:false,updated_at:new Date().toISOString()}).eq('id',a.id));
   }

   let memory={learned:false,action:'skipped'};
   if(source&&settings?.ai_learning_enabled!==false&&((prepared.transcribed&&prepared.transcription_trusted)||!prepared.is_audio)){
    memory=await learnFromConversation(this.db,{applicantId:a.id,officeId:a.office_id||null,staffMessageId:saved.id,staffId:null,force:true});
   }
   must(await this.db.from('masar_events').insert({applicant_id:a.id,kind:'staff_whatsapp_reply',detail:{message_id:saved.id,source_message_id:source?.id||null,source:'linked_whatsapp_device',memory_learned:Boolean(memory?.learned),memory_action:memory?.action||'skipped',agent_enabled:officeConfig.settings?.agent_enabled!==false,learning_mode:'continuous',voice:Boolean(prepared.is_audio),transcribed:Boolean(prepared.transcribed),transcription_trusted:Boolean(prepared.transcription_trusted),transcription_confidence:prepared.transcription_confidence}}));
   try{await syncInterviewFromStaffMessages(this.db,{applicant:a,source:'linked_whatsapp_device'});}
   catch(e){console.warn('Automatic interview scheduling failed:',e.code||e.name||'Error');}
   try{await syncRecruitmentStageFromConversation(this.db,a.id,{source:'linked_whatsapp_staff_reply'});}
   catch(e){console.warn('Conversation stage inference failed:',e.code||e.name||'Error');}
   try{
    const result=await this.db.from('masar_alerts').update({status:'resolved',resolved_at:new Date().toISOString(),resolution:'linked_whatsapp_reply',updated_at:new Date().toISOString()}).eq('applicant_id',a.id).eq('status','open').neq('kind','history_review');
    if(result.error)throw result.error;
   }catch(e){if(!schemaMissing(e)&&e.code!=='PGRST204')throw e;}
   return;
  }

  if(referral&&!historic){
   must(await this.db.from('masar_events').insert({applicant_id:a.id,kind:'ad_referral',detail:{...referral,whatsapp_account_id:accountId}}));
   try{
    if(!referral.source_id)throw new Error('ad source id unavailable');
    const current=must(await this.db.from('masar_ads').select('*').eq('ad_id',referral.source_id).maybeSingle());
    const metadata={headline:referral.title||current?.headline||'',source_url:referral.source_url||current?.source_url||null,source_app:referral.source_app||current?.source_app||null,source_type:referral.source_type||current?.source_type||'ad',last_seen_at:record.created_at};
    if(current)must(await this.db.from('masar_ads').update(metadata).eq('ad_id',referral.source_id));
    else must(await this.db.from('masar_ads').insert({ad_id:referral.source_id,name:referral.title||'',...metadata,first_seen_at:record.created_at}));
   }catch(e){console.warn('Ad attribution metadata not indexed yet:',e.code||e.name);}
  }

  const prepared=historic?{body:String(record.body||'').slice(0,10000),media_path:null,media_type:null,media_error:null,is_audio:false}:await this.prepareRecordMedia(record,a.id,accountId);
  const messageRow={applicant_id:a.id,wa_id:record.id,direction:'in',sender:'applicant',body:prepared.body,media_path:prepared.media_path,media_type:prepared.media_type,media_error:prepared.media_error,created_at:record.created_at};
  if(historic||prepared.is_audio&&(!prepared.transcribed||!prepared.transcription_trusted))messageRow.status='processed';
  if(multi)messageRow.whatsapp_account_id=accountId;
  const saved=must(await this.db.from('masar_messages').insert(messageRow).select('id').single());
  if(historic)return;
  if(shouldCreateHistoryReviewAlert({historical:historic,answers:a.answers})){
   // Never send a new automation before the staff can see why it was paused.
   // Historical synced messages should be recorded silently; an actual live
   // inbound message creates a single actionable review alert.
   try{
    const prior=must(await this.db.from('masar_alerts').select('id')
     .eq('applicant_id',a.id).eq('kind','history_review').eq('status','open').limit(1));
    if(!prior.length)must(await this.db.from('masar_alerts').insert({
     applicant_id:a.id,whatsapp_account_id:accountId,source_message_id:saved.id,
     kind:'history_review',title:'مراجعة المحادثة قبل تشغيل البوت',
     body:'الرد الآلي متوقف مؤقتًا لمراجعة محادثة واتساب القديمة قبل أول رد. لو سجل الرسائل ناقص، ارجع لواتساب أو مسؤول التوظيف ثم اعتمد تشغيل البوت من ملف المتقدم.',
     status:'open',updated_at:new Date().toISOString()
    }));
   }catch(error){console.warn('History review alert failed:',error.code||error.name||'Error');}
  }
  if(prepared.is_audio){
   must(await this.db.from('masar_events').insert({applicant_id:a.id,kind:'voice_message',detail:{message_id:saved.id,direction:'in',transcribed:Boolean(prepared.transcribed),transcription_trusted:Boolean(prepared.transcription_trusted),transcription_confidence:prepared.transcription_confidence}}));
  }
  try{await syncRecruitmentStageFromConversation(this.db,a.id,{source:'applicant_message'});}
  catch(e){console.warn('Conversation stage inference failed:',e.code||e.name||'Error');}
 }
 async reconcileInterviews(){
  const now=Date.now();
  if(now-this.lastInterviewReconcile<60000)return;
  this.lastInterviewReconcile=now;
  try{await reconcileRecentStaffInterviews(this.db,{hours:36,source:'worker_periodic_reconcile'});}
  catch(e){console.warn('Interview reconciliation failed:',e.code||e.name||'Error');}
 }
 async queueFollowups(){
  const now=Date.now();
  if(now-this.lastFollowupSweep<60000)return;
  this.lastFollowupSweep=now;
  let candidates;
  try{
   candidates=must(await this.db.from('masar_applicants').select('*').in('stage',['new','incomplete']).eq('bot_enabled',true).order('updated_at',{ascending:true}).limit(1000));
  }catch(e){
   if(['42703','PGRST204'].includes(e?.code))return;
   throw e;
  }
  if(!candidates.length)return;
  const open=must(await this.db.from('masar_messages').select('applicant_id').in('status',['pending','queued','sending','uncertain','failed']).limit(5000));
  const blocked=new Set(open.map(x=>x.applicant_id));
  const configCache=new Map();
  for(const a of candidates){
   const key=a.office_id||'__global__';if(!configCache.has(key))configCache.set(key,await config(this.db,a.office_id||null));
   const c=configCache.get(key);if(c.settings?.agent_enabled===false||c.settings?.followup_enabled!==true)continue;
   const account=a.whatsapp_account_id?must(await this.db.from('masar_whatsapp_accounts').select('reply_mode,active')
    .eq('id',a.whatsapp_account_id).maybeSingle()):null;
   if(account?.active===false||a.whatsapp_account_id&&!accountCanReply(account?.reply_mode||'all',{
    firstAttribution:a.answers?.__attribution
   })||historyReviewRequired({answers:a.answers}))continue;
   const hours=Math.max(1,Math.min(72,Number(c.settings?.followup_hours)||8));
   if(blocked.has(a.id)||!followupDue(a,{now,hours}))continue;
   const body=buildFollowupMessage(a,c.questions,c.areas);
   if(!body)continue;
   const row={applicant_id:a.id,direction:'out',sender:'bot',body,status:'queued'};
   if(this.multi())row.whatsapp_account_id=a.whatsapp_account_id;
   must(await this.db.from('masar_messages').insert(row));
   const at=new Date(now).toISOString();
   must(await this.db.from('masar_applicants').update({followup_last_sent_at:at,followup_count:Number(a.followup_count||0)+1,updated_at:at}).eq('id',a.id));
   must(await this.db.from('masar_events').insert({applicant_id:a.id,kind:'followup',detail:{hours,count:Number(a.followup_count||0)+1,awaiting_id:a.awaiting_id||null}}));
   blocked.add(a.id);
  }
 }
 async tick(){
  if(this.ticking)return;this.ticking=true;
  try{await this.serial(async()=>{
   await this.reconcileInterviews();
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
     const a=must(await this.db.from('masar_applicants').select('*').eq('id',m.applicant_id).single()),c=await config(this.db,a.office_id||null);
     const account=a.whatsapp_account_id?must(await this.db.from('masar_whatsapp_accounts')
      .select('reply_mode,active').eq('id',a.whatsapp_account_id).maybeSingle()):null;
     if(account?.active===false||a.whatsapp_account_id&&!accountCanReply(account?.reply_mode||'all',{
      firstAttribution:a.answers?.__attribution
     })||historyReviewRequired({answers:a.answers})){
      must(await this.db.from('masar_messages').update({status:'processed',error:null}).eq('id',m.id));
      continue;
     }
     if(c.settings?.agent_enabled===false){
      // Office-level agent pause. Learning from staff continues 24/7, but the
      // agent does not reply to applicants in this office.
      try{await syncRecruitmentStageFromConversation(this.db,a.id,{source:'office_agent_paused'});}
      catch(e){console.warn('Conversation stage inference failed:',e.code||e.name||'Error');}
      must(await this.db.from('masar_messages').update({status:'processed',error:null}).eq('id',m.id));
      continue;
     }

     // Backfill the entire existing history once, then incrementally index
     // every previously unseen message, including staff replies and corrections.
     // A memory-index failure must never prevent the applicant getting a reply.
     let lifetimeChanged=false;
     try{
      const loaded=await loadLifetimeMemory(this.db,{
       applicantId:a.id,throughSequence:m.sequence,existing:a.answers?.__lifetime_memory
      });
      if(loaded.changed){
       a.answers={...(a.answers||{}),__lifetime_memory:loaded.memory};
       lifetimeChanged=true;
      }
     }catch(memoryError){
      console.warn('Lifetime conversation memory unavailable:',memoryError.code||memoryError.name||'Error');
     }
     let knowledge=await loadKnowledge(this.db,a.office_id||null);
     let llmAnalysis={available:false,plan:null,state:this.agentRuntime?.snapshot?.(c.settings)||null};
     let recentMessages=[];
     let historicalExcerpts=[];
     let conversationEpisodes=[];
     if(this.agentRuntime&&c.settings?.agent_llm_enabled===true&&needsLlmPlanning(m)){
      try{
       const recent=must(await this.db.from('masar_messages').select('sequence,direction,sender,body,created_at')
        .eq('applicant_id',a.id).order('sequence',{ascending:false}).limit(Math.max(4,Math.min(30,Number(c.settings.agent_context_messages||12)))));
       recentMessages=[...recent].reverse();
       if(historicalRecallNeeded(m.body)){
        try{
         historicalExcerpts=await retrieveHistoricalExcerpts(this.db,{
          applicantId:a.id,currentSequence:m.sequence,query:m.body,
          recentSequences:recentMessages.map(x=>x.sequence)
         });
         if(needsConversationEpisodes(m.body)){
          conversationEpisodes=await retrieveConversationEpisodes(this.db,{
           applicantId:a.id,currentSequence:m.sequence,
           query:m.body,historicalExcerpts
          });
         }
        }catch(historyError){
         console.warn('Historical recall unavailable:',historyError.code||historyError.name||'Error');
        }
       }
       llmAnalysis=await this.agentRuntime.analyzeTurn({
        applicant:a,message:m,questions:c.questions,areas:c.areas,settings:c.settings,
        knowledge,recentMessages,historicalExcerpts,conversationEpisodes,office:c.office
       });
       if(llmAnalysis?.available&&['assist','live'].includes(c.settings.agent_llm_mode)){
        knowledge=this.agentRuntime.reorderKnowledge(knowledge,llmAnalysis.plan,c.settings);
       }
      }catch(e){
       llmAnalysis={available:false,plan:null,state:this.agentRuntime.snapshot(c.settings),error:String(e?.message||e).slice(0,500)};
       console.warn('AI Agent LLM planner failed:',e.code||e.name||'Error');
      }
     }
     let turn=await planTurn({applicant:a,message:m,...c,interpret,knowledge,llmPlan:llmAnalysis?.plan||null,historicalExcerpts,conversationEpisodes});
     if(lifetimeChanged&&turn.patch&&turn.reply){
      turn={...turn,patch:{...turn.patch,answers:{
       ...(turn.patch.answers||a.answers||{}),__lifetime_memory:a.answers.__lifetime_memory
      }}};
     }

     // Persist only explicit preferences, not freeform conversation or guesses.
     const brain=updateBrainMemory(a.answers?.__brain_memory,m.body);
     if(brain.changed&&turn.reply&&turn.patch){
      turn={...turn,patch:{...turn.patch,answers:{...(turn.patch.answers||a.answers||{}),__brain_memory:brain.memory}}};
     }
     let composerUsage=null,composerCalled=false;
     if(this.agentRuntime&&llmAnalysis?.available&&c.settings?.agent_llm_mode==='live'&&!turn.maps_grounded&&!turn.tools_grounded&&!turn.expert_grounded
       // Preserve safety-critical residence state and tested explanation verbatim.
       &&!['clarify_residence_location','residence_reference_options','residence_context_followup','residence_options_without_distance','residence_handoff','contextual_area_details','clarify_context_details','clarify_context_area_mode','contextual_resume_work_area','historical_residence_recall','compare_places','compare_places_followup','compare_area_modes'].includes(turn.agent_action)
       &&!replyContainsVerbatimAreaDetails(turn.reply,c.areas)){
      try{
       const composed=await this.agentRuntime.composeTurn({
        message:m,turn,settings:c.settings,plan:llmAnalysis?.plan||null,recentMessages,historicalExcerpts,conversationEpisodes,
        office:c.office,applicant:{...a,answers:turn.patch?.answers||a.answers}
       });
       composerCalled=Number.isFinite(composed?.latency_ms);
       composerUsage=composed?.usage||null;
       if(composed?.applied)turn={...turn,reply:composed.reply,agent_composed:true};
      }catch(e){
       console.warn('AI Agent response composer failed:',e.code||e.name||'Error');
      }
     }
     must(await this.db.rpc('masar_commit_turn',{p_message:m.id,p_patch:turn.patch,p_reply:turn.reply}));
     if(turn.followup_reply){
      try{
       const row={applicant_id:a.id,direction:'out',sender:'bot',body:String(turn.followup_reply),status:'queued',reply_to:m.id};
       if(this.multi())row.whatsapp_account_id=a.whatsapp_account_id;
       must(await this.db.from('masar_messages').insert(row));
      }catch(e){
       this.lastError='تم الرد على المتقدم لكن تعذر إرسال سؤال المتابعة تلقائياً.';
       console.error('Turn follow-up queue failed:',e.code||e.name);
      }
     }
     if(turn.knowledge_id){
      try{
       const row=must(await this.db.from('masar_knowledge').select('usage_count').eq('id',turn.knowledge_id).single());
       must(await this.db.from('masar_knowledge').update({usage_count:Number(row.usage_count||0)+1,last_used_at:new Date().toISOString()}).eq('id',turn.knowledge_id));
      }catch(e){if(!schemaMissing(e))throw e;}
     }
     try{
      const action=turn.agent_action||(turn.handoff?'handoff':turn.knowledge_id?'knowledge_answer':turn.followup_reply?'answer_and_continue':'flow_turn');
      const afterAwaiting=Object.prototype.hasOwnProperty.call(turn.patch||{},'awaiting_id')?turn.patch.awaiting_id:a.awaiting_id;
      const extracted=Object.values(turn.patch?.answers||{}).filter(v=>v?.agent_extracted===true).length;
      const reported=[llmAnalysis?.usage,composerUsage].filter(x=>x&&Number.isSafeInteger(x.prompt_tokens)&&Number.isSafeInteger(x.completion_tokens));
      const llmUsage={
       calls:Number(llmAnalysis?.available===true)+Number(composerCalled),
       tokens_reported_calls:reported.length,
       prompt_tokens:reported.reduce((sum,x)=>sum+Number(x.prompt_tokens||0),0),
       completion_tokens:reported.reduce((sum,x)=>sum+Number(x.completion_tokens||0),0)
      };
      const qualitySignals=turnQualitySignals({
       message:m.body,reply:turn.reply,turn,awaitingBefore:a.awaiting_id,
       awaitingAfter:afterAwaiting,
       llmUnavailable:Boolean(c.settings.agent_llm_enabled===true&&!llmAnalysis?.available&&needsLlmPlanning(m))
      });
      const eventResult=await this.db.from('masar_events').insert({
       applicant_id:a.id,kind:'agent_turn',
       detail:{
        message_id:m.id,office_id:a.office_id||null,action,
        handoff:Boolean(turn.handoff),handoff_reason:turn.handoff_reason||null,
        knowledge_id:turn.knowledge_id||null,knowledge_confidence:turn.knowledge_confidence??null,
        extracted_facts:extracted,awaiting_before:a.awaiting_id||null,awaiting_after:afterAwaiting||null,
        ...(llmUsage.calls>0?{llm_usage:llmUsage}:{}),
        ...(turn.expert_intent?{expert_topic:turn.expert_intent,expert_source:turn.expert_source}:{}),
        quality_signals:qualitySignals,
        brain_memory_updated:Boolean(brain.changed),planned_steps:llmAnalysis?.plan?.steps||[],
        crm_tools:Array.isArray(turn.tool_calls)?turn.tool_calls.map(x=>({name:x.tool,ok:x.ok})):[]
       }
      });
      if(eventResult.error)throw eventResult.error;
      try{await this.maybeOfficeQualityAlert({applicant:a,message:m,signals:qualitySignals});}
      catch(qualityError){console.warn('Agent quality alert failed:',qualityError.code||qualityError.name||'Error');}
      try{
       const plannerMode=llmAnalysis?.available
        ?(c.settings.agent_llm_mode==='live'?'llm_live':c.settings.agent_llm_mode==='assist'?'llm_assist':'llm_shadow')
        :(c.settings.agent_llm_enabled===true?'fallback':'deterministic');
       const decision=llmAnalysis?.plan;
       const trace=await this.db.from('masar_agent_decisions').insert({
        applicant_id:a.id,office_id:a.office_id||null,message_id:m.id,planner_mode:plannerMode,
        input_text:String(m.body||'').slice(0,4000),
        intents:[...(decision?.intent?[decision.intent,...(decision.steps||[]).map(step=>'planned:'+step)]:[]),...(turn.tool_calls||[]).map(x=>'tool:'+x.tool)],
        facts:decision?.facts||[],
        action:decision?.action||action,
        confidence:decision?.confidence??turn.agent_confidence??turn.knowledge_confidence??null,
        knowledge_ids:[...new Set([decision?.knowledge_id,turn.knowledge_id].filter(Boolean))],
        decision_summary:decision?.summary||'',
        provider:llmAnalysis?.provider||null,model:llmAnalysis?.model||null,
        latency_ms:llmAnalysis?.latency_ms??null,
        fallback_used:Boolean(c.settings.agent_llm_enabled===true&&!llmAnalysis?.available),
        error:llmAnalysis?.error||null
       });
       if(trace.error&&!schemaMissing(trace.error)&&trace.error.code!=='PGRST204')throw trace.error;
      }catch(traceError){if(!schemaMissing(traceError)&&traceError.code!=='PGRST204')console.warn('Agent decision trace failed:',traceError.code||traceError.name||'Error');}
     }catch(e){if(!schemaMissing(e)&&e.code!=='PGRST204')console.warn('Agent turn audit failed:',e.code||e.name||'Error');}
     if(turn.handoff){
      const question=String(turn.handoff_note||m.body||'').slice(0,1000);
      must(await this.db.from('masar_events').insert({applicant_id:a.id,kind:'ai_handoff',detail:{message_id:m.id,question,reason:turn.handoff_reason||'low_confidence'}}));
      try{
       const row={
        applicant_id:a.id,
        whatsapp_account_id:a.whatsapp_account_id,
        source_message_id:m.id,
        kind:'ai_handoff',
        title:'متقدم يحتاج تدخل',
        body:question,
        phone:a.phone||null,
        status:'open',
        updated_at:new Date().toISOString()
       };
       const result=await this.db.from('masar_alerts').upsert(row,{onConflict:'source_message_id',ignoreDuplicates:true});
       if(result.error)throw result.error;
       const alert=must(await this.db.from('masar_alerts').select('id').eq('source_message_id',m.id).single());
       sendHumanInterventionPush(this.db,{applicant:a,question,alertId:alert.id})
        .catch(e=>console.warn('Mobile push failed:',e.code||e.name||'Error'));
      }catch(e){if(!schemaMissing(e)&&e.code!=='PGRST204')throw e;}
     }
    }catch(e){
     blocked.add(m.applicant_id);const attempts=m.attempts+1;
     must(await this.db.from('masar_messages').update({attempts,status:attempts>=3?'failed':'pending',error:'تعذر معالجة الرسالة؛ أعد المحاولة من ملف المتقدم.'}).eq('id',m.id));
     this.lastError='توجد رسالة تحتاج مراجعة في ملف المتقدم';
    }
   }

   await this.queueFollowups();

   const outgoing=must(await this.db.from('masar_messages').select('*').eq('status','queued').order('sequence').limit(30));
   const sendConfigCache=new Map();
   for(const m of outgoing){
    const accountId=this.multi()?m.whatsapp_account_id:this.connections?.defaultAccountId?.()||null;
    const snapshot=this.connections?this.connections.snapshot(accountId):this.connection?.snapshot();
    if(snapshot?.status!=='connected')continue;
    const a=must(await this.db.from('masar_applicants').select('contact_id,awaiting_id,bot_enabled,answers,office_id').eq('id',m.applicant_id).single());
    const cfgKey=a.office_id||'__global__';if(!sendConfigCache.has(cfgKey))sendConfigCache.set(cfgKey,await config(this.db,a.office_id||null));const sendConfig=sendConfigCache.get(cfgKey);
    if(m.sender==='bot'){
     const acc=accountId?this.connections?.snapshot?.(accountId):null;
     if(a.bot_enabled===false||historyReviewRequired({answers:a.answers})||
       acc?.active===false||accountId&&!accountCanReply(acc?.reply_mode||'all',{
        firstAttribution:a.answers?.__attribution
       })){
      must(await this.db.from('masar_messages').update({
       status:'processed',error:'تم إلغاء الرد الآلي بسبب وضع الرقم أو مراجعة المحادثة.'
      }).eq('id',m.id));
      continue;
     }
    }
    if(m.sender==='bot'&&sendConfig?.settings?.agent_enabled===false){
     must(await this.db.from('masar_messages').update({status:'processed',error:'تم إلغاء الرد الآلي لأن Agent المكتب متوقف.'}).eq('id',m.id));
     continue;
    }
    let buttons=[];
    if(m.sender==='bot'&&a.bot_enabled&&sendConfig){
     const q=sendConfig.questions.find(q=>q.active&&q.id===a.awaiting_id);
     const body=String(m.body||'');
     const browseAreas=shouldBrowseAreaButtons(q,body);
     if(browseAreas){
      const activeAreas=botAreaChoices(sendConfig.areas);
      const recommended=recommendedAreaChoices(activeAreas,a.answers,body);
      if(recommended.length){
       buttons.push(...recommended.map(area=>({id:'area_preview:'+area.id,text:area.name})));
       buttons.push({id:'area_page:0',text:'📍 كل المناطق'});
       if(q?.field_key==='preferred_work_area')buttons.push({id:'no_work_area',text:'❌ ولا منطقة مناسبة'});
      }else{
       const pageSize=7,pages=Math.max(1,Math.ceil(activeAreas.length/pageSize));
       const rawPage=Number(a.answers?.__area_page?.value||0);
       const page=Math.max(0,Math.min(pages-1,Number.isInteger(rawPage)?rawPage:0));
       const pageAreas=activeAreas.slice(page*pageSize,(page+1)*pageSize);
       const previewId=q?.kind==='area'?a.answers?.__area_preview?.value:null;
       const preview=activeAreas.find(area=>area.id===previewId);
       if(preview)buttons.push({id:'confirm_area:'+preview.id,text:'✅ مناسبة وكمل'});
       buttons.push(...pageAreas.map(area=>({id:'area_preview:'+area.id,text:area.name})));
       if(q?.field_key==='preferred_work_area')buttons.push({id:'no_work_area',text:'❌ ولا منطقة مناسبة'});
       if(page>0)buttons.push({id:'area_page:'+(page-1),text:'⬅️ السابق'});
       if(page<pages-1)buttons.push({id:'area_page:'+(page+1),text:'التالي ➡️'});
      }
     }else if(shouldOfferYesNoButtons(q,body,sendConfig.areas)){
      buttons.push({id:'yes',text:'✅ نعم'},{id:'no',text:'❌ لا'});
     }else if(shouldOfferChoiceButtons(q,body,sendConfig.areas)){
      buttons.push(...choiceButtons(q));
     }
    }
    must(await this.db.from('masar_messages').update({status:'sending'}).eq('id',m.id));
    try{
     const sent=this.connections?await this.connections.send(accountId,a.contact_id,m.body,{buttons}):await this.connection.send(a.contact_id,m.body,{buttons});
     const sentAt=new Date().toISOString();
     must(await this.db.from('masar_messages').update({status:'sent',wa_id:sent?.key?.id||sent?.id?._serialized||null,error:null}).eq('id',m.id));
     must(await this.db.from('masar_applicants').update({last_message_at:sentAt,updated_at:sentAt}).eq('id',m.applicant_id));
     if(m.sender==='staff'){
      try{await syncInterviewFromStaffMessages(this.db,{applicant:a,source:'crm_staff_reply'});}
      catch(e){console.warn('Automatic interview scheduling failed:',e.code||e.name||'Error');}
      try{await syncRecruitmentStageFromConversation(this.db,m.applicant_id,{source:'crm_staff_reply'});}
      catch(e){console.warn('Conversation stage inference failed:',e.code||e.name||'Error');}
     }
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
