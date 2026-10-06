export const STAGES = {new:'جديد',incomplete:'لم يكمل البيانات',complete:'أرسل البيانات بالكامل',lecture:'حضر المحاضرة',working:'بدأ شغل'};
export const norm = v => String(v ?? '').trim().toLowerCase().replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي').replace(/[ًٌٍَُِّْـ]/g,'').replace(/\s+/g,' ');
export const digits = v => String(v ?? '').replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d));
export function phoneFromId(id) {
 if (!/@(c\.us|s\.whatsapp\.net)$/.test(id || '')) return null;
 const n=String(id).split('@')[0];
 return /^[1-9]\d{7,14}$/.test(n)?`+${n}`:null;
}
export function validPhone(n) { return /^\+[1-9]\d{7,14}$/.test(n || ''); }
export function activeQuestions(qs) { return qs.filter(q=>q.active).sort((a,b)=>a.position-b.position || a.id.localeCompare(b.id)); }
export function answered(q,answers,areas) {
 const a=answers[q.id];
 if (!a || a.value===null || a.value===undefined || a.value==='') return false;
 if (a.kind && a.kind!==q.kind) return false;
 return q.kind!=='area' || a.archived_area===true || areas.some(z=>z.id===a.value && z.active);
}
export function completion(questions,answers,areas) {
 const required=activeQuestions(questions).filter(q=>q.required);
 const done=required.filter(q=>answered(q,answers,areas)).length;
 return {done,total:required.length,percent:required.length?Math.round(done/required.length*100):0,complete:required.length>0&&done===required.length};
}
export function computedStage(a,questions,areas) {
 if (['lecture','working'].includes(a.stage)) return a.stage;
 if (completion(questions,a.answers,areas).complete) return 'complete';
 return Object.keys(a.answers||{}).some(k=>!k.startsWith('__'))?'incomplete':'new';
}
export function validateAnswer(q,input,areas,media) {
 const s=String(input ?? '').trim();
 if(q.kind==='image') return media?.path ? {ok:true,value:media.path,display:'مرفق مستلم'} : {ok:false};
 if(q.kind==='area') { const z=areas.find(z=>z.active&&(z.id===s||norm(z.name)===norm(s)));return z?{ok:true,value:z.id,display:z.name}:{ok:false}; }
 if(q.kind==='yes_no') {
  if(typeof input==='boolean') return {ok:true,value:input,display:input?'نعم':'لا'};
  const n=norm(s);
  if(/^(?:لا|لاء|no)(?:\s|$)/.test(n))return {ok:true,value:false,display:'لا'};
  if(/^(?:نعم|ايوه|ايوا|اه|تمام|موافق|yes)(?:\s|$)/.test(n))return {ok:true,value:true,display:'نعم'};
  if(['معنديش','ما عنديش','مش عندي','مش معايا'].includes(n)
    ||/(?:^|\s)(?:معنديش|مش عندي|مش معايا|ما عنديش)(?:\s|$)/.test(n))return {ok:true,value:false,display:'لا'};
  if(['عندي','معايا'].includes(n)
    ||/(?:^|\s)(?:عندي|معايا)(?:\s|$)/.test(n))return {ok:true,value:true,display:'نعم'};
  return {ok:false};
 }
 if(q.kind==='number') {
  const m=digits(s).match(/^(?:(?:عمري|سني|عندي)\s*)?(\d{1,3})(?:\s*(?:سنه|سنة))?$/);
  return m&&Number(m[1])>=1&&Number(m[1])<=100?{ok:true,value:Number(m[1]),display:m[1]}:{ok:false};
 }
 if (!s||s.length>1000||/[?؟]/.test(s)||/^(هو |هي |ايه|ازاي|فين|كام|هل |ممكن|عايز اعرف|قصدي|بالنسبه|بالنسبة|السلام|مرحبا|اهلا)/.test(norm(s))) return {ok:false};
 if(q.kind==='name' && (!/^[\p{L}\s.'-]{2,100}$/u.test(s)||s.trim().split(/\s+/).length<2))return {ok:false};
 return {ok:true,value:s,display:s};
}
export function questionPrompt(q,areas) {
 let text=q.label;
 if(q.kind==='area'){
  if(q.field_key==='preferred_work_area') text+='\nاختار منطقة العمل من الأزرار تحت. أول ما تختارها هنسجلها ونكمل التقديم. ولو مفيش أي منطقة تقدر تلتزم بيها اختار «❌ ولا منطقة مناسبة».';
  else text+='\nاختار المنطقة من الأزرار تحت علشان تشوف تفاصيلها. تقدر تقارن بين أكتر من منطقة، ومش هنسجل اختيارك النهائي غير لما تأكده.';
 }
 if(!q.required)text+='\n(اختياري؛ اكتب «تخطي» لو مش حابب تجاوب)';
 return text;
}
export function areaRejected(text,area) {
 const n=norm(text),name=norm(area?.name);
 if(!name)return false;
 const index=n.indexOf(name);if(index<0)return false;
 const before=n.slice(0,index);
 const segment=(before.split(/(?:^|\s)(?:بس|لكن|لاكن|انما)(?:\s|$)|[،,؛;.!?؟]/).pop()||'').trim();
 const tail=segment.split(/\s+/).slice(-10).join(' ');
 return /(?:^|\s)(?:مش|ما)\s+(?:عايز|عاوز|حابب|موافق|ناوي)(?:\s|$)/.test(tail)
  ||/(?:^|\s)(?:مش\s+مناسب|مش\s+مناسبه|ماينفعش|مينفعش|بعيد\s+عن|ابعد\s+عن)(?:\s|$)/.test(tail)
  ||/(?:^|\s)(?:غير|بدون|لا|لاء|مش)\s*$/.test(tail);
}
export function areaInquiry(text,areas) {
 const n=norm(text);
 const inquiry=/[?؟]/.test(text)||/(تفاصيل|مرتب|قبض|عنوان|مكان|مواعيد|ساعات|شغل|نظام|مميزات|راتب|بونص)/.test(n);
 if(!inquiry)return null;
 const hits=areas.filter(a=>a.active&&n.includes(norm(a.name))&&!areaRejected(text,a));
 return hits.length===1?hits[0]:null;
}
export function areaDetails(area) { return `📍 ${area.name}\n${area.details.trim()||'تفاصيل المنطقة لسه مش مضافة. مسؤول التوظيف يقدر يوضحها ليك.'}`; }
export function redactForAI(text) {return digits(text).replace(/\b\d{7,}\b/g,'[رقم محجوب]').replace(/\S+@\S+\.\S+/g,'[بريد محجوب]').replace(/https?:\/\/\S+/g,'[رابط محجوب]').slice(0,1500);}
export function csvCell(value) {
 let s=String(value??'');if(/^[\s]*[=+\-@]/.test(s))s="'"+s;
 return '"'+s.replace(/"/g,'""')+'"';
}

export function legacyPhone(raw) {
 raw=String(raw||'');
 if(raw.endsWith('@lid'))return null;
 const direct=phoneFromId(raw);if(direct)return direct;
 if(validPhone(raw))return raw;
 // The old bot stripped LID suffixes, so arbitrary bare digits are not trusted.
 return /^20\d{10}$/.test(raw)?'+'+raw:null;
}
