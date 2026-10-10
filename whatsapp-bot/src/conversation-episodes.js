import {norm} from './domain.js';

/**
 * Bounded episode reconstruction from conversation history. A past bot reply
 * describes what the bot said at that time; it is NOT verified CRM knowledge
 * and must never be reused as the present salary/eligibility policy.
 * All lookups require a server-derived applicant ID and stop before the new
 * inbound message.
 */
const OLD_DISCUSSION=/(?:فاكر|فكرني|كنا|اتكلمنا|قلتلك|قولتلك|قبل كده|المقارنه اللي|كنت شايف|انت شايف|انت رشحت)/;
const REVISIT=/(?:قارن|مقارن|مقارنه|الفرق|انسب|احسن|افضل|رشح|شغل|وظيفه|وظيفة|مرتب|قبض|مطاعم|ماركت)/;
const limitText=(text,max=175)=>String(text||'')
 .replace(/https?:\/\/\S+/g,'[رابط]')
 .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g,'[بريد]')
 .replace(/(?:\+?2?0?1[0125][0-9\s-]{7,}[0-9])/g,'[رقم]')
 .replace(/\b[0-9]{7,}\b/g,'[رقم]')
 .replace(/\s+/g,' ').trim().slice(0,max);
export function needsConversationEpisodes(message=''){
 const n=norm(message);
 return OLD_DISCUSSION.test(n)&&REVISIT.test(n);
}
export function selectEpisodeAnchors(excerpts=[],query='',max=2){
 if(!needsConversationEpisodes(query))return [];
 const seen=new Set(),possible=[];
 const queryWords=norm(query).split(/[^\p{L}\p{N}]+/u)
  .filter(x=>x.length>3&&!/(?:فاكر|اتكلمنا|كنت|انهي|اللي|علشان|كده)/.test(x));
 for(const item of excerpts||[]){
  const seq=Number(item?.sequence);
  if(item?.role!=='applicant'||item?.unverified!==true||!Number.isSafeInteger(seq)||seq<1||seen.has(seq))continue;
  seen.add(seq);
  const t=norm(item.excerpt||'');
  let relevance=0;
  if(REVISIT.test(t))relevance+=4;
  if(/(?:قارن|مقارن|مقارنه|الفرق|انسب|افضل|احسن|رشح)/.test(t))relevance+=6;
  for(const word of queryWords)if(t.includes(word))relevance+=2;
  if(relevance>0)possible.push({sequence:seq,applicant_excerpt:limitText(item.excerpt,135),relevance});
 }
 return possible.sort((a,b)=>b.relevance-a.relevance||b.sequence-a.sequence)
  .slice(0,Math.min(2,Math.max(0,Number(max)||0)));
}
export async function retrieveConversationEpisodes(db,{
 applicantId,currentSequence,query='',historicalExcerpts=[]
}={}){
 if(typeof applicantId!=='string'||!applicantId.trim())return [];
 const end=Number(currentSequence);
 if(!Number.isSafeInteger(end)||end<2)return [];
 const anchors=selectEpisodeAnchors(historicalExcerpts,query);
 if(!anchors.length)return [];
 const episodes=[];
 for(const item of anchors){
  const {data,error}=await db.from('masar_messages')
   .select('sequence,direction,sender,body,status')
   .eq('applicant_id',applicantId).gt('sequence',item.sequence)
   .lt('sequence',end).order('sequence',{ascending:true}).limit(4);
  if(error)throw error;
  // A new applicant message ends this conversational turn. Exclude a reply
  // that belongs to a *different* question, or to failed/queued sends.
  const next=(data||[]).find(row=>row.direction==='in'||row.direction==='out');
  const reply=next?.direction==='out'&&next?.status!=='failed'&&next?.status!=='queued'
   ?limitText(next.body,190):null;
  episodes.push({
   sequence:item.sequence,applicant_excerpt:item.applicant_excerpt,
   ...(reply?{previous_reply:reply}:{}),
   note:'رواية تاريخية لما اتقال، وليست إثباتًا لصحة شروط أو مرتبات الوظيفة حاليًا.',
   verified:false
  });
 }
 return episodes;
}
