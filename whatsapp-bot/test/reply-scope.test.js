import test from 'node:test';
import assert from 'node:assert/strict';
import {accountCanReply,hasVerifiedAdReferral,historyReviewRequired,normalizeReplyMode,
 initialHistoryReview,historicalChatMark,shouldCreateHistoryReviewAlert,
 eligibleForAutoAdStart,isVerifiedCampaignLead,pauseOnHistoricalStaffReply} from '../src/reply-scope.js';
import {normalizedRecord,extractAdReferral} from '../src/whatsapp.js';

test('per-number reply mode: all, ads_only, off (and fail closed for invalid)',()=>{
 const referral={source_id:'campaign-ad-123',source_type:'ad'};
 assert.equal(accountCanReply('off',{referral}),false);
 assert.equal(accountCanReply('all',{referral:null}),true);
 assert.equal(accountCanReply('ads_only',{referral:null}),false);
 assert.equal(accountCanReply('ads_only',{referral}),true);
 assert.equal(accountCanReply('ads_only',{firstAttribution:referral}),true);
 assert.equal(accountCanReply('ads_only',{firstAttribution:{source_id:null}}),false);
 assert.equal(accountCanReply('ads_only',{referral:{source_type:'unknown'}}),false);
 assert.equal(hasVerifiedAdReferral({ctwa_clid:'ctwa-1'}),true);
 assert.equal(normalizeReplyMode('malicious'),'off');
});
test('brand-new CRM contacts and imported WhatsApp messages require review before replying',()=>{
 assert.equal(historyReviewRequired({newApplicant:true}),true);
 assert.equal(historyReviewRequired({historyImported:true}),true);
 assert.equal(historyReviewRequired({answers:{__history_review:initialHistoryReview()}}),true);
 assert.equal(historyReviewRequired({answers:{__history_review:{status:'approved'}}}),false);
 assert.equal(historyReviewRequired({answers:{}}),false);
 assert.equal(historicalChatMark({historical:true}),true);
 assert.equal(historicalChatMark({upsert_type:'history'}),true);
});
test('Baileys history messages are recognized for silent import, including staff outbound',async()=>{
 const old={key:{remoteJid:'201001234567@s.whatsapp.net',id:'old1',fromMe:true},
  messageTimestamp:1712000000,message:{conversation:'قبل الربط، مسؤول التوظيف كلمك بالفعل'}};
 const record=await normalizedRecord({},old,{upsertType:'history'});
 assert.equal(record.historical,true);
 assert.equal(record.direction,'out');
 assert.equal(record.source,'linked_whatsapp_device');
 assert.equal(record.body,'قبل الربط، مسؤول التوظيف كلمك بالفعل');
 const suppressed=await normalizedRecord({},old,{upsertType:'append'});
 assert.equal(suppressed,null);
});
test('genuine ad context is detected without assuming ordinary text is an ad referral',()=>{
 const plain={extendedTextMessage:{text:'جايلك من اعلان على فيسبوك'}};
 assert.equal(extractAdReferral(plain),null);
 const referred={extendedTextMessage:{text:'ممكن تفاصيل الشغل',contextInfo:{
  externalAdReply:{sourceId:'123',sourceType:'ad',title:'Recruiting'}
 }}};
 assert.equal(extractAdReferral(referred).source_id,'123');
});

test('first live inbound from a verified ad must show history review alert instead of silently swallowing messages',()=>{
 const pending={__history_review:{status:'pending',source:'first_seen_after_link'}};
 assert.equal(shouldCreateHistoryReviewAlert({historical:false,answers:pending}),true);
 assert.equal(shouldCreateHistoryReviewAlert({historical:true,answers:pending}),false);
 assert.equal(shouldCreateHistoryReviewAlert({historical:false,answers:{
  __history_review:{status:'approved',source:'first_seen_after_link'}
 }}),false);
 assert.equal(shouldCreateHistoryReviewAlert({historical:false,answers:{}}),false);
});

const verifiedAd={source_id:'120253219829900236',source_type:'ad',ctwa_clid:'real-click-id',entry_point_source:'ctwa_ad'};
const adsAccount={reply_mode:'ads_only',active:true,review_new_contacts:true};
test('verified click-to-WhatsApp lead on ads-only number auto starts first contact',()=>{
 assert.equal(isVerifiedCampaignLead(verifiedAd),true);
 assert.equal(eligibleForAutoAdStart({account:adsAccount,referral:verifiedAd}),true);
 assert.equal(eligibleForAutoAdStart({account:adsAccount,referral:{source_type:'ad'}}),false);
 assert.equal(eligibleForAutoAdStart({account:{...adsAccount,reply_mode:'off'},referral:verifiedAd}),false);
 assert.equal(eligibleForAutoAdStart({account:{...adsAccount,active:false},referral:verifiedAd}),false);
 assert.equal(eligibleForAutoAdStart({account:adsAccount,referral:verifiedAd,historical:true}),false);
 assert.equal(eligibleForAutoAdStart({account:adsAccount,referral:verifiedAd,outbound:true}),false);
 assert.equal(eligibleForAutoAdStart({account:adsAccount,referral:{source_id:'ad-id'},existing:false}),false,
  'source id without a verified ad-type metadata does not bypass review');
});
test('old-policy pending Meta ad is resumed only if no imported staff conversation exists',()=>{
 const firstSeen={__history_review:{status:'pending',source:'first_seen_after_link'},__attribution:verifiedAd};
 const imported={__history_review:{status:'pending',source:'imported_whatsapp_history'},__attribution:verifiedAd};
 for(const answers of [firstSeen,imported]){
  assert.equal(eligibleForAutoAdStart({account:adsAccount,answers,existing:true}),true);
  assert.equal(eligibleForAutoAdStart({account:adsAccount,answers,existing:true,hasStaffHistory:true}),false);
 }
});
test('manual and previously staff-led pauses are never silently reopened',()=>{
 for(const status of [
  {status:'pending',source:'prior_staff_conversation'},
  {status:'approved',source:'prior_staff_conversation'},
  {status:'auto_started',source:'verified_campaign_without_known_staff_history'},
  {status:'pending',source:'manual_handoff'}
 ]){
  const answers={__history_review:status,__attribution:verifiedAd};
  assert.equal(eligibleForAutoAdStart({account:adsAccount,answers,existing:true}),false);
 }
 assert.equal(eligibleForAutoAdStart({account:adsAccount,answers:{__attribution:verifiedAd},existing:true}),false);
});
test('a late WhatsApp history sync reveals human outbound; stop bot and require review',()=>{
 assert.equal(pauseOnHistoricalStaffReply({
  historical:true,outbound:true,account:adsAccount,
  answers:{__history_review:{status:'auto_started'}}
 }),true);
 assert.equal(pauseOnHistoricalStaffReply({
  historical:true,outbound:false,account:adsAccount,
  answers:{__history_review:{status:'auto_started'}}
 }),false);
 assert.equal(pauseOnHistoricalStaffReply({
  historical:false,outbound:true,account:adsAccount,
  answers:{__history_review:{status:'auto_started'}}
 }),false);
 assert.equal(pauseOnHistoricalStaffReply({
  historical:true,outbound:true,account:adsAccount,
  answers:{__history_review:{status:'approved'}}
 }),false);
});
