import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import {rateLimit} from 'express-rate-limit';
import {must,allRows,config} from './db.js';
import {STAGES,computedStage,completion,csvCell} from './domain.js';
import {legacyImport} from './legacy.js';
import fs from 'node:fs';
import path from 'node:path';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v);
function bad(message,status=400){return Object.assign(new Error(message),{status});}
const PERMISSIONS=new Set(['applicants','areas','reports','campaigns','questions','whatsapp','settings']);
const DEFAULT_RECRUITER_PERMISSIONS=['applicants','areas','reports'];
const cleanPermissions=value=>Array.isArray(value)?[...new Set(value.filter(v=>PERMISSIONS.has(v)))]:[...DEFAULT_RECRUITER_PERMISSIONS];
export function makeApi({db,connection,worker,serial,origins,dashboardDist=null}){
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
 route('get','/bootstrap',async(req,res)=>{const cfg=await config(db);const profile={name:String(req.user.user_metadata?.full_name||''),email:req.user.email||'',role:req.role};const payload={role:req.role,permissions:req.permissions,profile,ai_configured:true,ai_provider:'local'};if(req.role==='admin'||req.permissions.includes('areas'))payload.areas=cfg.areas;if(req.role==='admin'||req.permissions.includes('questions'))payload.questions=cfg.questions;if(req.role==='admin'||req.permissions.includes('settings'))payload.settings=cfg.settings;res.json(payload);});
 permissionRoute('whatsapp','get','/whatsapp',async(_r,res)=>res.json({...connection.snapshot(),worker_error:worker.lastError}));
 permissionRoute('whatsapp','post','/whatsapp/connect',async(_r,res)=>{await connection.connect();res.json(connection.snapshot());});
 permissionRoute('whatsapp','post','/whatsapp/disconnect',async(_r,res)=>{await connection.disconnect();res.json(connection.snapshot());});
 permissionRoute('settings','put','/settings',async(req,res)=>{const b=req.body;if(typeof b.ai_enabled!=='boolean'||!String(b.welcome||'').trim()||!String(b.completion||'').trim()||b.welcome.length>1500||b.completion.length>1500)throw bad('راجع إعدادات الرسائل');must(await db.from('masar_settings').update({ai_enabled:b.ai_enabled,welcome:b.welcome,completion:b.completion}).eq('id',true));res.json({ok:true});});
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
 async function campaignCatalog(){
  try{
   const [campaigns,ads]=await Promise.all([
    db.from('masar_campaigns').select('*').order('created_at',{ascending:true}),
    db.from('masar_ads').select('*').order('last_seen_at',{ascending:false})
   ]);
   return {campaigns:must(campaigns),ads:must(ads)};
  }catch(e){
   if(['PGRST205','42P01','42703'].includes(e.code))throw bad('فعّل جداول تتبع الحملات أولاً بتشغيل ملف supabase/002_campaign_attribution.sql في Supabase SQL Editor.',503);
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
 permissionRoute('campaigns','get','/campaigns',async(_req,res)=>{
  const {campaigns,ads}=await discoverAds();
  const cfg=await config(db),applicants=(await allRows(db,'masar_applicants')).map(a=>({...a,stage:computedStage(a,cfg.questions,cfg.areas),completion:completion(cfg.questions,a.answers,cfg.areas)}));
  const stats=Object.fromEntries(ads.map(ad=>[ad.ad_id,summaryFor(applicants.filter(a=>attributionOf(a)?.source_id===ad.ad_id))]));
  res.json({campaigns,ads:ads.map(ad=>({...ad,stats:stats[ad.ad_id]}))});
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
 permissionRoute('reports','get','/reports/options',async(_req,res)=>{
  const {campaigns,ads}=await discoverAds();res.json({campaigns,ads});
 });

 async function applicantList(req){
  const c=await config(db);let rows=(await allRows(db,'masar_applicants')).map(a=>({...a,stage:computedStage(a,c.questions,c.areas),completion:completion(c.questions,a.answers,c.areas)}));
  if(req.query.search){const s=String(req.query.search).toLowerCase();rows=rows.filter(a=>(a.phone||'').includes(s)||a.display_name.toLowerCase().includes(s)||Object.values(a.answers).some(v=>v.kind==='name'&&String(v.value).toLowerCase().includes(s)));}
  if(req.query.stage)rows=rows.filter(a=>a.stage===req.query.stage);
  if(req.query.ad_id)rows=rows.filter(a=>String(attributionOf(a)?.source_id||'')===String(req.query.ad_id));
  if(req.query.campaign_id){
   if(!uuid(String(req.query.campaign_id)))throw bad('معرف الحملة غير صحيح');
   const {ads}=await campaignCatalog(),ids=new Set(ads.filter(ad=>ad.campaign_id===req.query.campaign_id).map(ad=>ad.ad_id));
   rows=rows.filter(a=>ids.has(String(attributionOf(a)?.source_id||'')));
  }
  if(req.query.from)rows=rows.filter(a=>a.created_at>=req.query.from);
  if(req.query.to)rows=rows.filter(a=>a.created_at<req.query.to);
  return {rows:rows.sort((a,b)=>b.created_at.localeCompare(a.created_at)),...c};
 }
 permissionRoute('applicants','get','/applicants',async(req,res)=>{const {rows}=await applicantList(req);const page=Math.max(1,parseInt(req.query.page)||1);res.json({items:rows.slice((page-1)*30,page*30),total:rows.length,page});});
 permissionRoute('applicants','get','/applicants/:id',async(req,res)=>{
  const a=must(await db.from('masar_applicants').select('*').eq('id',req.params.id).single());const c=await config(db);
  const before=req.query.before;let query=db.from('masar_messages').select('*').eq('applicant_id',a.id).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(101);
  // Timestamp+ID cursor prevents omission when timestamps coincide.
  if(before){const [time,id]=String(before).split('|');if(!uuid(id)||!Number.isFinite(Date.parse(time)))throw bad('مؤشر غير صحيح');query=query.or(`created_at.lt.${time},and(created_at.eq.${time},id.lt.${id})`);}
  const all=must(await query);const has_more=all.length>100;const messages=all.slice(0,100);const last=messages.at(-1);
  for(const m of messages){if(m.media_path){const signed=await db.storage.from('masar-documents').createSignedUrl(m.media_path,600);m.media_url=signed.data?.signedUrl||null;}}
  const events=must(await db.from('masar_events').select('*').eq('applicant_id',a.id).order('created_at',{ascending:false}).limit(50));
  res.json({applicant:{...a,stage:computedStage(a,c.questions,c.areas),completion:completion(c.questions,a.answers,c.areas)},messages:messages.reverse(),events,has_more,next_cursor:last?last.created_at+'|'+last.id:null});
 });
 permissionRoute('applicants','patch','/applicants/:id',async(req,res)=>{await serial(async()=>{
  const a=must(await db.from('masar_applicants').select('*').eq('id',req.params.id).single());const b=req.body;const patch={updated_at:new Date().toISOString()};
  if(b.notes!==undefined){if(typeof b.notes!=='string'||b.notes.length>4000)throw bad('الملاحظات لا تتجاوز 4000 حرف');patch.notes=b.notes;}
  if(b.bot_enabled!==undefined){if(typeof b.bot_enabled!=='boolean')throw bad('قيمة غير صحيحة');patch.bot_enabled=b.bot_enabled;}
  if(b.stage!==undefined){if(!['lecture','working','auto'].includes(b.stage))throw bad('حالة غير صحيحة');const c=await config(db);if(b.stage!=='auto'&&!completion(c.questions,a.answers,c.areas).complete)throw bad('أكمل البيانات المطلوبة قبل تأكيد الحضور أو بدء العمل');patch.stage=b.stage==='auto'?computedStage({...a,stage:'new'},c.questions,c.areas):b.stage;patch.lecture_at=b.stage==='auto'?null:(a.lecture_at||new Date().toISOString());patch.working_at=b.stage==='working'?new Date().toISOString():null;}
  must(await db.from('masar_applicants').update(patch).eq('id',a.id));
  must(await db.from('masar_events').insert({applicant_id:a.id,kind:'staff_update',staff_id:req.user.id,detail:{stage:patch.stage,bot_enabled:patch.bot_enabled,notes_changed:b.notes!==undefined}}));res.json({ok:true});
 });});
 permissionRoute('applicants','post','/applicants/:id/reply',async(req,res)=>{const body=String(req.body.body||'').trim();if(!body||body.length>4000)throw bad('اكتب رسالة لا تتجاوز 4000 حرف');await serial(async()=>{const a=must(await db.from('masar_applicants').select('id,contact_id').eq('id',req.params.id).single());if(a.contact_id.startsWith('legacy:'))throw bad('لا يمكن الإرسال قبل وصول رسالة جديدة تكشف جهة اتصال واتساب');must(await db.from('masar_applicants').update({bot_enabled:false}).eq('id',a.id));must(await db.from('masar_messages').insert({applicant_id:a.id,direction:'out',sender:'staff',body,status:'queued'}));});res.json({ok:true});});
 permissionRoute('applicants','post','/messages/:id/retry',async(req,res)=>{await serial(async()=>{const m=must(await db.from('masar_messages').select('*').eq('id',req.params.id).single());if(!['failed','uncertain'].includes(m.status))throw bad('هذه الرسالة لا تحتاج إعادة محاولة');if(m.status==='uncertain'&&req.body.confirm!==true)throw bad('راجع واتساب ثم أكد إعادة الإرسال');must(await db.from('masar_messages').update({status:m.direction==='in'?'pending':'queued',attempts:0,error:null}).eq('id',m.id));});res.json({ok:true});});
 permissionRoute('reports','get','/reports',async(req,res)=>{
  const {rows,areas}=await applicantList(req),catalog=await campaignCatalog();
  const base=summaryFor(rows),stages=base.stages;
  const zones=areas.map(z=>({name:z.name,count:rows.filter(a=>Object.values(a.answers||{}).some(v=>v?.kind==='area'&&v.value===z.id)).length}));
  const days={};for(const a of rows){const day=new Date(a.created_at).toLocaleDateString('en-CA',{timeZone:'Africa/Cairo'});days[day]=(days[day]||0)+1;}
  const campaignById=new Map(catalog.campaigns.map(x=>[x.id,x])),adById=new Map(catalog.ads.map(x=>[x.ad_id,x]));
  const adIds=[...new Set(rows.map(a=>String(attributionOf(a)?.source_id||'')).filter(Boolean))];
  const ad_breakdown=adIds.map(adId=>{const subset=rows.filter(a=>String(attributionOf(a)?.source_id||'')===adId),ad=adById.get(adId),s=summaryFor(subset);return {
   ad_id:adId,name:ad?.name||ad?.headline||'',campaign_id:ad?.campaign_id||null,campaign_name:campaignById.get(ad?.campaign_id)?.name||'غير مربوط بحملة',
   spend:Number(ad?.spend||0),...s
  };}).sort((a,b)=>b.total-a.total);
  const campaignIds=[...new Set(ad_breakdown.map(x=>x.campaign_id).filter(Boolean))];
  const campaign_breakdown=campaignIds.map(id=>{const adSet=new Set(catalog.ads.filter(x=>x.campaign_id===id).map(x=>x.ad_id)),subset=rows.filter(a=>adSet.has(String(attributionOf(a)?.source_id||''))),s=summaryFor(subset);return {
   id,name:campaignById.get(id)?.name||'حملة',spend:catalog.ads.filter(x=>x.campaign_id===id).reduce((n,x)=>n+Number(x.spend||0),0),...s
  };}).sort((a,b)=>b.total-a.total);
  const selectedSpend=req.query.ad_id?Number(adById.get(String(req.query.ad_id))?.spend||0):
   req.query.campaign_id?catalog.ads.filter(x=>x.campaign_id===req.query.campaign_id).reduce((n,x)=>n+Number(x.spend||0),0):
   catalog.ads.reduce((n,x)=>n+Number(x.spend||0),0);
  const div=n=>n?Math.round(selectedSpend/n*100)/100:null;
  res.json({
   total:base.total,stages,areas:zones,days:Object.entries(days).sort().map(([date,count])=>({date,count})),completed:base.completed,
   attributed:rows.filter(a=>Boolean(attributionOf(a)?.source_id)).length,unattributed:rows.filter(a=>!attributionOf(a)?.source_id).length,
   spend:selectedSpend,costs:{per_lead:div(base.total),per_complete:div(base.completed),per_lecture:div(stages.lecture),per_working:div(stages.working)},
   ad_breakdown,campaign_breakdown
  });
 });
 permissionRoute('reports','get','/reports.csv',async(req,res)=>{
  const {rows}=await applicantList(req),catalog=await campaignCatalog(),campaignById=new Map(catalog.campaigns.map(x=>[x.id,x])),adById=new Map(catalog.ads.map(x=>[x.ad_id,x]));
  const lines=[['رقم واتساب','الاسم','الحالة','المنطقة','اكتمال البيانات','الحملة','Ad ID','اسم الإعلان','CTWA Click ID','مصروف الإعلان المسجل','مصدر الإعلان','رابط الإعلان','تاريخ التسجيل'],...rows.map(a=>{
   const ref=attributionOf(a)||{},ad=adById.get(String(ref.source_id||'')),campaign=campaignById.get(ad?.campaign_id);
   return [a.phone||'غير متاح',Object.values(a.answers||{}).find(v=>v?.kind==='name')?.display||a.display_name,STAGES[a.stage],Object.values(a.answers||{}).find(v=>v?.kind==='area')?.display||'',a.completion.percent+'%',campaign?.name||'',ref.source_id||'',ad?.name||ad?.headline||ref.title||'',ref.ctwa_clid||'',Number(ad?.spend||0),ref.source_app||ref.source_type||'',ref.source_url||'',a.created_at];
  })];res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="speed-delivery-campaign-report.csv"');res.send('\uFEFF'+lines.map(row=>row.map(csvCell).join(',')).join('\r\n'));
 });
 async function staffRows(){
  const rows=must(await db.from('masar_staff').select('user_id,created_at').order('created_at',{ascending:true}));
  const {data,error}=await db.auth.admin.listUsers({page:1,perPage:1000});if(error)throw error;
  const byId=new Map((data.users||[]).map(u=>[u.id,u]));
  return rows.map(r=>{const u=byId.get(r.user_id);const role=u?.app_metadata?.masar_role==='recruiter'?'recruiter':'admin';return {id:r.user_id,name:String(u?.user_metadata?.full_name||''),email:u?.email||'',role,permissions:role==='admin'?[...PERMISSIONS]:cleanPermissions(u?.app_metadata?.masar_permissions),created_at:r.created_at,last_sign_in_at:u?.last_sign_in_at||null};});
 }
 async function recruiterTarget(id){
  if(!uuid(id))throw bad('معرف الحساب غير صحيح');
  const target=await db.auth.admin.getUserById(id);if(target.error||!target.data.user)throw bad('الحساب غير موجود',404);
  if(target.data.user.app_metadata?.masar_role!=='recruiter')throw bad('يمكن تعديل حسابات مسؤولي التوظيف فقط',403);
  return target.data.user;
 }
 adminRoute('get','/staff',async(_req,res)=>res.json({items:await staffRows()}));
 adminRoute('post','/staff',async(req,res)=>{
  const name=String(req.body.name||'').trim(),email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||''),permissions=cleanPermissions(req.body.permissions);
  if(name.length<2||name.length>100)throw bad('اكتب اسم مسؤول التوظيف');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw bad('اكتب بريد إلكتروني صحيح');
  if(password.length<8||password.length>100)throw bad('كلمة المرور لازم تكون 8 أحرف على الأقل');
  const created=await db.auth.admin.createUser({email,password,email_confirm:true,app_metadata:{masar_role:'recruiter',masar_permissions:permissions},user_metadata:{full_name:name}});
  if(created.error)throw bad(created.error.message.includes('already')?'البريد الإلكتروني مستخدم بالفعل':'تعذر إنشاء الحساب');
  try{must(await db.from('masar_staff').insert({user_id:created.data.user.id}));}
  catch(e){await db.auth.admin.deleteUser(created.data.user.id).catch(()=>{});throw e;}
  res.status(201).json({id:created.data.user.id,name,email,role:'recruiter',permissions});
 });
 adminRoute('put','/staff/:id',async(req,res)=>{
  const target=await recruiterTarget(req.params.id);const name=String(req.body.name||'').trim(),email=String(req.body.email||'').trim().toLowerCase();
  if(name.length<2||name.length>100)throw bad('اكتب اسم مسؤول التوظيف');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw bad('اكتب بريد إلكتروني صحيح');
  if(!Array.isArray(req.body.permissions))throw bad('حدد صلاحيات الحساب');
  const permissions=cleanPermissions(req.body.permissions);
  const changed=await db.auth.admin.updateUserById(req.params.id,{email,email_confirm:true,user_metadata:{...(target.user_metadata||{}),full_name:name},app_metadata:{...(target.app_metadata||{}),masar_role:'recruiter',masar_permissions:permissions}});
  if(changed.error)throw bad(changed.error.message.includes('already')?'البريد الإلكتروني مستخدم بالفعل':'تعذر تعديل الحساب');
  res.json({id:req.params.id,name,email,role:'recruiter',permissions});
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
