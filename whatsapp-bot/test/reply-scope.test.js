import test from 'node:test';
import assert from 'node:assert/strict';
import {accountCanReply,hasVerifiedAdReferral,historyReviewRequired,normalizeReplyMode,
 initialHistoryReview,historicalChatMark,shouldCreateHistoryReviewAlert} from '../src/reply-scope.js';
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
