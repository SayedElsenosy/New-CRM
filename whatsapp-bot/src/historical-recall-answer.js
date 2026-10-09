import {norm} from './domain.js';

const recallRequest=/(?:فاكر|فكرني|قلتلك|قولتلك|كنت قلت|كنت قولت|كنت قايل|قلت قبل كده)/;
const residenceRequest=/(?:ساكن|سكن|بيتي|عنواني|انا منين|مكان سكني)/;

/**
 * Narrow, citation-free conversational recall of an explicit applicant claim.
 * Never promote residence into preferred_work_area or qualification.
 * All returned excerpts must already be scoped to the applicant by the caller.
 */
export function answerHistoricResidenceRecall(text='',excerpts=[]){
 const message=norm(text);
 if(!recallRequest.test(message)||!residenceRequest.test(message))return null;
 const rows=(Array.isArray(excerpts)?excerpts:[])
  .filter(x=>x?.role==='applicant'&&x?.unverified===true&&Number.isSafeInteger(Number(x.sequence)))
  .sort((a,b)=>Number(b.sequence)-Number(a.sequence));
 const latestRelevant=rows.find(x=>/(?:ساكن|سكن|بيتي|عنواني)/.test(norm(x.excerpt||'')));
 if(!latestRelevant)return null;
 const evidence=norm(latestRelevant.excerpt);
 if(/(?:مش|غير|لا)\s+(?:في\s+)?المنصوريه/.test(evidence))return null;
 if(!/المنصوريه/.test(evidence))return null; // no speculation about other locations
 return {
  agent_action:'historical_residence_recall',
  reply:'أيوه، حسب كلامك اللي فات إنت قلت إنك ساكن في المنصورية'
   +(evidence.includes('مش المنصوره')?'، مش المنصورة':'')
   +'. لو مكان سكنك اتغير صححلي. وبالمناسبة مكان السكن مش بيحدد منطقة العمل اللي تختارها.',
 };
}
