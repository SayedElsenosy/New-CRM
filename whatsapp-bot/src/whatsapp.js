import makeWASocket,{DisconnectReason,useMultiFileAuthState,downloadMediaMessage,generateWAMessageFromContent,proto} from '@whiskeysockets/baileys';
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
export function extractMessageText(message){
 const m=unwrap(message);
 if(m.interactiveResponseMessage){
  const response=m.interactiveResponseMessage;
  try{
   const params=JSON.parse(response.nativeFlowResponseMessage?.paramsJson||'{}');
   const id=params.id||params.row_id||params.selected_id;
   if(id)return String(id);
  }catch{}
  if(response.body?.text)return String(response.body.text);
 }
 if(m.buttonsResponseMessage)return String(m.buttonsResponseMessage.selectedButtonId||m.buttonsResponseMessage.selectedDisplayText||'');
 if(m.listResponseMessage)return String(m.listResponseMessage.singleSelectReply?.selectedRowId||m.listResponseMessage.title||'');
 if(m.templateButtonReplyMessage)return String(m.templateButtonReplyMessage.selectedId||m.templateButtonReplyMessage.selectedDisplayText||'');
 return String(m.conversation||m.extendedTextMessage?.text||m.imageMessage?.caption||m.documentMessage?.caption||m.videoMessage?.caption||'');
}

function contextInfoOf(message){
 const m=unwrap(message);
 for(const node of [
  m.extendedTextMessage,m.imageMessage,m.documentMessage,m.videoMessage,m.audioMessage,
  m.buttonsResponseMessage,m.listResponseMessage,m.templateButtonReplyMessage,m.interactiveResponseMessage,
  m.contactMessage,m.contactsArrayMessage,m.locationMessage,m.liveLocationMessage
 ]){
  if(node?.contextInfo)return node.contextInfo;
 }
 return m.contextInfo||null;
}
export function extractAdReferral(message){
 const ctx=contextInfoOf(message);if(!ctx)return null;
 const ad=ctx.externalAdReply||null;
 const sourceId=String(ad?.sourceId||'').trim();
 const ctwaClid=String(ad?.ctwaClid||'').trim();
 const sourceType=String(ad?.sourceType||'').trim();
 const isReferral=Boolean(sourceId||ctwaClid||sourceType==='ad'||ad?.showAdAttribution||ctx.entryPointConversionSource||ctx.ctwaPayload);
 if(!isReferral)return null;
 const clean=value=>{const s=String(value||'').trim();return s||null;};
 return {
  source_id:clean(sourceId),
  source_type:clean(sourceType),
  source_url:clean(ad?.sourceUrl),
  source_app:clean(ad?.sourceApp||ctx.entryPointConversionApp),
  title:clean(ad?.title),
  body:clean(ad?.body),
  ctwa_clid:clean(ctwaClid),
  ref:clean(ad?.ref),
  entry_point_source:clean(ctx.entryPointConversionSource),
  utm_source:clean(ctx.utm?.utmSource),
  utm_campaign:clean(ctx.utm?.utmCampaign),
  whatsapp_campaign_id:clean(ctx.smbServerCampaignId||ctx.smbClientCampaignId),
  captured_at:new Date().toISOString()
 };
}
export function normalizeMediaType(value){
 const raw=String(value||'').toLowerCase().split(';')[0].trim();
 if(raw==='audio/opus')return 'audio/ogg';
 if(['audio/ogg','audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/x-wav'].includes(raw))return raw==='audio/x-wav'?'audio/wav':raw;
 return raw;
}
export function isAudioType(value){return normalizeMediaType(value).startsWith('audio/');}
function mediaMeta(message){
 const m=unwrap(message);
 if(m.imageMessage)return {node:m.imageMessage,type:m.imageMessage.mimetype||'image/jpeg',kind:'image'};
 if(m.documentMessage)return {node:m.documentMessage,type:m.documentMessage.mimetype||'application/octet-stream',kind:'document'};
 if(m.audioMessage)return {node:m.audioMessage,type:normalizeMediaType(m.audioMessage.mimetype||'audio/ogg'),kind:'audio',voice:Boolean(m.audioMessage.ptt)};
 return null;
}
function validMedia(bytes,type,kind){
 if(kind==='audio')return bytes.length>0;
 return (type==='image/jpeg'&&bytes.subarray(0,3).equals(Buffer.from([255,216,255])))||
  (type==='image/png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||
  (type==='image/webp'&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')||
  (type==='application/pdf'&&bytes.subarray(0,5).toString()==='%PDF-');
}
export async function normalizedRecord(sock,msg,{upsertType=null}={}){
 const jid=String(msg?.key?.remoteJid||'');
 if(!jid||jid.endsWith('@g.us')||jid==='status@broadcast'||!msg?.key?.id||!msg.message)return null;
 const fromMe=Boolean(msg?.key?.fromMe);
 if(fromMe&&upsertType&&upsertType!=='notify')return null;
 let media=null,media_error=null;
 const meta=mediaMeta(msg.message);
 if(meta){
  try{
   const size=Number(meta.node?.fileLength?.toString?.()||meta.node?.fileLength||0);
   if(size>10485760)throw new Error('too large');
   if(!['image/jpeg','image/png','image/webp','application/pdf','audio/ogg','audio/mpeg','audio/mp4','audio/aac','audio/wav'].includes(meta.type))throw new Error('unsupported');
   const bytes=await downloadMediaMessage(msg,'buffer',{},{
    reuploadRequest:sock.updateMediaMessage
   });
   if(!Buffer.isBuffer(bytes)||bytes.length>10485760||!validMedia(bytes,meta.type,meta.kind))throw new Error('invalid media');
   media={data:bytes.toString('base64'),type:meta.type,kind:meta.kind,voice:Boolean(meta.voice)};
  }catch{media_error=meta?.kind==='audio'?'تعذر تنزيل الرسالة الصوتية من واتساب.':'تعذر حفظ المرفق. ابعت صورة JPG/PNG/WebP أو PDF بحجم أقل من 10 ميجا.';}
 }
 const ts=Number(msg.messageTimestamp?.toString?.()||msg.messageTimestamp||Math.floor(Date.now()/1000));
 return {
  id:String(msg.key.id),contact_id:jid,phone:await resolvePhone(sock,msg),
  direction:fromMe?'out':'in',from_me:fromMe,source:fromMe?'linked_whatsapp_device':'applicant',
  body:extractMessageText(msg.message).slice(0,10000),media,media_error,
  referral:fromMe?null:extractAdReferral(msg.message),
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
    browser:['Speed Delivery','Chrome','1.0.0'],
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
   sock.ev.on('messages.upsert',({messages,type})=>{
    for(const msg of messages||[]){
     this.receiveTail=this.receiveTail.then(async()=>{
      const record=await normalizedRecord(sock,msg,{upsertType:type});if(record)await this.onMessage(record);
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
 async send(to,body,{buttons=[]}={}){
  if(this.state.status!=='connected'||!this.client)throw new Error('WhatsApp is disconnected');
  if(!buttons.length)return this.client.sendMessage(to,{text:body});
  try{
   const nativeButtons=buttons.slice(0,10).map((button,index)=>({
    name:'quick_reply',
    buttonParamsJson:JSON.stringify({display_text:String(button.text||button.label||('اختيار '+(index+1))).slice(0,80),id:String(button.id)})
   }));
   const interactive=proto.Message.InteractiveMessage.fromObject({
    header:{hasMediaAttachment:false},
    body:{text:String(body)},
    footer:{text:'اختار بالضغط على الزر'},
    nativeFlowMessage:{buttons:nativeButtons,messageParamsJson:'{}',messageVersion:1}
   });
   const generated=generateWAMessageFromContent(to,{interactiveMessage:interactive},{userJid:this.client.user?.id});
   const bizNode={tag:'biz',attrs:{},content:[{tag:'interactive',attrs:{type:'native_flow',v:'1'},content:[{tag:'native_flow',attrs:{v:'9',name:'mixed'}}]}]};
   const botNode={tag:'bot',attrs:{biz_bot:'1'}};
   const message={documentWithCaptionMessage:{message:generated.message}};
   await this.client.relayMessage(to,message,{messageId:generated.key.id,additionalNodes:[bizNode,botNode]});
   generated.message=message;return generated;
  }catch(e){
   console.warn('Interactive area buttons failed; falling back to text:',e?.name||'Error');
   return this.client.sendMessage(to,{text:body});
  }
 }
 async close(){
  const sock=this.client;this.client=null;
  if(sock)try{sock.end?.(new Error('service shutdown'));}catch{}
 }
}
