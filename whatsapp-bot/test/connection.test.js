import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {WhatsAppConnection,resolvePhone} from '../src/whatsapp.js';

test('phone resolution uses PN mapping and never treats LID digits as a phone',async()=>{
 const msg={key:{remoteJid:'99999999999999@lid'}};
 assert.equal(await resolvePhone({signalRepository:{lidMapping:{getPNForLID:async()=> '201012345678@s.whatsapp.net'}}},msg),'+201012345678');
 assert.equal(await resolvePhone({signalRepository:{lidMapping:{getPNForLID:async()=> null}}},msg),null);
 assert.equal(await resolvePhone({}, {key:{remoteJid:'201012345678@s.whatsapp.net'}}),'+201012345678');
});

test('connect lifecycle, persisted restart intent and real disconnect methods',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'masar-test-'));let starts=0,logouts=0,ends=0,sock;
 const authLoader=async()=>({state:{creds:{},keys:{}},saveCreds:async()=>{}});
 const SocketFactory=()=>{starts++;const ev=new EventEmitter();sock={ev,user:{id:'201012345678@s.whatsapp.net'},logout:async()=>{logouts++;},end:()=>{ends++;},sendMessage:async()=>({key:{id:'m1'}})};return sock;};
 const c=new WhatsAppConnection({sessionPath:tmp,onMessage:async()=>{},SocketFactory,authLoader});
 try{
  await c.init();assert.equal(starts,0);
  await c.connect();await c.connect();assert.equal(starts,1);assert.equal(c.snapshot().status,'starting');
  sock.ev.emit('connection.update',{connection:'open'});await new Promise(r=>setImmediate(r));
  assert.equal(c.snapshot().status,'connected');assert.equal(c.snapshot().phone,'+201012345678');
  assert.equal((await c.send('201099999999@s.whatsapp.net','hi')).key.id,'m1');
  await c.disconnect();assert.equal(logouts,1);assert.ok(ends>=1);assert.equal(c.snapshot().status,'disconnected');
  assert.equal(JSON.parse(await fs.readFile(path.join(tmp,'connection.json'))).connected,false);
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
