import test from 'node:test';
import assert from 'node:assert/strict';
import {inferRecruitmentStage} from '../src/conversation-stage.js';

const msg=(sender,body,id=Math.random().toString(36))=>({id,sender,direction:sender==='applicant'?'in':'out',body});

test('moves to interview from an explicit staff appointment',()=>{
 const r=inferRecruitmentStage([
  msg('applicant','تمام المقابلة امتى؟'),
  msg('staff','ميعاد المقابلة يوم الثلاثاء الساعة 3')
 ],'review');
 assert.equal(r.stage,'interview');
 assert.equal(r.changed,true);
 assert.ok(r.confidence>=.9);
});

test('uses applicant context plus a short staff confirmation',()=>{
 const r=inferRecruitmentStage([
  msg('applicant','هو انا اتقبلت؟'),
  msg('staff','ايوه تمام')
 ],'interview');
 assert.equal(r.stage,'accepted');
 assert.equal(r.changed,true);
});

test('moves to hired only on strong work-start language',()=>{
 const r=inferRecruitmentStage([
  msg('staff','مبروك تم قبولك'),
  msg('applicant','ابدأ الشغل امتى؟'),
  msg('staff','هتبدأ الشغل بكرة الساعة 10')
 ],'accepted');
 assert.equal(r.stage,'hired');
 assert.equal(r.changed,true);
});

test('explicit rejection wins but hired and rejected are terminal',()=>{
 const rejected=inferRecruitmentStage([msg('staff','للأسف غير مناسب للوظيفة')],'review');
 assert.equal(rejected.stage,'rejected');
 assert.equal(rejected.changed,true);
 const hired=inferRecruitmentStage([msg('staff','تم رفضك')],'hired');
 assert.equal(hired.stage,'hired');
 assert.equal(hired.changed,false);
});

test('does not move stage from applicant claims alone',()=>{
 const r=inferRecruitmentStage([
  msg('applicant','انا اتقبلت خلاص وهبدأ شغل بكرة')
 ],'new');
 assert.equal(r.stage,'new');
 assert.equal(r.changed,false);
});

test('never auto-downgrades a later recruitment stage',()=>{
 const r=inferRecruitmentStage([
  msg('staff','هنراجع بياناتك ونرد عليك')
 ],'accepted');
 assert.equal(r.stage,'accepted');
 assert.equal(r.changed,false);
});

test('recognizes review language from staff conversation',()=>{
 const r=inferRecruitmentStage([
  msg('applicant','في جديد؟'),
  msg('staff','طلبك تحت المراجعة وهنراجع بياناتك النهاردة')
 ],'new');
 assert.equal(r.stage,'review');
 assert.equal(r.changed,true);
});
