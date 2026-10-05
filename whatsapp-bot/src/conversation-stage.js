const STAGE_ORDER={new:0,review:1,interview:2,accepted:3,hired:4,rejected:5};

const normalize=value=>String(value||'')
 .normalize('NFKD')
 .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g,'')
 .replace(/ـ/g,'')
 .replace(/[أإآ]/g,'ا')
 .replace(/ى/g,'ي')
 .replace(/ؤ/g,'و')
 .replace(/ئ/g,'ي')
 .replace(/ة/g,'ه')
 .replace(/[^\p{L}\p{N}\s:]/gu,' ')
 .replace(/\s+/g,' ')
 .trim()
 .toLowerCase();

const includesAny=(text,phrases)=>phrases.some(p=>text.includes(normalize(p)));
const explicitPatterns=[
 {stage:'rejected',confidence:.99,phrases:['تم رفضك','تم الرفض','مرفوض','غير مقبول','مش مناسب للوظيفة','غير مناسب للوظيفة','للأسف مش مناسب','للأسف غير مناسب']},
 {stage:'hired',confidence:.99,phrases:['تم التعيين','اتعينت','تم تعيينك','باشر العمل','ابدأ الشغل','ابدأ شغل','هتبدأ الشغل','هتبدأ شغل','موعد استلام الشغل','ميعاد استلام الشغل','استلام العمل','استلام الشغل','تعالى استلم الشغل','تعال استلم الشغل']},
 {stage:'accepted',confidence:.97,phrases:['تم قبولك','اتقبلت','مقبول','تم القبول','قبول نهائي','مبروك تم قبولك','مبروك اتقبلت']},
 {stage:'interview',confidence:.96,phrases:['موعد المقابله','ميعاد المقابله','المقابله يوم','مقابله يوم','حددنا مقابله','حددنا لك مقابله','معاد الانترفيو','ميعاد الانترفيو','انترفيو يوم','تعالى المكتب للمقابله','تعال المكتب للمقابله']},
 {stage:'review',confidence:.9,phrases:['تحت المراجعه','هنراجع بياناتك','هنراجع الطلب','جاري مراجعه البيانات','جاري المراجعه','طلبك تحت المراجعه','بياناتك تحت المراجعه']}
];

const interviewTopic=['مقابله','انترفيو','interview'];
const acceptedTopic=['اتقبلت','مقبول','قبول','قبلتوني'];
const hiredTopic=['بدا الشغل','ابدأ الشغل','ابدا الشغل','استلام الشغل','استلام العمل','التعيين'];
const confirmation=['ايوه','ايوا','اه','نعم','تمام','تم','بالظبط','صحيح','اكيد','اوك','ok','yes'];
const scheduleWords=['بكره','غدا','النهارده','اليوم','الساعه','صباح','مساء','السبت','الاحد','الاثنين','الثلاثاء','الاربعاء','الخميس','الجمعه'];

const bodyOf=m=>normalize(m?.body);
const isStaff=m=>m?.sender==='staff'||(m?.direction==='out'&&m?.sender!=='bot');
const isApplicant=m=>m?.sender==='applicant'||m?.direction==='in';
const hasSchedule=text=>includesAny(text,scheduleWords)||/\b\d{1,2}(?::\d{2})?\b/.test(text);

function explicitSignal(message){
 if(!isStaff(message))return null;
 const text=bodyOf(message);
 if(!text)return null;
 for(const rule of explicitPatterns){
  const phrase=rule.phrases.find(p=>text.includes(normalize(p)));
  if(phrase)return {stage:rule.stage,confidence:rule.confidence,message_id:message.id||null,evidence:String(message.body||'').slice(0,240),reason:'staff_explicit'};
 }
 return null;
}

function contextualSignal(messages,index){
 const staff=messages[index];if(!isStaff(staff))return null;
 const staffText=bodyOf(staff);if(!staffText)return null;
 let applicant=null;
 for(let i=index-1;i>=0&&i>=index-3;i--){if(isApplicant(messages[i])&&bodyOf(messages[i])){applicant=messages[i];break;}}
 if(!applicant)return null;
 const applicantText=bodyOf(applicant),confirm=includesAny(staffText,confirmation);
 if(includesAny(applicantText,interviewTopic)&&(confirm||hasSchedule(staffText))){
  return {stage:'interview',confidence:hasSchedule(staffText)?.9:.86,message_id:staff.id||null,evidence:(String(applicant.body||'')+' ⇢ '+String(staff.body||'')).slice(0,240),reason:'conversation_context'};
 }
 if(includesAny(applicantText,acceptedTopic)&&confirm){
  return {stage:'accepted',confidence:.88,message_id:staff.id||null,evidence:(String(applicant.body||'')+' ⇢ '+String(staff.body||'')).slice(0,240),reason:'conversation_context'};
 }
 if(includesAny(applicantText,hiredTopic)&&(confirm||hasSchedule(staffText))){
  return {stage:'hired',confidence:hasSchedule(staffText)?.91:.87,message_id:staff.id||null,evidence:(String(applicant.body||'')+' ⇢ '+String(staff.body||'')).slice(0,240),reason:'conversation_context'};
 }
 return null;
}

export function inferRecruitmentStage(messages,currentStage='new'){
 const current=STAGE_ORDER[currentStage]===undefined?'new':currentStage;
 if(current==='hired'||current==='rejected')return {stage:current,changed:false,confidence:1,reason:'terminal_stage'};
 const recent=(Array.isArray(messages)?messages:[]).filter(m=>bodyOf(m)).slice(-40);
 let best=null;
 for(let i=0;i<recent.length;i++){
  const signal=explicitSignal(recent[i])||contextualSignal(recent,i);
  if(!signal)continue;
  // Newer messages win when confidence is close; very explicit language wins otherwise.
  if(!best||signal.confidence>best.confidence+.04||signal.confidence>=best.confidence-.04)best={...signal,index:i};
 }
 if(!best)return {stage:current,changed:false,confidence:0,reason:'no_signal'};
 if(best.stage==='rejected')return {stage:'rejected',changed:current!=='rejected',...best};
 if((STAGE_ORDER[best.stage]??0)<=(STAGE_ORDER[current]??0))return {stage:current,changed:false,...best,reason:'no_downgrade'};
 return {stage:best.stage,changed:true,...best};
}

export async function syncRecruitmentStageFromConversation(db,applicantId,{source='conversation'}={}){
 const applicantResult=await db.from('masar_applicants').select('id,recruitment_stage').eq('id',applicantId).single();
 if(applicantResult.error)throw applicantResult.error;
 const applicant=applicantResult.data;
 const messageResult=await db.from('masar_messages').select('id,direction,sender,body,sequence,created_at').eq('applicant_id',applicantId).order('sequence',{ascending:false}).limit(40);
 if(messageResult.error)throw messageResult.error;
 const messages=[...(messageResult.data||[])].reverse();
 const inferred=inferRecruitmentStage(messages,applicant.recruitment_stage||'new');
 if(!inferred.changed)return inferred;
 const now=new Date().toISOString();
 const update=await db.from('masar_applicants').update({recruitment_stage:inferred.stage,updated_at:now}).eq('id',applicantId);
 if(update.error)throw update.error;
 const event=await db.from('masar_events').insert({
  applicant_id:applicantId,
  kind:'conversation_stage_auto',
  detail:{from:applicant.recruitment_stage||'new',to:inferred.stage,confidence:inferred.confidence,reason:inferred.reason,evidence:inferred.evidence||'',message_id:inferred.message_id||null,source}
 });
 if(event.error)throw event.error;
 return inferred;
}
