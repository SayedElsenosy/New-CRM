import test from 'node:test';import assert from 'node:assert/strict';
import {makeApi} from '../src/api.js';
async function fixture(staff=true,role='admin',permissions){
 const metadata=role==='recruiter'?{masar_role:'recruiter',...(permissions!==undefined?{masar_permissions:permissions}:{})}:{};
 const db={auth:{getUser:async token=>token==='valid'?{data:{user:{id:'u',app_metadata:metadata}}}:{error:new Error('invalid'),data:{}}},from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:staff?{user_id:'u'}:null})})};
 let connects=0;const connection={snapshot:()=>({status:'disconnected'}),connect:async()=>{connects++;}};
 const app=makeApi({db,connection,worker:{lastError:null},serial:fn=>fn(),origins:['https://dashboard.test']});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>server.close(r)),connects:()=>connects};
}
test('QR and connect endpoints require valid staff session',async()=>{const f=await fixture();try{assert.equal((await fetch(f.url+'/api/whatsapp')).status,401);assert.equal((await fetch(f.url+'/api/whatsapp/connect',{method:'POST',headers:{Authorization:'Bearer invalid'}})).status,401);assert.equal(f.connects(),0);assert.equal((await fetch(f.url+'/api/whatsapp/connect',{method:'POST',headers:{Authorization:'Bearer valid'}})).status,200);assert.equal(f.connects(),1);}finally{await f.close();}});
test('authenticated nonstaff cannot connect',async()=>{const f=await fixture(false);try{assert.equal((await fetch(f.url+'/api/whatsapp/connect',{method:'POST',headers:{Authorization:'Bearer valid'}})).status,403);assert.equal(f.connects(),0);}finally{await f.close();}});
test('foreign origins cannot invoke authenticated actions',async()=>{const f=await fixture();try{assert.equal((await fetch(f.url+'/api/whatsapp/connect',{method:'POST',headers:{Authorization:'Bearer valid',Origin:'https://evil.test'}})).status,403);assert.equal(f.connects(),0);}finally{await f.close();}});

test('recruiter without WhatsApp permission cannot access WhatsApp controls',async()=>{const f=await fixture(true,'recruiter',[]);try{assert.equal((await fetch(f.url+'/api/whatsapp',{headers:{Authorization:'Bearer valid'}})).status,403);assert.equal((await fetch(f.url+'/api/whatsapp/connect',{method:'POST',headers:{Authorization:'Bearer valid'}})).status,403);assert.equal(f.connects(),0);}finally{await f.close();}});
test('recruiter with WhatsApp permission can connect',async()=>{const f=await fixture(true,'recruiter',['whatsapp']);try{assert.equal((await fetch(f.url+'/api/whatsapp/connect',{method:'POST',headers:{Authorization:'Bearer valid'}})).status,200);assert.equal(f.connects(),1);}finally{await f.close();}});
