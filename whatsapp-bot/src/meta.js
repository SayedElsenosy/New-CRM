import crypto from 'node:crypto';

const graphBase=version=>'https://graph.facebook.com/'+version;
const loginBase=version=>'https://www.facebook.com/'+version+'/dialog/oauth';

export function metaConfig(env=process.env){
 const appId=String(env.META_APP_ID||'').trim();
 const appSecret=String(env.META_APP_SECRET||'').trim();
 const encryptionKey=String(env.META_TOKEN_ENCRYPTION_KEY||'').trim();
 const version=String(env.META_GRAPH_VERSION||'').trim();
 const redirectUri=String(env.META_OAUTH_REDIRECT_URI||'').trim()||
  (env.RAILWAY_PUBLIC_DOMAIN?'https://'+String(env.RAILWAY_PUBLIC_DOMAIN).trim()+'/integrations/meta/callback':'');
 const missing=[];
 if(!appId)missing.push('META_APP_ID');
 if(!appSecret)missing.push('META_APP_SECRET');
 if(encryptionKey.length<32)missing.push('META_TOKEN_ENCRYPTION_KEY (32+ chars)');
 if(!/^v\d+\.\d+$/.test(version))missing.push('META_GRAPH_VERSION');
 if(!/^https:\/\//.test(redirectUri))missing.push('META_OAUTH_REDIRECT_URI');
 return {configured:missing.length===0,missing,appId,appSecret,encryptionKey,version,redirectUri};
}

const keyFor=value=>crypto.createHash('sha256').update(String(value)).digest();

export function encryptMetaToken(token,encryptionKey){
 if(!token)throw new Error('Missing Meta token');
 if(String(encryptionKey||'').length<32)throw new Error('META_TOKEN_ENCRYPTION_KEY must be at least 32 characters');
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',keyFor(encryptionKey),iv);
 const encrypted=Buffer.concat([cipher.update(String(token),'utf8'),cipher.final()]);
 const tag=cipher.getAuthTag();
 return ['v1',iv.toString('base64url'),tag.toString('base64url'),encrypted.toString('base64url')].join('.');
}

export function decryptMetaToken(payload,encryptionKey){
 const [version,ivRaw,tagRaw,dataRaw]=String(payload||'').split('.');
 if(version!=='v1'||!ivRaw||!tagRaw||!dataRaw)throw new Error('Invalid encrypted Meta token');
 const decipher=crypto.createDecipheriv('aes-256-gcm',keyFor(encryptionKey),Buffer.from(ivRaw,'base64url'));
 decipher.setAuthTag(Buffer.from(tagRaw,'base64url'));
 return Buffer.concat([decipher.update(Buffer.from(dataRaw,'base64url')),decipher.final()]).toString('utf8');
}

export const metaStateHash=state=>crypto.createHash('sha256').update(String(state||'')).digest('hex');
export const normalizeMetaAdAccountId=value=>String(value||'').trim().replace(/^act_/i,'');

export function metaLoginUrl({state,config}){
 const p=new URLSearchParams({
  client_id:config.appId,
  redirect_uri:config.redirectUri,
  state,
  response_type:'code',
  scope:'ads_read,business_management'
 });
 return loginBase(config.version)+'?'+p.toString();
}

async function graphRequest(url,options={}){
 const response=await fetch(url,{...options,headers:{Accept:'application/json',...(options.headers||{})}});
 let data=null;try{data=await response.json();}catch{}
 if(!response.ok||data?.error){
  const message=data?.error?.message||('Meta API request failed ('+response.status+')');
  const error=Object.assign(new Error(message),{status:502,meta_code:data?.error?.code,meta_subcode:data?.error?.error_subcode});
  throw error;
 }
 return data||{};
}

export async function exchangeMetaCode(code,config){
 const p=new URLSearchParams({client_id:config.appId,client_secret:config.appSecret,redirect_uri:config.redirectUri,code:String(code)});
 const short=await graphRequest(graphBase(config.version)+'/oauth/access_token?'+p.toString());
 if(!short.access_token)throw Object.assign(new Error('Meta لم يرجع Access Token'),{status:502});
 let token=short.access_token,expiresIn=Number(short.expires_in||0);
 try{
  const lp=new URLSearchParams({grant_type:'fb_exchange_token',client_id:config.appId,client_secret:config.appSecret,fb_exchange_token:short.access_token});
  const long=await graphRequest(graphBase(config.version)+'/oauth/access_token?'+lp.toString());
  if(long.access_token){token=long.access_token;expiresIn=Number(long.expires_in||expiresIn||0);}
 }catch{}
 return {access_token:token,expires_in:expiresIn};
}

export async function metaGraph(pathname,token,config,params={}){
 const p=new URLSearchParams({...params,access_token:token});
 return graphRequest(graphBase(config.version)+'/'+String(pathname).replace(/^\//,'')+'?'+p.toString());
}

export async function metaGraphAll(pathname,token,config,params={}){
 const firstUrl=graphBase(config.version)+'/'+String(pathname).replace(/^\//,'')+'?'+new URLSearchParams({...params,access_token:token}).toString();
 let next=firstUrl,out=[],guard=0;
 while(next&&guard++<100){
  const data=await graphRequest(next);
  if(Array.isArray(data.data))out.push(...data.data);
  next=data.paging?.next||null;
 }
 if(guard>=100)throw Object.assign(new Error('Meta pagination exceeded safe limit'),{status:502});
 return out;
}

export async function getMetaIdentity(token,config){
 return metaGraph('me',token,config,{fields:'id,name'});
}

export async function listMetaAdAccounts(token,config){
 const rows=await metaGraphAll('me/adaccounts',token,config,{
  fields:'id,account_id,name,account_status,currency,timezone_name,business{id,name}',
  limit:'100'
 });
 return rows.map(x=>({
  account_id:normalizeMetaAdAccountId(x.account_id||x.id),
  name:String(x.name||'').trim(),
  account_status:Number.isFinite(Number(x.account_status))?Number(x.account_status):null,
  currency:x.currency||null,
  timezone_name:x.timezone_name||null,
  business_name:x.business?.name||null
 })).filter(x=>/^\d+$/.test(x.account_id));
}

export async function fetchMetaAccountSnapshot(token,config,accountId){
 const id=normalizeMetaAdAccountId(accountId);if(!/^\d+$/.test(id))throw new Error('Invalid Meta ad account id');
 const root='act_'+id;
 const campaigns=await metaGraphAll(root+'/campaigns',token,config,{
  fields:'id,name,status,effective_status,objective,start_time,stop_time',
  limit:'200'
 });
 const ads=await metaGraphAll(root+'/ads',token,config,{
  fields:'id,name,status,effective_status,campaign_id,adset_id',
  limit:'200'
 });
 let insights=[],insights_error=null;
 try{
  insights=await metaGraphAll(root+'/insights',token,config,{
   fields:'ad_id,spend',
   level:'ad',
   date_preset:'maximum',
   limit:'500'
  });
 }catch(e){insights_error=e.message;}
 const spendByAd=new Map();
 for(const row of insights){
  const adId=String(row.ad_id||'');if(!adId)continue;
  spendByAd.set(adId,(spendByAd.get(adId)||0)+Number(row.spend||0));
 }
 return {campaigns,ads,spendByAd,insights_error};
}
