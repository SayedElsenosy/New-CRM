const TOKEN=/^(?:ExponentPushToken|ExpoPushToken)\[[^\]]{8,}\]$/;
const MISSING=new Set(['PGRST205','42P01','42703','PGRST204']);

export function validExpoPushToken(value){
 return TOKEN.test(String(value||'').trim());
}
function hasApplicantPermission(user){
 if(user?.app_metadata?.masar_role!=='recruiter')return true;
 const permissions=user?.app_metadata?.masar_permissions;
 if(!Array.isArray(permissions))return true;
 return permissions.includes('applicants');
}
function applicantName(applicant){
 const answer=Object.values(applicant?.answers||{}).find(v=>v?.kind==='name');
 return String(answer?.display||answer?.value||applicant?.display_name||'متقدم').trim()||'متقدم';
}
async function staffRecipients(db,accountId){
 let tokens;
 try{
  const result=await db.from('masar_push_tokens').select('user_id,token').eq('active',true).limit(5000);
  if(result.error)throw result.error;tokens=result.data||[];
 }catch(e){if(MISSING.has(e?.code))return [];throw e;}
 if(!tokens.length)return [];
 let staffResult=await db.from('masar_staff').select('user_id,office_id');
 if(staffResult.error&&MISSING.has(staffResult.error.code))staffResult=await db.from('masar_staff').select('user_id');
 if(staffResult.error)throw staffResult.error;
 const staff=new Map((staffResult.data||[]).map(x=>[x.user_id,x]));
 const usersResult=await db.auth.admin.listUsers({page:1,perPage:1000});
 if(usersResult.error)throw usersResult.error;
 const users=new Map((usersResult.data.users||[]).map(u=>[u.id,u]));
 let access=null,accountOffice=null;
 if(accountId){
  try{
   const wa=await db.from('masar_whatsapp_accounts').select('office_id').eq('id',accountId).maybeSingle();
   if(!wa.error)accountOffice=wa.data?.office_id||null;
   else if(!MISSING.has(wa.error.code))throw wa.error;
  }catch(e){if(!MISSING.has(e?.code))throw e;}

  try{
   const result=await db.from('masar_staff_whatsapp_access').select('user_id,whatsapp_account_id');
   if(result.error)throw result.error;
   access=new Map();
   for(const row of result.data||[]){
    if(!access.has(row.user_id))access.set(row.user_id,new Set());
    access.get(row.user_id).add(row.whatsapp_account_id);
   }
  }catch(e){if(!MISSING.has(e?.code))throw e;}
 }
 return [...new Set(tokens.filter(row=>{
  const staffRow=staff.get(row.user_id);if(!staffRow)return false;
  const user=users.get(row.user_id);if(!user||!hasApplicantPermission(user))return false;
  const role=user.app_metadata?.masar_role;
  if(role==='office_admin'&&accountOffice&&staffRow.office_id&&staffRow.office_id!==accountOffice)return false;
  if(role==='recruiter'&&access&&accountId&&!access.get(row.user_id)?.has(accountId))return false;
  return validExpoPushToken(row.token);
 }).map(row=>row.token))];
}
async function postBatch(messages){
 const response=await fetch('https://exp.host/--/api/v2/push/send',{
  method:'POST',
  headers:{'Content-Type':'application/json','Accept':'application/json','Accept-Encoding':'gzip, deflate'},
  body:JSON.stringify(messages)
 });
 if(!response.ok)throw new Error('Expo push service returned '+response.status);
 return response.json().catch(()=>null);
}
export async function sendHumanInterventionPush(db,{applicant,question,alertId=null}){
 const recipients=await staffRecipients(db,applicant?.whatsapp_account_id||null);
 if(!recipients.length)return {sent:0};
 const name=applicantName(applicant);
 const body=(String(question||'').trim()||'المتقدم يحتاج تدخل من مسؤول التوظيف.').slice(0,180);
 const messages=recipients.map(to=>({
  to,title:'متقدم يحتاج تدخل',
  body:name+' — '+body,
  sound:'default',
  channelId:'intervention',
  priority:'high',
  data:{applicant_id:applicant.id,alert_id:alertId||null,url:'masar://applicant/'+applicant.id}
 }));
 for(let i=0;i<messages.length;i+=100)await postBatch(messages.slice(i,i+100));
 return {sent:messages.length};
}
