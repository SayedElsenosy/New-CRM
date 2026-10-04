import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import {rateLimit} from 'express-rate-limit';
import {must,allRows,config} from './db.js';
import {STAGES,computedStage,completion,csvCell} from './domain.js';
import {schemaMissing,suggestKeywords,findKnowledgeAnswer,createLearningSuggestion} from './knowledge.js';
import {legacyImport} from './legacy.js';
import {validExpoPushToken} from './push.js';
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
   let access=[];
   if(['admin','office_admin'].includes(req.role)){
    try{access=must(await db.from('masar_staff_whatsapp_access').select('user_id,whatsapp_account_id'));}catch(e){if(!schemaMissing(e))throw e;}
   }
   const accountOffice=new Map(dbAccounts.map(x=>[x.id,x.office_id]));
   const publicAccounts=visibleAccounts.map(x=>{const live=snapshots.get(x.id)||{};return {id:x.id,name:x.name,phone:live.phone||x.phone||null,status:live.status||'disconnected',active:x.active,office_id:x.office_id||null};});
   return {configured:true,whatsapp_accounts:publicAccounts,items:offices.map(o=>{
    const accounts=publicAccounts.filter(x=>x.office_id===o.id);
    const applicantSubset=visibleApplicants.filter(x=>x.office_id===o.id);
    const staffIds=new Set(access.filter(x=>accountOffice.get(x.whatsapp_account_id)===o.id).map(x=>x.user_id));
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
 route('get','/offices',async(req,res)=>res.json(await officeState(req)));
 adminRoute('post','/offices',async(req,res)=>{await serial(async()=>{
  const name=String(req.body.name||'').trim(),code=String(req.body.code||'').trim().toUpperCase(),address=String(req.body.address||'').trim(),phone=String(req.body.phone||'').trim()||null,manager=String(req.body.manager_name||'').trim();
  if(name.length<2||name.length>120)throw bad('اكتب اسم واضح للمكتب');
  if(!/^[A-Z0-9_-]{2,30}$/.test(code))throw bad('كود المكتب يكون حروف إنجليزية أو أرقام فقط');
  if(address.length>300||manager.length>120)throw bad('راجع بيانات المكتب');
  const row=must(await db.from('masar_offices').insert({name,code,address,phone,manager_name:manager,active:req.body.active!==false}).select().single());
  await saveOfficeAccounts(row.id,req.body.whatsapp_account_ids||[]);
  res.status(201).json(row);
 });});
 adminRoute('put','/offices/:id',async(req,res)=>{await serial(async()=>{
  await ensureOfficeAccess(req,req.params.id);
  const name=String(req.body.name||'').trim(),code=String(req.body.code||'').trim().toUpperCase(),address=String(req.body.address||'').trim(),phone=String(req.body.phone||'').trim()||null,manager=String(req.body.manager_name||'').trim();
  if(name.length<2||name.length>120)throw bad('اكتب اسم واضح للمكتب');
  if(!/^[A-Z0-9_-]{2,30}$/.test(code))throw bad('كود المكتب يكون حروف إنجليزية أو أرقام فقط');
  if(address.length>300||manager.length>120)throw bad('راجع بيانات المكتب');
  const row=must(await db.from('masar_offices').update({name,code,address,phone,manager_name:manager,active:req.body.active!==false,updated_at:new Date().toISOString()}).eq('id',req.params.id).select().single());
  await saveOfficeAccounts(row.id,req.body.whatsapp_account_ids);
  res.json(row);
 });});

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
 adminRoute('post','/whatsapp/accounts',async(req,res)=>{await serial(async()=>{
  if(!whatsapp.configured)throw bad('فعّل تعدد أرقام واتساب أولاً بتشغيل ملف supabase/003_multi_whatsapp.sql في Supabase SQL Editor.',503);
  const name=String(req.body.name||'').trim();if(name.length<2||name.length>80)throw bad('اكتب اسم واضح لرقم واتساب');
  const offices=await officeState(req),officeId=req.body.office_id?String(req.body.office_id):null;
  if(offices.configured&&!officeId)throw bad('اختر مكتب التوظيف الخاص برقم واتساب');
  if(officeId)await ensureOfficeAccess(req,officeId);
  const insertRow={name,legacy_session:false,active:true};if(officeId)insertRow.office_id=officeId;
  const row=must(await db.from('masar_whatsapp_accounts').insert(insertRow).select().single());
  await whatsapp.add(row);res.status(201).json(whatsapp.snapshot(row.id));
 });});
 adminRoute('put','/whatsapp/accounts/:id',async(req,res)=>{await serial(async()=>{
  if(!whatsapp.configured||!uuid(req.params.id))throw bad('معرف رقم واتساب غير صحيح');
  const name=String(req.body.name||'').trim();if(name.length<2||name.length>80)throw bad('اكتب اسم واضح لرقم واتساب');
  const patch={name,updated_at:new Date().toISOString()};if(req.body.office_id){const officeId=String(req.body.office_id);await ensureOfficeAccess(req,officeId);patch.office_id=officeId;}
  const row=must(await db.from('masar_whatsapp_accounts').update(patch).eq('id',req.params.id).select().single());
  const item=whatsapp.item?.(req.params.id);if(item)item.account={...item.account,...row};
  res.json(whatsapp.snapshot(req.params.id)||row);
 });});
 permissionRoute('whatsapp','post','/whatsapp/accounts/:id/connect',async(req,res)=>{await ensureAccountAccess(req,req.params.id);await whatsapp.connect(req.params.id);res.json(whatsapp.snapshot(req.params.id));});
 permissionRoute('whatsapp','post','/whatsapp/accounts/:id/disconnect',async(req,res)=>{await ensureAccountAccess(req,req.params.id);await whatsapp.disconnect(req.params.id);res.json(whatsapp.snapshot(req.params.id));});
 permissionRoute('settings','put','/settings',async(req,res)=>{
  const b=req.body;
  if(typeof b.ai_enabled!=='boolean'||!String(b.welcome||'').trim()||!String(b.completion||'').trim()||b.welcome.length>1500||b.completion.length>1500)throw bad('راجع إعدادات الرسائل');
  const patch={ai_enabled:b.ai_enabled,welcome:b.welcome,completion:b.completion};
  if(b.followup_enabled!==undefined||b.followup_hours!==undefined){
   const hours=Number(b.followup_hours);
   if(typeof b.followup_enabled!=='boolean'||!Number.isInteger(hours)||hours<1||hours>72)throw bad('متابعة البيانات الناقصة لازم تكون من 1 إلى 72 ساعة');
   patch.followup_enabled=b.followup_enabled;patch.followup_hours=hours;
  }
  try{must(await db.from('masar_settings').update(patch).eq('id',true));}
  catch(e){if(['42703','PGRST204'].includes(e?.code))throw bad('فعّل المتابعة التلقائية أولاً بتشغيل ملف supabase/007_applicant_followups.sql في Supabase SQL Editor.',503);throw e;}
  res.json({ok:true});
 });
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
  const cfg=await config(db),alertIds=await openAlertApplicantIds(req);let rows=(await allRows(db,'masar_applicants')).map(a=>({...a,recruitment_stage:recruitmentStageOf(a),stage:computedStage(a,cfg.questions,cfg.areas),completion:completion(cfg.questions,a.answers,cfg.areas),needs_intervention:alertIds.has(a.id)}));
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
  if(['1','true','yes'].includes(String(req.query.needs_intervention||'').toLowerCase()))rows=rows.filter(a=>a.needs_intervention);
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
  const a=await applicantById(req,req.params.id),cfg=await config(db);
  const before=req.query.before;let query=db.from('masar_messages').select('*').eq('applicant_id',a.id).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(101);
  if(before){const [time,id]=String(before).split('|');if(!uuid(id)||!Number.isFinite(Date.parse(time)))throw bad('مؤشر غير صحيح');query=query.or(`created_at.lt.${time},and(created_at.eq.${time},id.lt.${id})`);}
  const all=must(await query),has_more=all.length>100,messages=all.slice(0,100),last=messages.at(-1);
  for(const m of messages){if(m.media_path){const signed=await db.storage.from('masar-documents').createSignedUrl(m.media_path,600);m.media_url=signed.data?.signedUrl||null;}}
  const events=must(await db.from('masar_events').select('*').eq('applicant_id',a.id).order('created_at',{ascending:false}).limit(50));
  const account=whatsapp.configured?whatsapp.snapshot(a.whatsapp_account_id):null;
  let office=null;try{if(a.office_id)office=must(await db.from('masar_offices').select('id,name,code,address,phone,manager_name').eq('id',a.office_id).maybeSingle());}catch(e){if(!schemaMissing(e)&&e.code!=='42703')throw e;}
  res.json({applicant:{...a,recruitment_stage:recruitmentStageOf(a),stage:computedStage(a,cfg.questions,cfg.areas),completion:completion(cfg.questions,a.answers,cfg.areas),office,whatsapp_account:account?{id:account.id,name:account.name,phone:account.phone}:null},messages:messages.reverse(),events,has_more,next_cursor:last?last.created_at+'|'+last.id:null});
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
   const select=whatsapp.configured?'id,contact_id,whatsapp_account_id,answers':'id,contact_id,answers';
   const a=await applicantById(req,req.params.id,select);if(a.contact_id.startsWith('legacy:'))throw bad('لا يمكن الإرسال قبل وصول رسالة جديدة تكشف جهة اتصال واتساب');
   let settings=null;try{settings=must(await db.from('masar_settings').select('*').eq('id',true).single());}catch(e){if(!schemaMissing(e))throw e;}
   const runMode=effectiveRunMode(settings),answers={...(a.answers||{})};delete answers.__ai_handoff;
   const applicantPatch={answers,updated_at:new Date().toISOString()};
   if(runMode==='live'){
    applicantPatch.bot_enabled=false;
    must(await db.from('masar_messages').update({status:'processed',error:'تم إلغاء الرد الآلي بسبب رد بشري.'}).eq('applicant_id',a.id).eq('direction','out').eq('sender','bot').eq('status','queued'));
   }
   must(await db.from('masar_applicants').update(applicantPatch).eq('id',a.id));
   const row={applicant_id:a.id,direction:'out',sender:'staff',body,status:'queued'};if(whatsapp.configured)row.whatsapp_account_id=a.whatsapp_account_id;
   const staffMessage=must(await db.from('masar_messages').insert(row).select('id').single());
   if(settings?.ai_learning_enabled!==false){
    try{
     const source=must(await db.from('masar_messages').select('id,body').eq('applicant_id',a.id).eq('direction','in').order('sequence',{ascending:false}).limit(1).maybeSingle());
     if(source)await createLearningSuggestion(db,{applicantId:a.id,sourceMessage:source,staffMessageId:staffMessage.id,answer:body,staffId:req.user.id,force:runMode==='training'});
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
  const months=[];const now=new Date();for(let i=5;i>=0;i--){const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-i,1));months.push({key:d.toISOString().slice(0,7),label:d.toLocaleDateString('ar-EG',{month:'short',timeZone:'Africa/Cairo'}),count:0});}
  const monthMap=new Map(months.map(x=>[x.key,x]));for(const a of rows){const key=monthKey(a.created_at);if(monthMap.has(key))monthMap.get(key).count++;}
  const applicantById=new Map(rows.map(x=>[x.id,x]));
  const upcoming=interviews.filter(x=>x.status==='scheduled'&&Date.parse(x.scheduled_at)>=Date.now()-86400000).slice(0,5).map(x=>{const a=applicantById.get(x.applicant_id);return {...x,applicant_name:a?Object.values(a.answers||{}).find(v=>v?.kind==='name')?.display||a.display_name||'مرشح':'مرشح',applicant_phone:a?.phone||null,office:officeMap.get(x.office_id)||null};});
  res.json({
   configured:officeData.configured,offices:officeData.items,selected_office:req.query.office_id?officeMap.get(String(req.query.office_id))||null:null,
   metrics:{total:rows.length,interviews:interviews.filter(x=>x.status==='scheduled').length,offices:officeData.configured?(req.query.office_id?1:officeData.items.filter(x=>x.active).length):0,hired:stageCounts.hired},
   recruitment_stages:stageCounts,growth:months,recent:rows.slice(0,6).map(a=>applicantPublic(a,officeMap)),upcoming_interviews:upcoming
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
   total:base.total,stages,recruitment_stages:Object.fromEntries(RECRUITMENT_STAGES.map(x=>[x,rows.filter(a=>recruitmentStageOf(a)===x).length])),areas:zones,days:Object.entries(days).sort().map(([date,count])=>({date,count})),completed:base.completed,
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
  let accounts=(await whatsapp.snapshots()).map(({id,name,phone,status})=>({id,name,phone,status,office_id:null})),offices=[];
  try{
   const links=must(await db.from('masar_whatsapp_accounts').select('id,office_id'));
   const byAccount=new Map(links.map(x=>[x.id,x.office_id||null]));
   accounts=accounts.map(x=>({...x,office_id:byAccount.get(x.id)||null}));
   offices=must(await db.from('masar_offices').select('id,name,code,active').order('created_at',{ascending:true}));
  }catch(e){if(!schemaMissing(e)&&e.code!=='42703'&&e.code!=='PGRST204')throw e;}
  const items=rows.map(r=>{const u=byId.get(r.user_id),role=u?.app_metadata?.masar_role==='recruiter'?'recruiter':'admin';return {
   id:r.user_id,name:String(u?.user_metadata?.full_name||''),email:u?.email||'',role,
   permissions:role==='admin'?[...PERMISSIONS]:cleanPermissions(u?.app_metadata?.masar_permissions),
   whatsapp_account_ids:role==='admin'?accounts.map(x=>x.id):accessByUser.get(r.user_id)||[],
   created_at:r.created_at,last_sign_in_at:u?.last_sign_in_at||null
  };});
  return {items,whatsapp_accounts:accounts,offices,offices_configured:offices.length>0,multi_whatsapp_configured:whatsapp.configured};
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
 app.use((error,_req,res,_next)=>{const status=error.status||500;if(status>=500)console.error('API:',{code:error.code||error.name,message:error.message,details:error.details,hint:error.hint});res.status(status).json({error:error.status?error.message:error.code==='23505'?'الاسم أو مفتاح البيانات مستخدم بالفعل':'تعذر إتمام العملية. راجع إعداد قاعدة البيانات واتصال الخدمة.'});});return app;
}
