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
// Only an authentic WhatsApp click-to-ad referral can bypass the initial
// unknown-contact review. Do not trust free-text claims of coming from an ad.
export function isVerifiedCampaignLead(referral){
 return Boolean(referral&&typeof referral==='object'&&(
  String(referral.source_type||'').toLowerCase()==='ad' ||
  String(referral.entry_point_source||'').toLowerCase()==='ctwa_ad' ||
  String(referral.ctwa_clid||'').trim()
 )&&(String(referral.source_id||'').trim()||String(referral.ctwa_clid||'').trim()));
}
const AUTO_REVIEW_SOURCES=new Set(['first_seen_after_link','imported_whatsapp_history']);
export function eligibleForAutoAdStart({historical=false,outbound=false,account=null,referral=null,answers=null,existing=false,hasStaffHistory=false}={}){
 if(historical||outbound||hasStaffHistory||account?.active!==true||account?.review_new_contacts!==true)return false;
 if(!accountCanReply(account.reply_mode,{referral,firstAttribution:answers?.__attribution}))return false;
 if(!isVerifiedCampaignLead(referral)&&!isVerifiedCampaignLead(answers?.__attribution))return false;
 if(!existing)return true;
 const history=answers?.__history_review;
 return history?.status==='pending'&&AUTO_REVIEW_SOURCES.has(history.source);
}
export function pauseOnHistoricalStaffReply({historical=false,outbound=false,account=null,answers={}}={}){
 return historical&&outbound&&account?.review_new_contacts===true
  &&answers?.__history_review?.status!=='approved';
}
export function automaticAdReview(){
 return {status:'auto_started',source:'verified_campaign_without_known_staff_history',at:new Date().toISOString()};
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
export function shouldCreateHistoryReviewAlert({historical=false,answers={}}={}){
 return !historical&&historyReviewRequired({answers});
}
export function historicalChatMark(record){
 return record?.historical===true||record?.upsert_type==='history';
}
