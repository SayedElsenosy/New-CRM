/** Read-only paired evaluation adapter for the CURRENT Node.js agent.
 * JSON fixtures contain synthetic messages. No DB/network or WhatsApp clients.
 * Never print freeform replies or identifiers in CI reports.
 */
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {planTurn} from '../../whatsapp-bot/src/flow.js';
import {accumulateLifetimeMemory} from '../../whatsapp-bot/src/lifetime-memory.js';

const q={id:'q-work',field_key:'preferred_work_area',kind:'area',
 label:'أنهي منطقة تقدر تشتغل فيها يوميًا؟',required:true,active:true,confirmation_required:true,position:1};
const questions=[q,{id:'q-name',field_key:'full_name',kind:'text',label:'اسمك إيه؟',
 required:true,active:true,position:2}];
const settings={
 ai_enabled:true,ai_knowledge_enabled:false,agent_crm_tools_enabled:false,
 agent_expert_enabled:false,agent_llm_enabled:false,
 welcome:'أهلاً بك في التقديم',
 completion:'تم حفظ بيانات التقديم'
};
function applicantFor(test,areas){
 const answers={};
 let index=0;
 const history=[];
 for(const item of test.history){
  index++;
  if(item.metadata?.preview_area_id){
   const area=areas.find(a=>String(a.id)===String(item.metadata.preview_area_id));
   if(area){
    answers.__area_preview={value:area.id,display:area.name,kind:'area_preview',at:new Date().toISOString()};
    answers.__area_context={kind:'area_context',place_key:area.place_key,at:new Date().toISOString()};
   }
  }
  if(typeof item.text!=='string')continue;
  history.push({sequence:index,body:item.text,
   direction:item.role==='applicant'?'in':'out',
   sender:item.role==='applicant'?'applicant':'bot',status:'sent'});
 }
 if(history.length)answers.__lifetime_memory=accumulateLifetimeMemory(null,history).memory;
 if(test.opening_ad)answers.__attribution={source_type:'ad',source_id:'synthetic-test'};
 return {id:'synthetic',bot_enabled:true,stage:'new',awaiting_id:test.opening_ad?null:q.id,answers};
}
function score({test,turn}){
 const reply=String(turn?.reply||'');
 const labels=[];
 for(const phrase of test.expect?.node_terms||[])
  labels.push({check:'includes:'+phrase,pass:reply.includes(phrase)});
 for(const phrase of test.expect?.node_not_terms||[])
  labels.push({check:'excludes:'+phrase,pass:!reply.includes(phrase)});
 if(test.expect?.node_no_qualification){
  const record=turn.patch?.answers?.[q.id];
  const changed=record?.value!=null;
  labels.push({check:'no_implicit_work_area_commit',pass:!changed});
  const candidates=[turn.patch?.qualified_candidate,turn.patch?.geo_qualified];
  labels.push({check:'no_implicit_qualification',pass:!candidates.includes(true)});
 }
 return labels;
}
export async function nodeResults(fixtures){
 const areas=fixtures.areas||[],cases=fixtures.cases||[];
 const output=[];
 for(const test of cases){
  const a=applicantFor(test,areas);
  const before=JSON.stringify({a,areas,questions,settings});
  const started=performance.now();
  try{
   const history=[...test.history].reverse();
   const current=history.find(row=>row.role==='applicant'&&row.text);
   const turn=await planTurn({
    applicant:a,message:{body:current?.text||''},questions,areas,settings,
    interpret:async()=>null,knowledge:[],llmPlan:null,
    conversationEpisodes:[],historicalExcerpts:[]
   });
   const elapsedMs=Math.round((performance.now()-started)*1000)/1000;
   const checks=score({test,turn});
   const unchanged=before===JSON.stringify({a,areas,questions,settings});
   checks.push({check:'fixture_read_only',pass:unchanged});
   output.push({id:test.id,action:turn.agent_action||'unclassified',
    elapsed_ms:elapsedMs,checks,passed:checks.filter(c=>c.pass).length,
    total:checks.length,has_reply:Boolean(turn.reply)});
  }catch(e){
   output.push({id:test.id,action:'error',elapsed_ms:null,
    checks:[{check:'executed',pass:false}],passed:0,total:1,error_type:e.name||'Error'});
  }
 }
 return output;
}
const executedAsCli=process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1];
if(executedAsCli){
 const file=process.argv[2];
 const fixtures=JSON.parse(fs.readFileSync(file,'utf8'));
 console.log(JSON.stringify({engine:'node-production-flow-offline',cases:await nodeResults(fixtures)}));
}
