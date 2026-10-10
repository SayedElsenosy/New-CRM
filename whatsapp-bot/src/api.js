import express from 'express';
import {normalizeReplyMode} from './reply-scope.js';
import cors from 'cors';
import helmet from 'helmet';
import {rateLimit} from 'express-rate-limit';
import {must,allRows,config} from './db.js';
import {qualityMetrics,runBuiltInQualitySuite} from './quality-center.js';
import {recruitmentPerformance,pilotReadiness} from './recruitment-performance.js';
import {loadPilotControl,loadPilotEnrollments,pilotCohortSummary,PILOT_LIMIT,validPilotSize} from './pilot-observation.js';
import {conversationIntelligenceMetrics,officeConversationIssues,safeLearningProposal} from './conversation-intelligence.js';
import {expertBrainSummary} from './recruitment-expert.js';
import {STAGES,computedStage,completion,csvCell,norm} from './domain.js';
import {qualificationFor,qualificationReasonLabels,funnelFor,RECRUITMENT_ZONES} from './qualification.js';
import {schemaMissing,suggestKeywords,findKnowledgeAnswer,learnFromConversation,snapshotKnowledgeVersion,recordKnowledgeEvidence,loadKnowledge} from './knowledge.js';
import {legacyImport} from './legacy.js';
import {validExpoPushToken} from './push.js';
import {metaConfig,metaLoginUrl,metaStateHash,exchangeMetaCode,encryptMetaToken,decryptMetaToken,getMetaIdentity,listMetaAdAccounts,fetchMetaAccountSnapshot,normalizeMetaAdAccountId} from './meta.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v);
function bad(message,status=400){return Object.assign(new Error(message),{status});}
const PERMISSIONS=new Set(['applicants','areas','reports','campaigns','questions','whatsapp','settings']);
const DEFAULT_RECRUITER_PERMISSIONS=['applicants','areas','reports'];
const RECRUITMENT_STAGES=['new','review','interview','accepted','hired','rejected'];
const RECRUITMENT_STAGE_SET=new Set(RECRUITMENT_STAGES);
const INTERVIEW_STATUSES=new Set(['scheduled','completed','cancelled','no_show']);
const cleanPermissions=value=>Array.isArray(value)?[...new Set(value.filter(v=>PERMISSIONS.has(v)))]:[...DEFAULT_RECRUITER_PERMISSIONS];
const recruitmentStageOf=a=>RECRUITMENT_STAGE_SET.has(a?.recruitment_stage)?a.recruitment_stage:a?.stage==='working'?'hired':a?.stage==='lecture'?'interview':a?.stage==='complete'?'review':'new';
export function makeApi({db,connection,connections,worker,speech=null,agentRuntime=null,serial,origins,dashboardDist=null}){
 const whatsapp=connections||{
  configured:false,
  defaultAccountId:()=>null,
  snapshot:()=>connection?.snapshot?.()||{status:'disconnected'},
  snapshots:async()=>[{id:null,name:'الرقم الرئيسي',legacy_session:true,...(connection?.snapshot?.()||{status:'disconnected'})}],
  connect:async()=>{await connection?.connect?.();return connection?.snapshot?.()||{status:'disconnected'};},
  disconnect:async()=>{await connection?.disconnect?.();return connection?.snapshot?.()||{status:'disconnected'};}
 };
 async function metaSyncOffice(officeId){
  const cfg=metaConfig();if(!cfg.configured)throw bad('إعداد ربط Meta ناقص: '+cfg.missing.join('، '),503);
  let connection;
  try{connection=must(await db.from('masar_meta_connections').select('*').eq('office_id',officeId).maybeSingle());}
  catch(e){if(schemaMissing(e)||['42703','PGRST204'].includes(e?.code||''))throw bad('شغّل ملف supabase/014_meta_ads_connection.sql أولاً',503);throw e;}
  if(!connection)throw bad('اربط حساب Meta بالمكتب أولاً',409);
  if(!connection.selected_ad_account_id)throw bad('اختر الحساب الإعلاني الخاص بالمكتب أولاً',409);
  let token;try{token=decryptMetaToken(connection.access_token_encrypted,cfg.encryptionKey);}catch{throw bad('تعذر قراءة مفتاح Meta المحفوظ؛ أعد ربط الحساب',409);}
  const now=new Date().toISOString();
  try{
   const snapshot=await fetchMetaAccountSnapshot(token,cfg,connection.selected_ad_account_id);
   const campaignMap=new Map();
   for(const metaCampaign of snapshot.campaigns){
    const metaId=String(metaCampaign.id||'').trim();if(!metaId)continue;
    const existing=must(await db.from('masar_campaigns').select('*').eq('office_id',officeId).eq('meta_campaign_id',metaId).limit(1).maybeSingle());
    const row={
     office_id:officeId,name:String(metaCampaign.name||'Meta Campaign').slice(0,150),meta_campaign_id:metaId,
     active:!['ARCHIVED','DELETED'].includes(String(metaCampaign.effective_status||metaCampaign.status||'').toUpperCase()),
     meta_status:metaCampaign.status||null,meta_effective_status:metaCampaign.effective_status||null,objective:metaCampaign.objective||null,
     meta_start_time:metaCampaign.start_time||null,meta_stop_time:metaCampaign.stop_time||null,meta_synced_at:now,updated_at:now
    };
    const saved=existing
     ?must(await db.from('masar_campaigns').update(row).eq('id',existing.id).select().single())
     :must(await db.from('masar_campaigns').insert(row).select().single());
    campaignMap.set(metaId,saved);
   }
   for(const metaAd of snapshot.ads){
    const adId=String(metaAd.id||'').trim();if(!/^\d{5,40}$/.test(adId))continue;
    const existing=must(await db.from('masar_ads').select('*').eq('ad_id',adId).maybeSingle());
    if(existing?.office_id&&existing.office_id!==officeId)throw bad('Ad ID '+adId+' مربوط بمكتب آخر',409);
    const localCampaign=campaignMap.get(String(metaAd.campaign_id||''))||null;
    const row={
     ad_id:adId,office_id:officeId,campaign_id:localCampaign?.id||existing?.campaign_id||null,
     name:String(metaAd.name||existing?.name||'').slice(0,200),source_app:'meta',source_type:'ad',
     meta_adset_id:metaAd.adset_id||null,meta_status:metaAd.status||null,meta_effective_status:metaAd.effective_status||null,
     meta_synced_at:now,last_seen_at:now,updated_at:now
    };
    if(!existing){row.first_seen_at=now;row.zone='UNKNOWN';}
    if(!snapshot.insights_error){
     row.spend=Math.round(Number(snapshot.spendByAd.get(adId)||0)*100)/100;
     row.spend_source='meta';row.spend_synced_at=now;
    }
    if(existing)must(await db.from('masar_ads').update(row).eq('ad_id',adId));
    else must(await db.from('masar_ads').insert(row));
   }
   must(await db.from('masar_meta_connections').update({status:'connected',last_sync_at:now,last_sync_error:snapshot.insights_error||null,updated_at:now}).eq('office_id',officeId));
   return {ok:true,campaigns:snapshot.campaigns.length,ads:snapshot.ads.length,last_sync_at:now,warning:snapshot.insights_error||null};
  }catch(e){
   try{await db.from('masar_meta_connections').update({status:'error',last_sync_error:String(e.message||'Meta sync failed').slice(0,1000),updated_at:now}).eq('office_id',officeId);}catch{}
   throw e;
  }
 }
 const app=express();app.set('trust proxy',1);app.use(helmet({
  contentSecurityPolicy:{
   directives:{
    connectSrc:["'self'","https://*.supabase.co","wss://*.supabase.co"],
    imgSrc:["'self'","data:","blob:","https://*.supabase.co"]
   }
  }
 }));
 app.use(cors({origin(origin,cb){cb(null,!origin||origins.includes(origin));}}));
 app.use(express.json({limit:'64kb'}));
 app.get('/health',(_req,res)=>res.json({ok:true}));
 app.use('/integrations/meta',rateLimit({windowMs:60000,limit:30,standardHeaders:'draft-8',legacyHeaders:false}));
 app.get('/integrations/meta/callback',async(req,res,next)=>{try{
  const cfg=metaConfig();if(!cfg.configured)throw bad('إعداد ربط Meta ناقص: '+cfg.missing.join('، '),503);
  const code=String(req.query.code||''),state=String(req.query.state||'');
  if(!code||state.length<20)throw bad('طلب ربط Meta غير صالح',400);
  const stateHash=metaStateHash(state);
  let oauthState;
  try{oauthState=must(await db.from('masar_meta_oauth_states').select('*').eq('state_hash',stateHash).maybeSingle());}
  catch(e){if(schemaMissing(e)||['42703','PGRST204'].includes(e?.code||''))throw bad('شغّل ملف supabase/014_meta_ads_connection.sql أولاً',503);throw e;}
  if(!oauthState||Date.parse(oauthState.expires_at)<=Date.now())throw bad('جلسة ربط Meta انتهت؛ ابدأ الربط من صفحة الحملات مرة أخرى',400);
  must(await db.from('masar_meta_oauth_states').delete().eq('state_hash',stateHash));
  const exchanged=await exchangeMetaCode(code,cfg),identity=await getMetaIdentity(exchanged.access_token,cfg),accounts=await listMetaAdAccounts(exchanged.access_token,cfg);
  const previous=must(await db.from('masar_meta_connections').select('selected_ad_account_id').eq('office_id',oauthState.office_id).maybeSingle());
  const accountIds=new Set(accounts.map(x=>x.account_id));
  let selected=previous?.selected_ad_account_id&&accountIds.has(previous.selected_ad_account_id)?previous.selected_ad_account_id:null;
  if(!selected&&accounts.length===1)selected=accounts[0].account_id;
  const selectedRow=accounts.find(x=>x.account_id===selected)||null,now=new Date().toISOString();
  must(await db.from('masar_meta_connections').upsert({
   office_id:oauthState.office_id,meta_user_id:identity.id||null,meta_user_name:identity.name||'',
   access_token_encrypted:encryptMetaToken(exchanged.access_token,cfg.encryptionKey),
   token_expires_at:exchanged.expires_in?new Date(Date.now()+exchanged.expires_in*1000).toISOString():null,
   selected_ad_account_id:selected,selected_ad_account_name:selectedRow?.name||null,currency:selectedRow?.currency||null,timezone_name:selectedRow?.timezone_name||null,
   status:'connected',connected_by:oauthState.user_id,last_sync_error:null,updated_at:now
  },{onConflict:'office_id'}));
  must(await db.from('masar_meta_ad_accounts').delete().eq('office_id',oauthState.office_id));
  if(accounts.length)must(await db.from('masar_meta_ad_accounts').insert(accounts.map(x=>({...x,office_id:oauthState.office_id,updated_at:now}))));
  if(selected){try{await metaSyncOffice(oauthState.office_id);}catch(e){console.warn('Meta initial sync failed:',e.message);}}
  const origin=String(process.env.DASHBOARD_ORIGIN||'').split(',').map(x=>x.trim()).find(Boolean)||(process.env.RAILWAY_PUBLIC_DOMAIN?'https://'+process.env.RAILWAY_PUBLIC_DOMAIN:'http://localhost:5173');
  const target=new URL(origin);target.searchParams.set('meta',selected?'connected':'choose-account');target.searchParams.set('office_id',oauthState.office_id);
  res.redirect(302,target.toString());
 }catch(e){next(e);}});
 app.post('/integrations/meta/ads-sync',async(req,res,next)=>{try{
  const expected=String(process.env.META_ADS_SYNC_SECRET||''),provided=String(req.headers['x-integration-key']||'');
  if(!expected)throw bad('تكامل مزامنة المصروف غير مفعّل على الخادم',503);
  const a=Buffer.from(expected),b=Buffer.from(provided);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw bad('مفتاح التكامل غير صحيح',401);
  const items=Array.isArray(req.body?.ads)?req.body.ads:[req.body];
  if(!items.length||items.length>500)throw bad('أرسل من 1 إلى 500 إعلان في الطلب الواحد');
  const now=new Date().toISOString(),saved=[];
  for(const item of items){
   const adId=String(item?.ad_id||item?.meta_ad_id||'').trim(),spend=Number(item?.spend);
   if(!/^\d{5,40}$/.test(adId))throw bad('Ad ID غير صحيح');
   if(!Number.isFinite(spend)||spend<0||spend>1000000000)throw bad('قيمة المصروف غير صحيحة');
   const zone=String(item?.zone||'UNKNOWN').toUpperCase();
   if(!RECRUITMENT_ZONES.includes(zone))throw bad('Zone غير صحيحة');
   const current=must(await db.from('masar_ads').select('*').eq('ad_id',adId).maybeSingle());
   const patch={spend:Math.round(spend*100)/100,spend_source:'meta',spend_synced_at:now,updated_at:now};
   if(item?.zone!==undefined)patch.zone=zone;
   if(item?.name!==undefined)patch.name=String(item.name||'').trim().slice(0,200);
   let row;
   if(current)row=must(await db.from('masar_ads').update(patch).eq('ad_id',adId).select().single());
   else row=must(await db.from('masar_ads').insert({ad_id:adId,name:patch.name||'',zone,spend:patch.spend,spend_source:'meta',spend_synced_at:now,first_seen_at:now,last_seen_at:now}).select().single());
   saved.push(row);
  }
  res.json({ok:true,count:saved.length,ads:saved.map(x=>({ad_id:x.ad_id,spend:Number(x.spend||0),zone:x.zone,spend_source:x.spend_source,spend_synced_at:x.spend_synced_at}))});
 }catch(e){
  if(schemaMissing(e)||['42703','PGRST204'].includes(e.code||''))return next(bad('شغّل migration 013_recruitment_performance_funnel.sql أولاً',503));
  next(e);
 }});
 app.use('/api',rateLimit({windowMs:60000,limit:240,standardHeaders:'draft-8',legacyHeaders:false}));
 app.use('/api',async(req,res,next)=>{try{
  if(req.headers.origin&&!origins.includes(req.headers.origin))throw bad('هذا العنوان غير مسموح',403);
  const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token)throw bad('سجل الدخول أولاً',401);
  const {data,error}=await db.auth.getUser(token);if(error||!data.user)throw bad('انتهت الجلسة؛ سجل الدخول مجدداً',401);
  let staffResult=await db.from('masar_staff').select('user_id,office_id,phone,job_title,bio,avatar_path').eq('user_id',data.user.id).maybeSingle();
  if(staffResult.error&&['42703','PGRST204'].includes(staffResult.error.code))staffResult=await db.from('masar_staff').select('user_id').eq('user_id',data.user.id).maybeSingle();
  const staff=must(staffResult);if(!staff)throw bad('الحساب غير مصرح له بإدارة مسار',403);
  const rawRole=data.user.app_metadata?.masar_role;
  req.user=data.user;req.staff=staff;req.role=rawRole==='recruiter'?'recruiter':rawRole==='office_admin'?'office_admin':'admin';
  req.officeId=staff.office_id||data.user.app_metadata?.masar_office_id||null;
  req.permissions=['admin','office_admin'].includes(req.role)?[...PERMISSIONS]:cleanPermissions(data.user.app_metadata?.masar_permissions);next();
 }catch(e){next(e);}});
 const route=(method,url,fn)=>app[method]('/api'+url,async(req,res,next)=>{try{await fn(req,res);}catch(e){next(e);}});
 const adminRoute=(method,url,fn)=>route(method,url,async(req,res)=>{if(req.role!=='admin')throw bad('هذه الصفحة متاحة لمسؤول النظام العام فقط',403);await fn(req,res);});
 const managerRoute=(method,url,fn)=>route(method,url,async(req,res)=>{if(!['admin','office_admin'].includes(req.role))throw bad('هذه العملية متاحة لمدير المكتب أو مسؤول النظام فقط',403);await fn(req,res);});
 const permissionRoute=(permission,method,url,fn)=>route(method,url,async(req,res)=>{if(!['admin','office_admin'].includes(req.role)&&!req.permissions.includes(permission))throw bad('ليس لديك صلاحية لهذه الصفحة',403);await fn(req,res);});
 async function accessibleAccountIds(req){
  if(!whatsapp.configured||req.role==='admin')return null;
  if(req.role==='office_admin'&&req.officeId){
   const rows=must(await db.from('masar_whatsapp_accounts').select('id').eq('office_id',req.officeId));
   return rows.map(x=>x.id);
  }
  const rows=must(await db.from('masar_staff_whatsapp_access').select('whatsapp_account_id').eq('user_id',req.user.id));
  return rows.map(x=>x.whatsapp_account_id);
 }
 async function openAlertApplicantIds(req){
  try{
   let rows=must(await db.from('masar_alerts').select('applicant_id,whatsapp_account_id').eq('status','open').limit(10000));
   const allowed=await accessibleAccountIds(req);
   if(allowed!==null)rows=rows.filter(x=>allowed.includes(x.whatsapp_account_id));
   return new Set(rows.map(x=>x.applicant_id));
  }catch(e){if(schemaMissing(e)||e.code==='PGRST204')return new Set();throw e;}
 }
 async function resolveApplicantAlerts(applicantId,{userId=null,resolution='handled'}={}){
  try{
   const patch={status:'resolved',resolved_at:new Date().toISOString(),resolution,updated_at:new Date().toISOString()};
   if(userId)patch.resolved_by=userId;
   const result=await db.from('masar_alerts').update(patch).eq('applicant_id',applicantId).eq('status','open');
   if(result.error)throw result.error;
  }catch(e){if(!schemaMissing(e)&&e.code!=='PGRST204')throw e;}
 }
 async function alertById(req,id){
  if(!uuid(id))throw bad('معرف التنبيه غير صحيح');
  let row;
  try{row=must(await db.from('masar_alerts').select('*').eq('id',id).single());}
  catch(e){if(schemaMissing(e)||e.code==='PGRST204')throw bad('فعّل مركز التنبيهات أولاً بتشغيل ملف supabase/009_human_intervention_alerts.sql في Supabase SQL Editor.',503);throw e;}
  if(whatsapp.configured){
   const allowed=await accessibleAccountIds(req);
   if(allowed!==null&&!allowed.includes(row.whatsapp_account_id))throw bad('التنبيه تابع لرقم واتساب غير مصرح لك به',403);
  }
  return row;
 }
 async function accountRows(req){
  const rows=await whatsapp.snapshots(),allowed=await accessibleAccountIds(req);
  return allowed===null?rows:rows.filter(x=>allowed.includes(x.id));
 }
 async function ensureAccountAccess(req,id){
  if(!whatsapp.configured)return;
  if(!uuid(id))throw bad('معرف رقم واتساب غير صحيح');
  const allowed=await accessibleAccountIds(req);
  if(allowed!==null&&!allowed.includes(id))throw bad('رقم واتساب ده مش ضمن صلاحيات حسابك',403);
  if(!whatsapp.snapshot(id))throw bad('حساب واتساب غير موجود',404);
 }
 async function officeState(req){
  try{
   let offices=must(await db.from('masar_offices').select('*').order('created_at',{ascending:true}));
   const dbAccounts=must(await db.from('masar_whatsapp_accounts').select('id,name,phone,active,office_id,created_at').order('created_at',{ascending:true}));
   const snapshots=new Map((await whatsapp.snapshots()).map(x=>[x.id,x]));
   const allowed=await accessibleAccountIds(req);
   let visibleAccounts=allowed===null?dbAccounts:dbAccounts.filter(x=>allowed.includes(x.id));
   if(req.officeId&&req.role!=='admin')visibleAccounts=visibleAccounts.filter(x=>x.office_id===req.officeId);
   const visibleOfficeIds=new Set(visibleAccounts.map(x=>x.office_id).filter(Boolean));
   if(req.officeId&&req.role!=='admin'){offices=offices.filter(x=>x.id===req.officeId);visibleOfficeIds.add(req.officeId);}
   else if(allowed!==null)offices=offices.filter(x=>visibleOfficeIds.has(x.id));
   const applicantRows=must(await db.from('masar_applicants').select('office_id,recruitment_stage'));
   const visibleApplicants=req.officeId&&req.role!=='admin'?applicantRows.filter(x=>x.office_id===req.officeId):(allowed===null?applicantRows:applicantRows.filter(x=>visibleOfficeIds.has(x.office_id)));
   let interviews=[];
   try{interviews=must(await db.from('masar_interviews').select('office_id,status'));}catch(e){if(!schemaMissing(e)&&e.code!=='PGRST204')throw e;}
   let access=[],staffOfficeRows=[];
   if(['admin','office_admin'].includes(req.role)){
    try{access=must(await db.from('masar_staff_whatsapp_access').select('user_id,whatsapp_account_id'));}catch(e){if(!schemaMissing(e))throw e;}
    try{staffOfficeRows=must(await db.from('masar_staff').select('user_id,office_id'));}catch(e){if(!schemaMissing(e)&&e.code!=='42703'&&e.code!=='PGRST204')throw e;}
   }
   const accountOffice=new Map(dbAccounts.map(x=>[x.id,x.office_id]));
   const publicAccounts=visibleAccounts.map(x=>{const live=snapshots.get(x.id)||{};return {id:x.id,name:x.name,phone:live.phone||x.phone||null,status:live.status||'disconnected',active:x.active,office_id:x.office_id||null};});
   return {configured:true,whatsapp_accounts:publicAccounts,items:offices.map(o=>{
    const accounts=publicAccounts.filter(x=>x.office_id===o.id);
    const applicantSubset=visibleApplicants.filter(x=>x.office_id===o.id);
    const staffIds=new Set(access.filter(x=>accountOffice.get(x.whatsapp_account_id)===o.id).map(x=>x.user_id));
    staffOfficeRows.filter(x=>x.office_id===o.id).forEach(x=>staffIds.add(x.user_id));
    return {...o,whatsapp_accounts:accounts,applicant_count:applicantSubset.length,hired_count:applicantSubset.filter(x=>recruitmentStageOf(x)==='hired').length,interview_count:interviews.filter(x=>x.office_id===o.id&&x.status==='scheduled').length,staff_count:['admin','office_admin'].includes(req.role)?staffIds.size:null};
   })};
  }catch(e){
   if(schemaMissing(e)||e.code==='PGRST204'||e.code==='42703')return {configured:false,whatsapp_accounts:[],items:[]};
   throw e;
  }
 }
 async function ensureOfficeAccess(req,id){
  if(!uuid(id))throw bad('معرف المكتب غير صحيح');
  const state=await officeState(req);
  if(!state.configured)throw bad('فعّل نظام المكاتب أولاً بتشغيل ملف supabase/011_multi_office_recruitment.sql في Supabase SQL Editor.',503);
  const office=state.items.find(x=>x.id===id);
  if(!office)throw bad('المكتب غير موجود أو غير مصرح لحسابك',403);
  return office;
 }
 async function saveOfficeAccounts(officeId,value){
  if(value===undefined)return;
  if(!Array.isArray(value))throw bad('اختر أرقام واتساب الخاصة بالمكتب');
  const ids=[...new Set(value.map(String))];
  if(ids.some(id=>!uuid(id)))throw bad('أحد أرقام واتساب المختارة غير صحيح');
  const available=must(await db.from('masar_whatsapp_accounts').select('id'));
  const set=new Set(available.map(x=>x.id));
  if(ids.some(id=>!set.has(id)))throw bad('أحد أرقام واتساب المختارة لم يعد موجودًا');
  for(const id of ids)must(await db.from('masar_whatsapp_accounts').update({office_id:officeId,updated_at:new Date().toISOString()}).eq('id',id));
 }
 async function scopedOfficeId(req,{required=true,body=true}={}){
  let id=req.role==='admin'?String(req.query.office_id||(body?req.body?.office_id:'')||'').trim():String(req.officeId||'').trim();
  if(!id){if(required)throw bad('اختر مكتب التوظيف أولاً',400);return null;}
  await ensureOfficeAccess(req,id);return id;
 }
 async function profilePayload(req){
  const staff=req.staff||{};let avatar_url=null;
  if(staff.avatar_path){
   try{const signed=await db.storage.from('masar-documents').createSignedUrl(staff.avatar_path,3600);avatar_url=signed.data?.signedUrl||null;}catch{}
  }
  return {id:req.user.id,name:String(req.user.user_metadata?.full_name||''),email:req.user.email||'',role:req.role,office_id:req.officeId||null,phone:staff.phone||'',job_title:staff.job_title||'',bio:staff.bio||'',avatar_path:staff.avatar_path||null,avatar_url};
 }
 function monthKey(value){const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleDateString('en-CA',{timeZone:'Africa/Cairo'}).slice(0,7):null;}
 function applicantPublic(a,officeMap=new Map()){return {...a,recruitment_stage:recruitmentStageOf(a),office:officeMap.get(a.office_id)||null};}

 permissionRoute('applicants','get','/alerts',async(req,res)=>{
  try{
   let rows=must(await db.from('masar_alerts').select('*').eq('status','open').order('created_at',{ascending:false}).limit(100));
   const allowed=await accessibleAccountIds(req);
   if(allowed!==null)rows=rows.filter(x=>allowed.includes(x.whatsapp_account_id));
   const ids=rows.map(x=>x.id),reads=ids.length?must(await db.from('masar_alert_reads').select('alert_id').eq('user_id',req.user.id).in('alert_id',ids)):[];
   const readSet=new Set(reads.map(x=>x.alert_id));
   const applicantIds=[...new Set(rows.map(x=>x.applicant_id))];
   const applicants=applicantIds.length?must(await db.from('masar_applicants').select('id,display_name,phone,answers').in('id',applicantIds)):[];
   const applicantMap=new Map(applicants.map(a=>[a.id,a]));
   const accountMap=new Map((await accountRows(req)).map(x=>[x.id,x]));
   const items=rows.map(row=>{
    const a=applicantMap.get(row.applicant_id),answerName=Object.values(a?.answers||{}).find(v=>v?.kind==='name');
    const account=accountMap.get(row.whatsapp_account_id);
    return {...row,read:readSet.has(row.id),applicant_name:answerName?.display||answerName?.value||a?.display_name||'متقدم',phone:row.phone||a?.phone||null,whatsapp_name:account?.name||'واتساب',whatsapp_phone:account?.phone||null};
   });
   res.json({configured:true,items,unread:items.filter(x=>!x.read).length,open_count:items.length});
  }catch(e){if(schemaMissing(e)||e.code==='PGRST204')return res.json({configured:false,items:[],unread:0,open_count:0});throw e;}
 });
 permissionRoute('applicants','post','/alerts/read-all',async(req,res)=>{
  let rows=must(await db.from('masar_alerts').select('id,whatsapp_account_id').eq('status','open').limit(1000));
  const allowed=await accessibleAccountIds(req);if(allowed!==null)rows=rows.filter(x=>allowed.includes(x.whatsapp_account_id));
  if(rows.length)must(await db.from('masar_alert_reads').upsert(rows.map(x=>({alert_id:x.id,user_id:req.user.id,read_at:new Date().toISOString()})),{onConflict:'alert_id,user_id'}));
  res.json({ok:true});
 });
 permissionRoute('applicants','post','/alerts/:id/read',async(req,res)=>{
  const alert=await alertById(req,req.params.id);
  must(await db.from('masar_alert_reads').upsert({alert_id:alert.id,user_id:req.user.id,read_at:new Date().toISOString()},{onConflict:'alert_id,user_id'}));
  res.json({ok:true});
 });
 permissionRoute('applicants','post','/alerts/:id/resolve',async(req,res)=>{
  const alert=await alertById(req,req.params.id);
  must(await db.from('masar_alerts').update({status:'resolved',resolved_by:req.user.id,resolved_at:new Date().toISOString(),resolution:'manual',updated_at:new Date().toISOString()}).eq('id',alert.id));
  must(await db.from('masar_alert_reads').upsert({alert_id:alert.id,user_id:req.user.id,read_at:new Date().toISOString()},{onConflict:'alert_id,user_id'}));
  res.json({ok:true});
 });
 route('get','/bootstrap',async(req,res)=>{
  const officeData=await officeState(req),selectedOfficeId=req.role==='admin'?await scopedOfficeId(req,{required:false,body:false}):req.officeId;
  let cfg={questions:[],areas:[],settings:null};
  if(selectedOfficeId||!officeData.configured)cfg=await config(db,selectedOfficeId||null);
  const profile=await profilePayload(req);
  const accounts=(await accountRows(req)).map(({id,name,phone,status,office_id})=>({id,name,phone,status,office_id:office_id||null}));
  const payload={role:req.role,permissions:req.permissions,profile,office_id:req.officeId||null,config_office_id:selectedOfficeId||null,whatsapp_accounts:accounts,multi_whatsapp_configured:whatsapp.configured,offices_configured:officeData.configured,offices:officeData.items,ai_configured:true,ai_provider:'local'};
  if(['admin','office_admin'].includes(req.role)||req.permissions.includes('areas'))payload.areas=cfg.areas;
  if(['admin','office_admin'].includes(req.role)||req.permissions.includes('questions'))payload.questions=cfg.questions;
  if(['admin','office_admin'].includes(req.role)||req.permissions.includes('settings'))payload.settings=cfg.settings;
  res.json(payload);
 });
 route('get','/profile',async(req,res)=>res.json(await profilePayload(req)));
 route('put','/profile',async(req,res)=>{
  const phone=String(req.body.phone||'').trim(),jobTitle=String(req.body.job_title||'').trim(),bio=String(req.body.bio||'').trim();
  const avatarPath=req.body.avatar_path===null||req.body.avatar_path===''?null:String(req.body.avatar_path||'').trim();
  if(phone.length>30||jobTitle.length>100||bio.length>600)throw bad('راجع بيانات الحساب');
  if(avatarPath&&!avatarPath.startsWith('staff/'+req.user.id+'/'))throw bad('مسار الصورة الشخصية غير صحيح');
  const patch={phone:phone||null,job_title:jobTitle,bio,avatar_path:avatarPath,updated_at:new Date().toISOString()};
  must(await db.from('masar_staff').update(patch).eq('user_id',req.user.id));
  req.staff={...(req.staff||{}),...patch};res.json(await profilePayload(req));
 });
 route('put','/profile/password',async(req,res)=>{
  const password=String(req.body.password||'');
  if(password.length<8||password.length>100)throw bad('كلمة المرور لازم تكون 8 أحرف على الأقل');
  const changed=await db.auth.admin.updateUserById(req.user.id,{password});if(changed.error)throw changed.error;
  res.json({ok:true});
 });
  route('get','/offices',async(req,res)=>res.json(await officeState(req)));
 adminRoute('post','/offices',async(req,res)=>{await serial(async()=>{
  const name=String(req.body.name||'').trim(),code=String(req.body.code||'').trim().toUpperCase(),address=String(req.body.address||'').trim(),phone=String(req.body.phone||'').trim()||null,manager=String(req.body.manager_name||'').trim();
  if(name.length<2||name.length>120)throw bad('اكتب اسم واضح للمكتب');
  if(!/^[A-Z0-9_-]{2,30}$/.test(code))throw bad('كود المكتب يكون حروف إنجليزية أو أرقام فقط');
  if(address.length>300||manager.length>120)throw bad('راجع بيانات المكتب');
  const row=must(await db.from('masar_offices').insert({name,code,address,phone,manager_name:manager,active:req.body.active!==false}).select().single());
  try{
   const source=must(await db.from('masar_offices').select('id').neq('id',row.id).order('created_at',{ascending:true}).limit(1).maybeSingle());
   if(source?.id)must(await db.rpc('masar_clone_office_config',{p_source:source.id,p_target:row.id,p_remap_existing:false}));
   else{
    const s=must(await db.from('masar_settings').select('ai_enabled,welcome,completion,followup_enabled,followup_hours').eq('id',true).single());
    must(await db.from('masar_office_settings').upsert({office_id:row.id,ai_enabled:s.ai_enabled,welcome:s.welcome,completion:s.completion,followup_enabled:s.followup_enabled??true,followup_hours:s.followup_hours||8}));
   }
  }catch(e){if(!schemaMissing(e)&&!['42703','PGRST204','PGRST202'].includes(e.code||''))throw e;}
  await saveOfficeAccounts(row.id,req.body.whatsapp_account_ids||[]);
  res.status(201).json(row);
 });});
 managerRoute('put','/offices/:id',async(req,res)=>{await serial(async()=>{
  await ensureOfficeAccess(req,req.params.id);
  const name=String(req.body.name||'').trim(),code=String(req.body.code||'').trim().toUpperCase(),address=String(req.body.address||'').trim(),phone=String(req.body.phone||'').trim()||null,manager=String(req.body.manager_name||'').trim();
  if(name.length<2||name.length>120)throw bad('اكتب اسم واضح للمكتب');
  if(!/^[A-Z0-9_-]{2,30}$/.test(code))throw bad('كود المكتب يكون حروف إنجليزية أو أرقام فقط');
  if(address.length>300||manager.length>120)throw bad('راجع بيانات المكتب');
  const row=must(await db.from('masar_offices').update({name,code,address,phone,manager_name:manager,active:req.body.active!==false,updated_at:new Date().toISOString()}).eq('id',req.params.id).select().single());
  if(req.role==='admin')await saveOfficeAccounts(row.id,req.body.whatsapp_account_ids);
  res.json(row);
 });});
 adminRoute('delete','/offices/:id',async(req,res)=>{
  if(!uuid(req.params.id))throw bad('معرف المكتب غير صحيح');
  const office=must(await db.from('masar_offices').select('*').eq('id',req.params.id).maybeSingle());
  if(!office)throw bad('المكتب غير موجود',404);
  const confirmCode=String(req.body?.confirm_code||'').trim().toUpperCase();
  if(confirmCode!==String(office.code||'').trim().toUpperCase())throw bad('اكتب كود المكتب للتأكيد قبل الحذف النهائي');
  const accounts=must(await db.from('masar_whatsapp_accounts').select('id,name,legacy_session').eq('office_id',office.id));
  const staffRows=must(await db.from('masar_staff').select('user_id,office_id').eq('office_id',office.id));
  const applicants=[];for(let page=0;;page++){
   const part=must(await db.from('masar_applicants').select('id,answers').eq('office_id',office.id).order('id').range(page*500,page*500+499));
   applicants.push(...part);if(part.length<500)break;
  }
  const applicantIds=applicants.map(x=>x.id),attributedAdIds=[...new Set(applicants.map(a=>String(a.answers?.__attribution?.source_id||'')).filter(x=>/^\d{5,40}$/.test(x)))];
  const campaigns=must(await db.from('masar_campaigns').select('id').eq('office_id',office.id)),campaignIds=campaigns.map(x=>x.id);
  const mediaPaths=[];
  for(let i=0;i<applicantIds.length;i+=100){
   const ids=applicantIds.slice(i,i+100);
   for(let page=0;;page++){
    const rows=must(await db.from('masar_messages').select('media_path').in('applicant_id',ids).order('id').range(page*500,page*500+499));
    mediaPaths.push(...rows.map(x=>x.media_path).filter(Boolean));
    if(rows.length<500)break;
   }
  }
  const whatsappWarnings=[];
  for(const account of accounts){
   try{if(whatsapp.item?.(account.id))await whatsapp.disconnect(account.id);}catch(e){whatsappWarnings.push(account.name||account.id);}
  }
  await serial(async()=>{
   for(let i=0;i<applicantIds.length;i+=100){
    const ids=applicantIds.slice(i,i+100);
    try{must(await db.from('masar_learning_suggestions').delete().in('applicant_id',ids));}catch(e){if(!schemaMissing(e))throw e;}
    must(await db.from('masar_events').delete().in('applicant_id',ids));
    must(await db.from('masar_contacts').delete().in('applicant_id',ids));
    must(await db.from('masar_messages').update({reply_to:null}).in('applicant_id',ids));
    must(await db.from('masar_messages').delete().in('applicant_id',ids));
   }
   must(await db.from('masar_interviews').delete().eq('office_id',office.id));
   must(await db.from('masar_applicants').delete().eq('office_id',office.id));
   if(campaignIds.length)for(let i=0;i<campaignIds.length;i+=100)must(await db.from('masar_ads').delete().in('campaign_id',campaignIds.slice(i,i+100)));
   if(attributedAdIds.length)for(let i=0;i<attributedAdIds.length;i+=100)must(await db.from('masar_ads').delete().in('ad_id',attributedAdIds.slice(i,i+100)));
   try{must(await db.from('masar_ads').delete().eq('office_id',office.id));}catch(e){if(!schemaMissing(e)&&!['42703','PGRST204'].includes(e?.code||''))throw e;}
   must(await db.from('masar_campaigns').delete().eq('office_id',office.id));
   const removableStaff=staffRows.map(x=>x.user_id).filter(id=>id!==req.user.id);
   if(removableStaff.length){
    for(let i=0;i<removableStaff.length;i+=100){
     const ids=removableStaff.slice(i,i+100);
     must(await db.from('masar_events').update({staff_id:null}).in('staff_id',ids));
     try{must(await db.from('masar_alert_reads').delete().in('user_id',ids));}catch(e){if(!schemaMissing(e))throw e;}
     try{must(await db.from('masar_push_tokens').delete().in('user_id',ids));}catch(e){if(!schemaMissing(e))throw e;}
     try{must(await db.from('masar_staff_whatsapp_access').delete().in('user_id',ids));}catch(e){if(!schemaMissing(e))throw e;}
     must(await db.from('masar_staff').delete().in('user_id',ids));
    }
   }
   if(staffRows.some(x=>x.user_id===req.user.id))must(await db.from('masar_staff').update({office_id:null,updated_at:new Date().toISOString()}).eq('user_id',req.user.id));
   must(await db.from('masar_whatsapp_accounts').delete().eq('office_id',office.id));
   must(await db.from('masar_offices').delete().eq('id',office.id));
  });
  for(const account of accounts){try{await whatsapp.remove?.(account.id);}catch{}}
  const authDeleteFailures=[];
  for(const staff of staffRows){
   if(staff.user_id===req.user.id)continue;
   const result=await db.auth.admin.deleteUser(staff.user_id);
   if(result.error)authDeleteFailures.push(staff.user_id);
  }
  if(staffRows.some(x=>x.user_id===req.user.id)){
   const current=await db.auth.admin.getUserById(req.user.id);
   if(!current.error&&current.data.user){
    const metadata={...(current.data.user.app_metadata||{}),masar_office_id:null};
    await db.auth.admin.updateUserById(req.user.id,{app_metadata:metadata});
   }
  }
  let media_cleanup_ok=true;const uniqueMedia=[...new Set(mediaPaths)];
  for(let i=0;i<uniqueMedia.length;i+=100){
   try{const result=await db.storage.from('masar-documents').remove(uniqueMedia.slice(i,i+100));if(result.error)throw result.error;}
   catch(e){media_cleanup_ok=false;console.warn('Office media cleanup failed:',e.code||e.name);}
  }
  res.json({ok:true,deleted:{office:office.name,applicants:applicantIds.length,whatsapp_accounts:accounts.length,staff:staffRows.length,campaigns:campaignIds.length},media_cleanup_ok,whatsapp_warnings:whatsappWarnings,auth_delete_failures:authDeleteFailures});
 });

 route('post','/mobile/push-token',async(req,res)=>{
  const token=String(req.body.token||'').trim();
  const platform=['ios','android'].includes(String(req.body.platform))?String(req.body.platform):'unknown';
  const deviceName=String(req.body.device_name||'').trim().slice(0,120);
  if(!validExpoPushToken(token))throw bad('Push token غير صحيح');
  const now=new Date().toISOString();
  try{
   const result=await db.from('masar_push_tokens').upsert({
    user_id:req.user.id,token,platform,device_name:deviceName,active:true,updated_at:now,last_seen_at:now
   },{onConflict:'token'});
   if(result.error)throw result.error;
  }catch(e){if(schemaMissing(e)||e.code==='PGRST204')throw bad('فعّل إشعارات الموبايل أولاً بتشغيل ملف supabase/010_mobile_push.sql في Supabase SQL Editor.',503);throw e;}
  res.json({ok:true});
 });
 route('delete','/mobile/push-token',async(req,res)=>{
  const token=String(req.body.token||'').trim();
  if(!validExpoPushToken(token))throw bad('Push token غير صحيح');
  try{
   const result=await db.from('masar_push_tokens').update({active:false,updated_at:new Date().toISOString()}).eq('user_id',req.user.id).eq('token',token);
   if(result.error)throw result.error;
  }catch(e){if(schemaMissing(e)||e.code==='PGRST204')return res.json({ok:true});throw e;}
  res.json({ok:true});
 });
 permissionRoute('whatsapp','get','/whatsapp',async(req,res)=>{
  const rows=await accountRows(req),first=rows[0]||null;
  res.json(first?{...first,worker_error:worker.lastError}:{status:'disconnected',phone:null,qr:null,error:'لا يوجد رقم واتساب ضمن صلاحيات الحساب',worker_error:worker.lastError});
 });
 permissionRoute('whatsapp','post','/whatsapp/connect',async(req,res)=>{
  const rows=await accountRows(req),id=rows[0]?.id??whatsapp.defaultAccountId();
  if(whatsapp.configured&&!id)throw bad('لا يوجد رقم واتساب ضمن صلاحيات الحساب',403);
  if(id)await ensureAccountAccess(req,id);res.json(await whatsapp.connect(id));
 });
 permissionRoute('whatsapp','post','/whatsapp/disconnect',async(req,res)=>{
  const rows=await accountRows(req),id=rows[0]?.id??whatsapp.defaultAccountId();
  if(whatsapp.configured&&!id)throw bad('لا يوجد رقم واتساب ضمن صلاحيات الحساب',403);
  if(id)await ensureAccountAccess(req,id);res.json(await whatsapp.disconnect(id));
 });
 permissionRoute('whatsapp','get','/whatsapp/accounts',async(req,res)=>res.json({configured:whatsapp.configured,items:await accountRows(req),worker_error:worker.lastError}));
 managerRoute('post','/whatsapp/accounts',async(req,res)=>{await serial(async()=>{
  if(!whatsapp.configured)throw bad('فعّل تعدد أرقام واتساب أولاً بتشغيل ملف supabase/003_multi_whatsapp.sql في Supabase SQL Editor.',503);
  const name=String(req.body.name||'').trim();if(name.length<2||name.length>80)throw bad('اكتب اسم واضح لرقم واتساب');
  const offices=await officeState(req),officeId=req.role==='admin'?(req.body.office_id?String(req.body.office_id):null):req.officeId;
  if(offices.configured&&!officeId)throw bad('اختر مكتب التوظيف الخاص برقم واتساب');
  if(officeId)await ensureOfficeAccess(req,officeId);
  const insertRow={name,legacy_session:false,active:true,reply_mode:'off',review_new_contacts:true};if(officeId)insertRow.office_id=officeId;
  const row=must(await db.from('masar_whatsapp_accounts').insert(insertRow).select().single());
  await whatsapp.add(row);res.status(201).json(whatsapp.snapshot(row.id));
 });});
 managerRoute('put','/whatsapp/accounts/:id/reply-mode',async(req,res)=>{await serial(async()=>{
  if(!whatsapp.configured||!uuid(req.params.id))throw bad('معرف رقم واتساب غير صحيح');
  await ensureAccountAccess(req,req.params.id);
  const mode=String(req.body?.reply_mode||'');
  if(normalizeReplyMode(mode)!==mode)throw bad('وضع الرد غير صحيح');
  const row=must(await db.from('masar_whatsapp_accounts')
   .update({reply_mode:mode,review_new_contacts:true,updated_at:new Date().toISOString()})
   .eq('id',req.params.id).select().single());
  const linked=whatsapp.item?.(req.params.id);
  if(linked){linked.account={...linked.account,...row};linked.connection.syncHistory=true;}
  must(await db.from('masar_events').insert({kind:'whatsapp_reply_mode_changed',
   staff_id:req.user.id,detail:{account_id:row.id,office_id:row.office_id,reply_mode:mode}}));
  res.json(whatsapp.snapshot(req.params.id)||row);
  worker.tick();
 });});
 managerRoute('put','/whatsapp/accounts/:id',async(req,res)=>{await serial(async()=>{
  if(!whatsapp.configured||!uuid(req.params.id))throw bad('معرف رقم واتساب غير صحيح');
  await ensureAccountAccess(req,req.params.id);
  const name=String(req.body.name||'').trim();if(name.length<2||name.length>80)throw bad('اكتب اسم واضح لرقم واتساب');
  const patch={name,updated_at:new Date().toISOString()};
  if(req.role==='admin'&&req.body.office_id){const officeId=String(req.body.office_id);await ensureOfficeAccess(req,officeId);patch.office_id=officeId;}
  const row=must(await db.from('masar_whatsapp_accounts').update(patch).eq('id',req.params.id).select().single());
  const item=whatsapp.item?.(req.params.id);if(item)item.account={...item.account,...row};
  res.json(whatsapp.snapshot(req.params.id)||row);
 });});
 permissionRoute('whatsapp','post','/whatsapp/accounts/:id/connect',async(req,res)=>{await ensureAccountAccess(req,req.params.id);await whatsapp.connect(req.params.id);res.json(whatsapp.snapshot(req.params.id));});
 permissionRoute('whatsapp','post','/whatsapp/accounts/:id/disconnect',async(req,res)=>{await ensureAccountAccess(req,req.params.id);await whatsapp.disconnect(req.params.id);res.json(whatsapp.snapshot(req.params.id));});
 managerRoute('put','/office-agent',async(req,res)=>{
  const officeId=await scopedOfficeId(req);
  if(typeof req.body.enabled!=='boolean')throw bad('قيمة تشغيل Agent غير صحيحة');
  try{
   must(await db.from('masar_office_settings').upsert({office_id:officeId,agent_enabled:req.body.enabled,updated_at:new Date().toISOString()},{onConflict:'office_id'}));
  }catch(e){
   if(schemaMissing(e)||['42703','PGRST204'].includes(e?.code))throw bad('فعّل Agent المكاتب أولاً بتشغيل ملف supabase/017_autonomous_office_agent.sql في Supabase SQL Editor.',503);
   throw e;
  }
  if(req.body.enabled===false){
   try{
    const applicants=must(await db.from('masar_applicants').select('id').eq('office_id',officeId));
    const ids=applicants.map(x=>x.id);
    for(let i=0;i<ids.length;i+=100){
     const chunk=ids.slice(i,i+100);
     if(chunk.length)must(await db.from('masar_messages').update({status:'processed',error:'تم إلغاء الرد الآلي لأن Agent المكتب متوقف.'}).in('applicant_id',chunk).eq('direction','out').eq('sender','bot').eq('status','queued'));
    }
   }catch(e){if(!schemaMissing(e))throw e;}
  }else worker.tick();
  must(await db.from('masar_events').insert({kind:req.body.enabled?'office_agent_enabled':'office_agent_disabled',staff_id:req.user.id,detail:{office_id:officeId}}));
  res.json({ok:true,office_id:officeId,agent_enabled:req.body.enabled});
 });
 permissionRoute('settings','put','/settings',async(req,res)=>{
  const b=req.body,officeId=await scopedOfficeId(req);
  if(!String(b.welcome||'').trim()||!String(b.completion||'').trim()||b.welcome.length>1500||b.completion.length>1500)throw bad('راجع إعدادات الرسائل');
  const hours=Number(b.followup_hours);
  if(typeof b.followup_enabled!=='boolean'||!Number.isInteger(hours)||hours<1||hours>72)throw bad('متابعة البيانات الناقصة لازم تكون من 1 إلى 72 ساعة');
  const patch={office_id:officeId,welcome:String(b.welcome).trim(),completion:String(b.completion).trim(),followup_enabled:b.followup_enabled,followup_hours:hours,qualification_require_shift:b.qualification_require_shift===true,qualification_require_motorcycle_license:b.qualification_require_motorcycle_license===true,updated_at:new Date().toISOString()};
  try{must(await db.from('masar_office_settings').upsert(patch,{onConflict:'office_id'}));}
  catch(e){if(schemaMissing(e)||['42703','PGRST204'].includes(e?.code))throw bad('فعّل إعدادات المكاتب أولاً بتشغيل ملف supabase/012_office_admin_scoped_config.sql في Supabase SQL Editor.',503);throw e;}
  res.json({ok:true});
 });
 const cleanKeywords=value=>Array.isArray(value)?[...new Set(value.map(x=>String(x||'').trim()).filter(Boolean).slice(0,20).map(x=>x.slice(0,80)))]:[];
 async function intelligenceState(){
  try{
   // This read endpoint must never approve or publish candidate-derived knowledge.
   const since=new Date(Date.now()-30*24*60*60*1000).toISOString();
   let eventQuery=db.from('masar_events').select('kind,detail,created_at').gte('created_at',since).in('kind',['agent_turn','ai_handoff']).order('created_at',{ascending:false}).limit(5000);
   const [settings,knowledge,suggestions,eventResult]=await Promise.all([
    db.from('masar_settings').select('*').eq('id',true).single(),
    db.from('masar_knowledge').select('*').order('updated_at',{ascending:false}),
    db.from('masar_learning_suggestions').select('*').order('created_at',{ascending:false}).limit(500),
    eventQuery
   ]);
   const s=must(settings),k=must(knowledge),sg=must(suggestions);
   const events=eventResult.error&&schemaMissing(eventResult.error)?[]:must(eventResult);
   const turns=events.filter(x=>x.kind==='agent_turn'),handoffTurns=turns.filter(x=>x.detail?.handoff===true);
   const handoffReasons={};
   for(const event of events.filter(x=>x.kind==='ai_handoff')){
    const reason=String(event.detail?.reason||'unknown');handoffReasons[reason]=(handoffReasons[reason]||0)+1;
   }
   const autonomyRate=turns.length?Math.round((turns.length-handoffTurns.length)/turns.length*1000)/10:null;
   return {configured:true,learning_mode:'continuous',voice_transcription:speech?.snapshot?.()||{available:false,error:'محرك الصوت غير متاح'},settings:{
    ai_knowledge_enabled:s.ai_knowledge_enabled!==false,
    ai_learning_enabled:s.ai_learning_enabled!==false,
    ai_confidence_threshold:Number(s.ai_confidence_threshold||0.62),
    ai_fallback:s.ai_fallback||'السؤال ده محتاج تأكيد من مسؤول التوظيف، هحوّل المحادثة للفريق علشان يرد عليك بدقة.',
    agent_llm_enabled:s.agent_llm_enabled===true,
    agent_llm_mode:s.agent_llm_mode||'shadow',
    agent_llm_provider:s.agent_llm_provider||'openai_compatible',
    agent_llm_model:s.agent_llm_model||'',
    agent_llm_temperature:Number(s.agent_llm_temperature??0.2),
    agent_llm_timeout_ms:Number(s.agent_llm_timeout_ms||8000),
    agent_llm_max_tokens:Number(s.agent_llm_max_tokens||800),
    agent_planner_confidence_threshold:Number(s.agent_planner_confidence_threshold||0.72),
    agent_hybrid_memory_enabled:s.agent_hybrid_memory_enabled!==false,
    agent_llm_rerank_enabled:s.agent_llm_rerank_enabled!==false,
    agent_fact_extraction_enabled:s.agent_fact_extraction_enabled!==false,
    agent_next_best_action_enabled:s.agent_next_best_action_enabled!==false,
    agent_context_messages:Number(s.agent_context_messages||12),
    agent_tone:s.agent_tone||'egyptian_natural',
    agent_system_instructions:s.agent_system_instructions||''
   },knowledge:k,suggestions:sg,stats:{
    active:k.filter(x=>x.active&&x.memory_status!=='conflict'&&x.memory_status!=='stale').length,total:k.length,pending:sg.filter(x=>x.status==='pending').length,
    conflicts:k.filter(x=>x.memory_status==='conflict').length,stale:k.filter(x=>x.memory_status==='stale').length,
    approved:sg.filter(x=>x.status==='approved').length,skipped:sg.filter(x=>x.status==='rejected').length,
    learned:k.filter(x=>x.source==='staff').length,
    shared_breadfast:k.filter(x=>x.knowledge_scope==='breadfast'&&x.active&&x.memory_status!=='conflict'&&x.memory_status!=='stale').length,
    shared_learned:k.filter(x=>x.knowledge_scope==='breadfast'&&x.source==='staff'&&x.active&&x.memory_status!=='conflict'&&x.memory_status!=='stale').length,
    shared_conflicts:k.filter(x=>x.knowledge_scope==='breadfast'&&x.memory_status==='conflict').length,
    usage:k.reduce((n,x)=>n+Number(x.usage_count||0),0),
    turns_30d:turns.length,handoffs_30d:handoffTurns.length,autonomy_rate_30d:autonomyRate,
    knowledge_turns_30d:turns.filter(x=>x.detail?.knowledge_id).length,
    extracted_fact_turns_30d:turns.filter(x=>Number(x.detail?.extracted_facts||0)>0).length,
    handoff_reasons_30d:handoffReasons
   }};
  }catch(e){
   if(schemaMissing(e))return {configured:false,learning_mode:'continuous',voice_transcription:speech?.snapshot?.()||{available:false,error:'محرك الصوت غير متاح'},settings:null,knowledge:[],suggestions:[],stats:{active:0,total:0,pending:0,approved:0,skipped:0,learned:0,usage:0}};
   throw e;
  }
 }
 async function agentState(){
  const base=await intelligenceState();
  if(!base.configured)return {...base,llm:agentRuntime?.snapshot?.({})||{configured:false,enabled:false},decisions:[],quality:{cases:[],recent_runs:[]},agent_stats:{},expert:expertBrainSummary()};
  let decisions=[],cases=[],runs=[];
  try{
   const [d,casesResult,runsResult]=await Promise.all([
    db.from('masar_agent_decisions').select('*').order('created_at',{ascending:false}).limit(300),
    db.from('masar_agent_eval_cases').select('*').order('created_at',{ascending:false}).limit(200),
    db.from('masar_agent_eval_runs').select('*').order('created_at',{ascending:false}).limit(300)
   ]);
   decisions=d.error&&schemaMissing(d.error)?[]:must(d);
   cases=casesResult.error&&schemaMissing(casesResult.error)?[]:must(casesResult);
   runs=runsResult.error&&schemaMissing(runsResult.error)?[]:must(runsResult);
  }catch(e){if(!schemaMissing(e))throw e;}
  const since24=Date.now()-24*60*60*1000,recent=decisions.filter(x=>Date.parse(x.created_at)>=since24);
  const llmRecent=recent.filter(x=>String(x.planner_mode||'').startsWith('llm_'));
  const fallback=recent.filter(x=>x.fallback_used===true);
  const confidenceValues=recent.map(x=>Number(x.confidence)).filter(Number.isFinite);
  const latencyValues=llmRecent.map(x=>Number(x.latency_ms)).filter(Number.isFinite);
  const actions={};for(const row of recent)actions[row.action]=(actions[row.action]||0)+1;
  const growth={};
  for(const row of base.knowledge||[]){
   const day=String(row.created_at||'').slice(0,10);if(day)growth[day]=(growth[day]||0)+1;
  }
  return {...base,
   expert:expertBrainSummary(),
   llm:agentRuntime?.snapshot?.(base.settings)||{configured:false,enabled:false},
   decisions:decisions.slice(0,100),
   quality:{cases,recent_runs:runs.slice(0,100)},
   knowledge_growth:Object.entries(growth).sort((a,b)=>a[0].localeCompare(b[0])).slice(-30).map(([day,count])=>({day,count})),
   agent_stats:{
    decisions_24h:recent.length,llm_decisions_24h:llmRecent.length,
    fallback_rate_24h:recent.length?Math.round(fallback.length/recent.length*1000)/10:0,
    avg_confidence_24h:confidenceValues.length?Math.round(confidenceValues.reduce((a,b)=>a+b,0)/confidenceValues.length*1000)/10:null,
    avg_latency_ms:latencyValues.length?Math.round(latencyValues.reduce((a,b)=>a+b,0)/latencyValues.length):null,
    actions_24h:actions
   }
  };
 }
 // Per-office Pilot Control. Only the system admin can read or mutate these
 // monitoring controls; candidate metadata never leaves these aggregate APIs.
 async function pilotOfficeDirectory(){
  const [o,w,settings]=await Promise.all([
   db.from('masar_offices').select('id,name,active').order('created_at',{ascending:true}).limit(100),
   db.from('masar_whatsapp_accounts').select('id,office_id,active').limit(500),
   db.from('masar_office_settings').select('office_id,agent_enabled').limit(100)
  ]);
  const offices=must(o),accounts=must(w),cfg=must(settings);
  const settingsByOffice=new Map(cfg.map(x=>[x.office_id,x]));
  return await Promise.all(offices.map(async office=>{
   const linked=accounts.filter(x=>x.office_id===office.id&&x.active===true);
   const pilot=await loadPilotControl(db,office.id,{officeId:true});
   const enrollments=await loadPilotEnrollments(db,pilot);
   return {
    id:office.id,name:office.name,active:office.active===true,
    agent_enabled:settingsByOffice.get(office.id)?.agent_enabled!==false,
    linked_accounts:linked.length,
    pilot, enrolled:enrollments.length
   };
  }));
 }
 async function officePilotReport(office){
  const pilot=office.pilot;
  const enrollments=await loadPilotEnrollments(db,pilot);
  const ids=[...new Set(enrollments.map(x=>x.applicant_id))];
  const [applicantResult,handoffResult]=ids.length?await Promise.all([
   db.from('masar_applicants').select('id,stage').in('id',ids).limit(200),
   db.from('masar_events').select('applicant_id').eq('kind','ai_handoff')
    .in('applicant_id',ids)
    .gte('created_at',pilot.started_at||'2000-01-01T00:00:00Z').limit(500)
  ]):[{data:[],error:null},{data:[],error:null}];
  return pilotCohortSummary({
   pilot,enrollments,applicants:must(applicantResult),handoffs:must(handoffResult)
  });
 }
 // Read-only recruitment performance; applicant IDs remain in-process.
 // The selected office's applicant cohort is isolated by office_id OR its
 // linked WhatsApp accounts (historical inbound rows may have null office_id).
 adminRoute('get','/agent/performance',async(req,res)=>{
  const days=Number(req.query.days||7);
  if(!Number.isInteger(days)||days<1||days>30)throw bad('اختار فترة بين 1 و30 يومًا');
  const directory=await pilotOfficeDirectory();
  const requested=String(req.query.office_id||'').trim();
  if(requested&&!uuid(requested))throw bad('معرف المكتب غير صحيح');
  const office=requested?directory.find(o=>o.id===requested)
   :directory.find(o=>o.pilot.active)||directory.find(o=>o.active)||directory[0];
  if(requested&&!office)throw bad('المكتب غير موجود',404);
  const offices=directory.map(({pilot,...o})=>({
   ...o,pilot_active:pilot.active,pilot_capacity:pilot.max,
   pilot_status:!pilot.active?'stopped':o.enrolled>=pilot.max?'cohort_full':'running'
  }));
  if(!office)return res.json({
   offices:[],office_id:null,pilot_observation:null,
   ...recruitmentPerformance({days}),pilot:pilotReadiness()
  });
  const since=new Date(Date.now()-days*86400000).toISOString();
  const cap=200;
  const accountRows=must(await db.from('masar_whatsapp_accounts').select('id')
   .eq('office_id',office.id).limit(200));
  const accountIds=accountRows.map(x=>x.id);
  let aq=db.from('masar_applicants')
   .select('id,stage,created_at,last_message_at',{count:'exact'})
   .gte('created_at',since);
  if(accountIds.length){
   aq=aq.or('office_id.eq.'+office.id+',whatsapp_account_id.in.('+accountIds.join(',')+')');
  }else aq=aq.eq('office_id',office.id);
  const a=await aq.order('created_at',{ascending:false}).limit(cap);
  const applicants=must(a),ids=applicants.map(x=>x.id);
  const empty={data:[],error:null,count:0};
  const [m,d,latestSuite,officeTurns]=await Promise.all([
   ids.length?db.from('masar_messages')
    .select('applicant_id,created_at,direction,sender',{count:'exact'})
    .in('applicant_id',ids).gte('created_at',since)
    .order('created_at',{ascending:false}).limit(cap):empty,
   ids.length?db.from('masar_agent_decisions')
    .select('applicant_id,created_at,latency_ms',{count:'exact'})
    .in('applicant_id',ids).gte('created_at',since)
    .order('created_at',{ascending:false}).limit(cap):empty,
   db.from('masar_events').select('created_at,detail')
    .eq('kind','agent_quality_suite').order('created_at',{ascending:false}).limit(1),
   ids.length?db.from('masar_events').select('kind,detail,created_at,applicant_id',{count:'exact'})
    .eq('kind','agent_turn').in('applicant_id',ids).gte('created_at',since)
    .order('created_at',{ascending:false}).limit(1000):empty
  ]);
  const optional=x=>{
   if(!x.error)return x.data||[];
   if(schemaMissing(x.error)||['42703','PGRST204'].includes(x.error.code))return [];
   throw x.error;
  };
  const messages=must(m),decisions=optional(d),suite=optional(latestSuite)[0],turns=optional(officeTurns);
  const qaPassed=suite&&Number(suite.detail?.total)>=560
   &&Number(suite.detail?.failed)===0&&Number(suite.detail?.passed)===Number(suite.detail?.total)
   &&Date.parse(suite.created_at)>=Date.now()-7*86400000;
  const report=recruitmentPerformance({
   applicants,messages,decisions,days,
   applicantsTotal:a.count,messagesTotal:m.count,decisionsTotal:d.count
  });
  // Office-scoped operational signals only; synthetic suite is global and is not counted as office accuracy.
  const officeQuality=qualityMetrics({events:turns,decisions:[],runs:[],days,
   truncated:Boolean(officeTurns.count>turns.length)||Boolean(a.count>applicants.length)});
  const officeIssues=officeConversationIssues(turns,{applicantIds:ids,days,truncated:officeQuality.sample.truncated});
  res.json({...report,office_quality:{sample:officeQuality.sample,operational:officeQuality.operational,
   handoff_reasons:officeQuality.handoff_reasons,issues:officeIssues,accuracy_rate:null,
   accuracy_note:'دقة إجابات المكتب لا تُحسب قبل وجود مراجعات بشرية موثقة.'},office_id:office.id,office_name:office.name,offices,
   pilot:pilotReadiness({qualitySuitePassed:Boolean(qaPassed)}),
   pilot_observation:await officePilotReport(office)});
 });
 // Starting/stopping the office pilot only changes audit metadata, NOT the
 // Office Agent enabled flag, LLM mode, followups, or WhatsApp sending.
 adminRoute('post','/agent/pilot/start',async(req,res)=>{
  await serial(async()=>{
   const officeId=String(req.body?.office_id||'').trim();
   if(!uuid(officeId))throw bad('حدد المكتب قبل بدء التجربة');
   const count=Number(req.body?.capacity??PILOT_LIMIT);
   if(!validPilotSize(count))throw bad('اختر عينة من 10 أو 25 أو 50 أو 100 أو 200 متقدم');
   const office=must(await db.from('masar_offices')
    .select('id,name,active').eq('id',officeId).maybeSingle());
   if(!office||office.active!==true)throw bad('المكتب غير موجود أو غير مفعل',409);
   const linked=must(await db.from('masar_whatsapp_accounts')
    .select('id').eq('office_id',officeId).eq('active',true).limit(100));
   if(!linked.length)throw bad('اربط رقم واتساب نشط بالمكتب الأول',409);
   const setting=must(await db.from('masar_office_settings')
    .select('agent_enabled').eq('office_id',officeId).maybeSingle());
   if(setting?.agent_enabled===false)throw bad('شغل Agent المكتب الأول',409);
   const existing=await loadPilotControl(db,officeId,{officeId:true});
   if(existing.active){
    if(existing.max!==count)throw bad('أوقف مراقبة المكتب أولًا علشان تبدأ عينة جديدة بحجم مختلف',409);
    return res.json({ok:true,already_active:true,office_id:officeId,capacity:existing.max});
   }
   must(await db.from('masar_events').insert({
    kind:'agent_pilot_started',staff_id:req.user.id,
    detail:{office_id:officeId,whatsapp_account_id:linked[0].id,
     capacity:count,mode:'new_inbound_observation',unsolicited_messages:false}
   }));
   res.json({ok:true,active:true,office_id:officeId,capacity:count});
  });
 });
 adminRoute('post','/agent/pilot/stop',async(req,res)=>{
  await serial(async()=>{
   const officeId=String(req.body?.office_id||'').trim();
   if(!uuid(officeId))throw bad('حدد المكتب قبل الإيقاف');
   const office=must(await db.from('masar_offices').select('id').eq('id',officeId).maybeSingle());
   if(!office)throw bad('المكتب غير موجود',404);
   const existing=await loadPilotControl(db,officeId,{officeId:true});
   if(!existing.active)return res.json({ok:true,already_stopped:true,office_id:officeId});
   must(await db.from('masar_events').insert({
    kind:'agent_pilot_stopped',staff_id:req.user.id,
    detail:{office_id:officeId,run_id:existing.run_id,capacity:existing.max,
     started_at:existing.started_at,mode:'new_inbound_observation',
     office_agent_unchanged:true}
   }));
   res.json({ok:true,active:false,office_id:officeId,
    note:'اتوقفت متابعة المكتب المحدد فقط؛ Agent المكتب وباقي المكاتب زي ما هم.'});
  });
 });
 // Admin-only, aggregate-only AI Quality Center. Never return candidate
 // messages, phone numbers, applicant IDs or raw decision traces here.
 adminRoute('get','/agent/quality/metrics',async(req,res)=>{
  const days=Number(req.query.days||7);
  if(!Number.isInteger(days)||days<1||days>30)throw bad('اختار مدة من يوم إلى 30 يوم');
  const since=new Date(Date.now()-days*86400000).toISOString();
  const maxEvents=5000,maxDecisions=5000,maxRuns=2000;
  const [ev,dc,er,suites]=await Promise.all([
   db.from('masar_events').select('kind,detail,created_at,applicant_id')
    .gte('created_at',since).eq('kind','agent_turn').order('created_at',{ascending:false}).limit(maxEvents),
   db.from('masar_agent_decisions').select('planner_mode,fallback_used,created_at')
    .gte('created_at',since).order('created_at',{ascending:false}).limit(maxDecisions),
   db.from('masar_agent_eval_runs').select('passed,created_at')
    .gte('created_at',since).order('created_at',{ascending:false}).limit(maxRuns),
   db.from('masar_events').select('detail,created_at').eq('kind','agent_quality_suite')
    .order('created_at',{ascending:false}).limit(12)
  ]);
  const safe=result=>{
   if(!result.error)return result.data||[];
   if(schemaMissing(result.error)||['42703','PGRST204'].includes(result.error.code))return [];
   throw result.error;
  };
  const events=safe(ev),decisions=safe(dc),runs=safe(er),history=safe(suites);
  const metrics=qualityMetrics({events,decisions,runs,days,
   truncated:events.length>=maxEvents||decisions.length>=maxDecisions||runs.length>=maxRuns});
  const conversation=conversationIntelligenceMetrics(events,{days});
  res.json({...metrics,conversation,builtin:{
   last_runs:history.map(x=>({
    created_at:x.created_at,passed:Number(x.detail?.passed||0),
    failed:Number(x.detail?.failed||0),total:Number(x.detail?.total||0),
    pass_rate:x.detail?.pass_rate??null
   }))
  }});
 });
 // No LLM calls and no production applicant state changes: every scenario
 // uses a tiny, completely synthetic office and applicant in memory.
 adminRoute('post','/agent/quality/suite/run',async(req,res)=>{
  const result=await runBuiltInQualitySuite();
  try{
   const row=await db.from('masar_events').insert({
    kind:'agent_quality_suite',staff_id:req.user.id,
    detail:{version:result.version,total:result.total,passed:result.passed,
     failed:result.failed,pass_rate:result.pass_rate,duration_ms:result.duration_ms}
   });
   if(row.error&&!schemaMissing(row.error))throw row.error;
  }catch(e){
   if(!schemaMissing(e))throw e;
  }
  res.json(result);
 });
 adminRoute('get','/agent',async(_req,res)=>res.json(await agentState()));
 adminRoute('put','/agent/settings',async(req,res)=>{
  const b=req.body||{};
  const mode=String(b.agent_llm_mode||'shadow'),provider=String(b.agent_llm_provider||'openai_compatible').trim(),model=String(b.agent_llm_model||'').trim();
  const temperature=Number(b.agent_llm_temperature),timeout=Number(b.agent_llm_timeout_ms),tokens=Number(b.agent_llm_max_tokens);
  const plannerThreshold=Number(b.agent_planner_confidence_threshold),contextMessages=Number(b.agent_context_messages);
  const tone=String(b.agent_tone||'egyptian_natural').trim(),instructions=String(b.agent_system_instructions||'').trim();
  const memoryThreshold=Number(b.ai_confidence_threshold),fallback=String(b.ai_fallback||'').trim();
  if(!['shadow','assist','live'].includes(mode)||!provider||provider.length>100||model.length>200
    ||!Number.isFinite(temperature)||temperature<0||temperature>1
    ||!Number.isInteger(timeout)||timeout<1000||timeout>30000
    ||!Number.isInteger(tokens)||tokens<200||tokens>3000
    ||!Number.isFinite(plannerThreshold)||plannerThreshold<.5||plannerThreshold>.95
    ||!Number.isInteger(contextMessages)||contextMessages<4||contextMessages>30
    ||!Number.isFinite(memoryThreshold)||memoryThreshold<.35||memoryThreshold>.95
    ||!fallback||fallback.length>1500
    ||tone.length<2||tone.length>100||instructions.length>5000)throw bad('راجع إعدادات AI Agent');
  if(b.agent_llm_enabled===true&&!agentRuntime?.snapshot?.({...b,agent_llm_model:model})?.configured)throw bad('لا يمكن تشغيل عقل LLM قبل إضافة AGENT_LLM_API_URL و AGENT_LLM_API_KEY واسم الموديل في Railway.',409);
  must(await db.from('masar_settings').update({
   agent_llm_enabled:b.agent_llm_enabled===true,agent_llm_mode:mode,agent_llm_provider:provider,agent_llm_model:model,
   agent_llm_temperature:temperature,agent_llm_timeout_ms:timeout,agent_llm_max_tokens:tokens,
   agent_planner_confidence_threshold:plannerThreshold,
   agent_hybrid_memory_enabled:b.agent_hybrid_memory_enabled!==false,
   agent_llm_rerank_enabled:b.agent_llm_rerank_enabled!==false,
   agent_fact_extraction_enabled:b.agent_fact_extraction_enabled!==false,
   agent_next_best_action_enabled:b.agent_next_best_action_enabled!==false,
   agent_context_messages:contextMessages,agent_tone:tone,agent_system_instructions:instructions,
   ai_knowledge_enabled:b.ai_knowledge_enabled!==false,
   ai_confidence_threshold:memoryThreshold,
   ai_fallback:fallback,
   ai_learning_enabled:true,
   ai_run_mode:'live',
   ai_training_started_at:null,
   ai_training_until:null
  }).eq('id',true));
  res.json({ok:true,llm:agentRuntime?.snapshot?.({...b,agent_llm_model:model})||{configured:false}});
 });
 adminRoute('post','/agent/test-plan',async(req,res)=>{
  const text=String(req.body?.text||'').trim();if(text.length<2||text.length>4000)throw bad('اكتب رسالة اختبار صحيحة');
  const state=await intelligenceState();
  const officeId=uuid(req.body?.office_id)?req.body.office_id:null;
  let questions=[],areas=[];
  if(officeId){
   const cfg=await config(db,officeId);questions=cfg.questions;areas=cfg.areas;
  }else{
   const first=must(await db.from('masar_offices').select('id').order('created_at',{ascending:true}).limit(1).maybeSingle());
   if(first){const cfg=await config(db,first.id);questions=cfg.questions;areas=cfg.areas;}
  }
  const knowledge=officeId?await loadKnowledge(db,officeId):(state.knowledge||[]).filter(x=>x.active);
  const testSettings={...state.settings,agent_llm_enabled:true};
  const runtime=agentRuntime?.snapshot?.(testSettings);
  if(!runtime?.configured)throw bad('LLM Provider غير متصل حاليًا. أضف إعدادات المزود في Railway أولاً.',409);
  const result=await agentRuntime.testPlan({
   applicant:{awaiting_id:null,answers:{}},message:{body:text},questions,areas,settings:testSettings,knowledge,recentMessages:[{direction:'in',sender:'applicant',body:text}]
  });
  res.json(result);
 });
 adminRoute('post','/agent/quality/cases',async(req,res)=>{
  const title=String(req.body?.title||'').trim(),input=String(req.body?.input_text||'').trim();
  if(title.length<2||title.length>200||input.length<2||input.length>4000)throw bad('راجع اسم ورسالة حالة الاختبار');
  if(/(?:\+?20|01[0125])[\d\s-]{8,}|\b\d{12,16}\b|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(input))
   throw bad('استخدم رسالة اختبار افتراضية من غير أرقام تليفون أو بطاقة أو بريد إلكتروني حقيقي.');
  const expectedAction=String(req.body?.expected?.action||'');
  const allowedExpected=['','answer_question','save_facts','ask_next','clarify','recommend_area','compare_areas','change_answer','resume_flow','handoff','none'];
  if(!allowedExpected.includes(expectedAction))throw bad('القرار المتوقع غير مدعوم');
  const tags=Array.isArray(req.body?.tags)?req.body.tags.map(x=>String(x||'').trim().slice(0,40)).filter(Boolean).slice(0,12):[];
  const row=must(await db.from('masar_agent_eval_cases').insert({title,input_text:input,
    expected:expectedAction?{action:expectedAction}:{},tags,created_by:req.user.id}).select().single());
  res.status(201).json(row);
 });
 adminRoute('delete','/agent/quality/cases/:id',async(req,res)=>{
  if(!uuid(req.params.id))throw bad('معرف حالة الاختبار غير صحيح');
  must(await db.from('masar_agent_eval_cases').delete().eq('id',req.params.id));res.json({ok:true});
 });
 adminRoute('post','/agent/quality/cases/:id/run',async(req,res)=>{
  if(!uuid(req.params.id))throw bad('معرف حالة الاختبار غير صحيح');
  const testCase=must(await db.from('masar_agent_eval_cases').select('*').eq('id',req.params.id).single());
  const state=await intelligenceState(),testSettings={...state.settings,agent_llm_enabled:true};
  if(!agentRuntime?.snapshot?.(testSettings)?.configured)throw bad('LLM Provider غير متصل حاليًا.',409);
  const knowledge=(state.knowledge||[]).filter(x=>x.active);
  const result=await agentRuntime.testPlan({applicant:{awaiting_id:null,answers:{}},message:{body:testCase.input_text},questions:[],areas:[],settings:testSettings,knowledge,recentMessages:[]});
  const expected=testCase.expected||{},plan=result.plan||{};
  let passed=null;
  if(expected.action)passed=String(plan.action)===String(expected.action);
  const run=must(await db.from('masar_agent_eval_runs').insert({
   case_id:testCase.id,result,passed,provider:result.provider||null,model:result.model||null,latency_ms:result.latency_ms||null
  }).select().single());
  res.json(run);
 });

 adminRoute('get','/intelligence',async(_req,res)=>res.json(await intelligenceState()));
 adminRoute('put','/intelligence/settings',async(req,res)=>{
  const b=req.body,threshold=Number(b.ai_confidence_threshold),fallback=String(b.ai_fallback||'').trim();
  if(typeof b.ai_knowledge_enabled!=='boolean'||!Number.isFinite(threshold)||threshold<.35||threshold>.95||!fallback||fallback.length>1500)throw bad('راجع إعدادات ذكاء البوت');
  try{must(await db.from('masar_settings').update({ai_knowledge_enabled:b.ai_knowledge_enabled,ai_learning_enabled:true,ai_run_mode:'live',ai_training_started_at:null,ai_training_until:null,ai_confidence_threshold:threshold,ai_fallback:fallback}).eq('id',true));}
  catch(e){if(schemaMissing(e))throw bad('فعّل ذكاء البوت أولاً بتشغيل ملف supabase/004_bot_intelligence.sql في Supabase SQL Editor.',503);throw e;}
  res.json({ok:true});
 });
 adminRoute('post','/intelligence/knowledge',async(req,res)=>{await serial(async()=>{
  const question=String(req.body.question||'').trim(),answer=String(req.body.answer||'').trim();
  if(question.length<2||question.length>2000||answer.length<2||answer.length>4000)throw bad('راجع السؤال والإجابة');
  const keywords=cleanKeywords(req.body.keywords?.length?req.body.keywords:suggestKeywords(question));
  try{
   const knowledge=must(await db.from('masar_knowledge').insert({
    question,answer,keywords,examples:[question],active:req.body.active!==false,
    source:'manual',office_id:null,knowledge_scope:'breadfast',confidence:1,
    last_verified_at:new Date().toISOString(),created_by:req.user.id
   }).select().single());
   await recordKnowledgeEvidence(db,{knowledgeId:knowledge.id,officeId:knowledge.office_id||null,candidate:{question,answer,context:'إضافة يدوية من مسؤول النظام'},kind:'manual',confidence:1});
   res.status(201).json(knowledge);
  }catch(e){if(schemaMissing(e))throw bad('فعّل ذكاء البوت أولاً بتشغيل ملف supabase/004_bot_intelligence.sql في Supabase SQL Editor.',503);throw e;}
 });});
 adminRoute('put','/intelligence/knowledge/:id',async(req,res)=>{await serial(async()=>{
  if(!uuid(req.params.id))throw bad('معرف المعرفة غير صحيح');
  const question=String(req.body.question||'').trim(),answer=String(req.body.answer||'').trim();
  if(question.length<2||question.length>2000||answer.length<2||answer.length>4000)throw bad('راجع السؤال والإجابة');
  const current=must(await db.from('masar_knowledge').select('*').eq('id',req.params.id).single());
  await snapshotKnowledgeVersion(db,current,{staffId:req.user.id,reason:'manual_edit'});
  const patch={
   question,answer,keywords:cleanKeywords(req.body.keywords?.length?req.body.keywords:suggestKeywords(question)),
   examples:[...new Set([...(Array.isArray(current.examples)?current.examples:[]),current.question,question].map(x=>String(x||'').trim()).filter(Boolean))].slice(0,30),
   active:req.body.active!==false,updated_at:new Date().toISOString()
  };
  if(Object.prototype.hasOwnProperty.call(current,'memory_status')){
   patch.memory_status='verified';patch.last_verified_at=new Date().toISOString();patch.confidence=1;
   patch.version=Number(current.version||1)+1;
  }
  const knowledge=must(await db.from('masar_knowledge').update(patch).eq('id',req.params.id).select().single());
  await recordKnowledgeEvidence(db,{knowledgeId:knowledge.id,officeId:knowledge.office_id||null,candidate:{question,answer,context:'تعديل يدوي من مسؤول النظام'},kind:'manual',confidence:1});
  res.json(knowledge);
 });});
 adminRoute('delete','/intelligence/knowledge/:id',async(req,res)=>{if(!uuid(req.params.id))throw bad('معرف المعرفة غير صحيح');must(await db.from('masar_knowledge').delete().eq('id',req.params.id));res.json({ok:true});});
 adminRoute('get','/intelligence/knowledge/:id/history',async(req,res)=>{
  if(!uuid(req.params.id))throw bad('معرف المعرفة غير صحيح');
  try{
   const rows=must(await db.from('masar_knowledge_versions').select('*').eq('knowledge_id',req.params.id).order('version',{ascending:false}).limit(100));
   res.json(rows);
  }catch(e){if(schemaMissing(e)||['42703','PGRST204'].includes(e?.code||''))throw bad('فعّل سجل ذاكرة الـAgent بتشغيل supabase/018_agent_memory_reliability.sql.',503);throw e;}
 });
 adminRoute('post','/intelligence/knowledge/:id/rollback',async(req,res)=>{await serial(async()=>{
  if(!uuid(req.params.id))throw bad('معرف المعرفة غير صحيح');
  const version=Number(req.body.version);if(!Number.isInteger(version)||version<1)throw bad('اختر نسخة صحيحة للرجوع إليها');
  let current,target;
  try{
   current=must(await db.from('masar_knowledge').select('*').eq('id',req.params.id).single());
   target=must(await db.from('masar_knowledge_versions').select('*').eq('knowledge_id',req.params.id).eq('version',version).single());
  }catch(e){if(schemaMissing(e)||['42703','PGRST204'].includes(e?.code||''))throw bad('فعّل سجل ذاكرة الـAgent بتشغيل supabase/018_agent_memory_reliability.sql.',503);throw e;}
  await snapshotKnowledgeVersion(db,current,{staffId:req.user.id,reason:'before_rollback'});
  const now=new Date().toISOString();
  const patch={
   question:target.question,answer:target.answer,keywords:target.keywords||[],active:target.active!==false,
   memory_status:'verified',confidence:1,last_verified_at:now,
   evidence_count:Number(target.evidence_count||1),conflict_count:Number(target.conflict_count||0),
   version:Number(current.version||1)+1,updated_at:now
  };
  const restored=must(await db.from('masar_knowledge').update(patch).eq('id',req.params.id).select().single());
  await recordKnowledgeEvidence(db,{knowledgeId:restored.id,officeId:restored.office_id||null,candidate:{question:restored.question,answer:restored.answer,context:'Rollback إلى النسخة '+version},kind:'rollback',confidence:1});
  must(await db.from('masar_events').insert({kind:'ai_memory_rollback',staff_id:req.user.id,detail:{knowledge_id:restored.id,from_version:current.version,to_snapshot_version:version,new_version:restored.version}}));
  res.json(restored);
 });});

 adminRoute('post','/intelligence/suggestions/:id/approve',async(req,res)=>{await serial(async()=>{
  if(!uuid(req.params.id))throw bad('معرف الاقتراح غير صحيح');
  const suggestion=must(await db.from('masar_learning_suggestions').select('*').eq('id',req.params.id).single());
  if(suggestion.status!=='pending')throw bad('تمت مراجعة الاقتراح بالفعل');
  const question=String(req.body.question||suggestion.question||'').trim(),answer=String(req.body.answer||suggestion.answer||'').trim();
  if(question.length<2||question.length>2000||answer.length<2||answer.length>4000)throw bad('راجع السؤال والإجابة');
  if(!safeLearningProposal(question,answer))
   throw bad('راجع الاقتراح واحذف أرقام الهواتف والبطاقات والبريد الإلكتروني قبل اعتماد المعرفة.');
  const knowledge=must(await db.from('masar_knowledge').insert({
   question,answer,keywords:cleanKeywords(req.body.keywords?.length?req.body.keywords:suggestKeywords(question)),
   examples:[question],active:true,source:'staff',office_id:suggestion.office_id||null,
   knowledge_scope:suggestion.office_id?'office':'legacy',
   source_suggestion_id:suggestion.id,created_by:req.user.id
  }).select().single());
  must(await db.from('masar_learning_suggestions').update({status:'approved',reviewed_by:req.user.id,reviewed_at:new Date().toISOString()}).eq('id',suggestion.id));
  res.json(knowledge);
 });});
 adminRoute('post','/intelligence/suggestions/:id/reject',async(req,res)=>{if(!uuid(req.params.id))throw bad('معرف الاقتراح غير صحيح');const row=must(await db.from('masar_learning_suggestions').select('status').eq('id',req.params.id).single());if(row.status!=='pending')throw bad('تمت مراجعة الاقتراح بالفعل');must(await db.from('masar_learning_suggestions').update({status:'rejected',reviewed_by:req.user.id,reviewed_at:new Date().toISOString()}).eq('id',req.params.id));res.json({ok:true});});
 adminRoute('post','/intelligence/test',async(req,res)=>{
  const text=String(req.body.text||'').trim();if(text.length<2||text.length>2000)throw bad('اكتب سؤال للاختبار');
  const state=await intelligenceState();if(!state.configured)throw bad('فعّل ذكاء البوت أولاً بتشغيل ملف supabase/004_bot_intelligence.sql في Supabase SQL Editor.',503);
  const match=findKnowledgeAnswer(text,state.knowledge.filter(x=>x.active),state.settings.ai_confidence_threshold);
  res.json(match?{matched:true,id:match.id,question:match.question,answer:match.answer,confidence:Math.round(match.confidence*1000)/1000}:{matched:false,answer:state.settings.ai_fallback,confidence:null});
 });
 async function suppressQueuedBotReplies(){
  const result=await db.from('masar_messages').update({status:'processed',error:'تم إلغاء الرد الآلي بسبب إيقاف البوت أو وضع التعلّم.'}).eq('direction','out').eq('sender','bot').eq('status','queued');
  if(result.error)throw result.error;
 }
 adminRoute('post','/intelligence/training/start',async(_req,res)=>res.status(410).json({error:'وضع تعلّم 3 أيام اتلغى؛ Agent بيتعلم تلقائيًا 24/7.'}));
 adminRoute('post','/intelligence/training/stop',async(_req,res)=>res.status(410).json({error:'التعلّم أصبح مستمرًا 24/7.'}));
 adminRoute('post','/intelligence/live',async(_req,res)=>res.status(410).json({error:'تشغيل Agent أصبح مستقل لكل مكتب من إعدادات المكتب.'}));
 adminRoute('post','/intelligence/pause',async(_req,res)=>res.status(410).json({error:'إيقاف Agent أصبح مستقل لكل مكتب من إعدادات المكتب.'}));
 for(const type of ['areas','questions']){
  // Area metadata edits are database writes, independent of long WhatsApp LLM
  // processing. Only applicant-sensitive operations need the worker serial.
  const editAreaWithoutWorkerQueue=task=>task();
  permissionRoute(type,'post','/'+type,async(req,res)=>{await (type==='areas'?editAreaWithoutWorkerQueue:serial)(async()=>{
   const b=req.body,officeId=await scopedOfficeId(req);let row;
   if(type==='areas'){
    if(typeof b.name!=='string'||!b.name.trim()||b.name.length>100||typeof b.details!=='string'||b.details.length>4000)throw bad('راجع اسم المنطقة وتفاصيلها');
    const zone=String(b.zone||'UNKNOWN').toUpperCase();if(!RECRUITMENT_ZONES.includes(zone))throw bad('Zone غير صحيحة');
    const aliases=Array.isArray(b.aliases)?b.aliases:String(b.aliases||'').split(/[,،\n]/);
    const cleanAliases=[...new Set(aliases.map(x=>String(x||'').trim()).filter(Boolean).slice(0,30).map(x=>x.slice(0,100)))];
    const active=b.active!==false;
    row={name:b.name.trim(),details:b.details,active,position:Number.isInteger(b.position)?b.position:0,office_id:officeId,zone,recruitment_eligible:active,aliases:cleanAliases};
   }else{
    if(typeof b.label!=='string'||!b.label.trim()||b.label.length>1000||!['name','text','number','yes_no','area','choice','image'].includes(b.kind)||!/^[a-z][a-z0-9_]{0,39}$/.test(b.field_key))throw bad('راجع المعلومة المطلوبة ونوعها ومفتاح حفظ البيانات');
    const instruction=String(b.agent_instruction||'').trim(),priority=Number(b.priority??50);
    if(instruction.length>1200||!Number.isInteger(priority)||priority<1||priority>100)throw bad('راجع تعليمات الـAgent وأولوية المعلومة');
    let options=[];
    if(b.kind==='choice'){
     const rawOptions=Array.isArray(b.options)?b.options:[];
     options=rawOptions.map(option=>{
      const label=String(typeof option==='string'?option:option?.label||'').trim();
      const value=String(typeof option==='string'?option:(option?.value??label)).trim();
      const aliases=Array.isArray(option?.aliases)?option.aliases.map(x=>String(x||'').trim()).filter(Boolean).slice(0,10):[];
      return {label:label.slice(0,80),value:value.slice(0,80),aliases:aliases.map(x=>x.slice(0,80))};
     }).filter(x=>x.label&&x.value);
     const keys=options.map(x=>norm(x.value));
     if(options.length<2||options.length>10||new Set(keys).size!==keys.length)throw bad('سؤال الاختيارات لازم يحتوي من 2 إلى 10 اختيارات مختلفة');
    }
    row={
     label:b.label.trim(),field_key:b.field_key,kind:b.kind,required:b.required!==false,active:b.active!==false,
     position:Number.isInteger(b.position)?b.position:0,office_id:officeId,
     agent_instruction:instruction,priority,allow_inference:b.allow_inference!==false,confirmation_required:b.confirmation_required===true,
     options
    };
   }
   if(b.id&&!uuid(b.id))throw bad('معرف غير صحيح');
   if(b.id){
    const current=must(await db.from('masar_'+type).select('id,office_id').eq('id',b.id).single());
    if(current.office_id!==officeId)throw bad('العنصر تابع لمكتب آخر',403);
   }
   const query=b.id?db.from('masar_'+type).update(row).eq('id',b.id):db.from('masar_'+type).insert(row);
   res.json(must(await query.select().single()));
  });});
 }
 permissionRoute('areas','delete','/areas/:id',async(req,res)=>{await serial(async()=>{
  if(!uuid(req.params.id))throw bad('معرف المنطقة غير صحيح');
  const officeId=await scopedOfficeId(req),area=must(await db.from('masar_areas').select('*').eq('id',req.params.id).maybeSingle());
  if(!area||area.office_id!==officeId)throw bad('المنطقة غير موجودة أو تابعة لمكتب آخر',404);
  let page=0,archivedAnswers=0;
  while(true){
   const applicants=must(await db.from('masar_applicants').select('id,answers').eq('office_id',officeId).order('id').range(page*500,page*500+499));
   for(const applicant of applicants){
    let changed=false;const answers={...(applicant.answers||{})};
    for(const [key,value] of Object.entries(answers)){
     if(value&&typeof value==='object'&&String(value.value||'')===area.id&&['area','area_preview'].includes(value.kind)){
      answers[key]={...value,archived_area:true,archived_area_id:area.id,archived_area_name:area.name,archived_area_zone:area.zone||'UNKNOWN',archived_area_recruitment_eligible:area.active!==false};
      changed=true;archivedAnswers++;
     }
    }
    if(changed)must(await db.from('masar_applicants').update({answers,updated_at:new Date().toISOString()}).eq('id',applicant.id));
   }
   if(applicants.length<500)break;page++;
  }
  must(await db.from('masar_areas').delete().eq('id',area.id));
  res.json({ok:true,archived_answers:archivedAnswers});
 });});
 permissionRoute('questions','post','/questions/reorder',async(req,res)=>{await serial(async()=>{
  const officeId=await scopedOfficeId(req),qs=must(await db.from('masar_questions').select('id').eq('office_id',officeId));
  const ids=req.body.ids;if(!Array.isArray(ids)||ids.length!==qs.length||new Set(ids).size!==ids.length||ids.some(id=>!qs.some(q=>q.id===id)))throw bad('تم تغيير قائمة الأسئلة؛ حدّث الصفحة');
  must(await db.rpc('masar_reorder_questions',{p_ids:ids}));res.json({ok:true});
 });});
 const attributionOf=a=>a?.answers?.__attribution&&typeof a.answers.__attribution==='object'?a.answers.__attribution:null;
 async function campaignCatalog(optional=false){
  try{
   const [campaigns,ads]=await Promise.all([
    db.from('masar_campaigns').select('*').order('created_at',{ascending:true}),
    db.from('masar_ads').select('*').order('last_seen_at',{ascending:false})
   ]);
   return {campaigns:must(campaigns),ads:must(ads),configured:true};
  }catch(e){
   if(['PGRST205','42P01','42703'].includes(e.code)){
    if(optional)return {campaigns:[],ads:[],configured:false};
    throw bad('فعّل جداول تتبع الحملات أولاً بتشغيل ملف supabase/002_campaign_attribution.sql في Supabase SQL Editor.',503);
   }
   throw e;
  }
 }
 async function discoverAds(){
  const catalog=await campaignCatalog(),byId=new Map(catalog.ads.map(a=>[a.ad_id,a]));
  const applicants=await allRows(db,'masar_applicants');
  for(const applicant of applicants){
   const ref=attributionOf(applicant),adId=String(ref?.source_id||'').trim();if(!adId)continue;
   const existing=byId.get(adId);
   if(!existing){
    const row={
     ad_id:adId,name:ref.title||'',headline:ref.title||'',source_url:ref.source_url||null,
     source_app:ref.source_app||null,source_type:ref.source_type||'ad',office_id:applicant.office_id||null,
     first_seen_at:ref.captured_at||applicant.created_at,last_seen_at:ref.captured_at||applicant.created_at
    };
    let result=await db.from('masar_ads').insert(row).select().single();
    if(result.error&&['42703','PGRST204'].includes(result.error.code||'')){delete row.office_id;result=await db.from('masar_ads').insert(row).select().single();}
    const inserted=must(result);byId.set(adId,inserted);catalog.ads.unshift(inserted);
   }else{
    const patch={last_seen_at:ref.captured_at||applicant.created_at,updated_at:new Date().toISOString()};
    if(!existing.office_id&&applicant.office_id)patch.office_id=applicant.office_id;
    if(!existing.headline&&ref.title)patch.headline=ref.title;
    if(!existing.source_url&&ref.source_url)patch.source_url=ref.source_url;
    if(!existing.source_app&&ref.source_app)patch.source_app=ref.source_app;
    if(Object.keys(patch).length>2){
     let result=await db.from('masar_ads').update(patch).eq('ad_id',adId);
     if(result.error&&patch.office_id&&['42703','PGRST204'].includes(result.error.code||'')){delete patch.office_id;result=await db.from('masar_ads').update(patch).eq('ad_id',adId);}
     must(result);Object.assign(existing,patch);
    }
   }
  }
  return catalog;
 }
 const summaryFor=rows=>{
  const stages=Object.fromEntries(Object.keys(STAGES).map(k=>[k,rows.filter(a=>a.stage===k).length]));
  const completed=rows.filter(a=>['complete','lecture','working'].includes(a.stage)).length;
  return {total:rows.length,completed,stages};
 };
 permissionRoute('campaigns','get','/meta/status',async(req,res)=>{
  const officeId=await scopedOfficeId(req,{body:false}),cfg=metaConfig();
  try{
   const connection=must(await db.from('masar_meta_connections').select('office_id,meta_user_id,meta_user_name,token_expires_at,selected_ad_account_id,selected_ad_account_name,currency,timezone_name,status,last_sync_at,last_sync_error,updated_at').eq('office_id',officeId).maybeSingle());
   const accounts=must(await db.from('masar_meta_ad_accounts').select('account_id,name,account_status,currency,timezone_name,business_name,updated_at').eq('office_id',officeId).order('name',{ascending:true}));
   res.json({configured:true,env_configured:cfg.configured,missing_env:cfg.missing,redirect_uri:cfg.redirectUri||null,required_permissions:['ads_read','business_management'],connected:Boolean(connection),connection,accounts});
  }catch(e){
   if(schemaMissing(e)||['42703','PGRST204'].includes(e?.code||''))return res.json({configured:false,env_configured:cfg.configured,missing_env:cfg.missing,redirect_uri:cfg.redirectUri||null,required_permissions:['ads_read','business_management'],connected:false,connection:null,accounts:[]});
   throw e;
  }
 });
 managerRoute('get','/meta/connect-url',async(req,res)=>{
  const officeId=await scopedOfficeId(req,{body:false}),cfg=metaConfig();
  if(!cfg.configured)throw bad('إعداد ربط Meta ناقص على Railway: '+cfg.missing.join('، '),503);
  const state=crypto.randomBytes(32).toString('base64url'),stateHash=metaStateHash(state),expiresAt=new Date(Date.now()+15*60*1000).toISOString();
  try{
   await db.from('masar_meta_oauth_states').delete().lt('expires_at',new Date().toISOString());
   must(await db.from('masar_meta_oauth_states').insert({state_hash:stateHash,office_id:officeId,user_id:req.user.id,expires_at:expiresAt}));
  }catch(e){if(schemaMissing(e)||['42703','PGRST204'].includes(e?.code||''))throw bad('شغّل ملف supabase/014_meta_ads_connection.sql أولاً',503);throw e;}
  res.json({url:metaLoginUrl({state,config:cfg}),expires_at:expiresAt});
 });
 managerRoute('put','/meta/account',async(req,res)=>{
  const officeId=await scopedOfficeId(req),accountId=normalizeMetaAdAccountId(req.body.account_id);
  if(!/^\d+$/.test(accountId))throw bad('اختر حسابًا إعلانيًا صحيحًا');
  const account=must(await db.from('masar_meta_ad_accounts').select('*').eq('office_id',officeId).eq('account_id',accountId).maybeSingle());
  if(!account)throw bad('الحساب الإعلاني غير موجود ضمن حساب Meta المتصل',404);
  const connection=must(await db.from('masar_meta_connections').select('office_id').eq('office_id',officeId).maybeSingle());
  if(!connection)throw bad('اربط حساب Meta أولاً',409);
  must(await db.from('masar_meta_connections').update({selected_ad_account_id:accountId,selected_ad_account_name:account.name||'',currency:account.currency||null,timezone_name:account.timezone_name||null,status:'connected',last_sync_error:null,updated_at:new Date().toISOString()}).eq('office_id',officeId));
  res.json(await metaSyncOffice(officeId));
 });
 managerRoute('post','/meta/sync',async(req,res)=>{
  const officeId=await scopedOfficeId(req);res.json(await metaSyncOffice(officeId));
 });
 managerRoute('delete','/meta/connection',async(req,res)=>{
  const officeId=await scopedOfficeId(req);
  try{
   must(await db.from('masar_meta_ad_accounts').delete().eq('office_id',officeId));
   must(await db.from('masar_meta_connections').delete().eq('office_id',officeId));
  }catch(e){if(schemaMissing(e)||['42703','PGRST204'].includes(e?.code||''))throw bad('شغّل ملف supabase/014_meta_ads_connection.sql أولاً',503);throw e;}
  res.json({ok:true});
 });
 permissionRoute('campaigns','get','/campaigns',async(req,res)=>{
  const {campaigns,ads}=await discoverAds(),applicants=(await applicantList(req)).rows,officeId=req.role==='admin'?String(req.query.office_id||''):String(req.officeId||'');
  const visibleIds=new Set(applicants.map(a=>String(attributionOf(a)?.source_id||'')).filter(Boolean)),scopeActive=req.role!=='admin'||Boolean(officeId);
  const scopedAds=scopeActive?ads.filter(ad=>ad.office_id===officeId||visibleIds.has(ad.ad_id)):ads;
  const scopedCampaignIds=new Set(scopedAds.map(ad=>ad.campaign_id).filter(Boolean));
  const scopedCampaigns=campaigns.filter(x=>(!scopeActive||x.office_id===officeId||scopedCampaignIds.has(x.id)));
  const stats=Object.fromEntries(scopedAds.map(ad=>{const subset=applicants.filter(a=>attributionOf(a)?.source_id===ad.ad_id);return [ad.ad_id,{...summaryFor(subset),...funnelFor(subset,Number(ad.spend||0))}];}));
  res.json({campaigns:scopedCampaigns,ads:scopedAds.map(ad=>({...ad,stats:stats[ad.ad_id]}))});
 });
 permissionRoute('campaigns','post','/campaigns',async(req,res)=>{await serial(async()=>{
  const b=req.body,name=String(b.name||'').trim(),meta=String(b.meta_campaign_id||'').trim()||null,officeId=await scopedOfficeId(req);
  if(name.length<2||name.length>150)throw bad('اكتب اسم الحملة');
  const row={name,meta_campaign_id:meta,active:b.active!==false,updated_at:new Date().toISOString(),office_id:officeId};
  if(b.id&&!uuid(b.id))throw bad('معرف الحملة غير صحيح');
  if(b.id){const current=must(await db.from('masar_campaigns').select('office_id').eq('id',b.id).single());if(current.office_id!==officeId)throw bad('الحملة تابعة لمكتب آخر',403);}
  const q=b.id?db.from('masar_campaigns').update(row).eq('id',b.id):db.from('masar_campaigns').insert(row);
  res.json(must(await q.select().single()));
 });});
 permissionRoute('campaigns','delete','/campaigns/:id',async(req,res)=>{await serial(async()=>{
  if(!uuid(req.params.id))throw bad('معرف الحملة غير صحيح');
  const current=must(await db.from('masar_campaigns').select('office_id').eq('id',req.params.id).single()),officeId=req.role==='admin'?current.office_id:req.officeId;
  if(req.role!=='admin'&&current.office_id!==officeId)throw bad('الحملة تابعة لمكتب آخر',403);
  if(req.role==='admin'&&req.query.office_id&&current.office_id!==String(req.query.office_id))throw bad('الحملة تابعة لمكتب آخر',403);
  must(await db.from('masar_ads').update({campaign_id:null,updated_at:new Date().toISOString()}).eq('campaign_id',req.params.id));
  must(await db.from('masar_campaigns').delete().eq('id',req.params.id));res.json({ok:true});
 });});
 permissionRoute('campaigns','put','/ads/:id',async(req,res)=>{await serial(async()=>{
  const adId=String(req.params.id||'').trim(),b=req.body;if(!/^\d{5,40}$/.test(adId))throw bad('Ad ID غير صحيح');
  const campaignId=b.campaign_id||null;if(campaignId&&!uuid(campaignId))throw bad('معرف الحملة غير صحيح');
  const applicants=(await applicantList(req)).rows,visibleIds=new Set(applicants.map(a=>String(attributionOf(a)?.source_id||'')).filter(Boolean));
  if(req.role!=='admin'&&!visibleIds.has(adId))throw bad('الإعلان تابع لمكتب آخر',403);
  if(campaignId){const campaign=must(await db.from('masar_campaigns').select('office_id').eq('id',campaignId).single()),officeId=req.role==='admin'?(String(req.query.office_id||b.office_id||campaign.office_id)):req.officeId;if(campaign.office_id!==officeId)throw bad('الحملة تابعة لمكتب آخر',403);}
  const spend=Number(b.spend);if(!Number.isFinite(spend)||spend<0||spend>1000000000)throw bad('راجع تكلفة الإعلان');
  const name=String(b.name||'').trim();if(name.length>200)throw bad('اسم الإعلان طويل');
  const zone=String(b.zone||'UNKNOWN').toUpperCase();if(!RECRUITMENT_ZONES.includes(zone))throw bad('Zone غير صحيحة');
  const patch={campaign_id:campaignId,name,zone,spend:Math.round(spend*100)/100,spend_source:'manual',spend_synced_at:null,updated_at:new Date().toISOString()};
  res.json(must(await db.from('masar_ads').update(patch).eq('ad_id',adId).select().single()));
 });});
 permissionRoute('reports','get','/reports/options',async(req,res)=>{
  try{
   const {campaigns,ads}=await discoverAds(),rows=(await applicantList(req)).rows;
   const ids=new Set(rows.map(a=>String(attributionOf(a)?.source_id||'')).filter(Boolean));
   const officeId=req.role==='admin'?String(req.query.office_id||''):String(req.officeId||''),scopeActive=req.role!=='admin'||Boolean(officeId);
   const scopedAds=scopeActive?ads.filter(x=>x.office_id===officeId||ids.has(x.ad_id)):ads;
   const campaignIds=new Set(scopedAds.map(x=>x.campaign_id).filter(Boolean));
   const scopedCampaigns=campaigns.filter(x=>!scopeActive||x.office_id===officeId||campaignIds.has(x.id));
   const accounts=(await accountRows(req)).map(({id,name,phone,status})=>({id,name,phone,status}));
   const officeData=await officeState(req);
   res.json({campaigns:scopedCampaigns,ads:scopedAds,accounts,offices:officeData.items,offices_configured:officeData.configured,configured:true,multi_whatsapp_configured:whatsapp.configured});
  }catch(e){if(e.status===503)return res.json({campaigns:[],ads:[],accounts:[],offices:[],offices_configured:false,configured:false,multi_whatsapp_configured:whatsapp.configured});throw e;}
 });

 async function ensureApplicantAccess(req,a){
  if(!whatsapp.configured||req.role==='admin')return;
  const allowed=await accessibleAccountIds(req);
  if(!allowed.includes(a.whatsapp_account_id))throw bad('المتقدم ده تابع لرقم واتساب غير مصرح لك به',403);
 }
 async function applicantById(req,id,select='*'){
  if(!uuid(id))throw bad('معرف المتقدم غير صحيح');
  const a=must(await db.from('masar_applicants').select(select).eq('id',id).single());
  await ensureApplicantAccess(req,a);return a;
 }
 async function applicantList(req){
  const alertIds=await openAlertApplicantIds(req),rawRows=await allRows(db,'masar_applicants'),cfgCache=new Map();
  const cfgFor=async officeId=>{const key=officeId||'__global__';if(!cfgCache.has(key))cfgCache.set(key,await config(db,officeId||null));return cfgCache.get(key);};
  let rows=[];
  for(const a of rawRows){const cfg=await cfgFor(a.office_id);rows.push({...a,recruitment_stage:recruitmentStageOf(a),stage:computedStage(a,cfg.questions,cfg.areas),completion:completion(cfg.questions,a.answers,cfg.areas),qualification:qualificationFor(a,cfg.questions,cfg.areas,cfg.settings),application_flow_status:a.answers?.__qualification_stop?'stopped_not_qualified':completion(cfg.questions,a.answers,cfg.areas).complete?'completed':'active',needs_intervention:alertIds.has(a.id)});}
  if(whatsapp.configured){
   const allowed=await accessibleAccountIds(req);
   if(allowed!==null)rows=rows.filter(a=>allowed.includes(a.whatsapp_account_id));
   if(req.query.whatsapp_account_id){
    const accountId=String(req.query.whatsapp_account_id);
    if(!uuid(accountId))throw bad('معرف رقم واتساب غير صحيح');
    if(allowed!==null&&!allowed.includes(accountId))throw bad('رقم واتساب ده مش ضمن صلاحيات حسابك',403);
    rows=rows.filter(a=>a.whatsapp_account_id===accountId);
   }
  }
  if(req.query.office_id){
   const officeId=String(req.query.office_id);await ensureOfficeAccess(req,officeId);
   rows=rows.filter(a=>a.office_id===officeId);
  }
  if(req.query.search){const s=String(req.query.search).toLowerCase();rows=rows.filter(a=>(a.phone||'').includes(s)||(a.display_name||'').toLowerCase().includes(s)||Object.values(a.answers||{}).some(v=>v?.kind==='name'&&String(v.value).toLowerCase().includes(s)));}
  if(req.query.stage)rows=rows.filter(a=>a.stage===req.query.stage);
  if(req.query.recruitment_stage){const rs=String(req.query.recruitment_stage);if(!RECRUITMENT_STAGE_SET.has(rs))throw bad('مرحلة التوظيف غير صحيحة');rows=rows.filter(a=>recruitmentStageOf(a)===rs);}
  if(req.query.qualification){const q=String(req.query.qualification);if(!['qualified','not_qualified','pending'].includes(q))throw bad('حالة التأهيل غير صحيحة');rows=rows.filter(a=>a.qualification?.overall_status===q);}
  if(req.query.motorcycle){const m=String(req.query.motorcycle);if(!['yes','no','unknown'].includes(m))throw bad('فلتر الموتوسيكل غير صحيح');rows=rows.filter(a=>m==='yes'?a.qualification?.motorcycle_qualified===true:m==='no'?a.qualification?.motorcycle_qualified===false:a.qualification?.motorcycle_qualified==null);}
  if(req.query.geo){const g=String(req.query.geo);if(!['qualified','outside','unknown'].includes(g))throw bad('فلتر المنطقة غير صحيح');rows=rows.filter(a=>a.qualification?.geo_status===g);}
  if(req.query.zone){const z=String(req.query.zone).toUpperCase();if(!RECRUITMENT_ZONES.includes(z))throw bad('Zone غير صحيحة');rows=rows.filter(a=>(a.qualification?.zone||'UNKNOWN')===z);}
  if(['1','true','yes'].includes(String(req.query.needs_intervention||'').toLowerCase()))rows=rows.filter(a=>a.needs_intervention);
  if(req.query.ad_id)rows=rows.filter(a=>String(attributionOf(a)?.source_id||'')===String(req.query.ad_id));
  if(req.query.campaign_id){
   if(!uuid(String(req.query.campaign_id)))throw bad('معرف الحملة غير صحيح');
   const {ads}=await campaignCatalog(),ids=new Set(ads.filter(ad=>ad.campaign_id===req.query.campaign_id).map(ad=>ad.ad_id));
   rows=rows.filter(a=>ids.has(String(attributionOf(a)?.source_id||'')));
  }
  if(req.query.from)rows=rows.filter(a=>a.created_at>=req.query.from);
  if(req.query.to)rows=rows.filter(a=>a.created_at<req.query.to);
  const configs=[...cfgCache.values()],areas=[...new Map(configs.flatMap(x=>x.areas||[]).map(x=>[x.id,x])).values()],questions=[...new Map(configs.flatMap(x=>x.questions||[]).map(x=>[x.id,x])).values()];
  return {rows:rows.sort((a,b)=>b.created_at.localeCompare(a.created_at)),areas,questions};
 }
 permissionRoute('applicants','get','/applicants',async(req,res)=>{const {rows}=await applicantList(req);const page=Math.max(1,parseInt(req.query.page)||1);res.json({items:rows.slice((page-1)*30,page*30),total:rows.length,page});});
 permissionRoute('applicants','post','/applicants',async(req,res)=>{await serial(async()=>{
  const officeId=String(req.body.office_id||'');const office=await ensureOfficeAccess(req,officeId);
  const name=String(req.body.name||'').trim(),phone=String(req.body.phone||'').trim()||null;
  if(name.length<2||name.length>120)throw bad('اكتب اسم المرشح');
  if(phone&&!/^\+[1-9][0-9]{7,14}$/.test(phone))throw bad('رقم الهاتف لازم يبدأ بكود الدولة، مثال +2010...');
  const officeAccounts=office.whatsapp_accounts||[];if(!officeAccounts.length)throw bad('اربط رقم واتساب بالمكتب قبل إضافة مرشح يدويًا');
  const primary=officeAccounts[0];
  if(phone){const existing=must(await db.from('masar_applicants').select('id').eq('whatsapp_account_id',primary.id).eq('phone',phone).maybeSingle());if(existing)throw bad('رقم الهاتف موجود بالفعل في نفس المكتب');}
  const row={contact_id:'manual:'+crypto.randomUUID(),phone,display_name:name,whatsapp_account_id:primary.id,office_id:office.id,recruitment_stage:'new',bot_enabled:false,last_message_at:new Date().toISOString()};
  const applicant=must(await db.from('masar_applicants').insert(row).select().single());
  must(await db.from('masar_contacts').insert({whatsapp_account_id:primary.id,contact_id:row.contact_id,applicant_id:applicant.id}));
  must(await db.from('masar_events').insert({applicant_id:applicant.id,kind:'manual_applicant_created',staff_id:req.user.id,detail:{office_id:office.id}}));
  res.status(201).json(applicant);
 });});
 permissionRoute('applicants','get','/applicants/:id',async(req,res)=>{
  const a=await applicantById(req,req.params.id),cfg=await config(db,a.office_id||null);
  const before=req.query.before;let query=db.from('masar_messages').select('*').eq('applicant_id',a.id).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(101);
  if(before){const [time,id]=String(before).split('|');if(!uuid(id)||!Number.isFinite(Date.parse(time)))throw bad('مؤشر غير صحيح');query=query.or(`created_at.lt.${time},and(created_at.eq.${time},id.lt.${id})`);}
  const all=must(await query),has_more=all.length>100,messages=all.slice(0,100),last=messages.at(-1);
  for(const m of messages){if(m.media_path){const signed=await db.storage.from('masar-documents').createSignedUrl(m.media_path,600);m.media_url=signed.data?.signedUrl||null;}}
  const events=must(await db.from('masar_events').select('*').eq('applicant_id',a.id).order('created_at',{ascending:false}).limit(50));
  const account=whatsapp.configured?whatsapp.snapshot(a.whatsapp_account_id):null;
  let office=null;try{if(a.office_id)office=must(await db.from('masar_offices').select('id,name,code,address,phone,manager_name').eq('id',a.office_id).maybeSingle());}catch(e){if(!schemaMissing(e)&&e.code!=='42703')throw e;}
  const qualification=qualificationFor(a,cfg.questions,cfg.areas,cfg.settings);
  res.json({applicant:{...a,recruitment_stage:recruitmentStageOf(a),stage:computedStage(a,cfg.questions,cfg.areas),completion:completion(cfg.questions,a.answers,cfg.areas),application_flow_status:a.answers?.__qualification_stop?'stopped_not_qualified':completion(cfg.questions,a.answers,cfg.areas).complete?'completed':'active',qualification:{...qualification,reason_labels:qualificationReasonLabels(qualification.reasons)},office,whatsapp_account:account?{id:account.id,name:account.name,phone:account.phone}:null},messages:messages.reverse(),events,has_more,next_cursor:last?last.created_at+'|'+last.id:null});
 });
 permissionRoute('applicants','patch','/applicants/:id',async(req,res)=>{
  let resumedMessageId=null;
  await serial(async()=>{
   const a=await applicantById(req,req.params.id),b=req.body,patch={updated_at:new Date().toISOString()};
   if(b.notes!==undefined){if(typeof b.notes!=='string'||b.notes.length>4000)throw bad('الملاحظات لا تتجاوز 4000 حرف');patch.notes=b.notes;}
   if(b.recruitment_stage!==undefined){
    const rs=String(b.recruitment_stage);if(!RECRUITMENT_STAGE_SET.has(rs))throw bad('مرحلة التوظيف غير صحيحة');
    patch.recruitment_stage=rs;
   }
   if(b.bot_enabled!==undefined){
    if(typeof b.bot_enabled!=='boolean')throw bad('قيمة غير صحيحة');
    patch.bot_enabled=b.bot_enabled;
    if(b.bot_enabled){
     const officeCfg=await config(db,a.office_id||null);
     if(officeCfg.settings?.agent_enabled===false)throw bad('Agent المكتب متوقف حاليًا. مدير المكتب يقدر يشغّله من إعدادات المكتب.',409);
     const answers={...(a.answers||{})};
     if(answers.__history_review?.status==='pending'){
      if(b.history_review_approved!==true)throw bad('راجع محادثة الرقم القديمة أولاً، ثم أكد المراجعة صراحةً قبل تشغيل البوت.',409);
      answers.__history_review={...answers.__history_review,status:'approved',approved_at:new Date().toISOString(),
       reviewed_by:req.user.id};
     }
     delete answers.__ai_handoff;delete answers.__bot_paused_by_staff;patch.answers=answers;
     const lastOut=must(await db.from('masar_messages').select('sequence').eq('applicant_id',a.id).eq('direction','out').order('sequence',{ascending:false}).limit(1).maybeSingle());
     let q=db.from('masar_messages').select('id,sequence,status,media_error').eq('applicant_id',a.id).eq('direction','in').eq('status','processed').order('sequence',{ascending:false}).limit(1);
     if(lastOut?.sequence)q=q.gt('sequence',lastOut.sequence);
     const missed=must(await q.maybeSingle());
     if(missed&&!String(missed.media_error||'').includes('غير موثوق')){
      must(await db.from('masar_messages').update({status:'pending',attempts:0,error:null}).eq('id',missed.id));
      resumedMessageId=missed.id;
     }
    }
    else {
     // Explicit staff intervention must never be silently undone just because
     // this contact originally arrived from a real WhatsApp ad.
     patch.answers={...(a.answers||{}),__bot_paused_by_staff:true};
    }
   }
   if(b.stage!==undefined){
    if(!['lecture','working','auto'].includes(b.stage))throw bad('حالة غير صحيحة');
    const cfg=await config(db,a.office_id||null);if(b.stage!=='auto'&&!completion(cfg.questions,a.answers,cfg.areas).complete)throw bad('أكمل البيانات المطلوبة قبل تأكيد الحضور أو بدء العمل');
    patch.stage=b.stage==='auto'?computedStage({...a,stage:'new'},cfg.questions,cfg.areas):b.stage;
    patch.lecture_at=b.stage==='auto'?null:(a.lecture_at||new Date().toISOString());
    patch.working_at=b.stage==='working'?new Date().toISOString():null;
    if(['lecture','working'].includes(b.stage)&&b.bot_enabled===undefined)patch.bot_enabled=false;
   }
   if(patch.bot_enabled===false){
    must(await db.from('masar_messages').update({status:'processed',error:'تم إلغاء الرد الآلي بسبب تدخل مسؤول التوظيف.'}).eq('applicant_id',a.id).eq('direction','out').eq('sender','bot').eq('status','queued'));
   }
   must(await db.from('masar_applicants').update(patch).eq('id',a.id));
   must(await db.from('masar_events').insert({applicant_id:a.id,kind:'staff_update',staff_id:req.user.id,detail:{stage:patch.stage,recruitment_stage:patch.recruitment_stage,bot_enabled:patch.bot_enabled,notes_changed:b.notes!==undefined,resumed_message_id:resumedMessageId}}));
   if(b.bot_enabled===true||['lecture','working'].includes(b.stage))await resolveApplicantAlerts(a.id,{userId:req.user.id,resolution:b.bot_enabled===true?'bot_resumed':'stage_handled'});
  });
  if(resumedMessageId)worker.tick();
  res.json({ok:true,resumed_message_id:resumedMessageId});
 });
 permissionRoute('applicants','post','/applicants/:id/reply',async(req,res)=>{
  const body=String(req.body.body||'').trim();if(!body||body.length>4000)throw bad('اكتب رسالة لا تتجاوز 4000 حرف');
  await serial(async()=>{
   const select=whatsapp.configured?'id,contact_id,whatsapp_account_id,answers,office_id':'id,contact_id,answers,office_id';
   const a=await applicantById(req,req.params.id,select);if(a.contact_id.startsWith('legacy:'))throw bad('لا يمكن الإرسال قبل وصول رسالة جديدة تكشف جهة اتصال واتساب');
   let settings=null;try{settings=must(await db.from('masar_settings').select('*').eq('id',true).single());}catch(e){if(!schemaMissing(e))throw e;}
   const officeCfg=await config(db,a.office_id||null),answers={...(a.answers||{})};delete answers.__ai_handoff;
   const applicantPatch={answers,updated_at:new Date().toISOString()};
   if(officeCfg.settings?.agent_enabled!==false){
    applicantPatch.bot_enabled=false;
    must(await db.from('masar_messages').update({status:'processed',error:'تم إلغاء الرد الآلي بسبب رد بشري.'}).eq('applicant_id',a.id).eq('direction','out').eq('sender','bot').eq('status','queued'));
   }
   must(await db.from('masar_applicants').update(applicantPatch).eq('id',a.id));
   const row={applicant_id:a.id,direction:'out',sender:'staff',body,status:'queued'};if(whatsapp.configured)row.whatsapp_account_id=a.whatsapp_account_id;
   const staffMessage=must(await db.from('masar_messages').insert(row).select('id').single());
   if(settings?.ai_learning_enabled!==false){
    try{
     await learnFromConversation(db,{applicantId:a.id,officeId:a.office_id||null,staffMessageId:staffMessage.id,staffId:req.user.id,force:true});
    }catch(e){if(!schemaMissing(e))throw e;}
   }
   await resolveApplicantAlerts(a.id,{userId:req.user.id,resolution:'crm_reply'});
  });res.json({ok:true});
 });
 permissionRoute('applicants','post','/messages/:id/retry',async(req,res)=>{await serial(async()=>{
  const m=must(await db.from('masar_messages').select('*').eq('id',req.params.id).single()),a=await applicantById(req,m.applicant_id,whatsapp.configured?'id,whatsapp_account_id':'id');
  if(!['failed','uncertain'].includes(m.status))throw bad('هذه الرسالة لا تحتاج إعادة محاولة');if(m.status==='uncertain'&&req.body.confirm!==true)throw bad('راجع واتساب ثم أكد إعادة الإرسال');
  must(await db.from('masar_messages').update({status:m.direction==='in'?'pending':'queued',attempts:0,error:null}).eq('id',m.id));
 });res.json({ok:true});});
 adminRoute('delete','/applicants/:id',async(req,res)=>{
  if(!uuid(req.params.id))throw bad('معرف المتقدم غير صحيح');
  let mediaPaths=[];
  await serial(async()=>{
   const select=whatsapp.configured?'id,contact_id,phone,whatsapp_account_id':'id,contact_id,phone';
   const a=must(await db.from('masar_applicants').select(select).eq('id',req.params.id).single());
   if(whatsapp.configured){
    try{
     must(await db.from('masar_applicant_resets').upsert({
      whatsapp_account_id:a.whatsapp_account_id,contact_id:a.contact_id,phone:a.phone||null,reset_at:new Date().toISOString()
     },{onConflict:'whatsapp_account_id,contact_id'}));
    }catch(e){
     if(schemaMissing(e))throw bad('فعّل إعادة ضبط المتقدمين أولاً بتشغيل ملف supabase/008_clean_applicant_reset.sql في Supabase SQL Editor.',503);
     throw e;
    }
   }
   const messages=must(await db.from('masar_messages').select('media_path').eq('applicant_id',a.id));
   mediaPaths=[...new Set(messages.map(x=>x.media_path).filter(Boolean))];
   try{must(await db.from('masar_learning_suggestions').delete().eq('applicant_id',a.id));}catch(e){if(!schemaMissing(e))throw e;}
   must(await db.from('masar_events').delete().eq('applicant_id',a.id));
   must(await db.from('masar_contacts').delete().eq('applicant_id',a.id));
   must(await db.from('masar_messages').update({reply_to:null}).eq('applicant_id',a.id));
   must(await db.from('masar_messages').delete().eq('applicant_id',a.id));
   must(await db.from('masar_applicants').delete().eq('id',a.id));
  });
  let media_cleanup_ok=true;
  for(let i=0;i<mediaPaths.length;i+=100){
   try{const result=await db.storage.from('masar-documents').remove(mediaPaths.slice(i,i+100));if(result.error)throw result.error;}
   catch(e){media_cleanup_ok=false;console.warn('Applicant media cleanup failed:',e.code||e.name);}
  }
  res.json({ok:true,media_cleanup_ok,clean_reset:true});
 });
 permissionRoute('reports','get','/dashboard',async(req,res)=>{
  const officeData=await officeState(req);
  if(req.query.office_id){if(!officeData.configured)throw bad('فعّل نظام المكاتب أولاً بتشغيل ملف supabase/011_multi_office_recruitment.sql في Supabase SQL Editor.',503);await ensureOfficeAccess(req,String(req.query.office_id));}
  const {rows}=await applicantList(req),officeMap=new Map(officeData.items.map(x=>[x.id,{id:x.id,name:x.name,code:x.code}]));
  const stageCounts=Object.fromEntries(RECRUITMENT_STAGES.map(x=>[x,rows.filter(a=>recruitmentStageOf(a)===x).length]));
  let interviews=[];
  if(officeData.configured){interviews=must(await db.from('masar_interviews').select('*').order('scheduled_at',{ascending:true}).limit(1000));const visibleOfficeIds=new Set(officeData.items.map(x=>x.id));interviews=interviews.filter(x=>visibleOfficeIds.has(x.office_id));if(req.query.office_id)interviews=interviews.filter(x=>x.office_id===String(req.query.office_id));}
  const months=[];const now=new Date();for(let i=5;i>=0;i--){const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-i,1));months.push({key:d.toISOString().slice(0,7),label:d.toLocaleDateString('ar-EG',{month:'short',timeZone:'Africa/Cairo'}),count:0,accepted:0});}
  const monthMap=new Map(months.map(x=>[x.key,x]));for(const a of rows){const key=monthKey(a.created_at);if(monthMap.has(key)){const bucket=monthMap.get(key);bucket.count++;if(['accepted','hired'].includes(recruitmentStageOf(a)))bucket.accepted++;}}
  const applicantById=new Map(rows.map(x=>[x.id,x]));
  const upcoming=interviews.filter(x=>x.status==='scheduled'&&Date.parse(x.scheduled_at)>=Date.now()-86400000).slice(0,5).map(x=>{const a=applicantById.get(x.applicant_id);return {...x,applicant_name:a?Object.values(a.answers||{}).find(v=>v?.kind==='name')?.display||a.display_name||'مرشح':'مرشح',applicant_phone:a?.phone||null,office:officeMap.get(x.office_id)||null};});
  const todayKey=new Date().toLocaleDateString('en-CA',{timeZone:'Africa/Cairo'});
  const localDay=value=>new Date(value).toLocaleDateString('en-CA',{timeZone:'Africa/Cairo'});
  const newToday=rows.filter(x=>localDay(x.created_at)===todayKey).length;
  const interviewsToday=interviews.filter(x=>x.status==='scheduled'&&localDay(x.scheduled_at)===todayKey).length;
  const activeCandidates=rows.filter(x=>!['hired','rejected'].includes(recruitmentStageOf(x))).length;
  const areaCounts=new Map();
  for(const a of rows){
   const name=String(a.qualification?.preferred_work_area||'').trim();
   if(name)areaCounts.set(name,(areaCounts.get(name)||0)+1);
  }
  const areaDistribution=[...areaCounts.entries()].map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count).slice(0,8);
  res.json({
   configured:officeData.configured,offices:officeData.items,selected_office:req.query.office_id?officeMap.get(String(req.query.office_id))||null:null,
   metrics:{total:rows.length,interviews:interviews.filter(x=>x.status==='scheduled').length,offices:officeData.configured?(req.query.office_id?1:officeData.items.filter(x=>x.active).length):0,hired:stageCounts.hired,new_today:newToday,interviews_today:interviewsToday,active_candidates:activeCandidates},
   recruitment_stages:stageCounts,growth:months,recent:rows.slice(0,5).map(a=>applicantPublic(a,officeMap)),upcoming_interviews:upcoming,area_distribution:areaDistribution
  });
 });
 permissionRoute('applicants','get','/interviews',async(req,res)=>{
  const offices=await officeState(req);if(!offices.configured)return res.json({configured:false,items:[]});
  let rows=must(await db.from('masar_interviews').select('*').order('scheduled_at',{ascending:true}).limit(1000));
  const officeIds=new Set(offices.items.map(x=>x.id));rows=rows.filter(x=>officeIds.has(x.office_id));
  if(req.query.office_id){await ensureOfficeAccess(req,String(req.query.office_id));rows=rows.filter(x=>x.office_id===String(req.query.office_id));}
  if(req.query.status){const status=String(req.query.status);if(!INTERVIEW_STATUSES.has(status))throw bad('حالة المقابلة غير صحيحة');rows=rows.filter(x=>x.status===status);}
  const applicantIds=[...new Set(rows.map(x=>x.applicant_id))],applicants=applicantIds.length?must(await db.from('masar_applicants').select('id,display_name,phone,answers,recruitment_stage,office_id').in('id',applicantIds)):[];
  const amap=new Map(applicants.map(x=>[x.id,x])),omap=new Map(offices.items.map(x=>[x.id,{id:x.id,name:x.name,code:x.code}]));
  res.json({configured:true,items:rows.map(x=>{const a=amap.get(x.applicant_id);return {...x,applicant:a?applicantPublic(a,omap):null,office:omap.get(x.office_id)||null};})});
 });
 permissionRoute('applicants','post','/interviews',async(req,res)=>{await serial(async()=>{
  const applicant=await applicantById(req,String(req.body.applicant_id||''));if(!applicant.office_id)throw bad('فعّل نظام المكاتب للمرشح أولاً',503);
  await ensureOfficeAccess(req,applicant.office_id);
  const scheduledAt=String(req.body.scheduled_at||''),time=Date.parse(scheduledAt),notes=String(req.body.notes||'').trim();
  if(!Number.isFinite(time))throw bad('حدد موعد مقابلة صحيح');if(notes.length>2000)throw bad('ملاحظات المقابلة طويلة');
  const row=must(await db.from('masar_interviews').insert({applicant_id:applicant.id,office_id:applicant.office_id,scheduled_at:new Date(time).toISOString(),notes,interviewer_id:req.user.id,created_by:req.user.id}).select().single());
  must(await db.from('masar_applicants').update({recruitment_stage:'interview',updated_at:new Date().toISOString()}).eq('id',applicant.id));
  must(await db.from('masar_events').insert({applicant_id:applicant.id,kind:'interview_scheduled',staff_id:req.user.id,detail:{interview_id:row.id,scheduled_at:row.scheduled_at,office_id:row.office_id}}));
  res.status(201).json(row);
 });});
 permissionRoute('applicants','put','/interviews/:id',async(req,res)=>{await serial(async()=>{
  if(!uuid(req.params.id))throw bad('معرف المقابلة غير صحيح');
  const current=must(await db.from('masar_interviews').select('*').eq('id',req.params.id).single());await ensureOfficeAccess(req,current.office_id);
  const patch={updated_at:new Date().toISOString()};
  if(req.body.status!==undefined){const status=String(req.body.status);if(!INTERVIEW_STATUSES.has(status))throw bad('حالة المقابلة غير صحيحة');patch.status=status;}
  if(req.body.scheduled_at!==undefined){const t=Date.parse(String(req.body.scheduled_at));if(!Number.isFinite(t))throw bad('موعد المقابلة غير صحيح');patch.scheduled_at=new Date(t).toISOString();}
  if(req.body.notes!==undefined){const notes=String(req.body.notes||'').trim();if(notes.length>2000)throw bad('ملاحظات المقابلة طويلة');patch.notes=notes;}
  const row=must(await db.from('masar_interviews').update(patch).eq('id',current.id).select().single());
  must(await db.from('masar_events').insert({applicant_id:current.applicant_id,kind:'interview_updated',staff_id:req.user.id,detail:{interview_id:current.id,status:row.status,scheduled_at:row.scheduled_at}}));
  res.json(row);
 });});
 permissionRoute('reports','get','/reports',async(req,res)=>{
  const {rows,areas}=await applicantList(req),catalog=await campaignCatalog(true);
  const base=summaryFor(rows),stages=base.stages;
  const residenceCounts=new Map();
  for(const a of rows){const name=a.qualification?.geo_status==='outside'?'Outside Area':a.qualification?.residence_area||'لم يجب';residenceCounts.set(name,(residenceCounts.get(name)||0)+1);}
  const zones=[...residenceCounts.entries()].map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count);
  const days={};for(const a of rows){const day=new Date(a.created_at).toLocaleDateString('en-CA',{timeZone:'Africa/Cairo'});days[day]=(days[day]||0)+1;}
  const campaignById=new Map(catalog.campaigns.map(x=>[x.id,x])),adById=new Map(catalog.ads.map(x=>[x.ad_id,x]));
  const attributedAdIds=[...new Set(rows.map(a=>String(attributionOf(a)?.source_id||'')).filter(Boolean))],visibleAdIds=new Set(attributedAdIds);
  const officeId=req.role==='admin'?String(req.query.office_id||''):String(req.officeId||'');
  let relevantAds=catalog.ads.filter(x=>!officeId||x.office_id===officeId||visibleAdIds.has(x.ad_id)||(x.campaign_id&&campaignById.get(x.campaign_id)?.office_id===officeId));
  if(req.query.campaign_id)relevantAds=relevantAds.filter(x=>x.campaign_id===String(req.query.campaign_id));
  if(req.query.ad_id)relevantAds=relevantAds.filter(x=>x.ad_id===String(req.query.ad_id));
  const adIds=[...new Set([...relevantAds.map(x=>x.ad_id),...attributedAdIds])];
  const ad_breakdown=adIds.map(adId=>{const subset=rows.filter(a=>String(attributionOf(a)?.source_id||'')===adId),ad=adById.get(adId),s=summaryFor(subset);return {
   ad_id:adId,name:ad?.name||ad?.headline||'',campaign_id:ad?.campaign_id||null,campaign_name:campaignById.get(ad?.campaign_id)?.name||'غير مربوط بحملة',
   spend:Number(ad?.spend||0),...s
  };}).sort((a,b)=>b.total-a.total);
  const campaignIds=[...new Set(ad_breakdown.map(x=>x.campaign_id).filter(Boolean))];
  const campaign_breakdown=campaignIds.map(id=>{const campaignAds=relevantAds.filter(x=>x.campaign_id===id),adSet=new Set(campaignAds.map(x=>x.ad_id)),subset=rows.filter(a=>adSet.has(String(attributionOf(a)?.source_id||''))),s=summaryFor(subset);return {
   id,name:campaignById.get(id)?.name||'حملة',spend:campaignAds.reduce((n,x)=>n+Number(x.spend||0),0),...s
  };}).sort((a,b)=>b.total-a.total);
  const selectedSpend=req.query.ad_id?Number(relevantAds.find(x=>x.ad_id===String(req.query.ad_id))?.spend||0):
   req.query.campaign_id?relevantAds.filter(x=>x.campaign_id===req.query.campaign_id).reduce((n,x)=>n+Number(x.spend||0),0):
   relevantAds.reduce((n,x)=>n+Number(x.spend||0),0);
  const div=n=>n?Math.round(selectedSpend/n*100)/100:null;
  res.json({
   total:base.total,stages,recruitment_stages:Object.fromEntries(RECRUITMENT_STAGES.map(x=>[x,rows.filter(a=>recruitmentStageOf(a)===x).length])),areas:zones,days:Object.entries(days).sort().map(([date,count])=>({date,count})),completed:base.completed,
   qualification:{qualified:rows.filter(a=>a.qualification?.qualified_candidate===true).length,not_qualified:rows.filter(a=>a.qualification?.qualified_candidate===false).length,pending:rows.filter(a=>a.qualification?.qualified_candidate==null).length,motorcycle_qualified:rows.filter(a=>a.qualification?.motorcycle_qualified===true).length,geo_qualified:rows.filter(a=>a.qualification?.geo_qualified===true).length},
   attributed:rows.filter(a=>Boolean(attributionOf(a)?.source_id)).length,unattributed:rows.filter(a=>!attributionOf(a)?.source_id).length,
   spend:selectedSpend,costs:{per_lead:div(base.total),per_complete:div(base.completed),per_lecture:div(stages.lecture),per_working:div(stages.working)},
   ad_breakdown,campaign_breakdown
  });
 });
 permissionRoute('reports','get','/reports/recruitment-performance',async(req,res)=>{
  const listReq={...req,query:{...req.query}};delete listReq.query.zone;
  const {rows}=await applicantList(listReq),catalog=await discoverAds();
  const campaignById=new Map(catalog.campaigns.map(x=>[x.id,x])),adById=new Map(catalog.ads.map(x=>[x.ad_id,x]));
  const requestedZone=req.query.zone?String(req.query.zone).toUpperCase():'';
  if(requestedZone&&!RECRUITMENT_ZONES.includes(requestedZone))throw bad('Zone غير صحيحة');
  let scopedRows=rows;
  if(requestedZone)scopedRows=scopedRows.filter(a=>(adById.get(String(attributionOf(a)?.source_id||''))?.zone||'UNKNOWN')===requestedZone);

  const visibleIds=new Set(scopedRows.map(a=>String(attributionOf(a)?.source_id||'')).filter(Boolean));
  const officeId=req.role==='admin'?String(req.query.office_id||''):String(req.officeId||'');
  let ads=catalog.ads.filter(ad=>!officeId||ad.office_id===officeId||visibleIds.has(ad.ad_id)||(ad.campaign_id&&campaignById.get(ad.campaign_id)?.office_id===officeId));
  if(req.query.campaign_id)ads=ads.filter(ad=>ad.campaign_id===String(req.query.campaign_id));
  if(req.query.ad_id)ads=ads.filter(ad=>ad.ad_id===String(req.query.ad_id));
  if(requestedZone)ads=ads.filter(ad=>(ad.zone||'UNKNOWN')===requestedZone);
  const adIds=new Set(ads.map(x=>x.ad_id));
  // Keep attributed applicants whose Ad ID was captured before the catalog row existed.
  for(const id of visibleIds)if(!adIds.has(id)){const ad=adById.get(id);if(ad){ads.push(ad);adIds.add(id);}}

  const ad_performance=ads.map(ad=>{
   const subset=scopedRows.filter(a=>String(attributionOf(a)?.source_id||'')===ad.ad_id);
   return {ad_id:ad.ad_id,ad_name:ad.name||ad.headline||'',campaign_id:ad.campaign_id||null,campaign_name:campaignById.get(ad.campaign_id)?.name||'غير مربوط بحملة',zone:ad.zone||'UNKNOWN',spend:Number(ad.spend||0),spend_source:ad.spend_source||'manual',spend_synced_at:ad.spend_synced_at||null,...funnelFor(subset,Number(ad.spend||0))};
  }).sort((a,b)=>b.applicants-a.applicants||b.spend-a.spend);

  const campaignIds=[...new Set(ads.map(x=>x.campaign_id).filter(Boolean))];
  const campaign_performance=campaignIds.map(id=>{
   const campaignAds=ads.filter(x=>x.campaign_id===id),ids=new Set(campaignAds.map(x=>x.ad_id));
   const subset=scopedRows.filter(a=>ids.has(String(attributionOf(a)?.source_id||''))),spend=campaignAds.reduce((n,x)=>n+Number(x.spend||0),0);
   return {campaign_id:id,campaign_name:campaignById.get(id)?.name||'حملة',spend,...funnelFor(subset,spend)};
  }).sort((a,b)=>b.applicants-a.applicants);

  const zone_performance=RECRUITMENT_ZONES.map(zone=>{
   const zoneAds=ads.filter(x=>(x.zone||'UNKNOWN')===zone),ids=new Set(zoneAds.map(x=>x.ad_id)),subset=scopedRows.filter(a=>ids.has(String(attributionOf(a)?.source_id||''))),spend=zoneAds.reduce((n,x)=>n+Number(x.spend||0),0);
   return {zone,spend,...funnelFor(subset,spend)};
  });

  const residenceMap=new Map();
  for(const a of scopedRows){
   const key=a.qualification?.geo_status==='outside'?'Outside Area':a.qualification?.residence_area||'لم يجب';
   if(!residenceMap.has(key))residenceMap.set(key,[]);
   residenceMap.get(key).push(a);
  }
  const residence_performance=[...residenceMap.entries()].map(([residence_area,subset])=>({residence_area,...funnelFor(subset,0)})).sort((a,b)=>b.applicants-a.applicants);
  const spend=ads.reduce((n,x)=>n+Number(x.spend||0),0),unattributedRows=scopedRows.filter(a=>!attributionOf(a)?.source_id);
  res.json({
   generated_at:new Date().toISOString(),filters:{from:req.query.from||null,to:req.query.to||null,office_id:req.query.office_id||req.officeId||null,campaign_id:req.query.campaign_id||null,ad_id:req.query.ad_id||null,zone:requestedZone||null,recruitment_stage:req.query.recruitment_stage||null},
   overall:{spend,...funnelFor(scopedRows,spend)},
   attributed:scopedRows.length-unattributedRows.length,unattributed:unattributedRows.length,unattributed_funnel:funnelFor(unattributedRows,0),
   ad_performance,campaign_performance,zone_performance,residence_performance
  });
 });
 permissionRoute('reports','get','/reports.csv',async(req,res)=>{
  const {rows}=await applicantList(req),catalog=await campaignCatalog(true),campaignById=new Map(catalog.campaigns.map(x=>[x.id,x])),adById=new Map(catalog.ads.map(x=>[x.ad_id,x]));
  const accountById=new Map((await accountRows(req)).map(x=>[x.id,x]));
  const lines=[['رقم واتساب المتقدم','حساب واتساب المستلم','رقم الحساب المستلم','الاسم','مرحلة التوظيف','حالة التقديم','اكتمال البيانات','مكان السكن','Zone السكن','Motorcycle Qualified','Geo Qualified','Overall Qualification','أسباب عدم التأهيل','الحملة','Ad ID','اسم الإعلان','Ad Zone','CTWA Click ID','مصروف الإعلان المسجل','مصدر المصروف','مصدر الإعلان','رابط الإعلان','تاريخ التسجيل'],...rows.map(a=>{
   const ref=attributionOf(a)||{},ad=adById.get(String(ref.source_id||'')),campaign=campaignById.get(ad?.campaign_id),account=accountById.get(a.whatsapp_account_id),q=a.qualification||{};
   return [a.phone||'غير متاح',account?.name||'',account?.phone||'',Object.values(a.answers||{}).find(v=>v?.kind==='name')?.display||a.display_name,RECRUITMENT_STAGES.includes(a.recruitment_stage)?a.recruitment_stage:recruitmentStageOf(a),STAGES[a.stage],a.completion.percent+'%',q.residence_area||'',q.zone||'UNKNOWN',q.motorcycle_qualified==null?'':q.motorcycle_qualified?'YES':'NO',q.geo_qualified==null?'':q.geo_qualified?'YES':'NO',q.overall_status||'pending',qualificationReasonLabels(q.reasons||[]).join(' | '),campaign?.name||'',ref.source_id||'',ad?.name||ad?.headline||ref.title||'',ad?.zone||'UNKNOWN',ref.ctwa_clid||'',Number(ad?.spend||0),ad?.spend_source||'manual',ref.source_app||ref.source_type||'',ref.source_url||'',a.created_at];
  })];res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="speed-delivery-campaign-report.csv"');res.send('\uFEFF'+lines.map(row=>row.map(csvCell).join(',')).join('\r\n'));
 });
 async function normalizedStaffAccountIds(value,officeId=null){
  if(!whatsapp.configured)return [];
  if(!Array.isArray(value))throw bad('حدد أرقام واتساب المسموح بها');
  const requested=[...new Set(value.map(String))];
  if(requested.some(id=>!uuid(id)))throw bad('أحد أرقام واتساب المختارة غير صحيح');
  let available=must(await db.from('masar_whatsapp_accounts').select('id,office_id'));
  if(officeId)available=available.filter(x=>x.office_id===officeId);
  const ids=new Set(available.map(x=>x.id));
  if(requested.some(id=>!ids.has(id)))throw bad('أحد أرقام واتساب المختارة تابع لمكتب آخر أو لم يعد موجودًا');
  return requested;
 }
 async function saveStaffAccountAccess(userId,ids){
  if(!whatsapp.configured)return;
  must(await db.from('masar_staff_whatsapp_access').delete().eq('user_id',userId));
  if(ids.length)must(await db.from('masar_staff_whatsapp_access').insert(ids.map(whatsapp_account_id=>({user_id:userId,whatsapp_account_id}))));
 }
 async function staffRows(req){
  let rows=must(await db.from('masar_staff').select('user_id,office_id,phone,job_title,bio,avatar_path,created_at').order('created_at',{ascending:true}));
  if(req.role==='office_admin')rows=rows.filter(x=>x.office_id===req.officeId);
  const {data,error}=await db.auth.admin.listUsers({page:1,perPage:1000});if(error)throw error;
  const byId=new Map((data.users||[]).map(u=>[u.id,u]));
  const access=whatsapp.configured?must(await db.from('masar_staff_whatsapp_access').select('user_id,whatsapp_account_id')):[];
  const accessByUser=new Map();
  for(const row of access){if(!accessByUser.has(row.user_id))accessByUser.set(row.user_id,[]);accessByUser.get(row.user_id).push(row.whatsapp_account_id);}
  let accounts=(await whatsapp.snapshots()).map(({id,name,phone,status})=>({id,name,phone,status,office_id:null})),offices=[];
  try{
   const links=must(await db.from('masar_whatsapp_accounts').select('id,office_id'));
   const byAccount=new Map(links.map(x=>[x.id,x.office_id||null]));
   accounts=accounts.map(x=>({...x,office_id:byAccount.get(x.id)||null}));
   offices=must(await db.from('masar_offices').select('id,name,code,active').order('created_at',{ascending:true}));
  }catch(e){if(!schemaMissing(e)&&e.code!=='42703'&&e.code!=='PGRST204')throw e;}
  if(req.role==='office_admin'){accounts=accounts.filter(x=>x.office_id===req.officeId);offices=offices.filter(x=>x.id===req.officeId);}
  const items=rows.map(r=>{const u=byId.get(r.user_id),raw=u?.app_metadata?.masar_role,role=raw==='recruiter'?'recruiter':raw==='office_admin'?'office_admin':'admin',officeAccounts=accounts.filter(x=>x.office_id===r.office_id).map(x=>x.id);return {
   id:r.user_id,name:String(u?.user_metadata?.full_name||''),email:u?.email||'',role,office_id:r.office_id||null,phone:r.phone||'',job_title:r.job_title||'',bio:r.bio||'',avatar_path:r.avatar_path||null,
   permissions:['admin','office_admin'].includes(role)?[...PERMISSIONS]:cleanPermissions(u?.app_metadata?.masar_permissions),
   whatsapp_account_ids:role==='admin'?accounts.map(x=>x.id):role==='office_admin'?officeAccounts:accessByUser.get(r.user_id)||[],
   created_at:r.created_at,last_sign_in_at:u?.last_sign_in_at||null
  };});
  return {items,whatsapp_accounts:accounts,offices,offices_configured:offices.length>0,multi_whatsapp_configured:whatsapp.configured};
 }
 async function staffTarget(req,id){
  if(!uuid(id))throw bad('معرف الحساب غير صحيح');
  const target=await db.auth.admin.getUserById(id);if(target.error||!target.data.user)throw bad('الحساب غير موجود',404);
  const staff=must(await db.from('masar_staff').select('user_id,office_id').eq('user_id',id).maybeSingle());if(!staff)throw bad('الحساب غير موجود',404);
  const raw=target.data.user.app_metadata?.masar_role,role=raw==='recruiter'?'recruiter':raw==='office_admin'?'office_admin':'admin';
  if(role==='admin')throw bad('لا يمكن تعديل حساب مسؤول النظام العام من إدارة المكاتب',403);
  if(req.role==='office_admin'&&(role!=='recruiter'||staff.office_id!==req.officeId))throw bad('يمكنك إدارة مستخدمي مكتبك فقط',403);
  return {user:target.data.user,staff,role};
 }
 managerRoute('get','/staff',async(req,res)=>res.json(await staffRows(req)));
 managerRoute('post','/staff',async(req,res)=>{
  const name=String(req.body.name||'').trim(),email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');
  const desiredRole=req.role==='admin'&&req.body.role==='office_admin'?'office_admin':'recruiter';
  const officeId=req.role==='admin'?String(req.body.office_id||''):String(req.officeId||'');
  if(!uuid(officeId))throw bad('اختر مكتب التوظيف للحساب');
  await ensureOfficeAccess(req,officeId);
  const permissions=desiredRole==='office_admin'?[...PERMISSIONS]:cleanPermissions(req.body.permissions);
  let accountIds=desiredRole==='office_admin'?must(await db.from('masar_whatsapp_accounts').select('id').eq('office_id',officeId)).map(x=>x.id):await normalizedStaffAccountIds(req.body.whatsapp_account_ids||[],officeId);
  if(name.length<2||name.length>100)throw bad('اكتب اسم المستخدم');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw bad('اكتب بريد إلكتروني صحيح');
  if(password.length<8||password.length>100)throw bad('كلمة المرور لازم تكون 8 أحرف على الأقل');
  const officeAccounts=must(await db.from('masar_whatsapp_accounts').select('id').eq('office_id',officeId));
  if(desiredRole==='recruiter'&&officeAccounts.length&&!accountIds.length)throw bad('اختر رقم واتساب واحد على الأقل للمستخدم');
  const created=await db.auth.admin.createUser({email,password,email_confirm:true,app_metadata:{masar_role:desiredRole,masar_permissions:permissions,masar_office_id:officeId},user_metadata:{full_name:name}});
  if(created.error)throw bad(created.error.message.includes('already')?'البريد الإلكتروني مستخدم بالفعل':'تعذر إنشاء الحساب');
  try{must(await db.from('masar_staff').insert({user_id:created.data.user.id,office_id:officeId,job_title:desiredRole==='office_admin'?'مدير المكتب':'مسؤول توظيف'}));await saveStaffAccountAccess(created.data.user.id,accountIds);}
  catch(e){await db.auth.admin.deleteUser(created.data.user.id).catch(()=>{});throw e;}
  res.status(201).json({id:created.data.user.id,name,email,role:desiredRole,office_id:officeId,permissions,whatsapp_account_ids:accountIds});
 });
 managerRoute('put','/staff/:id',async(req,res)=>{
  const target=await staffTarget(req,req.params.id),name=String(req.body.name||'').trim(),email=String(req.body.email||'').trim().toLowerCase();
  const desiredRole=req.role==='admin'&&req.body.role==='office_admin'?'office_admin':'recruiter';
  const officeId=req.role==='admin'?String(req.body.office_id||target.staff.office_id||''):String(req.officeId||'');
  if(!uuid(officeId))throw bad('اختر مكتب التوظيف للحساب');await ensureOfficeAccess(req,officeId);
  if(name.length<2||name.length>100)throw bad('اكتب اسم المستخدم');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw bad('اكتب بريد إلكتروني صحيح');
  const permissions=desiredRole==='office_admin'?[...PERMISSIONS]:cleanPermissions(req.body.permissions),accountIds=desiredRole==='office_admin'?must(await db.from('masar_whatsapp_accounts').select('id').eq('office_id',officeId)).map(x=>x.id):await normalizedStaffAccountIds(req.body.whatsapp_account_ids||[],officeId);
  const changed=await db.auth.admin.updateUserById(req.params.id,{email,email_confirm:true,user_metadata:{...(target.user.user_metadata||{}),full_name:name},app_metadata:{...(target.user.app_metadata||{}),masar_role:desiredRole,masar_permissions:permissions,masar_office_id:officeId}});
  if(changed.error)throw bad(changed.error.message.includes('already')?'البريد الإلكتروني مستخدم بالفعل':'تعذر تعديل الحساب');
  must(await db.from('masar_staff').update({office_id:officeId,updated_at:new Date().toISOString()}).eq('user_id',req.params.id));
  await saveStaffAccountAccess(req.params.id,accountIds);
  res.json({id:req.params.id,name,email,role:desiredRole,office_id:officeId,permissions,whatsapp_account_ids:accountIds});
 });
 managerRoute('put','/staff/:id/password',async(req,res)=>{
  await staffTarget(req,req.params.id);const password=String(req.body.password||'');if(password.length<8||password.length>100)throw bad('كلمة المرور لازم تكون 8 أحرف على الأقل');
  const changed=await db.auth.admin.updateUserById(req.params.id,{password});if(changed.error)throw changed.error;res.json({ok:true});
 });
 managerRoute('delete','/staff/:id',async(req,res)=>{
  const target=await staffTarget(req,req.params.id);
  if(req.params.id===req.user.id)throw bad('لا يمكن حذف حسابك أثناء تسجيل الدخول',400);
  must(await db.from('masar_events').update({staff_id:null}).eq('staff_id',req.params.id));
  must(await db.from('masar_events').insert({kind:'staff_account_deleted',staff_id:req.user.id,detail:{deleted_user_id:req.params.id,deleted_name:String(target.user.user_metadata?.full_name||''),deleted_email:target.user.email||'',office_id:target.staff.office_id}}));
  const removed=await db.auth.admin.deleteUser(req.params.id);if(removed.error)throw removed.error;res.json({ok:true});
 });
 let importJob={status:'idle',result:null,error:null};
 adminRoute('get','/legacy/import',async(_req,res)=>res.json(importJob));
 adminRoute('post','/legacy/import',async(_req,res)=>{
  if(importJob.status!=='running'){
   importJob={status:'running',result:null,error:null};
   serial(()=>legacyImport(db)).then(result=>{importJob={status:'done',result,error:null};}).catch(()=>{importJob={status:'error',result:null,error:'تعذر الاستيراد. تحقق من الجداول القديمة ثم أعد المحاولة؛ لن تتكرر السجلات المحفوظة.'};});
  }
  res.status(202).json(importJob);
 });
 permissionRoute('questions','post','/questions/defaults',async(req,res)=>{await serial(async()=>{
  const officeId=await scopedOfficeId(req),existing=must(await db.from('masar_questions').select('id').eq('office_id',officeId).limit(1));if(existing.length)throw bad('الأسئلة موجودة بالفعل؛ استخدم صفحة الأسئلة لتعديلها');
  must(await db.from('masar_questions').insert([
   {field_key:'preferred_work_area',label:'منطقة العمل اللي حابب ينزل فيها',kind:'area',priority:100,confirmation_required:true,agent_instruction:'اسأل عن منطقة العمل أولًا. اعرض تفاصيل المنطقة قبل تسجيلها، ولا تعتبر مكان السكن اختيارًا لمنطقة العمل. لا تسجلها إلا بعد تأكيد أن التفاصيل مناسبة.'},
   {field_key:'has_motorcycle',label:'وجود موتوسيكل متاح للشغل يوميًا',kind:'yes_no',priority:90,agent_instruction:'بعد تأكيد منطقة العمل، اتأكد إن الموتوسيكل متاح للشغل بشكل مستمر، مش مجرد موجود أحيانًا.'},
   {field_key:'motorcycle_license',label:'حالة رخصة الموتوسيكل',kind:'yes_no',priority:85,agent_instruction:'اعرف هل الرخصة سارية حسب متطلبات الوظيفة الحالية.'},
   {field_key:'full_name',label:'الاسم بالكامل',kind:'name',priority:80,agent_instruction:'اجمع الاسم الكامل بشكل طبيعي من المحادثة.'},
   {field_key:'age',label:'العمر',kind:'number',priority:60,agent_instruction:'لو العمر اتقال طبيعيًا سجله، وإلا اسأل عنه وقت ما يكون مناسب.'},
   {field_key:'residence_area',label:'منطقة السكن الحالية',kind:'text',priority:40,agent_instruction:'للمعلومة والتحليل فقط؛ لا تستخدم السكن في Geo Qualification.'},
   {field_key:'document',label:'المستند المطلوب للتقديم',kind:'image',priority:20,required:false,active:false,confirmation_required:true}
  ].map((q,i)=>({...q,required:q.required!==false,active:q.active!==false,allow_inference:q.allow_inference!==false,confirmation_required:q.confirmation_required===true,position:i+1,office_id:officeId}))));
 });res.json({ok:true});});
 if(dashboardDist&&fs.existsSync(dashboardDist)){
  app.use(express.static(dashboardDist,{index:false}));
  app.use((req,res,next)=>{if(req.method==='GET'&&!req.path.startsWith('/api')&&req.path!=='/health')return res.sendFile(path.join(dashboardDist,'index.html'));next();});
 }
 app.use((error,_req,res,_next)=>{const status=error.status||500;if(status>=500)console.error('API:',{code:error.code||error.name,message:error.message,details:error.details,hint:error.hint});res.status(status).json({error:error.status?error.message:error.code==='23505'?'الاسم أو مفتاح البيانات مستخدم بالفعل':'تعذر إتمام العملية. راجع إعداد قاعدة البيانات واتصال الخدمة.'});});return app;
}
