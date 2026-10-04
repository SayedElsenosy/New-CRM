import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import {rateLimit} from 'express-rate-limit';
import {must,allRows,config} from './db.js';
import {STAGES,computedStage,completion,csvCell} from './domain.js';
import {schemaMissing,suggestKeywords,findKnowledgeAnswer,createLearningSuggestion} from './knowledge.js';
import {legacyImport} from './legacy.js';
import fs from 'node:fs';
import path from 'node:path';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v);
function bad(message,status=400){return Object.assign(new Error(message),{status});}
const PERMISSIONS=new Set(['applicants','areas','reports','campaigns','questions','whatsapp','settings']);
const DEFAULT_RECRUITER_PERMISSIONS=['applicants','areas','reports'];
const cleanPermissions=value=>Array.isArray(value)?[...new Set(value.filter(v=>PERMISSIONS.has(v)))]:[...DEFAULT_RECRUITER_PERMISSIONS];
export function makeApi({db,connection,connections,worker,speech=null,serial,origins,dashboardDist=null}){
 const whatsapp=connections||{
  configured:false,
  defaultAccountId:()=>null,
  snapshot:()=>connection?.snapshot?.()||{status:'disconnected'},
  snapshots:async()=>[{id:null,name:'الرقم الرئيسي',legacy_session:true,...(connection?.snapshot?.()||{status:'disconnected'})}],
  connect:async()=>{await connection?.connect?.();return connection?.snapshot?.()||{status:'disconnected'};},
  disconnect:async()=>{await connection?.disconnect?.();return connection?.snapshot?.()||{status:'disconnected'};}
 };
 const app=express();app.set('trust proxy',1);app.use(helmet({
  contentSecurityPolicy:{
   directives:{
    connectSrc:["'self'","https://*.supabase.co","wss://*.supabase.co"]
   }
  }
 }));
 app.use(cors({origin(origin,cb){cb(null,!origin||origins.includes(origin));}}));
 app.use(express.json({limit:'64kb'}));
 app.get('/health',(_req,res)=>res.json({ok:true}));
 app.use('/api',rateLimit({windowMs:60000,limit:240,standardHeaders:'draft-8',legacyHeaders:false}));
 app.use('/api',async(req,res,next)=>{try{
  if(req.headers.origin&&!origins.includes(req.headers.origin))throw bad('هذا العنوان غير مسموح',403);
  const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token)throw bad('سجل الدخول أولاً',401);
  const {data,error}=await db.auth.getUser(token);if(error||!data.user)throw bad('انتهت الجلسة؛ سجل الدخول مجدداً',401);
  const staff=must(await db.from('masar_staff').select('user_id').eq('user_id',data.user.id).maybeSingle());if(!staff)throw bad('الحساب غير مصرح له بإدارة مسار',403);
  req.user=data.user;req.role=data.user.app_metadata?.masar_role==='recruiter'?'recruiter':'admin';req.permissions=req.role==='admin'?[...PERMISSIONS]:cleanPermissions(data.user.app_metadata?.masar_permissions);next();
 }catch(e){next(e);}});
 const route=(method,url,fn)=>app[method]('/api'+url,async(req,res,next)=>{try{await fn(req,res);}catch(e){next(e);}});
 const adminRoute=(method,url,fn)=>route(method,url,async(req,res)=>{if(req.role!=='admin')throw bad('هذه الصفحة متاحة لمسؤول النظام فقط',403);await fn(req,res);});
 const permissionRoute=(permission,method,url,fn)=>route(method,url,async(req,res)=>{if(req.role!=='admin'&&!req.permissions.includes(permission))throw bad('ليس لديك صلاحية لهذه الصفحة',403);await fn(req,res);});
 async function accessibleAccountIds(req){
  if(!whatsapp.configured||req.role==='admin')return null;
  const rows=must(await db.from('masar_staff_whatsapp_access').select('whatsapp_account_id').eq('user_id',req.user.id));
  return rows.map(x=>x.whatsapp_account_id);
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
 route('get','/bootstrap',async(req,res)=>{
  const cfg=await config(db),profile={name:String(req.user.user_metadata?.full_name||''),email:req.user.email||'',role:req.role};
  const accounts=(await accountRows(req)).map(({id,name,phone,status})=>({id,name,phone,status}));
  const payload={role:req.role,permissions:req.permissions,profile,whatsapp_accounts:accounts,multi_whatsapp_configured:whatsapp.configured,ai_configured:true,ai_provider:'local'};
  if(req.role==='admin'||req.permissions.includes('areas'))payload.areas=cfg.areas;
  if(req.role==='admin'||req.permissions.includes('questions'))payload.questions=cfg.questions;
  if(req.role==='admin'||req.permissions.includes('settings'))payload.settings=cfg.settings;
  res.json(payload);
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
 adminRoute('post','/whatsapp/accounts',async(req,res)=>{await serial(async()=>{
  if(!whatsapp.configured)throw bad('فعّل تعدد أرقام واتساب أولاً بتشغيل ملف supabase/003_multi_whatsapp.sql في Supabase SQL Editor.',503);
  const name=String(req.body.name||'').trim();if(name.length<2||name.length>80)throw bad('اكتب اسم واضح لرقم واتساب');
  const row=must(await db.from('masar_whatsapp_accounts').insert({name,legacy_session:false,active:true}).select().single());
  await whatsapp.add(row);res.status(201).json(whatsapp.snapshot(row.id));
 });});
 adminRoute('put','/whatsapp/accounts/:id',async(req,res)=>{await serial(async()=>{
  if(!whatsapp.configured||!uuid(req.params.id))throw bad('معرف رقم واتساب غير صحيح');
  const name=String(req.body.name||'').trim();if(name.length<2||name.length>80)throw bad('اكتب اسم واضح لرقم واتساب');
  const row=must(await db.from('masar_whatsapp_accounts').update({name,updated_at:new Date().toISOString()}).eq('id',req.params.id).select().single());
  const item=whatsapp.item?.(req.params.id);if(item)item.account={...item.account,...row};
  res.json(whatsapp.snapshot(req.params.id)||row);
 });});
 permissionRoute('whatsapp','post','/whatsapp/accounts/:id/connect',async(req,res)=>{await ensureAccountAccess(req,req.params.id);await whatsapp.connect(req.params.id);res.json(whatsapp.snapshot(req.params.id));});
 permissionRoute('whatsapp','post','/whatsapp/accounts/:id/disconnect',async(req,res)=>{await ensureAccountAccess(req,req.params.id);await whatsapp.disconnect(req.params.id);res.json(whatsapp.snapshot(req.params.id));});
 permissionRoute('settings','put','/settings',async(req,res)=>{const b=req.body;if(typeof b.ai_enabled!=='boolean'||!String(b.welcome||'').trim()||!String(b.completion||'').trim()||b.welcome.length>1500||b.completion.length>1500)throw bad('راجع إعدادات الرسائل');must(await db.from('masar_settings').update({ai_enabled:b.ai_enabled,welcome:b.welcome,completion:b.completion}).eq('id',true));res.json({ok:true});});
 const cleanKeywords=value=>Array.isArray(value)?[...new Set(value.map(x=>String(x||'').trim()).filter(Boolean).slice(0,20).map(x=>x.slice(0,80)))]:[];
 const effectiveRunMode=s=>{
  const mode=s?.ai_run_mode||'live';
  if(mode==='training'&&s?.ai_training_until&&Date.parse(s.ai_training_until)<=Date.now())return 'paused';
  return mode;
 };
 async function intelligenceState(){
  try{
   const [settings,knowledge,suggestions]=await Promise.all([
    db.from('masar_settings').select('*').eq('id',true).single(),
    db.from('masar_knowledge').select('*').order('updated_at',{ascending:false}),
    db.from('masar_learning_suggestions').select('*').order('created_at',{ascending:false}).limit(500)
   ]);
   const s=must(settings),k=must(knowledge),sg=must(suggestions),learningModeConfigured=Object.prototype.hasOwnProperty.call(s,'ai_run_mode');
   let runMode=effectiveRunMode(s);
   if(learningModeConfigured&&s.ai_run_mode==='training'&&runMode==='paused'){
    must(await db.from('masar_settings').update({ai_run_mode:'paused'}).eq('id',true));
   }
   const started=s.ai_training_started_at||null,until=s.ai_training_until||null;
   const trainingSuggestions=started?sg.filter(x=>{
    const t=Date.parse(x.created_at),from=Date.parse(started),to=until?Date.parse(until):Infinity;
    return Number.isFinite(t)&&t>=from&&t<=to;
   }).length:0;
   return {configured:true,learning_mode_configured:learningModeConfigured,voice_transcription:speech?.snapshot?.()||{available:false,error:'محرك الصوت غير متاح'},settings:{
    ai_knowledge_enabled:s.ai_knowledge_enabled!==false,
    ai_learning_enabled:s.ai_learning_enabled!==false,
    ai_confidence_threshold:Number(s.ai_confidence_threshold||0.62),
    ai_fallback:s.ai_fallback||'السؤال ده محتاج تأكيد من مسؤول التوظيف، هحوّل المحادثة للفريق علشان يرد عليك بدقة.',
    ai_run_mode:runMode,
    ai_training_started_at:started,
    ai_training_until:until
   },knowledge:k,suggestions:sg,stats:{
    active:k.filter(x=>x.active).length,total:k.length,pending:sg.filter(x=>x.status==='pending').length,
    learned:k.filter(x=>x.source==='staff').length,usage:k.reduce((n,x)=>n+Number(x.usage_count||0),0),
    training_suggestions:trainingSuggestions
   }};
  }catch(e){
   if(schemaMissing(e))return {configured:false,learning_mode_configured:false,voice_transcription:speech?.snapshot?.()||{available:false,error:'محرك الصوت غير متاح'},settings:null,knowledge:[],suggestions:[],stats:{active:0,total:0,pending:0,learned:0,usage:0,training_suggestions:0}};
   throw e;
  }
 }
 adminRoute('get','/intelligence',async(_req,res)=>res.json(await intelligenceState()));
 adminRoute('put','/intelligence/settings',async(req,res)=>{
  const b=req.body,threshold=Number(b.ai_confidence_threshold),fallback=String(b.ai_fallback||'').trim();
  if(typeof b.ai_knowledge_enabled!=='boolean'||typeof b.ai_learning_enabled!=='boolean'||!Number.isFinite(threshold)||threshold<.35||threshold>.95||!fallback||fallback.length>1500)throw bad('راجع إعدادات ذكاء البوت');
  try{must(await db.from('masar_settings').update({ai_knowledge_enabled:b.ai_knowledge_enabled,ai_learning_enabled:b.ai_learning_enabled,ai_confidence_threshold:threshold,ai_fallback:fallback}).eq('id',true));}
  catch(e){if(schemaMissing(e))throw bad('فعّل ذكاء البوت أولاً بتشغيل ملف supabase/004_bot_intelligence.sql في Supabase SQL Editor.',503);throw e;}
  res.json({ok:true});
 });
 adminRoute('post','/intelligence/knowledge',async(req,res)=>{await serial(async()=>{
  const question=String(req.body.question||'').trim(),answer=String(req.body.answer||'').trim();
  if(question.length<2||question.length>2000||answer.length<2||answer.length>4000)throw bad('راجع السؤال والإجابة');
  const keywords=cleanKeywords(req.body.keywords?.length?req.body.keywords:suggestKeywords(question));
  try{res.status(201).json(must(await db.from('masar_knowledge').insert({question,answer,keywords,active:req.body.active!==false,source:'manual',created_by:req.user.id}).select().single()));}
  catch(e){if(schemaMissing(e))throw bad('فعّل ذكاء البوت أولاً بتشغيل ملف supabase/004_bot_intelligence.sql في Supabase SQL Editor.',503);throw e;}
 });});
 adminRoute('put','/intelligence/knowledge/:id',async(req,res)=>{await serial(async()=>{
  if(!uuid(req.params.id))throw bad('معرف المعرفة غير صحيح');
  const question=String(req.body.question||'').trim(),answer=String(req.body.answer||'').trim();
  if(question.length<2||question.length>2000||answer.length<2||answer.length>4000)throw bad('راجع السؤال والإجابة');
  const patch={question,answer,keywords:cleanKeywords(req.body.keywords?.length?req.body.keywords:suggestKeywords(question)),active:req.body.active!==false,updated_at:new Date().toISOString()};
  res.json(must(await db.from('masar_knowledge').update(patch).eq('id',req.params.id).select().single()));
 });});
 adminRoute('delete','/intelligence/knowledge/:id',async(req,res)=>{if(!uuid(req.params.id))throw bad('معرف المعرفة غير صحيح');must(await db.from('masar_knowledge').delete().eq('id',req.params.id));res.json({ok:true});});
 adminRoute('post','/intelligence/suggestions/:id/approve',async(req,res)=>{await serial(async()=>{
  if(!uuid(req.params.id))throw bad('معرف الاقتراح غير صحيح');
  const suggestion=must(await db.from('masar_learning_suggestions').select('*').eq('id',req.params.id).single());
  if(suggestion.status!=='pending')throw bad('تمت مراجعة الاقتراح بالفعل');
  const question=String(req.body.question||suggestion.question||'').trim(),answer=String(req.body.answer||suggestion.answer||'').trim();
  if(question.length<2||question.length>2000||answer.length<2||answer.length>4000)throw bad('راجع السؤال والإجابة');
  const knowledge=must(await db.from('masar_knowledge').insert({question,answer,keywords:cleanKeywords(req.body.keywords?.length?req.body.keywords:suggestKeywords(question)),active:true,source:'staff',source_suggestion_id:suggestion.id,created_by:req.user.id}).select().single());
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
 adminRoute('post','/intelligence/training/start',async(req,res)=>{
  const now=new Date(),until=new Date(now.getTime()+72*60*60*1000);
  try{
   must(await db.from('masar_settings').update({
    ai_run_mode:'training',ai_training_started_at:now.toISOString(),ai_training_until:until.toISOString(),ai_learning_enabled:true
   }).eq('id',true));
  }catch(e){if(['42703','PGRST204'].includes(e.code))throw bad('فعّل وضع التعلّم أولاً بتشغيل ملف supabase/005_learning_mode.sql في Supabase SQL Editor.',503);throw e;}
  await suppressQueuedBotReplies();
  must(await db.from('masar_events').insert({kind:'ai_training_started',staff_id:req.user.id,detail:{until:until.toISOString(),duration_hours:72}}));
  res.json(await intelligenceState());
 });
 adminRoute('post','/intelligence/training/stop',async(req,res)=>{
  try{must(await db.from('masar_settings').update({ai_run_mode:'paused'}).eq('id',true));}
  catch(e){if(['42703','PGRST204'].includes(e.code))throw bad('فعّل وضع التعلّم أولاً بتشغيل ملف supabase/005_learning_mode.sql في Supabase SQL Editor.',503);throw e;}
  must(await db.from('masar_events').insert({kind:'ai_training_stopped',staff_id:req.user.id,detail:{source:'manual'}}));
  res.json(await intelligenceState());
 });
 adminRoute('post','/intelligence/live',async(req,res)=>{
  try{must(await db.from('masar_settings').update({ai_run_mode:'live',ai_learning_enabled:true}).eq('id',true));}
  catch(e){if(['42703','PGRST204'].includes(e.code))throw bad('فعّل وضع التعلّم أولاً بتشغيل ملف supabase/005_learning_mode.sql في Supabase SQL Editor.',503);throw e;}
  must(await db.from('masar_events').insert({kind:'ai_bot_live',staff_id:req.user.id,detail:{learning_continues:true}}));
  res.json(await intelligenceState());
 });
 adminRoute('post','/intelligence/pause',async(req,res)=>{
  try{must(await db.from('masar_settings').update({ai_run_mode:'paused'}).eq('id',true));}
  catch(e){if(['42703','PGRST204'].includes(e.code))throw bad('فعّل وضع التعلّم أولاً بتشغيل ملف supabase/005_learning_mode.sql في Supabase SQL Editor.',503);throw e;}
  await suppressQueuedBotReplies();
  must(await db.from('masar_events').insert({kind:'ai_bot_paused',staff_id:req.user.id,detail:{learning_continues:true}}));
  res.json(await intelligenceState());
 });
 for(const type of ['areas','questions']){
  permissionRoute(type,'post','/'+type,async(req,res)=>{await serial(async()=>{
   const b=req.body;let row;
   if(type==='areas'){
    if(typeof b.name!=='string'||!b.name.trim()||b.name.length>100||typeof b.details!=='string'||b.details.length>4000)throw bad('راجع اسم المنطقة وتفاصيلها');
    row={name:b.name.trim(),details:b.details,active:b.active!==false,position:Number.isInteger(b.position)?b.position:0};
   }else{
    if(typeof b.label!=='string'||!b.label.trim()||b.label.length>1000||!['name','text','number','yes_no','area','image'].includes(b.kind)||!/^[a-z][a-z0-9_]{0,39}$/.test(b.field_key))throw bad('راجع السؤال ونوعه ومفتاح حفظ البيانات');
    row={label:b.label.trim(),field_key:b.field_key,kind:b.kind,required:b.required!==false,active:b.active!==false,position:Number.isInteger(b.position)?b.position:0};
   }
   if(b.id&&!uuid(b.id))throw bad('معرف غير صحيح');
   const query=b.id?db.from('masar_'+type).update(row).eq('id',b.id):db.from('masar_'+type).insert(row);
   res.json(must(await query.select().single()));
  });});
 }
 permissionRoute('questions','post','/questions/reorder',async(req,res)=>{await serial(async()=>{
  const qs=must(await db.from('masar_questions').select('id'));
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
    const inserted=must(await db.from('masar_ads').insert({
     ad_id:adId,name:ref.title||'',headline:ref.title||'',source_url:ref.source_url||null,
     source_app:ref.source_app||null,source_type:ref.source_type||'ad',
     first_seen_at:ref.captured_at||applicant.created_at,last_seen_at:ref.captured_at||applicant.created_at
    }).select().single());byId.set(adId,inserted);catalog.ads.unshift(inserted);
   }else{
    const patch={last_seen_at:ref.captured_at||applicant.created_at,updated_at:new Date().toISOString()};
    if(!existing.headline&&ref.title)patch.headline=ref.title;
    if(!existing.source_url&&ref.source_url)patch.source_url=ref.source_url;
    if(!existing.source_app&&ref.source_app)patch.source_app=ref.source_app;
    if(Object.keys(patch).length>2){must(await db.from('masar_ads').update(patch).eq('ad_id',adId));Object.assign(existing,patch);}
   }
  }
  return catalog;
 }
 const summaryFor=rows=>{
  const stages=Object.fromEntries(Object.keys(STAGES).map(k=>[k,rows.filter(a=>a.stage===k).length]));
  const completed=rows.filter(a=>['complete','lecture','working'].includes(a.stage)).length;
  return {total:rows.length,completed,stages};
 };
 permissionRoute('campaigns','get','/campaigns',async(req,res)=>{
  const {campaigns,ads}=await discoverAds(),applicants=(await applicantList(req)).rows;
  const visibleIds=new Set(applicants.map(a=>String(attributionOf(a)?.source_id||'')).filter(Boolean));
  const scopedAds=req.role==='admin'?ads:ads.filter(ad=>visibleIds.has(ad.ad_id));
  const scopedCampaignIds=new Set(scopedAds.map(ad=>ad.campaign_id).filter(Boolean));
  const scopedCampaigns=req.role==='admin'?campaigns:campaigns.filter(x=>scopedCampaignIds.has(x.id));
  const stats=Object.fromEntries(scopedAds.map(ad=>[ad.ad_id,summaryFor(applicants.filter(a=>attributionOf(a)?.source_id===ad.ad_id))]));
  res.json({campaigns:scopedCampaigns,ads:scopedAds.map(ad=>({...ad,stats:stats[ad.ad_id]}))});
 });
 permissionRoute('campaigns','post','/campaigns',async(req,res)=>{await serial(async()=>{
  const b=req.body,name=String(b.name||'').trim(),meta=String(b.meta_campaign_id||'').trim()||null;
  if(name.length<2||name.length>150)throw bad('اكتب اسم الحملة');
  const row={name,meta_campaign_id:meta,active:b.active!==false,updated_at:new Date().toISOString()};
  if(b.id&&!uuid(b.id))throw bad('معرف الحملة غير صحيح');
  const q=b.id?db.from('masar_campaigns').update(row).eq('id',b.id):db.from('masar_campaigns').insert(row);
  res.json(must(await q.select().single()));
 });});
 permissionRoute('campaigns','delete','/campaigns/:id',async(req,res)=>{await serial(async()=>{
  if(!uuid(req.params.id))throw bad('معرف الحملة غير صحيح');
  must(await db.from('masar_ads').update({campaign_id:null,updated_at:new Date().toISOString()}).eq('campaign_id',req.params.id));
  must(await db.from('masar_campaigns').delete().eq('id',req.params.id));res.json({ok:true});
 });});
 permissionRoute('campaigns','put','/ads/:id',async(req,res)=>{await serial(async()=>{
  const adId=String(req.params.id||'').trim(),b=req.body;if(!/^\d{5,40}$/.test(adId))throw bad('Ad ID غير صحيح');
  const campaignId=b.campaign_id||null;if(campaignId&&!uuid(campaignId))throw bad('معرف الحملة غير صحيح');
  const spend=Number(b.spend);if(!Number.isFinite(spend)||spend<0||spend>1000000000)throw bad('راجع تكلفة الإعلان');
  const name=String(b.name||'').trim();if(name.length>200)throw bad('اسم الإعلان طويل');
  const patch={campaign_id:campaignId,name,spend:Math.round(spend*100)/100,updated_at:new Date().toISOString()};
  res.json(must(await db.from('masar_ads').update(patch).eq('ad_id',adId).select().single()));
 });});
 permissionRoute('reports','get','/reports/options',async(req,res)=>{
  try{
   const {campaigns,ads}=await discoverAds(),rows=(await applicantList(req)).rows;
   const ids=new Set(rows.map(a=>String(attributionOf(a)?.source_id||'')).filter(Boolean));
   const scopedAds=req.role==='admin'?ads:ads.filter(x=>ids.has(x.ad_id));
   const campaignIds=new Set(scopedAds.map(x=>x.campaign_id).filter(Boolean));
   const scopedCampaigns=req.role==='admin'?campaigns:campaigns.filter(x=>campaignIds.has(x.id));
   const accounts=(await accountRows(req)).map(({id,name,phone,status})=>({id,name,phone,status}));
   res.json({campaigns:scopedCampaigns,ads:scopedAds,accounts,configured:true,multi_whatsapp_configured:whatsapp.configured});
  }catch(e){if(e.status===503)return res.json({campaigns:[],ads:[],accounts:[],configured:false,multi_whatsapp_configured:whatsapp.configured});throw e;}
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
  const cfg=await config(db);let rows=(await allRows(db,'masar_applicants')).map(a=>({...a,stage:computedStage(a,cfg.questions,cfg.areas),completion:completion(cfg.questions,a.answers,cfg.areas)}));
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
  if(req.query.search){const s=String(req.query.search).toLowerCase();rows=rows.filter(a=>(a.phone||'').includes(s)||(a.display_name||'').toLowerCase().includes(s)||Object.values(a.answers||{}).some(v=>v?.kind==='name'&&String(v.value).toLowerCase().includes(s)));}
  if(req.query.stage)rows=rows.filter(a=>a.stage===req.query.stage);
  if(req.query.ad_id)rows=rows.filter(a=>String(attributionOf(a)?.source_id||'')===String(req.query.ad_id));
  if(req.query.campaign_id){
   if(!uuid(String(req.query.campaign_id)))throw bad('معرف الحملة غير صحيح');
   const {ads}=await campaignCatalog(),ids=new Set(ads.filter(ad=>ad.campaign_id===req.query.campaign_id).map(ad=>ad.ad_id));
   rows=rows.filter(a=>ids.has(String(attributionOf(a)?.source_id||'')));
  }
  if(req.query.from)rows=rows.filter(a=>a.created_at>=req.query.from);
  if(req.query.to)rows=rows.filter(a=>a.created_at<req.query.to);
  return {rows:rows.sort((a,b)=>b.created_at.localeCompare(a.created_at)),...cfg};
 }
 permissionRoute('applicants','get','/applicants',async(req,res)=>{const {rows}=await applicantList(req);const page=Math.max(1,parseInt(req.query.page)||1);res.json({items:rows.slice((page-1)*30,page*30),total:rows.length,page});});
 permissionRoute('applicants','get','/applicants/:id',async(req,res)=>{
  const a=await applicantById(req,req.params.id),cfg=await config(db);
  const before=req.query.before;let query=db.from('masar_messages').select('*').eq('applicant_id',a.id).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(101);
  if(before){const [time,id]=String(before).split('|');if(!uuid(id)||!Number.isFinite(Date.parse(time)))throw bad('مؤشر غير صحيح');query=query.or(`created_at.lt.${time},and(created_at.eq.${time},id.lt.${id})`);}
  const all=must(await query),has_more=all.length>100,messages=all.slice(0,100),last=messages.at(-1);
  for(const m of messages){if(m.media_path){const signed=await db.storage.from('masar-documents').createSignedUrl(m.media_path,600);m.media_url=signed.data?.signedUrl||null;}}
  const events=must(await db.from('masar_events').select('*').eq('applicant_id',a.id).order('created_at',{ascending:false}).limit(50));
  const account=whatsapp.configured?whatsapp.snapshot(a.whatsapp_account_id):null;
  res.json({applicant:{...a,stage:computedStage(a,cfg.questions,cfg.areas),completion:completion(cfg.questions,a.answers,cfg.areas),whatsapp_account:account?{id:account.id,name:account.name,phone:account.phone}:null},messages:messages.reverse(),events,has_more,next_cursor:last?last.created_at+'|'+last.id:null});
 });
 permissionRoute('applicants','patch','/applicants/:id',async(req,res)=>{
  let resumedMessageId=null;
  await serial(async()=>{
   const a=await applicantById(req,req.params.id),b=req.body,patch={updated_at:new Date().toISOString()};
   if(b.notes!==undefined){if(typeof b.notes!=='string'||b.notes.length>4000)throw bad('الملاحظات لا تتجاوز 4000 حرف');patch.notes=b.notes;}
   if(b.bot_enabled!==undefined){
    if(typeof b.bot_enabled!=='boolean')throw bad('قيمة غير صحيحة');
    patch.bot_enabled=b.bot_enabled;
    if(b.bot_enabled){
     let settings=null;try{settings=must(await db.from('masar_settings').select('*').eq('id',true).single());}catch(e){if(!schemaMissing(e))throw e;}
     if(effectiveRunMode(settings)!=='live')throw bad('البوت العام متوقف حاليًا. شغّله أولًا من صفحة ذكاء البوت.',409);
     const answers={...(a.answers||{})};delete answers.__ai_handoff;patch.answers=answers;
     const lastOut=must(await db.from('masar_messages').select('sequence').eq('applicant_id',a.id).eq('direction','out').order('sequence',{ascending:false}).limit(1).maybeSingle());
     let q=db.from('masar_messages').select('id,sequence,status,media_error').eq('applicant_id',a.id).eq('direction','in').eq('status','processed').order('sequence',{ascending:false}).limit(1);
     if(lastOut?.sequence)q=q.gt('sequence',lastOut.sequence);
     const missed=must(await q.maybeSingle());
     if(missed&&!String(missed.media_error||'').includes('غير موثوق')){
      must(await db.from('masar_messages').update({status:'pending',attempts:0,error:null}).eq('id',missed.id));
      resumedMessageId=missed.id;
     }
    }
   }
   if(b.stage!==undefined){
    if(!['lecture','working','auto'].includes(b.stage))throw bad('حالة غير صحيحة');
    const cfg=await config(db);if(b.stage!=='auto'&&!completion(cfg.questions,a.answers,cfg.areas).complete)throw bad('أكمل البيانات المطلوبة قبل تأكيد الحضور أو بدء العمل');
    patch.stage=b.stage==='auto'?computedStage({...a,stage:'new'},cfg.questions,cfg.areas):b.stage;
    patch.lecture_at=b.stage==='auto'?null:(a.lecture_at||new Date().toISOString());
    patch.working_at=b.stage==='working'?new Date().toISOString():null;
    if(['lecture','working'].includes(b.stage)&&b.bot_enabled===undefined)patch.bot_enabled=false;
   }
   must(await db.from('masar_applicants').update(patch).eq('id',a.id));
   must(await db.from('masar_events').insert({applicant_id:a.id,kind:'staff_update',staff_id:req.user.id,detail:{stage:patch.stage,bot_enabled:patch.bot_enabled,notes_changed:b.notes!==undefined,resumed_message_id:resumedMessageId}}));
  });
  if(resumedMessageId)worker.tick();
  res.json({ok:true,resumed_message_id:resumedMessageId});
 });
 permissionRoute('applicants','post','/applicants/:id/reply',async(req,res)=>{
  const body=String(req.body.body||'').trim();if(!body||body.length>4000)throw bad('اكتب رسالة لا تتجاوز 4000 حرف');
  await serial(async()=>{
   const select=whatsapp.configured?'id,contact_id,whatsapp_account_id,answers':'id,contact_id,answers';
   const a=await applicantById(req,req.params.id,select);if(a.contact_id.startsWith('legacy:'))throw bad('لا يمكن الإرسال قبل وصول رسالة جديدة تكشف جهة اتصال واتساب');
   let settings=null;try{settings=must(await db.from('masar_settings').select('*').eq('id',true).single());}catch(e){if(!schemaMissing(e))throw e;}
   const runMode=effectiveRunMode(settings),answers={...(a.answers||{})};delete answers.__ai_handoff;
   const applicantPatch={answers,updated_at:new Date().toISOString()};
   if(runMode==='live')applicantPatch.bot_enabled=false;
   must(await db.from('masar_applicants').update(applicantPatch).eq('id',a.id));
   const row={applicant_id:a.id,direction:'out',sender:'staff',body,status:'queued'};if(whatsapp.configured)row.whatsapp_account_id=a.whatsapp_account_id;
   const staffMessage=must(await db.from('masar_messages').insert(row).select('id').single());
   if(settings?.ai_learning_enabled!==false){
    try{
     const source=must(await db.from('masar_messages').select('id,body').eq('applicant_id',a.id).eq('direction','in').order('sequence',{ascending:false}).limit(1).maybeSingle());
     if(source)await createLearningSuggestion(db,{applicantId:a.id,sourceMessage:source,staffMessageId:staffMessage.id,answer:body,staffId:req.user.id,force:runMode==='training'});
    }catch(e){if(!schemaMissing(e))throw e;}
   }
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
   const a=must(await db.from('masar_applicants').select('id').eq('id',req.params.id).single());
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
  res.json({ok:true,media_cleanup_ok});
 });
 permissionRoute('reports','get','/reports',async(req,res)=>{
  const {rows,areas}=await applicantList(req),catalog=await campaignCatalog(true);
  const base=summaryFor(rows),stages=base.stages;
  const zones=areas.map(z=>({name:z.name,count:rows.filter(a=>Object.values(a.answers||{}).some(v=>v?.kind==='area'&&v.value===z.id)).length}));
  const days={};for(const a of rows){const day=new Date(a.created_at).toLocaleDateString('en-CA',{timeZone:'Africa/Cairo'});days[day]=(days[day]||0)+1;}
  const campaignById=new Map(catalog.campaigns.map(x=>[x.id,x])),adById=new Map(catalog.ads.map(x=>[x.ad_id,x]));
  const adIds=[...new Set(rows.map(a=>String(attributionOf(a)?.source_id||'')).filter(Boolean))],visibleAdIds=new Set(adIds);
  const relevantAds=catalog.ads.filter(x=>visibleAdIds.has(x.ad_id));
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
   total:base.total,stages,areas:zones,days:Object.entries(days).sort().map(([date,count])=>({date,count})),completed:base.completed,
   attributed:rows.filter(a=>Boolean(attributionOf(a)?.source_id)).length,unattributed:rows.filter(a=>!attributionOf(a)?.source_id).length,
   spend:selectedSpend,costs:{per_lead:div(base.total),per_complete:div(base.completed),per_lecture:div(stages.lecture),per_working:div(stages.working)},
   ad_breakdown,campaign_breakdown
  });
 });
 permissionRoute('reports','get','/reports.csv',async(req,res)=>{
  const {rows}=await applicantList(req),catalog=await campaignCatalog(true),campaignById=new Map(catalog.campaigns.map(x=>[x.id,x])),adById=new Map(catalog.ads.map(x=>[x.ad_id,x]));
  const accountById=new Map((await accountRows(req)).map(x=>[x.id,x]));
  const lines=[['رقم واتساب المتقدم','حساب واتساب المستلم','رقم الحساب المستلم','الاسم','الحالة','المنطقة','اكتمال البيانات','الحملة','Ad ID','اسم الإعلان','CTWA Click ID','مصروف الإعلان المسجل','مصدر الإعلان','رابط الإعلان','تاريخ التسجيل'],...rows.map(a=>{
   const ref=attributionOf(a)||{},ad=adById.get(String(ref.source_id||'')),campaign=campaignById.get(ad?.campaign_id),account=accountById.get(a.whatsapp_account_id);
   return [a.phone||'غير متاح',account?.name||'',account?.phone||'',Object.values(a.answers||{}).find(v=>v?.kind==='name')?.display||a.display_name,STAGES[a.stage],Object.values(a.answers||{}).find(v=>v?.kind==='area')?.display||'',a.completion.percent+'%',campaign?.name||'',ref.source_id||'',ad?.name||ad?.headline||ref.title||'',ref.ctwa_clid||'',Number(ad?.spend||0),ref.source_app||ref.source_type||'',ref.source_url||'',a.created_at];
  })];res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="speed-delivery-campaign-report.csv"');res.send('\uFEFF'+lines.map(row=>row.map(csvCell).join(',')).join('\r\n'));
 });
 async function normalizedStaffAccountIds(value){
  if(!whatsapp.configured)return [];
  if(!Array.isArray(value))throw bad('حدد أرقام واتساب المسموح بها');
  const requested=[...new Set(value.map(String))];
  if(requested.some(id=>!uuid(id)))throw bad('أحد أرقام واتساب المختارة غير صحيح');
  const available=(await whatsapp.snapshots()).map(x=>x.id);
  if(requested.some(id=>!available.includes(id)))throw bad('تم تغيير قائمة أرقام واتساب؛ حدّث الصفحة');
  return requested;
 }
 async function saveStaffAccountAccess(userId,ids){
  if(!whatsapp.configured)return;
  must(await db.from('masar_staff_whatsapp_access').delete().eq('user_id',userId));
  if(ids.length)must(await db.from('masar_staff_whatsapp_access').insert(ids.map(whatsapp_account_id=>({user_id:userId,whatsapp_account_id}))));
 }
 async function staffRows(){
  const rows=must(await db.from('masar_staff').select('user_id,created_at').order('created_at',{ascending:true}));
  const {data,error}=await db.auth.admin.listUsers({page:1,perPage:1000});if(error)throw error;
  const byId=new Map((data.users||[]).map(u=>[u.id,u]));
  const access=whatsapp.configured?must(await db.from('masar_staff_whatsapp_access').select('user_id,whatsapp_account_id')):[];
  const accessByUser=new Map();
  for(const row of access){if(!accessByUser.has(row.user_id))accessByUser.set(row.user_id,[]);accessByUser.get(row.user_id).push(row.whatsapp_account_id);}
  const accounts=(await whatsapp.snapshots()).map(({id,name,phone,status})=>({id,name,phone,status}));
  const items=rows.map(r=>{const u=byId.get(r.user_id),role=u?.app_metadata?.masar_role==='recruiter'?'recruiter':'admin';return {
   id:r.user_id,name:String(u?.user_metadata?.full_name||''),email:u?.email||'',role,
   permissions:role==='admin'?[...PERMISSIONS]:cleanPermissions(u?.app_metadata?.masar_permissions),
   whatsapp_account_ids:role==='admin'?accounts.map(x=>x.id):accessByUser.get(r.user_id)||[],
   created_at:r.created_at,last_sign_in_at:u?.last_sign_in_at||null
  };});
  return {items,whatsapp_accounts:accounts,multi_whatsapp_configured:whatsapp.configured};
 }
 async function recruiterTarget(id){
  if(!uuid(id))throw bad('معرف الحساب غير صحيح');
  const target=await db.auth.admin.getUserById(id);if(target.error||!target.data.user)throw bad('الحساب غير موجود',404);
  if(target.data.user.app_metadata?.masar_role!=='recruiter')throw bad('يمكن تعديل حسابات مسؤولي التوظيف فقط',403);
  return target.data.user;
 }
 adminRoute('get','/staff',async(_req,res)=>res.json(await staffRows()));
 adminRoute('post','/staff',async(req,res)=>{
  const name=String(req.body.name||'').trim(),email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||''),permissions=cleanPermissions(req.body.permissions);
  const accountIds=await normalizedStaffAccountIds(req.body.whatsapp_account_ids||[]);
  if(name.length<2||name.length>100)throw bad('اكتب اسم مسؤول التوظيف');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw bad('اكتب بريد إلكتروني صحيح');
  if(password.length<8||password.length>100)throw bad('كلمة المرور لازم تكون 8 أحرف على الأقل');
  if(whatsapp.configured&&!accountIds.length)throw bad('اختر رقم واتساب واحد على الأقل للمسؤول');
  const created=await db.auth.admin.createUser({email,password,email_confirm:true,app_metadata:{masar_role:'recruiter',masar_permissions:permissions},user_metadata:{full_name:name}});
  if(created.error)throw bad(created.error.message.includes('already')?'البريد الإلكتروني مستخدم بالفعل':'تعذر إنشاء الحساب');
  try{must(await db.from('masar_staff').insert({user_id:created.data.user.id}));await saveStaffAccountAccess(created.data.user.id,accountIds);}
  catch(e){await db.auth.admin.deleteUser(created.data.user.id).catch(()=>{});throw e;}
  res.status(201).json({id:created.data.user.id,name,email,role:'recruiter',permissions,whatsapp_account_ids:accountIds});
 });
 adminRoute('put','/staff/:id',async(req,res)=>{
  const target=await recruiterTarget(req.params.id),name=String(req.body.name||'').trim(),email=String(req.body.email||'').trim().toLowerCase();
  if(name.length<2||name.length>100)throw bad('اكتب اسم مسؤول التوظيف');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw bad('اكتب بريد إلكتروني صحيح');
  if(!Array.isArray(req.body.permissions))throw bad('حدد صلاحيات الحساب');
  const permissions=cleanPermissions(req.body.permissions),accountIds=await normalizedStaffAccountIds(req.body.whatsapp_account_ids||[]);
  if(whatsapp.configured&&!accountIds.length)throw bad('اختر رقم واتساب واحد على الأقل للمسؤول');
  const changed=await db.auth.admin.updateUserById(req.params.id,{email,email_confirm:true,user_metadata:{...(target.user_metadata||{}),full_name:name},app_metadata:{...(target.app_metadata||{}),masar_role:'recruiter',masar_permissions:permissions}});
  if(changed.error)throw bad(changed.error.message.includes('already')?'البريد الإلكتروني مستخدم بالفعل':'تعذر تعديل الحساب');
  await saveStaffAccountAccess(req.params.id,accountIds);
  res.json({id:req.params.id,name,email,role:'recruiter',permissions,whatsapp_account_ids:accountIds});
 });
 adminRoute('put','/staff/:id/password',async(req,res)=>{
  await recruiterTarget(req.params.id);const password=String(req.body.password||'');if(password.length<8||password.length>100)throw bad('كلمة المرور لازم تكون 8 أحرف على الأقل');
  const changed=await db.auth.admin.updateUserById(req.params.id,{password});if(changed.error)throw changed.error;res.json({ok:true});
 });
 adminRoute('delete','/staff/:id',async(req,res)=>{
  const target=await recruiterTarget(req.params.id);
  must(await db.from('masar_events').update({staff_id:null}).eq('staff_id',req.params.id));
  must(await db.from('masar_events').insert({kind:'staff_account_deleted',staff_id:req.user.id,detail:{deleted_user_id:req.params.id,deleted_name:String(target.user_metadata?.full_name||''),deleted_email:target.email||''}}));
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
 permissionRoute('questions','post','/questions/defaults',async(_req,res)=>{await serial(async()=>{
  const existing=must(await db.from('masar_questions').select('id').limit(1));if(existing.length)throw bad('الأسئلة موجودة بالفعل؛ استخدم صفحة الأسئلة لتعديلها');
  must(await db.from('masar_questions').insert([
   {field_key:'full_name',label:'اسمك بالكامل إيه؟',kind:'name'},
   {field_key:'age',label:'عندك كام سنة؟',kind:'number'},
   {field_key:'area',label:'حابب تشتغل في أنهي منطقة؟',kind:'area'},
   {field_key:'motorcycle',label:'معاك موتوسيكل؟',kind:'yes_no'},
   {field_key:'license',label:'معاك رخصة موتوسيكل سارية؟',kind:'yes_no'},
   {field_key:'document',label:'ابعت المستند المطلوب للتقديم بعد مراجعة مسؤول التوظيف لنوعه.',kind:'image',required:false,active:false}
  ].map((q,i)=>({...q,required:q.required!==false,active:q.active!==false,position:i+1}))));
 });res.json({ok:true});});
 if(dashboardDist&&fs.existsSync(dashboardDist)){
  app.use(express.static(dashboardDist,{index:false}));
  app.use((req,res,next)=>{if(req.method==='GET'&&!req.path.startsWith('/api')&&req.path!=='/health')return res.sendFile(path.join(dashboardDist,'index.html'));next();});
 }
 app.use((error,_req,res,_next)=>{console.error('API:',{code:error.code||error.name,message:error.message,details:error.details,hint:error.hint});res.status(error.status||500).json({error:error.status?error.message:error.code==='23505'?'الاسم أو مفتاح البيانات مستخدم بالفعل':'تعذر إتمام العملية. راجع إعداد قاعدة البيانات واتصال الخدمة.'});});return app;
}
