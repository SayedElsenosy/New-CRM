import {norm,digits} from './domain.js';

const QUESTION_WORDS=['ايه','اي','ازاي','فين','كام','امتى','متي','هل','ممكن','عايز اعرف','عاوز اعرف','تفاصيل','مرتب','راتب','قبض','دخل','عنوان','مكان','مواعيد','ميعاد','ساعات','شفت','مميزات','تأمين','تامين','اجازه','اجازة','بونص','تقديم','محاضره','محاضرة','انترفيو'];
const STOP=new Set(['في','من','على','علي','عن','هو','هي','ده','دي','دا','انا','انت','انتم','يا','لو','و','او','ولا','بس','بقى','بقا','كده','كدا','ايه','هل','ممكن','عايز','عاوز','اعرف','تفاصيل']);
const REPLACEMENTS=[
 [/(?:ميعاد|مواعيد|امتي|امتى|متي)/g,'وقت'],
 [/(?:مرتب|راتب|قبض|دخل)/g,'مرتب'],
 [/(?:عنوان|مكان|لوكيشن)/g,'مكان'],
 [/(?:ساعات|ساعه|ساعة|شفت|ورديه|وردية)/g,'شفت'],
 [/(?:اجازه|اجازة|اجازات|إجازة|إجازات)/g,'اجازه'],
 [/(?:تأمين|تامين|التأمين|التامين)/g,'تامين'],
 [/(?:موتوسيكل|موتوسكل|مكنه|مكنة)/g,'موتوسيكل'],
 [/(?:تقديم|اقدم|أقدم|التقديم)/g,'تقديم'],
 [/(?:محاضره|محاضرة|المحاضره|المحاضرة)/g,'محاضره']
];

export const schemaMissing=e=>['PGRST205','42P01','42703'].includes(e?.code);

function canonical(value){
 let s=norm(digits(value)).replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
 for(const [pattern,replacement] of REPLACEMENTS)s=s.replace(pattern,replacement);
 return s;
}
function tokens(value){
 return canonical(value).split(' ').filter(t=>t.length>1&&!STOP.has(t));
}
function trigrams(value){
 const s='  '+canonical(value)+'  ',out=new Set();
 for(let i=0;i<s.length-2;i++)out.add(s.slice(i,i+3));
 return out;
}
function overlap(a,b){
 if(!a.size||!b.size)return 0;let n=0;for(const x of a)if(b.has(x))n++;
 return n;
}
function dice(a,b){const n=overlap(a,b);return a.size+b.size?2*n/(a.size+b.size):0;}
function autoKeywords(question){
 const seen=new Set(tokens(question));
 return [...seen].slice(0,12);
}
export function suggestKeywords(question){return autoKeywords(question);}
export function looksLikeQuestion(text){
 const raw=String(text||'').trim(),n=canonical(raw);
 if(raw.length<4||raw.length>2000)return false;
 if(/[?؟]/.test(raw)&&raw.length>=6)return true;
 return QUESTION_WORDS.some(w=>n.includes(canonical(w)));
}
export function isLearnableExchange(question,answer){
 const q=String(question||'').trim(),a=String(answer||'').trim();
 if(!looksLikeQuestion(q)||a.length<3||a.length>4000)return false;
 const n=canonical(a);
 if(['تمام','اوكي','ok','okay','حاضر','شكرا','شكراً','اه','ايوه','لا','لاء'].map(canonical).includes(n))return false;
 return true;
}
function scoreEntry(text,row){
 const q=canonical(text),target=canonical(row.question);
 if(!q||!target)return 0;
 if(q===target)return 1;
 if(q.length>=6&&target.length>=6&&(q.includes(target)||target.includes(q)))return .94;
 const qa=new Set(tokens(q)),ta=new Set(tokens(target)),inter=overlap(qa,ta);
 const union=new Set([...qa,...ta]).size;
 const jaccard=union?inter/union:0,coverage=Math.min(qa.size,ta.size)?inter/Math.min(qa.size,ta.size):0;
 const char=dice(trigrams(q),trigrams(target));
 let score=jaccard*.48+coverage*.32+char*.20;
 const keywordList=[...(row.keywords||[]),...autoKeywords(row.question)].map(canonical).filter(Boolean);
 let keywordHits=0;
 for(const keyword of new Set(keywordList)){
  if(q.includes(keyword))keywordHits++;
 }
 if(keywordHits>=2)score+=.12;
 else if(keywordHits===1)score+=.06;
 return Math.min(1,score);
}
export function findKnowledgeAnswer(text,rows,threshold=.62){
 if(!looksLikeQuestion(text))return null;
 const active=(rows||[]).filter(r=>r.active!==false);
 let best=null;
 for(const row of active){
  const confidence=scoreEntry(text,row);
  if(!best||confidence>best.confidence)best={...row,confidence};
 }
 return best&&best.confidence>=threshold?best:null;
}
export async function loadKnowledge(db){
 try{
  const result=await db.from('masar_knowledge').select('*').eq('active',true).order('updated_at',{ascending:false});
  if(result.error)throw result.error;
  return result.data||[];
 }catch(e){if(schemaMissing(e))return [];throw e;}
}
export async function createLearningSuggestion(db,{applicantId,sourceMessage,staffMessageId,answer,staffId}){
 if(!isLearnableExchange(sourceMessage?.body,answer))return false;
 try{
  const result=await db.from('masar_learning_suggestions').insert({
   applicant_id:applicantId,
   source_message_id:sourceMessage.id,
   staff_message_id:staffMessageId,
   question:String(sourceMessage.body).trim().slice(0,2000),
   answer:String(answer).trim().slice(0,4000),
   created_by:staffId
  });
  if(result.error){
   if(result.error.code==='23505')return false;
   throw result.error;
  }
  return true;
 }catch(e){if(schemaMissing(e))return false;throw e;}
}
