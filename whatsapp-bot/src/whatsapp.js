import makeWASocket,{DisconnectReason,useMultiFileAuthState,downloadMediaMessage} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import fs from 'node:fs/promises';
import path from 'node:path';
const noop=()=>{};
const silentLogger={trace:noop,debug:noop,info:noop,warn:noop,error:noop,fatal:noop,child(){return this;}};

function jidPhone(jid){
 const s=String(jid||'');
 if(!s.endsWith('@s.whatsapp.net'))return null;
 const n=s.split('@')[0].split(':')[0];
 return /^[1-9]\d{7,14}$/.test(n)?`+${n}`:null;
}
export async function resolvePhone(sock,msg){
 for(const id of [msg?.key?.remoteJidAlt,msg?.key?.participantAlt,msg?.key?.senderPn,msg?.key?.participantPn,msg?.key?.remoteJid]){
  const p=jidPhone(id);if(p)return p;
 }
 const lid=String(msg?.key?.remoteJid||'');
 if(lid.endsWith('@lid')){
  try{return jidPhone(await sock?.signalRepository?.lidMapping?.getPNForLID?.(lid));}catch{}
 }
 return null;
}
function unwrap(message){
 let m=message||{};
 for(let i=0;i<4;i++){
  const next=m.ephemeralMessage?.message||m.viewOnceMessage?.message||m.viewOnceMessageV2?.message||m.viewOnceMessageV2Extension?.message||m.documentWithCaptionMessage?.message;
  if(!next)break;m=next;
 }
 return m;
}
function textOf(message){
 const m=unwrap(message);
 return String(m.conversation||m.extendedTextMessage?.text||m.imageMessage?.caption||m.documentMessage?.caption||m.videoMessage?.caption||'');
}
function mediaMeta(message){
 const m=unwrap(message);
 if(m.imageMessage)return {node:m.imageMessage,type:m.imageMessage.mimetype||'image/jpeg'};
 if(m.documentMessage)return {node:m.documentMessage,type:m.documentMessage.mimetype||'application/octet-stream'};
 return null;
}
function validMedia(bytes,type){
 return (type==='image/jpeg'&&bytes.subarray(0,3).equals(Buffer.from([255,216,255])))||
  (type==='image/png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||
  (type==='image/webp'&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')||
  (type==='application/pdf'&&bytes.subarray(0,5).toString()==='%PDF-');
}
async function normalizedRecord(sock,msg){
 const jid=String(msg?.key?.remoteJid||'');
 if(!jid||msg?.key?.fromMe||jid.endsWith('@g.us')||jid==='status@broadcast'||!msg?.key?.id||!msg.message)return null;
 let media=null,media_error=null;
 const meta=mediaMeta(msg.message);
 if(meta){
  try{
   const size=Number(meta.node?.fileLength?.toString?.()||meta.node?.fileLength||0);
   if(size>10485760)throw new Error('too large');
   if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(meta.type))throw new Error('unsupported');
   const bytes=await downloadMediaMessage(msg,'buffer',{},{
    reuploadRequest:sock.updateMediaMessage
   });
   if(!Buffer.isBuffer(bytes)||bytes.length>10485760||!validMedia(bytes,meta.type))throw new Error('invalid media');
   media={data:bytes.toString('base64'),type:meta.type};
  }catch{media_error='تعذر حفظ المرفق. ابعت صورة JPG/PNG/WebP أو PDF بحجم أقل من 10 ميجا.';}
 }
 const ts=Number(msg.messageTimestamp?.toString?.()||msg.messageTimestamp||Math.floor(Date.now()/1000));
 return {
  id:String(msg.key.id),contact_id:jid,phone:await resolvePhone(sock,msg),
  body:textOf(msg.message).slice(0,10000),media,media_error,
  created_at:new Date((Number.isFinite(ts)?ts:Math.floor(Date.now()/1000))*1000).toISOString()
 };
}
export class WhatsAppConnection{
 constructor({sessionPath,onMessage,SocketFactory=makeWASocket,authLoader=useMultiFileAuthState}){
  this.sessionPath=path.resolve(sessionPath);this.authPath=path.join(this.sessionPath,'baileys-auth');
  this.onMessage=onMessage;this.SocketFactory=SocketFactory;this.authLoader=authLoader;this.client=null;
  this.desired=false;this.busy=false;this.receiveTail=Promise.resolve();
  this.state={status:'disconnected',phone:null,qr:null,error:null};
 }
 snapshot(){return {...this.state,qr:Date.now()<(this.state.qrExpiresAt||0)?this.state.qr:null};}
 async init(){
  await fs.mkdir(this.sessionPath,{recursive:true});
  try{this.desired=JSON.parse(await fs.readFile(path.join(this.sessionPath,'connection.json'),'utf8')).connected===true;}catch{}
  if(this.desired)this.connect().catch(()=>{});
 }
 async persist(){await fs.writeFile(path.join(this.sessionPath,'connection.json'),JSON.stringify({connected:this.desired}),{mode:0o600});}
 async connect(){
  if(this.busy||['connected','starting','qr','authenticated'].includes(this.state.status))return;
  this.busy=true;this.desired=true;
  try{
   await this.persist();
   const previous=this.client;this.client=null;
   try{previous?.end?.(new Error('reconnect'));}catch{}
   this.state={status:'starting',phone:null,qr:null,error:null};
   const {state,saveCreds}=await this.authLoader(this.authPath);
   const sock=this.SocketFactory({
    auth:state,
    markOnlineOnConnect:false,
    syncFullHistory:false,
    generateHighQualityLinkPreview:false,
    browser:['Masar','Chrome','1.0.0'],
    getMessage:async()=>undefined,
    logger:silentLogger
   });
   this.client=sock;
   sock.ev.on('creds.update',saveCreds);
   sock.ev.on('connection.update',async update=>{
    if(this.client!==sock)return;
    if(update.qr){
     const image=await QRCode.toDataURL(update.qr,{width:300,margin:2});
     if(this.client===sock)this.state={status:'qr',qr:image,qrExpiresAt:Date.now()+55000,phone:null,error:null};
    }
    if(update.connection==='connecting'&&!update.qr)this.state={...this.state,status:'authenticated',qr:null};
    if(update.connection==='open'){
     this.state={status:'connected',phone:jidPhone(sock.user?.id)||jidPhone(sock.user?.lid),qr:null,error:null};
    }
    if(update.connection==='close'){
     const code=update.lastDisconnect?.error?.output?.statusCode||update.lastDisconnect?.error?.statusCode;
     this.client=null;
     if(code===DisconnectReason.loggedOut){
      this.desired=false;await this.persist().catch(()=>{});
      this.state={status:'error',phone:null,qr:null,error:'جلسة واتساب خرجت من الحساب. اضغط فصل ثم ربط لعرض QR جديد.'};
     }else{
      this.state={status:'disconnected',phone:null,qr:null,error:null};
      if(this.desired)setTimeout(()=>this.connect().catch(()=>{}),3000).unref();
     }
    }
   });
   sock.ev.on('messages.upsert',({messages})=>{
    for(const msg of messages||[]){
     this.receiveTail=this.receiveTail.then(async()=>{
      const record=await normalizedRecord(sock,msg);if(record)await this.onMessage(record);
     }).catch(err=>{console.error('Inbound persistence failed:',err.code||err.name);this.state.error='تعذر حفظ رسالة؛ راجع اتصال قاعدة البيانات ومساحة التخزين.';});
    }
   });
  }catch(e){
   this.client=null;this.state={status:'error',phone:null,qr:null,error:'تعذر تشغيل واتساب. أعد الربط بعد لحظات.'};
   throw e;
  }finally{this.busy=false;}
 }
 async disconnect(){
  if(this.busy)throw new Error('انتظر انتهاء العملية الحالية');this.busy=true;
  try{
   this.desired=false;await this.persist();const sock=this.client;this.client=null;
   this.state={status:'disconnecting',qr:null,phone:null,error:null};
   if(sock){try{await sock.logout();}catch{} try{sock.end?.(new Error('logout'));}catch{}}
   await fs.rm(this.authPath,{recursive:true,force:true});
   this.state={status:'disconnected',qr:null,phone:null,error:null};
  }finally{this.busy=false;}
 }
 async send(to,body){
  if(this.state.status!=='connected'||!this.client)throw new Error('WhatsApp is disconnected');
  return this.client.sendMessage(to,{text:body});
 }
 async close(){
  const sock=this.client;this.client=null;
  if(sock)try{sock.end?.(new Error('service shutdown'));}catch{}
 }
}
