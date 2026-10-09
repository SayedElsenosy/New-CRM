const ISSUES={
 repeated_stall:{title:'متقدم متوقف عند نفس السؤال',severity:'high'},
 tool_failure:{title:'فشل متكرر في أدوات الـCRM',severity:'high'},
 llm_fallback:{title:'تكرار رجوع الـAgent للوضع الاحتياطي',severity:'medium'},
 knowledge_gap:{title:'أسئلة متكررة بدون معلومة موثقة',severity:'medium'},
 ambiguous_reply:{title:'صعوبة متكررة في فهم الردود',severity:'medium'}
};
const since24h=24*60*60*1000;
const dedup=list=>new Set(list.map(x=>x.applicant_id).filter(Boolean)).size;

/**
 * Alert decisions use a single office's metadata only. This does NOT pause the
 * bot, change qualification, expose transcripts or approve training data.
 * Current candidate is retained server-side solely to attach the alert card
 * to a reviewable real conversation.
 */
export function qualityIssueAlertCandidate(events=[],{officeId=null,currentApplicantId=null,now=Date.now(),partial=false}={}){
 if(!officeId||!currentApplicantId||partial)return null;
 const scoped=(Array.isArray(events)?events:[])
  .filter(e=>e?.kind==='agent_turn'&&e.detail?.office_id===officeId&&
   e.applicant_id&&Number.isFinite(Date.parse(e.created_at))&&
   Date.parse(e.created_at)>=now-since24h&&Date.parse(e.created_at)<=now)
  .sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
 if(!scoped.length||scoped[0].applicant_id!==currentApplicantId)return null;
 const candidateTurns=scoped.filter(e=>e.applicant_id===currentApplicantId);
 if(candidateTurns.length>=2){
  const [one,two]=candidateTurns;
  const repeated=[one,two].every(e=>{
   const d=e.detail||{},before=d.awaiting_before,after=d.awaiting_after;
   return before&&before===after&&Array.isArray(d.quality_signals)&&d.quality_signals.includes('ambiguous_reply');
  })&&one.detail.awaiting_after===two.detail.awaiting_after&&
   Date.parse(one.created_at)-Date.parse(two.created_at)<=since24h;
  if(repeated)return {key:'repeated_stall',title:ISSUES.repeated_stall.title,count:2,sampled_turns:scoped.length};
 }
 if(scoped.length<10)return null;
 const priorities=['tool_failure','llm_fallback','knowledge_gap','ambiguous_reply'];
 for(const key of priorities){
  const tagged=scoped.filter(e=>Array.isArray(e.detail?.quality_signals)&&e.detail.quality_signals.includes(key));
  if(tagged.length>=4&&dedup(tagged)>=2&&tagged.length/scoped.length>=.25)
   return {key,title:ISSUES[key].title,count:tagged.length,sampled_turns:scoped.length};
 }
 return null;
}
