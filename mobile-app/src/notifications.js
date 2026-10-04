import {Platform} from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

Notifications.setNotificationHandler({
 handleNotification:async()=>({
  shouldShowBanner:true,
  shouldShowList:true,
  shouldPlaySound:true,
  shouldSetBadge:true
 })
});

export async function registerForPush(api){
 if(!Device.isDevice)return {token:null,reason:'device_required'};
 if(Platform.OS==='android'){
  await Notifications.setNotificationChannelAsync('intervention',{
   name:'تدخل بشري',
   importance:Notifications.AndroidImportance.MAX,
   vibrationPattern:[0,250,150,250],
   sound:'default'
  });
 }
 const current=await Notifications.getPermissionsAsync();
 let status=current.status;
 if(status!=='granted')status=(await Notifications.requestPermissionsAsync()).status;
 if(status!=='granted')return {token:null,reason:'permission_denied'};
 const projectId=
  process.env.EXPO_PUBLIC_EAS_PROJECT_ID||
  Constants?.easConfig?.projectId||
  Constants?.expoConfig?.extra?.eas?.projectId||
  null;
 if(!projectId)return {token:null,reason:'project_id_missing'};
 const token=(await Notifications.getExpoPushTokenAsync({projectId})).data;
 await api('/mobile/push-token',{
  method:'POST',
  body:JSON.stringify({
   token,
   platform:Platform.OS,
   device_name:Device.deviceName||Device.modelName||''
  })
 });
 return {token,reason:null};
}

export async function unregisterPush(api,token){
 if(!token)return;
 await api('/mobile/push-token',{method:'DELETE',body:JSON.stringify({token})}).catch(()=>{});
}

export function listenForNotificationOpen(callback){
 const open=data=>{
  const applicantId=data?.applicant_id;
  if(typeof applicantId==='string'&&applicantId)callback(applicantId);
 };
 Notifications.getLastNotificationResponseAsync().then(response=>{
  if(response?.notification?.request?.content?.data)open(response.notification.request.content.data);
 }).catch(()=>{});
 const sub=Notifications.addNotificationResponseReceivedListener(response=>{
  open(response.notification.request.content.data);
 });
 return ()=>sub.remove();
}
