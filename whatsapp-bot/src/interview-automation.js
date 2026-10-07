import {must} from './db.js';
import {digits,norm} from './domain.js';

const CAIRO_TZ='Africa/Cairo';
const SCHEMA_CODES=new Set(['PGRST205','42P01','42703','PGRST204']);
const DAY_MS=86400000;
const WINDOW_MS=2*60*60*1000;
const WEEKDAY_ALIASES=[
 {day:0,names:['الاحد','الحد']},
 {day:1,names:['الاثنين','الاتنين']},
 {day:2,names:['الثلاثاء','التلات','التلاتاء']},
 {day:3,names:['الاربعاء','الاربع']},
 {day:4,names:['الخميس']},
 {day:5,names:['الجمعه','الجمعه']},
 {day:6,names:['السبت']}
];

function cairoParts(value){
 const date=value instanceof Date?value:new Date(value);
 const parts=new Intl.DateTimeFormat('en-CA',{
  timeZone:CAIRO_TZ,year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
 }).formatToParts(date);
 const out={};
 for(const part of parts)if(part.type!=='literal')out[part.type]=Number(part.value);
 return {year:out.year,month:out.month,day:out.day,hour:out.hour,minute:out.minute,second:out.second};
}
function cairoOffsetMs(date){
 const p=cairoParts(date);
 return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-date.getTime();
}
function cairoLocalToIso({year,month,day,hour,minute}){
 const wall=Date.UTC(year,month-1,day,hour,minute,0);
 let guess=wall;
 for(let i=0;i<3;i++)guess=wall-cairoOffsetMs(new Date(guess));
 return new Date(guess).toISOString();
}
function addDays(parts,count){
 const d=new Date(Date.UTC(parts.year,parts.month-1,parts.day)+count*DAY_MS);
 return {year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate()};
}
function hasLectureIntent(text){
 const n=norm(text);
 return /(?:محاضره|ليكتشر|lecture|مقابله|interview|انترفيو|ميعادك|معادك|موعدك|معاد الحضور|ميعاد الحضور|هتحضر|تحضر|الحضور)/.test(n);
}
function parseTime(text){
 const n=norm(digits(text));
 const m=n.match(/(?:الساعه|ساعه)\s*(\d{1,2})(?:\s*[:.]\s*(\d{1,2}))?\s*(ونص|وربع)?\s*(ص|م|am|pm|صباحا|صباح|مساء|مساءا|ظهرا|الظهر|عصرا|العصر|بالليل|ليل)?/i);
 if(!m)return null;
 let hour=Number(m[1]),minute=m[2]?Number(m[2]):m[3]==='ونص'?30:m[3]==='وربع'?15:0;
 if(hour<1||hour>12||minute<0||minute>59)return null;
 const period=String(m[4]||'').toLowerCase();
 const pm=period==='م'||period==='pm'||/(مساء|ظهر|عصر|ليل)/.test(period);
 const am=period==='ص'||period==='am'||/صباح/.test(period);
 if(pm&&hour<12)hour+=12;
 else if(am&&hour===12)hour=0;
 else if(!pm&&!am){
  if(hour>=1&&hour<=7)hour+=12;
  else if(hour===12)hour=12;
 }
 return {hour,minute};
}
function parseDate(text,reference,time){
 const n=norm(digits(text));
 const base=cairoParts(reference);
 const explicit=n.match(/(?:^|[^\d])(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?:\s*[\/\-.]\s*(\d{2,4}))?(?=$|[^\d])/);
 if(explicit){
  let day=Number(explicit[1]),month=Number(explicit[2]),year=explicit[3]?Number(explicit[3]):base.year;
  if(year<100)year+=2000;
  if(day<1||day>31||month<1||month>12)return null;
  const check=new Date(Date.UTC(year,month-1,day));
  if(check.getUTCFullYear()!==year||check.getUTCMonth()+1!==month||check.getUTCDate()!==day)return null;
  return {year,month,day};
 }
 if(n.includes('بعد بكره'))return addDays(base,2);
 if(n.includes('بكره')||n.includes('غدا'))return addDays(base,1);
 if(n.includes('النهارده')||n.includes('اليوم'))return {year:base.year,month:base.month,day:base.day};
 const weekday=WEEKDAY_ALIASES.find(x=>x.names.some(name=>n.includes(name)));
 if(weekday){
  const current=new Date(Date.UTC(base.year,base.month-1,base.day)).getUTCDay();
  let delta=(weekday.day-current+7)%7;
  if(delta===0){
   const targetMinutes=time.hour*60+time.minute,currentMinutes=base.hour*60+base.minute;
   if(targetMinutes<=currentMinutes+15)delta=7;
  }
  return addDays(base,delta);
 }
 return null;
}
export function extractInterviewSchedule(text,{reference=new Date()}={}){
 const time=parseTime(text);
 if(!time)return null;
 const day=parseDate(text,reference,time);
 if(!day)return null;
 const scheduled_at=cairoLocalToIso({...day,...time});
 const ref=reference instanceof Date?reference:new Date(reference);
 if(Date.parse(scheduled_at)<ref.getTime()-30*60*1000)return null;
 return {scheduled_at,local:{...day,...time}};
}
export function extractInterviewLocation(text){
 const raw=String(text||'').trim();
 if(!raw)return null;
 const urls=raw.match(/https?:\/\/[^\s]+/gi)||[];
 const mapUrl=urls.map(x=>x.replace(/[)،,.]+$/g,'')).find(url=>/(?:maps\.app\.goo\.gl|goo\.gl\/maps|google\.[^/\s]+\/maps|maps\.google\.|maps\.apple\.com)/i.test(url))||null;
 const label=raw.match(/(?:اللوكيشن|لوكيشن|المكان|العنوان)\s*[:：\-]?\s*([^\n]{2,300})/i);
 let labelText=label?String(label[1]||'').trim():null;
 if(labelText&&mapUrl)labelText=labelText.replace(mapUrl,'').replace(/^[\s:：\-]+|[\s،,.-]+$/g,'').trim()||null;
 if(!mapUrl&&!labelText)return null;
 return {url:mapUrl,text:labelText,display:labelText||mapUrl};
}
export function interviewSignalFromStaffMessages(messages,{windowMs=WINDOW_MS}={}){
 const rows=(messages||[]).filter(x=>x&&String(x.body||'').trim()&&Date.parse(x.created_at)).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at));
 if(!rows.length)return null;
 const latestAt=Date.parse(rows.at(-1).created_at);
 const recent=rows.filter(x=>latestAt-Date.parse(x.created_at)<=windowMs);
 if(!recent.some(x=>hasLectureIntent(x.body)))return null;
 let scheduleHit=null,locationHit=null;
 for(let i=recent.length-1;i>=0;i--){
  const row=recent[i];
  if(!scheduleHit){
   const schedule=extractInterviewSchedule(row.body,{reference:new Date(row.created_at)});
   if(schedule)scheduleHit={row,...schedule};
  }
  if(!locationHit){
   const location=extractInterviewLocation(row.body);
   if(location)locationHit={row,...location};
  }
 }
 if(!scheduleHit||!locationHit)return null;
 if(Date.parse(scheduleHit.scheduled_at)<latestAt-30*60*1000)return null;
 const ids=[...new Set([scheduleHit.row.id,locationHit.row.id].filter(Boolean).map(String))];
 return {
  scheduled_at:scheduleHit.scheduled_at,
  location:{url:locationHit.url||null,text:locationHit.text||null,display:locationHit.display},
  source_message_ids:ids,
  detected_from:recent.map(x=>String(x.body||'')).join('\n').slice(0,1800)
 };
}
function autoNotes(signal){
 const lines=[];
 if(signal.location.text)lines.push('📍 المكان: '+signal.location.text);
 if(signal.location.url)lines.push('🔗 اللوكيشن: '+signal.location.url);
 lines.push('تم تسجيل الموعد تلقائيًا من رسالة الموظف.');
 return lines.join('\n');
}
async function previousAutoInterview(db,applicantId){
 let events;
 try{
  events=must(await db.from('masar_events').select('detail,created_at').eq('applicant_id',applicantId).in('kind',['auto_interview_scheduled','auto_interview_updated']).order('created_at',{ascending:false}).limit(20));
 }catch(e){
  if(SCHEMA_CODES.has(e?.code))return null;
  throw e;
 }
 const ids=[...new Set(events.map(x=>x.detail?.interview_id).filter(Boolean))];
 for(const id of ids){
  const row=must(await db.from('masar_interviews').select('*').eq('id',id).maybeSingle());
  if(row?.status==='scheduled')return row;
 }
 return null;
}
export async function syncInterviewFromStaffMessages(db,{applicant,source='staff_whatsapp'}={}){
 if(!applicant?.id||!applicant?.office_id)return {applied:false,reason:'missing_applicant_office'};
 try{
  const rows=must(await db.from('masar_messages').select('id,body,created_at').eq('applicant_id',applicant.id).eq('direction','out').eq('sender','staff').eq('status','sent').order('sequence',{ascending:false}).limit(8));
  const signal=interviewSignalFromStaffMessages(rows);
  if(!signal)return {applied:false,reason:'no_complete_schedule_signal'};
  const notes=autoNotes(signal),now=new Date().toISOString();
  let interview=await previousAutoInterview(db,applicant.id),kind='auto_interview_scheduled';
  if(interview){
   if(Date.parse(interview.scheduled_at)!==Date.parse(signal.scheduled_at)||String(interview.notes||'')!==notes){
    interview=must(await db.from('masar_interviews').update({scheduled_at:signal.scheduled_at,notes,updated_at:now}).eq('id',interview.id).select().single());
    kind='auto_interview_updated';
   }else return {applied:false,reason:'already_synced',interview,signal};
  }else{
   const same=must(await db.from('masar_interviews').select('*').eq('applicant_id',applicant.id).eq('scheduled_at',signal.scheduled_at).eq('status','scheduled').limit(1).maybeSingle());
   if(same){
    const mergedNotes=String(same.notes||'').includes(signal.location.display)?String(same.notes||''):[String(same.notes||'').trim(),notes].filter(Boolean).join('\n');
    interview=must(await db.from('masar_interviews').update({notes:mergedNotes,updated_at:now}).eq('id',same.id).select().single());
    kind='auto_interview_updated';
   }else{
    interview=must(await db.from('masar_interviews').insert({
     applicant_id:applicant.id,office_id:applicant.office_id,scheduled_at:signal.scheduled_at,status:'scheduled',notes
    }).select().single());
   }
  }
  if(!['accepted','hired','rejected'].includes(String(applicant.recruitment_stage||''))){
   must(await db.from('masar_applicants').update({recruitment_stage:'interview',updated_at:now}).eq('id',applicant.id));
  }
  must(await db.from('masar_events').insert({
   applicant_id:applicant.id,kind,
   detail:{interview_id:interview.id,scheduled_at:interview.scheduled_at,office_id:applicant.office_id,location:signal.location,source_message_ids:signal.source_message_ids,source}
  }));
  return {applied:true,kind,interview,signal};
 }catch(e){
  if(SCHEMA_CODES.has(e?.code))return {applied:false,reason:'interviews_not_configured'};
  throw e;
 }
}


export async function reconcileRecentStaffInterviews(db,{hours=36,limit=500,source='recent_staff_reconcile'}={}){
 const since=new Date(Date.now()-Math.max(1,Math.min(168,Number(hours)||36))*60*60*1000).toISOString();
 try{
  const rows=must(await db.from('masar_messages')
   .select('applicant_id,created_at')
   .eq('direction','out').eq('sender','staff').eq('status','sent')
   .gte('created_at',since).order('created_at',{ascending:false}).limit(Math.max(1,Math.min(1000,Number(limit)||500))));
  const ids=[...new Set(rows.map(x=>x.applicant_id).filter(Boolean))];
  let applied=0;
  for(let i=0;i<ids.length;i+=100){
   const chunk=ids.slice(i,i+100);
   const applicants=must(await db.from('masar_applicants').select('id,office_id,recruitment_stage').in('id',chunk));
   for(const applicant of applicants){
    const result=await syncInterviewFromStaffMessages(db,{applicant,source});
    if(result.applied)applied++;
   }
  }
  return {checked:ids.length,applied};
 }catch(e){
  if(SCHEMA_CODES.has(e?.code))return {checked:0,applied:0,reason:'interviews_not_configured'};
  throw e;
 }
}
