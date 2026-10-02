import wa from 'whatsapp-web.js';
import QRCode from 'qrcode';
import fs from 'node:fs/promises';
import path from 'node:path';
import {phoneFromId} from './domain.js';
const {Client,LocalAuth}=wa;
export async function resolvePhone(client,msg){
 const direct=phoneFromId(msg.from);if(direct)return direct;
 if(!String(msg.from).endsWith('@lid'))return null;
 try{const rows=await client.getContactLidAndPhone([msg.from]);const n=phoneFromId(rows?.[0]?.pn);if(n)return n;}catch{}
 try{const c=await msg.getContact();return phoneFromId(c?.id?._serialized);}catch{return null;}
}
export class WhatsAppConnection {
 constructor({sessionPath,onMessage,ClientClass=Client}){this.sessionPath=path.resolve(sessionPath);this.onMessage=onMessage;this.ClientClass=ClientClass;this.client=null;this.desired=false;this.busy=false;this.receiveTail=Promise.resolve();this.state={status:'disconnected',phone:null,qr:null,error:null};}
 snapshot(){return {...this.state,qr:Date.now()<(this.state.qrExpiresAt||0)?this.state.qr:null};}
 async init(){await fs.mkdir(this.sessionPath,{recursive:true});try{this.desired=JSON.parse(await fs.readFile(path.join(this.sessionPath,'connection.json'),'utf8')).connected===true;}catch{}if(this.desired)this.connect().catch(()=>{});}
 async persist(){await fs.writeFile(path.join(this.sessionPath,'connection.json'),JSON.stringify({connected:this.desired}));}
 async connect(){
  if(this.busy||['connected','starting','qr','authenticated'].includes(this.state.status))return;
  this.busy=true;this.desired=true;
  try{await this.persist();if(this.client){await this.client.destroy().catch(()=>{});this.client=null;}
   this.state={status:'starting',phone:null,qr:null,error:null};
   const client=new this.ClientClass({authStrategy:new LocalAuth({clientId:'masar',dataPath:this.sessionPath}),puppeteer:{headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||undefined,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']},authTimeoutMs:120000});
   this.client=client;
   client.on('qr',async qr=>{const image=await QRCode.toDataURL(qr,{width:300,margin:2});if(this.client===client)this.state={status:'qr',qr:image,qrExpiresAt:Date.now()+55000,phone:null,error:null};});
   client.on('authenticated',()=>{if(this.client===client)this.state={...this.state,status:'authenticated',qr:null};});
   client.on('ready',async()=>{if(this.client!==client)return;let phone=phoneFromId(client.info?.wid?._serialized);if(!phone&&client.info?.wid?._serialized){try{phone=phoneFromId((await client.getContactLidAndPhone([client.info.wid._serialized]))?.[0]?.pn);}catch{}}this.state={status:'connected',phone,qr:null,error:null};});
   client.on('auth_failure',()=>{if(this.client===client)this.state={status:'error',phone:null,qr:null,error:'فشل توثيق الجلسة. اضغط فصل ثم ربط لعرض QR جديد.'};});
   client.on('disconnected',()=>{if(this.client!==client)return;this.state={status:'disconnected',phone:null,qr:null,error:null};if(this.desired)setTimeout(()=>this.connect().catch(()=>{}),10000).unref();});
   client.on('message',msg=>{if(this.client!==client)return;this.receiveTail=this.receiveTail.then(()=>this.onMessage(client,msg)).catch(err=>{console.error('Inbound persistence failed:',err.code||err.name);this.state.error='تعذر حفظ رسالة؛ راجع اتصال قاعدة البيانات ومساحة التخزين.';});});
   client.initialize().then(async()=>{if(this.client!==client)await client.destroy().catch(()=>{});}).catch(()=>{if(this.client===client)this.state={status:'error',phone:null,qr:null,error:'تعذر تشغيل واتساب. راجع الخدمة ثم أعد الربط.'};});
  }finally{this.busy=false;}
 }
 async disconnect(){
  if(this.busy)throw new Error('انتظر انتهاء العملية الحالية');this.busy=true;
  try{this.desired=false;await this.persist();const c=this.client;this.client=null;this.state={status:'disconnecting',qr:null,phone:null,error:null};
   if(c){await c.logout().catch(()=>{});await c.destroy().catch(()=>{});}
   await fs.rm(path.join(this.sessionPath,'session-masar'),{recursive:true,force:true});
   this.state={status:'disconnected',qr:null,phone:null,error:null};
  }finally{this.busy=false;}
 }
 async send(to,body){if(this.state.status!=='connected'||!this.client)throw new Error('WhatsApp is disconnected');return this.client.sendMessage(to,body);}
 async close(){this.desired=false;const c=this.client;this.client=null;if(c)await c.destroy().catch(()=>{});}
}
