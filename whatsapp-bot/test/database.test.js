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
 }finally{await db.close();}
});
