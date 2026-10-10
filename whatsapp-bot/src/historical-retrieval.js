import {norm} from './domain.js';

/**
 * On-demand read-only retrieval across the applicant's entire saved chat.
 * This is topic/phrase search, NOT a semantic embedding or a source of
 * authoritative employment facts. Only the applicant's earlier messages are
 * considered; office facts always come from the current, verified CRM.
 */
const TOPIC={
 comparison:{
  ask:/(?:قارن|مقارن|مقارنه|الفرق|انسب|احسن|افضل|ترشح|رشحت|الاحسن|نصيحتك)/,
  terms:['قارن','مقارن','مقارنة','المقارنة','الفرق','انسب','أفضل','افضل','احسن','الهرم','زايد','المطاعم','الماركت']
 },
 residence:{
  ask:/(?:ساكن|سكن|بيتي|فين|منصوري|الهرم|اقرب|قريب|عنواني|مكان سكن)/,
  terms:['ساكن','سكن','المنصور','الهرم','بيتي','عنوان','المنطقه','المنطقة','القريب']
 },
 job:{
  ask:/(?:تفاصيل|شغل|وظيفه|الوظيفه|ماركت|مطاعم|نظام الشغل|المهندسين|الهرم)/,
  terms:['تفاصيل','شغل','وظيف','ماركت','مطاعم','مطعم','الهرم','زايد']
 },
 payroll:{
  ask:/(?:قبض|مرتب|راتب|دخل|اورد|بونص|الفيزا)/,
  terms:['قبض','مرتب','راتب','دخل','اورد','بونص','الفيزا','فلوس']
 },
 shift:{
  ask:/(?:شفت|شيفت|ساعات|صباح|مسائي|مواعيد|ورديه)/,
  terms:['شفت','شيفت','ساعات','صباح','مسائي','مواعيد','وردي']
 },
 documents:{
  ask:/(?:ورق|بطاقه|رخصه|صوره|مستند|الاوراق)/,
  terms:['بطاق','رخص','ورق','صوره','مستند','اوراق']
 },
 corrections:{
  ask:/(?:فاكر|قلتلك|قولتلك|قبل كده|سبق|مش ده|قصدي|صححت)/,
  terms:['قصدي','اقصد','قلتلك','قولتلك','مش','تصحيح','غيرت']
 }
};
const MAX_HITS=5,MAX_TEXT=190;
const HISTORIC_TRIGGER=/(?:فاكر|قلتلك|قولتلك|قبل كده|زمان|اول ما|الاول|سابق|كنا|اتكلمنا|سبق|مش فاهم|مش عارف|نفس|التفاصيل|كمل|نكمل|طب|طيب|اللي قولته|الكلام اللي)/;
const sensitive=s=>String(s||'')
 .replace(/https?:\/\/\S+/g,'[رابط]')
 .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g,'[بريد]')
 .replace(/(?:\+?2?0?1[0125][0-9\s-]{7,}[0-9])/g,'[رقم]')
 .replace(/\b[0-9]{7,}\b/g,'[رقم]')
 .replace(/\s+/g,' ').trim().slice(0,MAX_TEXT);

function topicMatch(text){
 const n=norm(text);
 return Object.entries(TOPIC).filter(([,x])=>x.ask.test(n)).map(([key])=>key);
}
function queryTerms(text){
 const tags=topicMatch(text);
 if(!tags.length||(!HISTORIC_TRIGGER.test(norm(text))&&tags.length===1&&!/^(?:residence|job)$/.test(tags[0])))return [];
 const chosen=tags.includes('comparison')?['comparison']:tags.includes('residence')?['residence']:tags.includes('payroll')?['payroll']:
  tags.includes('shift')?['shift']:tags.includes('documents')?['documents']:
  tags.includes('job')?['job']:tags.includes('corrections')?['corrections']:[];
 const terms=[...new Set(chosen.flatMap(tag=>TOPIC[tag].terms))].slice(0,10);
 return terms.filter(t=>/^[\p{L}\d]{3,20}$/u.test(t));
}
function relevance(row,terms,query){
 const t=norm(row.body||'');
 const qWords=[...new Set(norm(query).split(/[^\p{L}\p{N}]+/u).filter(x=>x.length>=4))].slice(0,8);
 let score=0;
 for(const word of terms)if(t.includes(norm(word)))score+=2;
 for(const word of qWords)if(t.includes(word))score+=4;
 if(/(?:قصدي|اقصد|مش المنصوره|تصحيح)/.test(t))score+=3;
 return score;
}
export function selectHistoricalExcerpts(rows,{query='',recentSequences=[],limit=MAX_HITS}={}){
 const terms=queryTerms(query),ignore=new Set((recentSequences||[]).map(Number));
 if(!terms.length)return [];
 const unique=new Map();
 for(const row of rows||[]){
  if(row?.direction!=='in'||!Number.isSafeInteger(Number(row?.sequence))||ignore.has(Number(row.sequence)))continue;
  const text=sensitive(row.body);
  if(!text||/^\[رقم\]$/.test(text))continue;
  const score=relevance(row,terms,query);
  if(score<2)continue;
  const seq=Number(row.sequence);
  if(!unique.has(seq))unique.set(seq,{
   sequence:seq,role:'applicant',excerpt:text,score
  });
 }
 return [...unique.values()].sort((a,b)=>b.score-a.score||b.sequence-a.sequence)
  .slice(0,Math.min(MAX_HITS,Math.max(0,Number(limit)||0)))
  .map(({sequence,role,excerpt})=>({sequence,role,excerpt,unverified:true}));
}
export function historicalRecallNeeded(text){return queryTerms(text).length>0;}
export async function retrieveHistoricalExcerpts(db,{
 applicantId,currentSequence,query='',recentSequences=[]
}={}){
 const terms=queryTerms(query);
 const end=Number(currentSequence);
 if(!terms.length||!Number.isSafeInteger(end)||end<1)return [];
 if(typeof applicantId!=='string'||!applicantId.trim())return [];
 // Fixed allowlisted literal fragments only: no user input in PostgREST OR.
 const or=terms.map(t=>'body.ilike.%'+t+'%').join(',');
 const load=async ascending=>{
  const result=await db.from('masar_messages')
   .select('sequence,direction,body')
   .eq('applicant_id',applicantId).eq('direction','in')
   .lt('sequence',end).or(or)
   .order('sequence',{ascending}).limit(70);
  if(result.error)throw result.error;
  return result.data||[];
 };
 // Oldest AND newest excerpts avoid a first-message correction disappearing
 // just because the topic has been revisited many times.
 const [first,last]=await Promise.all([load(true),load(false)]);
 return selectHistoricalExcerpts([...first,...last],{query,recentSequences});
}
