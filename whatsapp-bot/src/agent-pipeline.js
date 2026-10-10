/**
 * Production operational telemetry. Never store message text, model prompts,
 * generated answers, applicant PII or hidden reasoning in this structure.
 * One compact snapshot is appended to the existing agent_turn event.
 */
export const PIPELINE_STAGES=['received','memory','knowledge','understanding','decision','response'];
const safeMs=value=>Number.isFinite(Number(value))?Math.min(120000,Math.max(0,Math.round(Number(value)))):null;
const safeCount=value=>Number.isFinite(Number(value))?Math.min(500,Math.max(0,Math.floor(Number(value)))):0;
const safeAction=value=>String(value||'flow_turn').replace(/[^a-z0-9_]/gi,'').slice(0,50)||'flow_turn';
const safeStatus=value=>['done','skipped','degraded','failed'].includes(value)?value:'skipped';

export function buildTurnPipeline({
 waitMs=null,memory={},knowledge={},understanding={},decision={},response={}
}={}){
 const stage=(key,status,duration_ms,meta={})=>({key,status:safeStatus(status),duration_ms:safeMs(duration_ms),...meta});
 return {
  version:1,
  stages:[
   stage('received','done',waitMs),
   stage('memory',memory.status||'skipped',memory.ms,{indexed:memory.indexed===true}),
   stage('knowledge',knowledge.status||'skipped',knowledge.ms,{items:safeCount(knowledge.items),
    historical_excerpts:safeCount(knowledge.excerpts)}),
   stage('understanding',understanding.status||'skipped',understanding.ms,{
    engine:['llm','rules'].includes(understanding.engine)?understanding.engine:'rules',
    used_llm:understanding.usedLlm===true
   }),
   stage('decision',decision.status||'done',decision.ms,{action:safeAction(decision.action)}),
   stage('response',response.status||'done',response.ms,{queued:response.queued===true})
  ]
 };
}
const validStage=new Set(PIPELINE_STAGES);
export function publicPipeline(event){
 const source=event?.detail?.pipeline;
 if(source?.version!==1||!Array.isArray(source.stages))return null;
 // Explicit allowlist: do not echo arbitrary fields from the audit event.
 const rows=new Map();
 for(const stage of source.stages.slice(0,8)){
  if(!validStage.has(stage?.key)||rows.has(stage.key))continue;
  const row={key:stage.key,status:safeStatus(stage.status),duration_ms:safeMs(stage.duration_ms)};
  if(stage.key==='memory')row.indexed=stage.indexed===true;
  if(stage.key==='knowledge'){row.items=safeCount(stage.items);row.historical_excerpts=safeCount(stage.historical_excerpts);}
  if(stage.key==='understanding'){row.engine=stage.engine==='llm'?'llm':'rules';row.used_llm=stage.used_llm===true;}
  if(stage.key==='decision')row.action=safeAction(stage.action);
  if(stage.key==='response')row.queued=stage.queued===true;
  rows.set(stage.key,row);
 }
 return PIPELINE_STAGES.map(key=>rows.get(key)).filter(Boolean);
}
export function deliveryState(status){
 switch(String(status||'')){
  case 'sent':return 'sent';
  case 'queued':return 'queued';
  case 'sending':return 'sending';
  case 'uncertain':return 'uncertain';
  case 'processed':return 'cancelled';
  case 'failed':return 'failed';
  default:return 'not_recorded';
 }
}
export function summarizePipelineEvents(events=[],outgoing=[]){
 const byParent=new Map();
 for(const row of outgoing||[]){
  if(!row?.reply_to||row.sender!=='bot')continue;
  const values=byParent.get(row.reply_to)||[];
  values.push(deliveryState(row.status));byParent.set(row.reply_to,values);
 }
 const priority=['failed','uncertain','sending','queued','cancelled','sent','not_recorded'];
 return (events||[]).slice(0,30).map(event=>{
  const detail=event?.detail||{},messageId=detail.message_id||null;
  const stages=publicPipeline(event);
  const states=byParent.get(messageId)||[];
  const delivery=states.length?priority.find(x=>states.includes(x)):'not_recorded';
  return {
   event_id:event.id,
   message_id:messageId,
   created_at:event.created_at,
   action:safeAction(detail.action),
   stages:stages||[],
   historic_trace:!stages,
   delivery,
   response_count:states.length
  };
 });
}
