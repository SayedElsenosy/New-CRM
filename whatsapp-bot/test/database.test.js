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

 // Meta integration schema stores only encrypted tokens server-side, scopes assets by office,
 // and cascades Meta/campaign/ad data when an office is removed.
 const metaSql=(await fs.readFile(new URL('../../supabase/014_meta_ads_connection.sql',import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;','');
 await db.exec(metaSql);await db.exec(metaSql);
 await db.query("insert into masar_meta_connections(office_id,meta_user_id,meta_user_name,access_token_encrypted,connected_by) values($1,'meta-user','Tester','v1.encrypted.token.payload',$2)",[thirdOffice.id,reader.id]);
 await db.query("insert into masar_meta_ad_accounts(office_id,account_id,name,currency) values($1,'123456','Main Ad Account','EGP')",[thirdOffice.id]);
 const {rows:[metaCampaign]}=await db.query("insert into masar_campaigns(name,meta_campaign_id,office_id,meta_status,meta_synced_at) values('Meta Campaign','987654',$1,'ACTIVE',now()) returning id",[thirdOffice.id]);
 await db.query("insert into masar_ads(ad_id,name,campaign_id,office_id,meta_status,meta_synced_at) values('120240000000000099','Meta Ad',$1,$2,'ACTIVE',now())",[metaCampaign.id,thirdOffice.id]);
 const {rows:[metaConnection]}=await db.query("select meta_user_name from masar_meta_connections where office_id=$1",[thirdOffice.id]);
 assert.equal(metaConnection.meta_user_name,'Tester');
 assert.equal((await db.query("select has_table_privilege('anon','masar_meta_connections','SELECT') as allowed")).rows[0].allowed,false);
 await db.query("delete from masar_offices where id=$1",[thirdOffice.id]);
 assert.equal((await db.query("select count(*)::int as n from masar_meta_connections where office_id=$1",[thirdOffice.id])).rows[0].n,0);
 assert.equal((await db.query("select count(*)::int as n from masar_meta_ad_accounts where office_id=$1",[thirdOffice.id])).rows[0].n,0);
 assert.equal((await db.query("select count(*)::int as n from masar_campaigns where id=$1",[metaCampaign.id])).rows[0].n,0);
 assert.equal((await db.query("select count(*)::int as n from masar_ads where ad_id='120240000000000099'")).rows[0].n,0);

 // Early qualification migration is idempotent, keeps Meta/attribution tables untouched,
 // installs the six canonical questions, residence aliases, messages and approved KB answers.
 const earlyFlowSql=(await fs.readFile(new URL('../../supabase/015_early_qualification_flow.sql',import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;','');
 await db.exec(earlyFlowSql);await db.exec(earlyFlowSql);
 const {rows:canonicalQuestions}=await db.query("select field_key,kind,required,active,position,label from masar_questions where office_id=$1 and active=true order by position",[primaryOfficeForConfig.id]);
 assert.deepEqual(canonicalQuestions.map(x=>x.field_key),['has_motorcycle','residence_area','preferred_work_area','full_name','shift_acceptance','ready_to_start']);
 assert.deepEqual(canonicalQuestions.map(x=>x.kind),['yes_no','text','area','name','yes_no','yes_no']);
 assert.ok(canonicalQuestions.every(x=>x.required===true));
 assert.equal(canonicalQuestions[0].label,'هل معاك موتوسيكل متاح للشغل يوميًا؟');
 assert.equal(canonicalQuestions[1].label,'ساكن فين حاليًا؟ اكتب اسم المنطقة أو الحي بالتحديد.');

 const {rows:[octoberArea]}=await db.query("select zone,recruitment_eligible,aliases from masar_areas where office_id=$1 and name='أكتوبر'",[primaryOfficeForConfig.id]);
 assert.equal(octoberArea.zone,'WEST');assert.equal(octoberArea.recruitment_eligible,true);
 assert.ok(octoberArea.aliases.includes('6 اكتوبر'));
 assert.ok(octoberArea.aliases.includes('السادس من أكتوبر'));

 const {rows:[flowSettings]}=await db.query("select welcome,completion,qualification_require_shift,qualification_require_motorcycle_license from masar_office_settings where office_id=$1",[primaryOfficeForConfig.id]);
 assert.match(flowSettings.welcome,/Breadfast/);assert.match(flowSettings.welcome,/6200/);
 assert.match(flowSettings.completion,/مرحلة التقديم الأولية/);
 assert.equal(flowSettings.qualification_require_shift,false);
 assert.equal(flowSettings.qualification_require_motorcycle_license,false);

 const {rows:[knowledgeCount]}=await db.query("select count(*)::int as n from masar_knowledge where question in ('المرتب كام؟','الدخل كام؟','الشيفت كام ساعة؟','لازم موتوسيكل؟','في تأمين؟','التقديم بفلوس؟')");
 assert.equal(knowledgeCount.n,6);
 assert.equal((await db.query("select count(*)::int as n from masar_ads where ad_id='120240000000000001'")).rows[0].n,1);

 // Work-area correction removes residence from qualification flow without deleting historical residence data.
 const {rows:[targetResidenceQuestion]}=await db.query("select id from masar_questions where office_id=$1 and field_key='residence_area'",[targetOfficeForConfig.id]);
 await db.query("update masar_applicants set awaiting_id=$2,answers=jsonb_build_object('__qualification_stop',jsonb_build_object('reason','residence_outside_hiring_zones','at',now()),'__application_flow_status',jsonb_build_object('value','stopped_not_qualified','reason','residence_outside_hiring_zones')) where id=$1",[samePersonOtherNumber.id,targetResidenceQuestion.id]);
 const workAreaSql=await fs.readFile(new URL('../../supabase/016_work_area_qualification.sql',import.meta.url),'utf8');
 await db.exec(workAreaSql);await db.exec(workAreaSql);

 const {rows:correctedQuestions}=await db.query("select field_key,kind,required,active,position,label from masar_questions where office_id=$1 order by position,field_key",[targetOfficeForConfig.id]);
 const activeCorrected=correctedQuestions.filter(x=>x.active);
 assert.deepEqual(activeCorrected.map(x=>x.field_key),['has_motorcycle','preferred_work_area','full_name','shift_acceptance','ready_to_start']);
 assert.equal(activeCorrected[1].label,'أنهي منطقة تقدر تشتغل فيها يوميًا؟ اختار المنطقة اللي تقدر تلتزم بالشغل فيها بشكل مستمر.');
 const residenceCorrected=correctedQuestions.find(x=>x.field_key==='residence_area');
 assert.equal(residenceCorrected.active,false);assert.equal(residenceCorrected.required,false);
 const {rows:[preferredCorrected]}=await db.query("select id from masar_questions where office_id=$1 and field_key='preferred_work_area'",[targetOfficeForConfig.id]);
 const {rows:[reopenedApplicant]}=await db.query("select awaiting_id,answers,recruitment_stage from masar_applicants where id=$1",[samePersonOtherNumber.id]);
 assert.equal(String(reopenedApplicant.awaiting_id),String(preferredCorrected.id));
 assert.equal(reopenedApplicant.answers.__qualification_stop,undefined);
 assert.equal(reopenedApplicant.answers.__application_flow_status.value,'active');
 assert.notEqual(reopenedApplicant.recruitment_stage,'rejected');
 assert.equal((await db.query("select count(*)::int as n from masar_ads where ad_id='120240000000000001'")).rows[0].n,1);

 // Autonomous agent migration: continuous learning, per-office runtime control,
 // office-scoped memory, and dynamic information requirements.
 const autonomousSql=await fs.readFile(new URL('../../supabase/017_autonomous_office_agent.sql',import.meta.url),'utf8');
 await db.exec(autonomousSql);await db.exec(autonomousSql);
 const {rows:[autonomousSettings]}=await db.query("select ai_learning_enabled,ai_run_mode,ai_training_started_at,ai_training_until from masar_settings where id=true");
 assert.equal(autonomousSettings.ai_learning_enabled,true);
 assert.equal(autonomousSettings.ai_run_mode,'live');
 assert.equal(autonomousSettings.ai_training_started_at,null);
 assert.equal(autonomousSettings.ai_training_until,null);
 const {rows:agentOfficeSettings}=await db.query("select office_id,agent_enabled from masar_office_settings order by office_id");
 assert.ok(agentOfficeSettings.length>=2);assert.ok(agentOfficeSettings.every(x=>x.agent_enabled===true));
 const {rows:[agentQuestion]}=await db.query("select priority,allow_inference,confirmation_required,agent_instruction from masar_questions where office_id=$1 and field_key='has_motorcycle'",[primaryOfficeForConfig.id]);
 assert.equal(agentQuestion.priority,100);assert.equal(agentQuestion.allow_inference,true);assert.equal(agentQuestion.confirmation_required,false);
 const {rows:[preferredPriority]}=await db.query("select priority from masar_questions where office_id=$1 and field_key='preferred_work_area'",[primaryOfficeForConfig.id]);
 assert.equal(preferredPriority.priority,95);
 const {rows:[namePriority]}=await db.query("select priority from masar_questions where office_id=$1 and field_key='full_name'",[primaryOfficeForConfig.id]);
 assert.equal(namePriority.priority,90);
 const {rows:knowledgeScopes}=await db.query("select office_id from masar_knowledge limit 1");
 assert.equal(Object.prototype.hasOwnProperty.call(knowledgeScopes[0],'office_id'),true);
 }finally{await db.close();}
});
