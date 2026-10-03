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
const PERMISSIONS=new Set(['applicants','areas','reports','questions','whatsapp','settings']);
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
 async function applicantList(req){
  const c=await config(db);let rows=(await allRows(db,'masar_applicants')).map(a=>({...a,stage:computedStage(a,c.questions,c.areas),completion:completion(c.questions,a.answers,c.areas)}));
  if(req.query.search){const s=String(req.query.search).toLowerCase();rows=rows.filter(a=>(a.phone||'').includes(s)||a.display_name.toLowerCase().includes(s)||Object.values(a.answers).some(v=>v.kind==='name'&&String(v.value).toLowerCase().includes(s)));}
  if(req.query.stage)rows=rows.filter(a=>a.stage===req.query.stage);
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
  const {rows,areas}=await applicantList(req);const stages=Object.fromEntries(Object.keys(STAGES).map(k=>[k,rows.filter(a=>a.stage===k).length]));
  const zones=areas.map(z=>({name:z.name,count:rows.filter(a=>Object.values(a.answers).some(v=>v.kind==='area'&&v.value===z.id)).length}));
  const days={};for(const a of rows){const day=new Date(a.created_at).toLocaleDateString('en-CA',{timeZone:'Africa/Cairo'});days[day]=(days[day]||0)+1;}
  res.json({total:rows.length,stages,areas:zones,days:Object.entries(days).sort().map(([date,count])=>({date,count})),completed:rows.filter(a=>['complete','lecture','working'].includes(a.stage)).length});
 });
 permissionRoute('reports','get','/reports.csv',async(req,res)=>{
  const {rows}=await applicantList(req);const lines=[['رقم واتساب','الاسم','الحالة','المنطقة','اكتمال البيانات','تاريخ التسجيل'],...rows.map(a=>[a.phone||'غير متاح',Object.values(a.answers).find(v=>v.kind==='name')?.display||a.display_name,STAGES[a.stage],Object.values(a.answers).find(v=>v.kind==='area')?.display||'',a.completion.percent+'%',a.created_at])];res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="masar-report.csv"');res.send('\uFEFF'+lines.map(row=>row.map(csvCell).join(',')).join('\r\n'));
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
