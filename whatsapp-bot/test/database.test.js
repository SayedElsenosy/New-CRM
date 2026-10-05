import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
test('migration, atomic turn, idempotency, protected stages and reorder',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid';create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;create or replace function storage.foldername(text) returns text[] language sql immutable as 'select string_to_array($1,''/'')';`);
 // gen_random_uuid is built into PostgreSQL; PGlite doesn't package pgcrypto.
 const sql=(await fs.readFile(new URL('../../supabase/001_masar.sql',import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;','');
 await db.exec(sql);await db.exec(sql);
 const {rows:[a]}=await db.query("insert into masar_applicants(contact_id,phone) values('201012345678@c.us','+201012345678') returning id");
 const {rows:[q]}=await db.query("insert into masar_questions(label,field_key,kind) values('Name','name','name') returning id");
 const {rows:[m]}=await db.query("insert into masar_messages(applicant_id,wa_id,direction,sender,body) values($1,'wa-1','in','applicant','Sayed Mohamed') returning id",[a.id]);
 const patch={answers:{[q.id]:{value:'Sayed Mohamed',kind:'name'}},stage:'complete',awaiting_id:null};
 await db.query('select masar_commit_turn($1,$2::jsonb,$3)',[m.id,JSON.stringify(patch),'Done']);
 await db.query('select masar_commit_turn($1,$2::jsonb,$3)',[m.id,JSON.stringify(patch),'Done']);
 const {rows:out}=await db.query("select * from masar_messages where direction='out'");assert.equal(out.length,1);assert.equal(out[0].status,'queued');
 assert.equal((await db.query('select stage from masar_applicants where id=$1',[a.id])).rows[0].stage,'complete');
 await db.query("update masar_applicants set stage='lecture' where id=$1",[a.id]);
 const {rows:[m2]}=await db.query("insert into masar_messages(applicant_id,wa_id,direction,sender) values($1,'wa-2','in','applicant') returning id",[a.id]);
 await db.query('select masar_commit_turn($1,$2::jsonb,$3)',[m2.id,JSON.stringify({stage:'incomplete'}),'']);
 assert.equal((await db.query('select stage from masar_applicants where id=$1',[a.id])).rows[0].stage,'lecture');
 await db.query('select masar_reorder_questions($1::uuid[])',[[q.id]]);
 assert.equal((await db.query('select position from masar_questions')).rows[0].position,1);
 assert.equal((await db.query("select has_table_privilege('anon','masar_applicants','SELECT') as allowed")).rows[0].allowed,false);

 // Upgrade an existing single-number installation to multi-WhatsApp.
 const multiSql=(await fs.readFile(new URL('../../supabase/003_multi_whatsapp.sql',import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;','');
 await db.exec(multiSql);await db.exec(multiSql);
 const {rows:[defaultAccount]}=await db.query("select id from masar_whatsapp_accounts where legacy_session=true limit 1");
 assert.ok(defaultAccount?.id);
 assert.equal(String((await db.query('select whatsapp_account_id from masar_applicants where id=$1',[a.id])).rows[0].whatsapp_account_id),String(defaultAccount.id));
 const {rows:[second]}=await db.query("insert into masar_whatsapp_accounts(name) values('Second') returning id");
 const {rows:[samePersonOtherNumber]}=await db.query("insert into masar_applicants(whatsapp_account_id,contact_id,phone) values($1,'201012345678@c.us','+201012345678') returning id",[second.id]);
 assert.ok(samePersonOtherNumber.id);
 const {rows:[in2]}=await db.query("insert into masar_messages(whatsapp_account_id,applicant_id,wa_id,direction,sender,body) values($1,$2,'same-account-msg','in','applicant','Hi') returning id",[second.id,samePersonOtherNumber.id]);
 await db.query('select masar_commit_turn($1,$2::jsonb,$3)',[in2.id,JSON.stringify({stage:'incomplete'}),'Reply']);
 const {rows:[out2]}=await db.query("select whatsapp_account_id from masar_messages where applicant_id=$1 and direction='out' order by created_at desc limit 1",[samePersonOtherNumber.id]);
 assert.equal(String(out2.whatsapp_account_id),String(second.id));

 // Add supervised bot intelligence without losing existing data.
 const intelligenceSql=(await fs.readFile(new URL('../../supabase/004_bot_intelligence.sql',import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;','');
 await db.exec(intelligenceSql);await db.exec(intelligenceSql);
 const {rows:[knowledge]}=await db.query("insert into masar_knowledge(question,answer,keywords) values('التأمين الطبي يبدأ امتى؟','من أول يوم',array['تأمين','طبي']) returning id");
 assert.ok(knowledge.id);
 const {rows:[handoffMessage]}=await db.query("insert into masar_messages(whatsapp_account_id,applicant_id,wa_id,direction,sender,body) values($1,$2,'handoff-msg','in','applicant','سؤال جديد') returning id",[second.id,samePersonOtherNumber.id]);
 await db.query('select masar_commit_turn($1,$2::jsonb,$3)',[handoffMessage.id,JSON.stringify({bot_enabled:false}),'هحوّلك لمسؤول التوظيف']);
 const {rows:[paused]}=await db.query('select bot_enabled from masar_applicants where id=$1',[samePersonOtherNumber.id]);
 assert.equal(paused.bot_enabled,false);
 assert.equal((await db.query("select has_table_privilege('anon','masar_knowledge','SELECT') as allowed")).rows[0].allowed,false);

 // Add the three-day learning/run mode. Migration is idempotent and defaults to live.
 const learningSql=await fs.readFile(new URL('../../supabase/005_learning_mode.sql',import.meta.url),'utf8');
 await db.exec(learningSql);await db.exec(learningSql);
 const {rows:[mode]}=await db.query("select ai_run_mode,ai_training_started_at,ai_training_until from masar_settings where id=true");
 assert.equal(mode.ai_run_mode,'live');assert.equal(mode.ai_training_started_at,null);assert.equal(mode.ai_training_until,null);
 await db.query("update masar_settings set ai_run_mode='training',ai_training_started_at=now(),ai_training_until=now()+interval '3 days' where id=true");
 const {rows:[training]}=await db.query("select ai_run_mode,extract(epoch from (ai_training_until-ai_training_started_at))/3600 as hours from masar_settings where id=true");
 assert.equal(training.ai_run_mode,'training');assert.equal(Number(training.hours),72);

 // Add automatic incomplete-applicant follow-ups. Migration is idempotent and defaults to 8 hours.
 const followupSql=await fs.readFile(new URL('../../supabase/007_applicant_followups.sql',import.meta.url),'utf8');
 await db.exec(followupSql);await db.exec(followupSql);
 const {rows:[followup]}=await db.query("select followup_enabled,followup_hours from masar_settings where id=true");
 assert.equal(followup.followup_enabled,true);assert.equal(followup.followup_hours,8);
 const {rows:[followApplicant]}=await db.query("select followup_count,followup_last_sent_at from masar_applicants where id=$1",[samePersonOtherNumber.id]);
 assert.equal(followApplicant.followup_count,0);assert.equal(followApplicant.followup_last_sent_at,null);

 // Clean-reset markers protect a deleted applicant from stale WhatsApp history.
 const resetSql=await fs.readFile(new URL('../../supabase/008_clean_applicant_reset.sql',import.meta.url),'utf8');
 await db.exec(resetSql);await db.exec(resetSql);
 await db.query("insert into masar_applicant_resets(whatsapp_account_id,contact_id,phone) values($1,'201012345678@c.us','+201012345678') on conflict(whatsapp_account_id,contact_id) do update set reset_at=now()",[second.id]);
 const {rows:[reset]}=await db.query("select phone,reset_at from masar_applicant_resets where whatsapp_account_id=$1 and contact_id='201012345678@c.us'",[second.id]);
 assert.equal(reset.phone,'+201012345678');assert.ok(reset.reset_at);
 assert.equal((await db.query("select has_table_privilege('anon','masar_applicant_resets','SELECT') as allowed")).rows[0].allowed,false);

 // Durable human-intervention alerts support per-user unread state and resolution.
 const alertsSql=await fs.readFile(new URL('../../supabase/009_human_intervention_alerts.sql',import.meta.url),'utf8');
 await db.exec(alertsSql);await db.exec(alertsSql);
 const {rows:[alert]}=await db.query("insert into masar_alerts(applicant_id,whatsapp_account_id,source_message_id,body,phone) values($1,$2,$3,'سؤال يحتاج تدخل','+201012345678') returning id,status",[samePersonOtherNumber.id,second.id,handoffMessage.id]);
 assert.equal(alert.status,'open');assert.ok(alert.id);
 const {rows:[reader]}=await db.query("insert into auth.users(id) values(gen_random_uuid()) returning id");
 await db.query("insert into masar_alert_reads(alert_id,user_id) values($1,$2)",[alert.id,reader.id]);
 assert.equal((await db.query("select count(*)::int as n from masar_alert_reads where alert_id=$1",[alert.id])).rows[0].n,1);
 await db.query("update masar_alerts set status='resolved',resolved_at=now(),resolution='test' where id=$1",[alert.id]);
 assert.equal((await db.query("select status from masar_alerts where id=$1",[alert.id])).rows[0].status,'resolved');
 assert.equal((await db.query("select has_table_privilege('anon','masar_alerts','SELECT') as allowed")).rows[0].allowed,false);

 // Mobile push tokens are server-only and tied to authorized auth users.
 const pushSql=await fs.readFile(new URL('../../supabase/010_mobile_push.sql',import.meta.url),'utf8');
 await db.exec(pushSql);await db.exec(pushSql);
 await db.query("insert into masar_push_tokens(user_id,token,platform,device_name) values($1,'ExponentPushToken[test-token-123456]','android','Test phone')",[reader.id]);
 const {rows:[push]}=await db.query("select platform,active from masar_push_tokens where user_id=$1",[reader.id]);
 assert.equal(push.platform,'android');assert.equal(push.active,true);
 assert.equal((await db.query("select has_table_privilege('anon','masar_push_tokens','SELECT') as allowed")).rows[0].allowed,false);

 // Multi-office recruitment keeps existing records, maps WhatsApp accounts to offices,
 // backfills the recruitment pipeline, and supports interviews.
 const officeSql=(await fs.readFile(new URL('../../supabase/011_multi_office_recruitment.sql',import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;','');
 await db.exec(officeSql);await db.exec(officeSql);
 const {rows:officeCount}=await db.query("select count(*)::int as n from masar_offices");
 assert.equal(officeCount[0].n,2);
 const {rows:[firstOffice]}=await db.query("select office_id from masar_applicants where id=$1",[a.id]);
 const {rows:[firstStage]}=await db.query("select recruitment_stage from masar_applicants where id=$1",[a.id]);
 assert.ok(firstOffice.office_id);assert.equal(firstStage.recruitment_stage,'interview');
 const {rows:[secondOffice]}=await db.query("select office_id,recruitment_stage from masar_applicants where id=$1",[samePersonOtherNumber.id]);
 assert.equal(String(secondOffice.office_id),String(second.id));assert.equal(secondOffice.recruitment_stage,'new');
 const {rows:[interview]}=await db.query("insert into masar_interviews(applicant_id,office_id,scheduled_at,interviewer_id,created_by) values($1,$2,now()+interval '1 day',$3,$3) returning id,status",[samePersonOtherNumber.id,second.id,reader.id]);
 assert.ok(interview.id);assert.equal(interview.status,'scheduled');
 await db.query("update masar_whatsapp_accounts set office_id=$1 where id=$2",[defaultAccount.id,second.id]);
 const {rows:[moved]}=await db.query("select office_id from masar_applicants where id=$1",[samePersonOtherNumber.id]);
 assert.equal(String(moved.office_id),String(defaultAccount.id));
 assert.equal((await db.query("select has_table_privilege('anon','masar_offices','SELECT') as allowed")).rows[0].allowed,false);
 assert.equal((await db.query("select has_table_privilege('anon','masar_interviews','SELECT') as allowed")).rows[0].allowed,false);

 // Office-manager isolation: staff profiles, office-specific questions/areas/settings,
 // and safe cloning for existing offices.
 await db.exec(`create table if not exists masar_campaigns(id uuid primary key default gen_random_uuid(),name text not null,meta_campaign_id text,active boolean not null default true,created_at timestamptz not null default now(),updated_at timestamptz not null default now());`);
 // Put the second WhatsApp account in the non-primary office so cloning/remapping is deterministic.
 const {rows:[primaryOfficeForConfig]}=await db.query("select id from masar_offices order by created_at,id limit 1");
 const {rows:[targetOfficeForConfig]}=await db.query("select id from masar_offices where id<>$1 order by created_at,id limit 1",[primaryOfficeForConfig.id]);
 await db.query("update masar_whatsapp_accounts set office_id=$1 where id=$2",[targetOfficeForConfig.id,second.id]);
 await db.query("insert into masar_staff(user_id) values($1) on conflict(user_id) do nothing",[reader.id]);
 await db.query("insert into masar_staff_whatsapp_access(user_id,whatsapp_account_id) values($1,$2) on conflict do nothing",[reader.id,second.id]);
 const {rows:[areaBefore]}=await db.query("insert into masar_areas(name,details,position) values('Test Area','Office scoped area',1) returning id");
 const {rows:[areaQuestionBefore]}=await db.query("insert into masar_questions(label,field_key,kind,position) values('Area?','work_area','area',2) returning id");
 await db.query("update masar_applicants set awaiting_id=$2::uuid,answers=jsonb_build_object(($2::uuid)::text,jsonb_build_object('value',($3::uuid)::text,'display','Test Area','kind','area')) where id=$1::uuid",[samePersonOtherNumber.id,areaQuestionBefore.id,areaBefore.id]);

 const officeAdminSql=(await fs.readFile(new URL('../../supabase/012_office_admin_scoped_config.sql',import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;','');
 await db.exec(officeAdminSql);await db.exec(officeAdminSql);
 const {rows:[staffOffice]}=await db.query("select office_id,job_title,bio,avatar_path from masar_staff where user_id=$1",[reader.id]);
 assert.equal(String(staffOffice.office_id),String(targetOfficeForConfig.id));assert.equal(staffOffice.job_title,'');assert.equal(staffOffice.bio,'');assert.equal(staffOffice.avatar_path,null);
 const {rows:officeSettings}=await db.query("select office_id,welcome,followup_hours from masar_office_settings order by office_id");
 assert.equal(officeSettings.length,2);assert.ok(officeSettings.every(x=>x.followup_hours===8));
 const {rows:qByOffice}=await db.query("select office_id,count(*)::int as n from masar_questions group by office_id order by office_id");
 assert.equal(qByOffice.length,2);assert.equal(qByOffice[0].n,qByOffice[1].n);
 const {rows:aByOffice}=await db.query("select office_id,count(*)::int as n from masar_areas group by office_id order by office_id");
 assert.equal(aByOffice.length,2);assert.equal(aByOffice[0].n,aByOffice[1].n);
 const {rows:[remapped]}=await db.query("select awaiting_id,answers from masar_applicants where id=$1",[samePersonOtherNumber.id]);
 assert.notEqual(String(remapped.awaiting_id),String(areaQuestionBefore.id));
 const remappedAnswer=remapped.answers[String(remapped.awaiting_id)];
 assert.ok(remappedAnswer);assert.equal(remappedAnswer.kind,'area');assert.notEqual(String(remappedAnswer.value),String(areaBefore.id));
 const {rows:[targetArea]}=await db.query("select id from masar_areas where office_id=$1 and name='Test Area'",[targetOfficeForConfig.id]);
 assert.equal(String(remappedAnswer.value),String(targetArea.id));
 assert.equal((await db.query("select has_table_privilege('anon','masar_office_settings','SELECT') as allowed")).rows[0].allowed,false);

 // Recruitment performance migration preserves existing data, adds editable zone rules,
 // stable qualification keys, spend metadata and future-office cloning support.
 await db.query("update masar_areas set name='أكتوبر' where id=$1",[targetArea.id]);
 await db.query("insert into masar_questions(label,field_key,kind,position,office_id) values('معاك موتوسيكل؟','motorcycle','yes_no',90,$1)",[primaryOfficeForConfig.id]);
 await db.query("insert into masar_ads(ad_id,name,spend) values('120240000000000001','Legacy Ad',700) on conflict(ad_id) do update set spend=excluded.spend");
 const performanceSql=(await fs.readFile(new URL('../../supabase/013_recruitment_performance_funnel.sql',import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;','');
 await db.exec(performanceSql);await db.exec(performanceSql);

 const {rows:[performanceAd]}=await db.query("select zone,spend_source,spend_synced_at,spend from masar_ads where ad_id='120240000000000001'");
 assert.equal(performanceAd.zone,'UNKNOWN');assert.equal(performanceAd.spend_source,'manual');assert.equal(Number(performanceAd.spend),700);assert.equal(performanceAd.spend_synced_at,null);
 const {rows:[eligibleArea]}=await db.query("select zone,recruitment_eligible from masar_areas where id=$1",[targetArea.id]);
 assert.equal(eligibleArea.zone,'WEST');assert.equal(eligibleArea.recruitment_eligible,true);
 const {rows:[renamedMoto]}=await db.query("select field_key from masar_questions where office_id=$1 and label='معاك موتوسيكل؟'",[primaryOfficeForConfig.id]);
 assert.equal(renamedMoto.field_key,'has_motorcycle');
 const {rows:residenceQuestions}=await db.query("select office_id,field_key,kind from masar_questions where field_key='residence_area' order by office_id");
 assert.equal(residenceQuestions.length,2);assert.ok(residenceQuestions.every(x=>x.kind==='text'));

 const {rows:[thirdOffice]}=await db.query("insert into masar_offices(name,code) values('Third Office','THIRD') returning id");
 await db.query("select masar_clone_office_config($1,$2,false)",[targetOfficeForConfig.id,thirdOffice.id]);
 const {rows:[clonedEligible]}=await db.query("select zone,recruitment_eligible from masar_areas where office_id=$1 and name='أكتوبر'",[thirdOffice.id]);
 assert.equal(clonedEligible.zone,'WEST');assert.equal(clonedEligible.recruitment_eligible,true);
 const {rows:[clonedResidence]}=await db.query("select field_key from masar_questions where office_id=$1 and field_key='residence_area'",[thirdOffice.id]);
 assert.equal(clonedResidence.field_key,'residence_area');
 }finally{await db.close();}
});
