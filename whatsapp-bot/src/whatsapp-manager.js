import fs from 'node:fs/promises';
import path from 'node:path';
import {must} from './db.js';
import {WhatsAppConnection} from './whatsapp.js';

const schemaMissing=e=>['PGRST205','42P01','42703'].includes(e?.code);

export class WhatsAppManager{
 constructor({db,sessionPath,onMessage,ConnectionClass=WhatsAppConnection}){
  this.db=db;this.sessionPath=path.resolve(sessionPath);this.onMessage=onMessage;this.ConnectionClass=ConnectionClass;
  this.configured=false;this.items=new Map();
 }
 async init(){
  await fs.mkdir(this.sessionPath,{recursive:true});
  let accounts;
  try{
   accounts=must(await this.db.from('masar_whatsapp_accounts').select('*').eq('active',true).order('created_at',{ascending:true}));
   this.configured=true;
  }catch(e){
   if(!schemaMissing(e))throw e;
   this.configured=false;accounts=[{id:null,name:'الرقم الرئيسي',phone:null,legacy_session:true,active:true}];
  }
  for(const account of accounts)await this.register(account);
 }
 sessionFor(account){
  return account.legacy_session?this.sessionPath:path.join(this.sessionPath,'accounts',String(account.id));
 }
 async register(account){
  const key=account.id||'legacy';
  if(this.items.has(key))return this.items.get(key);
  const connection=new this.ConnectionClass({
   sessionPath:this.sessionFor(account),
   syncHistory:account.review_new_contacts===true,
   onMessage:record=>this.onMessage({...record,whatsapp_account_id:account.id})
  });
  const item={account:{...account},connection};
  this.items.set(key,item);await connection.init();return item;
 }
 key(id){return id||'legacy';}
 item(id){return this.items.get(this.key(id))||null;}
 defaultAccountId(){
  const items=[...this.items.values()];
  return (items.find(x=>x.account.legacy_session)||items[0])?.account?.id||null;
 }
 async add(account){return this.register(account);}
 async remove(id){
  const item=this.item(id);if(!item)return;
  await item.connection.close().catch(()=>{});
  this.items.delete(this.key(id));
 }
 snapshot(id){
  const item=this.item(id);if(!item)return null;
  return {...item.account,...item.connection.snapshot()};
 }
 async snapshots(){
  const out=[];
  for(const item of this.items.values()){
   const snap={...item.account,...item.connection.snapshot()};
   out.push(snap);
   if(this.configured&&snap.phone&&snap.phone!==item.account.phone){
    item.account.phone=snap.phone;
    this.db.from('masar_whatsapp_accounts').update({phone:snap.phone,updated_at:new Date().toISOString()}).eq('id',item.account.id).then(()=>{}).catch(()=>{});
   }
  }
  return out;
 }
 async connect(id){
  const item=this.item(id);if(!item)throw new Error('WhatsApp account not found');
  await item.connection.connect();return this.snapshot(id);
 }
 async disconnect(id){
  const item=this.item(id);if(!item)throw new Error('WhatsApp account not found');
  await item.connection.disconnect();return this.snapshot(id);
 }
 async send(id,to,body,options){
  const item=this.item(id);if(!item)throw new Error('WhatsApp account not found');
  return item.connection.send(to,body,options);
 }
 async close(){
  await Promise.all([...this.items.values()].map(x=>x.connection.close().catch(()=>{})));
 }
}
