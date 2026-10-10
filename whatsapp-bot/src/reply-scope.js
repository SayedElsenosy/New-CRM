export const WHATSAPP_REPLY_MODES=['off','all','ads_only'];
export function normalizeReplyMode(mode){
 return WHATSAPP_REPLY_MODES.includes(mode)?mode:'off';
}
export function hasVerifiedAdReferral(referral){
 return Boolean(referral&&typeof referral==='object'&&(
  String(referral.source_id||'').trim() ||
  String(referral.ctwa_clid||'').trim() ||
  String(referral.source_type||'').toLowerCase()==='ad' ||
  String(referral.entry_point_source||'').toLowerCase().includes('ad') ||
  String(referral.whatsapp_campaign_id||'').trim()
 ));
}
export function accountCanReply(mode,{referral=null,firstAttribution=null}={}){
 const selected=normalizeReplyMode(mode);
 if(selected==='off')return false;
 if(selected==='all')return true;
 return hasVerifiedAdReferral(referral)||hasVerifiedAdReferral(firstAttribution);
}
// Known CRM applicants retain their prior per-applicant bot status; for a
// contact FIRST seen on a newly linked number, earlier device-side dialogue
// cannot be assumed to have been imported completely. Require staff review.
export function historyReviewRequired({newApplicant=false,historyImported=false,answers={}}={}){
 if(answers?.__history_review?.status==='approved')return false;
 return Boolean(newApplicant||historyImported||answers?.__history_review?.status==='pending');
}
export function initialHistoryReview({source='unverified_prior_history'}={}){
 return {status:'pending',source,at:new Date().toISOString()};
}
export function historicalChatMark(record){
 return record?.historical===true||record?.upsert_type==='history';
}
