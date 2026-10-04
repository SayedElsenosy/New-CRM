import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
test('migration, atomic turn, idempotency, protected stages and reorder',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
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
 }finally{await db.close();}
});
