import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {
 ActivityIndicator,Alert,FlatList,KeyboardAvoidingView,Linking,Platform,Pressable,
 RefreshControl,SafeAreaView,ScrollView,StatusBar,StyleSheet,Text,TextInput,View
} from 'react-native';
import {api,can,configured,fmtDate,personName,send,STAGES,supabase} from './src/api';
import {listenForNotificationOpen,registerForPush,unregisterPush} from './src/notifications';

const COLORS={
 bg:'#f4f7fb',card:'#ffffff',text:'#172033',muted:'#697386',primary:'#155eef',
 primarySoft:'#eaf1ff',danger:'#c4320a',dangerSoft:'#fff0eb',success:'#067647',
 successSoft:'#ecfdf3',warning:'#b54708',warningSoft:'#fff7ed',border:'#e4e7ec',
 dark:'#101828'
};
const stageTone={
 new:[COLORS.primarySoft,COLORS.primary],
 incomplete:[COLORS.warningSoft,COLORS.warning],
 complete:[COLORS.successSoft,COLORS.success],
 lecture:['#f4f3ff','#6938ef'],
 working:['#ecfdf3','#027a48']
};

function Loading({label='جاري التحميل...'}){return <View style={styles.center}><ActivityIndicator size="large"/><Text style={styles.muted}>{label}</Text></View>;}
function ErrorBox({message}){if(!message)return null;return <View style={styles.errorBox}><Text style={styles.errorText}>{message}</Text></View>;}
function Empty({title='لا توجد بيانات',subtitle=''}){return <View style={styles.empty}><Text style={styles.emptyTitle}>{title}</Text>{subtitle?<Text style={styles.muted}>{subtitle}</Text>:null}</View>;}
function Badge({children,tone='primary'}){
 const bg=tone==='danger'?COLORS.dangerSoft:tone==='success'?COLORS.successSoft:COLORS.primarySoft;
 const color=tone==='danger'?COLORS.danger:tone==='success'?COLORS.success:COLORS.primary;
 return <View style={[styles.badge,{backgroundColor:bg}]}><Text style={[styles.badgeText,{color}]}>{children}</Text></View>;
}
function StageBadge({stage}){
 const [bg,color]=stageTone[stage]||[COLORS.primarySoft,COLORS.primary];
 return <View style={[styles.badge,{backgroundColor:bg}]}><Text style={[styles.badgeText,{color}]}>{STAGES[stage]||stage}</Text></View>;
}
function Button({title,onPress,variant='primary',disabled=false,compact=false}){
 const secondary=variant==='secondary',danger=variant==='danger',ghost=variant==='ghost';
 return <Pressable disabled={disabled} onPress={onPress} style={({pressed})=>[
  styles.button,compact&&styles.buttonCompact,
  secondary&&styles.buttonSecondary,danger&&styles.buttonDanger,ghost&&styles.buttonGhost,
  disabled&&styles.buttonDisabled,pressed&&!disabled&&{opacity:.8}
 ]}>
  <Text style={[
   styles.buttonText,(secondary||ghost)&&styles.buttonTextSecondary,danger&&{color:'#fff'}
  ]}>{title}</Text>
 </Pressable>;
}
function Card({children,style}){return <View style={[styles.card,style]}>{children}</View>;}
function SectionTitle({title,action}){return <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>{title}</Text>{action||null}</View>;}
function Header({title,subtitle,onBack,right}){
 return <View style={styles.header}>
  <View style={styles.headerSide}>{onBack?<Pressable onPress={onBack} hitSlop={10}><Text style={styles.back}>رجوع ←</Text></Pressable>:null}</View>
  <View style={styles.headerTitleWrap}><Text style={styles.headerTitle}>{title}</Text>{subtitle?<Text style={styles.headerSub}>{subtitle}</Text>:null}</View>
  <View style={[styles.headerSide,{alignItems:'flex-end'}]}>{right||null}</View>
 </View>;
}

function ConfigMissing(){
 return <SafeAreaView style={styles.safe}><View style={styles.centerPad}>
  <Text style={styles.logo}>Speed CRM</Text>
  <Text style={styles.title}>إعدادات التطبيق غير مكتملة</Text>
  <Text style={styles.paragraph}>انسخ mobile-app/.env.example إلى .env وضع رابط Supabase وAnon Key ورابط الـBackend.</Text>
 </View></SafeAreaView>;
}

function Login(){
 const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(){
  if(!email.trim()||!password){setError('اكتب البريد الإلكتروني وكلمة المرور');return;}
  setBusy(true);setError('');
  const {error:e}=await supabase.auth.signInWithPassword({email:email.trim().toLowerCase(),password});
  if(e)setError(e.message==='Invalid login credentials'?'بيانات الدخول غير صحيحة':e.message);
  setBusy(false);
 }
 return <SafeAreaView style={styles.safe}><KeyboardAvoidingView behavior={Platform.OS==='ios'?'padding':undefined} style={styles.loginWrap}>
  <View style={styles.loginHero}>
   <Text style={styles.logo}>Speed CRM</Text>
   <Text style={styles.loginTitle}>إدارة التوظيف من الموبايل</Text>
   <Text style={styles.loginSub}>نفس حساب الويب ونفس بيانات المتقدمين والمحادثات.</Text>
  </View>
  <Card style={styles.loginCard}>
   <Text style={styles.label}>البريد الإلكتروني</Text>
   <TextInput autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} style={styles.input} placeholder="name@company.com"/>
   <Text style={styles.label}>كلمة المرور</Text>
   <TextInput secureTextEntry value={password} onChangeText={setPassword} style={styles.input} placeholder="••••••••" onSubmitEditing={submit}/>
   <ErrorBox message={error}/>
   <Button title={busy?'جاري الدخول...':'تسجيل الدخول'} onPress={submit} disabled={busy}/>
  </Card>
 </KeyboardAvoidingView></SafeAreaView>;
}

function HomeScreen({bootstrap,onOpenApplicant,refreshTick}){
 const [alerts,setAlerts]=useState(null),[report,setReport]=useState(null),[applicants,setApplicants]=useState(null),[error,setError]=useState('');
 const load=useCallback(async()=>{
  setError('');
  try{
   const jobs=[api('/alerts'),api('/applicants?page=1')];
   if(can(bootstrap,'reports'))jobs.push(api('/reports'));
   const [a,p,r]=await Promise.all(jobs);
   setAlerts(a);setApplicants(p);if(r)setReport(r);
  }catch(e){setError(e.message);}
 },[bootstrap]);
 useEffect(()=>{load();},[load,refreshTick]);
 if(!alerts||!applicants)return <Loading/>;
 const total=report?.total??applicants.total;
 return <ScrollView style={styles.screen} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={false} onRefresh={load}/>}>
  <ErrorBox message={error}/>
  <View style={styles.heroCard}>
   <Text style={styles.heroKicker}>أهلاً {bootstrap?.profile?.name||''}</Text>
   <Text style={styles.heroTitle}>كل اللي محتاج متابعتك في مكان واحد</Text>
   <Text style={styles.heroSub}>التطبيق والويب شغالين على نفس البيانات لحظياً.</Text>
  </View>
  <View style={styles.statsGrid}>
   <Stat label="إجمالي المتقدمين" value={total}/>
   <Stat label="يحتاج تدخل" value={alerts.open_count||0} tone="danger"/>
   <Stat label="مكتمل البيانات" value={report?.stages?.complete??'—'} tone="success"/>
   <Stat label="بدأ شغل" value={report?.stages?.working??'—'} tone="success"/>
  </View>
  <SectionTitle title="تنبيهات تحتاج تدخل"/>
  {alerts.items?.slice(0,4).map(item=><AlertRow key={item.id} item={item} onPress={()=>onOpenApplicant(item.applicant_id)}/>)}
  {!alerts.items?.length?<Empty title="مفيش تنبيهات مفتوحة" subtitle="كل المحادثات تحت السيطرة ✅"/>:null}
  <SectionTitle title="أحدث المتقدمين"/>
  {applicants.items?.slice(0,5).map(item=><ApplicantRow key={item.id} item={item} onPress={()=>onOpenApplicant(item.id)}/>)}
 </ScrollView>;
}
function Stat({label,value,tone='primary'}){
 const color=tone==='danger'?COLORS.danger:tone==='success'?COLORS.success:COLORS.primary;
 return <Card style={styles.stat}><Text style={[styles.statValue,{color}]}>{value}</Text><Text style={styles.statLabel}>{label}</Text></Card>;
}

function AlertRow({item,onPress,onResolve}){
 return <Pressable onPress={onPress}><Card style={[styles.rowCard,!item.read&&styles.unread]}>
  <View style={styles.rowTop}><Badge tone="danger">تدخل بشري</Badge><Text style={styles.time}>{fmtDate(item.created_at)}</Text></View>
  <Text style={styles.rowTitle}>{item.applicant_name||'متقدم'}</Text>
  {item.phone?<Text style={styles.meta}>{item.phone}</Text>:null}
  <Text style={styles.rowBody} numberOfLines={3}>{item.body||'المتقدم يحتاج تدخل من مسؤول التوظيف.'}</Text>
  {onResolve?<View style={styles.inlineActions}><Button compact variant="secondary" title="تم التعامل" onPress={onResolve}/></View>:null}
 </Card></Pressable>;
}

function AlertsScreen({onOpenApplicant,onCountChange,refreshTick}){
 const [data,setData]=useState(null),[error,setError]=useState(''),[refreshing,setRefreshing]=useState(false);
 const load=useCallback(async()=>{
  try{const r=await api('/alerts');setData(r);onCountChange?.(r.unread||0);setError('');}
  catch(e){setError(e.message);}
 },[onCountChange]);
 useEffect(()=>{load();},[load,refreshTick]);
 async function open(item){
  if(!item.read)send('/alerts/'+item.id+'/read').catch(()=>{});
  onOpenApplicant(item.applicant_id);
 }
 async function resolve(item){
  try{await send('/alerts/'+item.id+'/resolve');await load();}catch(e){Alert.alert('تعذر التحديث',e.message);}
 }
 if(!data)return <Loading/>;
 return <FlatList style={styles.screen} contentContainerStyle={styles.content} data={data.items||[]} keyExtractor={x=>x.id}
  refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async()=>{setRefreshing(true);await load();setRefreshing(false);}}/>}
  ListHeaderComponent={<><ErrorBox message={error}/><View style={styles.listHead}><Text style={styles.screenTitle}>التنبيهات</Text><Badge tone={data.open_count?'danger':'success'}>{data.open_count||0} مفتوح</Badge></View></>}
  renderItem={({item})=><AlertRow item={item} onPress={()=>open(item)} onResolve={()=>resolve(item)}/>}
  ListEmptyComponent={<Empty title="مفيش تنبيهات مفتوحة" subtitle="لما البوت يحتاج تدخل هتلاقي التنبيه هنا."/>}
 />;
}

function ApplicantRow({item,onPress}){
 return <Pressable onPress={onPress}><Card style={styles.rowCard}>
  <View style={styles.rowTop}><StageBadge stage={item.stage}/>{item.needs_intervention?<Badge tone="danger">يحتاج تدخل</Badge>:null}</View>
  <Text style={styles.rowTitle}>{personName(item)}</Text>
  <Text style={styles.meta}>{item.phone||'الرقم غير متاح'}</Text>
  <View style={styles.progressLine}><View style={[styles.progressFill,{width:`${item.completion?.percent||0}%`}]}/></View>
  <Text style={styles.meta}>اكتمال البيانات {item.completion?.percent||0}%</Text>
 </Card></Pressable>;
}

function ApplicantsScreen({onOpenApplicant,refreshTick}){
 const [items,setItems]=useState([]),[total,setTotal]=useState(0),[page,setPage]=useState(1),[search,setSearch]=useState(''),[stage,setStage]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const stages=['',...Object.keys(STAGES)];
 const load=useCallback(async(nextPage=1,append=false)=>{
  setLoading(true);setError('');
  try{
   const q=new URLSearchParams({page:String(nextPage)});
   if(search.trim())q.set('search',search.trim());
   if(stage)q.set('stage',stage);
   const r=await api('/applicants?'+q.toString());
   setItems(old=>append?[...old,...r.items]:r.items);setTotal(r.total);setPage(nextPage);
  }catch(e){setError(e.message);}finally{setLoading(false);}
 },[search,stage]);
 useEffect(()=>{const t=setTimeout(()=>load(1,false),250);return()=>clearTimeout(t);},[load,refreshTick]);
 return <View style={styles.screen}>
  <View style={styles.filterBox}>
   <TextInput style={styles.input} value={search} onChangeText={setSearch} placeholder="ابحث بالاسم أو رقم الهاتف..." textAlign="right"/>
   <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pills}>
    {stages.map(s=><Pressable key={s||'all'} onPress={()=>setStage(s)} style={[styles.pill,stage===s&&styles.pillActive]}><Text style={[styles.pillText,stage===s&&styles.pillTextActive]}>{s?STAGES[s]:'الكل'}</Text></Pressable>)}
   </ScrollView>
  </View>
  <ErrorBox message={error}/>
  <FlatList contentContainerStyle={styles.listContent} data={items} keyExtractor={x=>x.id}
   refreshControl={<RefreshControl refreshing={false} onRefresh={()=>load(1,false)}/>}
   ListHeaderComponent={<Text style={styles.countText}>{total} متقدم</Text>}
   renderItem={({item})=><ApplicantRow item={item} onPress={()=>onOpenApplicant(item.id)}/>}
   ListEmptyComponent={!loading?<Empty title="مفيش نتائج"/>:null}
   ListFooterComponent={loading?<ActivityIndicator style={{margin:20}}/>:items.length<total?<Button variant="secondary" title="تحميل المزيد" onPress={()=>load(page+1,true)}/>:null}
  />
 </View>;
}

function AnswerList({answers}){
 const rows=Object.entries(answers||{}).filter(([key])=>!key.startsWith('__'));
 if(!rows.length)return <Text style={styles.muted}>لسه مفيش إجابات محفوظة.</Text>;
 return <View>{rows.map(([key,a])=><View key={key} style={styles.answerRow}><Text style={styles.answerLabel}>{a.label||a.key||key}</Text><Text style={styles.answerValue}>{a.display??String(a.value??'—')}</Text></View>)}</View>;
}

function MessageBubble({message}){
 const incoming=message.direction==='in';
 const who=incoming?'المتقدم':message.sender==='staff'?'الموظف':'البوت';
 return <View style={[styles.messageWrap,incoming?styles.messageIncoming:styles.messageOutgoing]}>
  <View style={[styles.messageBubble,incoming?styles.bubbleIncoming:styles.bubbleOutgoing]}>
   <Text style={styles.messageWho}>{who}</Text>
   <Text style={styles.messageText}>{message.body||'مرفق'}</Text>
   {message.media_url?<Pressable onPress={()=>Linking.openURL(message.media_url)}><Text style={styles.link}>فتح المرفق</Text></Pressable>:null}
   {message.error?<Text style={styles.messageError}>{message.error}</Text>:null}
   <Text style={styles.messageTime}>{fmtDate(message.created_at)}</Text>
  </View>
 </View>;
}

function ApplicantDetail({id,onBack}){
 const [data,setData]=useState(null),[error,setError]=useState(''),[refreshing,setRefreshing]=useState(false),[reply,setReply]=useState(''),[sending,setSending]=useState(false);
 const load=useCallback(async()=>{
  try{setData(await api('/applicants/'+id));setError('');}catch(e){setError(e.message);}
 },[id]);
 useEffect(()=>{load();const timer=setInterval(load,12000);return()=>clearInterval(timer);},[load]);
 if(!data)return <SafeAreaView style={styles.safe}><Header title="ملف المتقدم" onBack={onBack}/><ErrorBox message={error}/><Loading/></SafeAreaView>;
 const a=data.applicant;
 async function patch(body){
  try{await api('/applicants/'+id,{method:'PATCH',body:JSON.stringify(body)});await load();}
  catch(e){Alert.alert('تعذر التحديث',e.message);}
 }
 async function sendReply(){
  const body=reply.trim();if(!body)return;
  setSending(true);
  try{await send('/applicants/'+id+'/reply',{body});setReply('');await load();}
  catch(e){Alert.alert('تعذر الإرسال',e.message);}finally{setSending(false);}
 }
 async function setStage(stage){
  const title=stage==='lecture'?'تأكيد حضور المحاضرة':stage==='working'?'تأكيد بدء العمل':'إرجاع المرحلة للوضع التلقائي';
  Alert.alert(title,'هل تريد تنفيذ التغيير؟',[
   {text:'إلغاء',style:'cancel'},
   {text:'تأكيد',onPress:()=>patch({stage})}
  ]);
 }
 return <SafeAreaView style={styles.safe}>
  <StatusBar barStyle="dark-content"/>
  <Header title={personName(a)} subtitle={a.phone||'الرقم غير متاح'} onBack={onBack} right={<StageBadge stage={a.stage}/>}/>
  <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':undefined} keyboardVerticalOffset={8}>
   <ScrollView style={styles.screen} contentContainerStyle={styles.detailContent} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async()=>{setRefreshing(true);await load();setRefreshing(false);}}/>}>
    <ErrorBox message={error}/>
    <Card>
     <View style={styles.rowTop}><Text style={styles.cardTitle}>حالة البوت</Text><Badge tone={a.bot_enabled?'success':'danger'}>{a.bot_enabled?'شغال':'متوقف'}</Badge></View>
     <Text style={styles.paragraph}>{a.bot_enabled?'البوت يقدر يكمل التقديم تلقائياً.':'التدخل البشري مفعل والبوت متوقف لهذا المتقدم.'}</Text>
     <Button variant={a.bot_enabled?'danger':'primary'} title={a.bot_enabled?'إيقاف البوت لهذا المتقدم':'تشغيل البوت والمتابعة'} onPress={()=>patch({bot_enabled:!a.bot_enabled})}/>
    </Card>
    <Card>
     <Text style={styles.cardTitle}>التقدم</Text>
     <Text style={styles.bigPercent}>{a.completion?.percent||0}%</Text>
     <View style={styles.progressLine}><View style={[styles.progressFill,{width:`${a.completion?.percent||0}%`}]}/></View>
     <View style={styles.stageActions}>
      <Button compact variant="secondary" title="حضر المحاضرة" onPress={()=>setStage('lecture')} disabled={!a.completion?.complete}/>
      <Button compact variant="secondary" title="بدأ شغل" onPress={()=>setStage('working')} disabled={!a.completion?.complete}/>
      <Button compact variant="ghost" title="مرحلة تلقائية" onPress={()=>setStage('auto')}/>
     </View>
    </Card>
    <Card><SectionTitle title="الإجابات"/><AnswerList answers={a.answers}/></Card>
    <SectionTitle title="المحادثة"/>
    {data.messages?.length?data.messages.map(m=><MessageBubble key={m.id} message={m}/>):<Empty title="لا توجد رسائل"/>}
   </ScrollView>
   <View style={styles.composer}>
    <TextInput style={styles.composerInput} value={reply} onChangeText={setReply} multiline placeholder="اكتب ردك للمتقدم..." textAlign="right"/>
    <Button compact title={sending?'...':'إرسال'} onPress={sendReply} disabled={sending||!reply.trim()}/>
   </View>
  </KeyboardAvoidingView>
 </SafeAreaView>;
}

function ProfileScreen({bootstrap,onLogout,pushState}){
 return <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
  <Card>
   <Text style={styles.profileName}>{bootstrap?.profile?.name||'موظف'}</Text>
   <Text style={styles.meta}>{bootstrap?.profile?.email}</Text>
   <View style={styles.divider}/>
   <Text style={styles.answerLabel}>نوع الحساب</Text><Text style={styles.answerValue}>{bootstrap?.role==='admin'?'مسؤول النظام':'مسؤول توظيف'}</Text>
   <Text style={styles.answerLabel}>إشعارات الموبايل</Text><Text style={styles.answerValue}>{pushState?.token?'مفعلة ✅':pushState?.reason==='permission_denied'?'مرفوضة من الهاتف':'سيتم تفعيلها مع EAS Build'}</Text>
  </Card>
  <Button variant="danger" title="تسجيل الخروج" onPress={onLogout}/>
 </ScrollView>;
}

function TabBar({tab,setTab,unread}){
 const tabs=[['home','الرئيسية'],['alerts','التنبيهات'],['applicants','المتقدمين'],['profile','حسابي']];
 return <View style={styles.tabBar}>{tabs.map(([key,label])=><Pressable key={key} onPress={()=>setTab(key)} style={styles.tab}>
  <View style={styles.tabLabelWrap}><Text style={[styles.tabText,tab===key&&styles.tabTextActive]}>{label}</Text>{key==='alerts'&&unread>0?<View style={styles.tabDot}><Text style={styles.tabDotText}>{unread>99?'99+':unread}</Text></View>:null}</View>
 </Pressable>)}</View>;
}

function MainApp({session}){
 const [bootstrap,setBootstrap]=useState(null),[bootError,setBootError]=useState(''),[tab,setTab]=useState('home'),[selectedId,setSelectedId]=useState(null),[unread,setUnread]=useState(0),[tick,setTick]=useState(0),[pushState,setPushState]=useState({token:null,reason:null});
 const pushToken=useRef(null);
 useEffect(()=>{
  let alive=true;
  api('/bootstrap').then(b=>alive&&setBootstrap(b)).catch(e=>alive&&setBootError(e.message));
  api('/alerts').then(a=>alive&&setUnread(a.unread||0)).catch(()=>{});
  registerForPush(api).then(state=>{if(alive){setPushState(state);pushToken.current=state.token;}}).catch(()=>{});
  const stop=listenForNotificationOpen(id=>{setSelectedId(id);setTab('alerts');});
  const timer=setInterval(()=>{setTick(v=>v+1);api('/alerts').then(a=>setUnread(a.unread||0)).catch(()=>{});},15000);
  return()=>{alive=false;stop();clearInterval(timer);};
 },[session?.user?.id]);
 async function logout(){
  await unregisterPush(api,pushToken.current);
  await supabase.auth.signOut();
 }
 if(bootError)return <SafeAreaView style={styles.safe}><View style={styles.centerPad}><ErrorBox message={bootError}/><Button title="تسجيل الخروج" variant="secondary" onPress={logout}/></View></SafeAreaView>;
 if(!bootstrap)return <SafeAreaView style={styles.safe}><Loading label="بنجهز حسابك..."/></SafeAreaView>;
 if(selectedId)return <ApplicantDetail id={selectedId} onBack={()=>setSelectedId(null)}/>;
 let screen=null;
 if(tab==='home')screen=<HomeScreen bootstrap={bootstrap} onOpenApplicant={setSelectedId} refreshTick={tick}/>;
 if(tab==='alerts')screen=<AlertsScreen onOpenApplicant={setSelectedId} onCountChange={setUnread} refreshTick={tick}/>;
 if(tab==='applicants')screen=<ApplicantsScreen onOpenApplicant={setSelectedId} refreshTick={tick}/>;
 if(tab==='profile')screen=<ProfileScreen bootstrap={bootstrap} onLogout={logout} pushState={pushState}/>;
 return <SafeAreaView style={styles.safe}>
  <StatusBar barStyle="dark-content"/>
  <Header title="Speed CRM" subtitle={bootstrap.profile?.name||''}/>
  <View style={{flex:1}}>{screen}</View>
  <TabBar tab={tab} setTab={setTab} unread={unread}/>
 </SafeAreaView>;
}

export default function App(){
 const [session,setSession]=useState(undefined);
 useEffect(()=>{
  if(!configured){setSession(null);return;}
  supabase.auth.getSession().then(({data})=>setSession(data.session||null));
  const {data:listener}=supabase.auth.onAuthStateChange((_event,next)=>setSession(next));
  return()=>listener.subscription.unsubscribe();
 },[]);
 if(!configured)return <ConfigMissing/>;
 if(session===undefined)return <SafeAreaView style={styles.safe}><Loading/></SafeAreaView>;
 return session?<MainApp session={session}/>:<Login/>;
}

const styles=StyleSheet.create({
 safe:{flex:1,backgroundColor:COLORS.bg,paddingTop:Platform.OS==='android'?StatusBar.currentHeight||0:0},
 screen:{flex:1,backgroundColor:COLORS.bg},
 content:{padding:16,paddingBottom:28,gap:12},
 detailContent:{padding:14,paddingBottom:24,gap:12},
 center:{flex:1,alignItems:'center',justifyContent:'center',gap:12,padding:24},
 centerPad:{flex:1,justifyContent:'center',padding:24,gap:14},
 muted:{color:COLORS.muted,textAlign:'right',writingDirection:'rtl'},
 paragraph:{color:COLORS.muted,fontSize:14,lineHeight:22,textAlign:'right',writingDirection:'rtl',marginVertical:8},
 title:{fontSize:22,fontWeight:'800',color:COLORS.text,textAlign:'right',writingDirection:'rtl'},
 logo:{fontSize:28,fontWeight:'900',color:COLORS.primary,textAlign:'center'},
 header:{minHeight:68,backgroundColor:COLORS.card,borderBottomWidth:1,borderBottomColor:COLORS.border,flexDirection:'row-reverse',alignItems:'center',paddingHorizontal:14,paddingVertical:10},
 headerSide:{width:92},
 headerTitleWrap:{flex:1,alignItems:'center'},
 headerTitle:{fontSize:18,fontWeight:'800',color:COLORS.text,textAlign:'center',writingDirection:'rtl'},
 headerSub:{fontSize:12,color:COLORS.muted,marginTop:2,textAlign:'center'},
 back:{color:COLORS.primary,fontWeight:'700',textAlign:'right'},
 loginWrap:{flex:1,justifyContent:'center',padding:20,backgroundColor:COLORS.bg},
 loginHero:{gap:8,marginBottom:22},
 loginTitle:{fontSize:24,fontWeight:'900',color:COLORS.text,textAlign:'center',writingDirection:'rtl'},
 loginSub:{fontSize:14,color:COLORS.muted,textAlign:'center',writingDirection:'rtl',lineHeight:22},
 loginCard:{gap:8},
 card:{backgroundColor:COLORS.card,borderRadius:16,padding:15,borderWidth:1,borderColor:COLORS.border},
 label:{fontSize:13,fontWeight:'700',color:COLORS.text,textAlign:'right',writingDirection:'rtl',marginTop:5},
 input:{minHeight:48,borderWidth:1,borderColor:'#d0d5dd',borderRadius:12,backgroundColor:'#fff',paddingHorizontal:13,fontSize:15,color:COLORS.text,marginBottom:7},
 errorBox:{backgroundColor:COLORS.dangerSoft,borderRadius:12,padding:12,borderWidth:1,borderColor:'#fecdca'},
 errorText:{color:COLORS.danger,textAlign:'right',writingDirection:'rtl',lineHeight:20},
 button:{minHeight:46,borderRadius:12,backgroundColor:COLORS.primary,alignItems:'center',justifyContent:'center',paddingHorizontal:15,paddingVertical:10},
 buttonCompact:{minHeight:38,paddingVertical:7,paddingHorizontal:12},
 buttonSecondary:{backgroundColor:COLORS.primarySoft,borderWidth:1,borderColor:'#c7d7fe'},
 buttonDanger:{backgroundColor:COLORS.danger},
 buttonGhost:{backgroundColor:'#fff',borderWidth:1,borderColor:COLORS.border},
 buttonDisabled:{opacity:.45},
 buttonText:{color:'#fff',fontWeight:'800',fontSize:14,textAlign:'center',writingDirection:'rtl'},
 buttonTextSecondary:{color:COLORS.primary},
 heroCard:{backgroundColor:COLORS.dark,borderRadius:20,padding:20,marginBottom:4},
 heroKicker:{color:'#84adff',fontWeight:'700',textAlign:'right',writingDirection:'rtl'},
 heroTitle:{color:'#fff',fontSize:22,fontWeight:'900',textAlign:'right',writingDirection:'rtl',marginTop:6,lineHeight:31},
 heroSub:{color:'#d0d5dd',textAlign:'right',writingDirection:'rtl',marginTop:7,lineHeight:21},
 statsGrid:{flexDirection:'row-reverse',flexWrap:'wrap',gap:10},
 stat:{width:'48%',minHeight:108,justifyContent:'center'},
 statValue:{fontSize:27,fontWeight:'900',textAlign:'right'},
 statLabel:{fontSize:13,color:COLORS.muted,textAlign:'right',writingDirection:'rtl',marginTop:5},
 sectionHeader:{flexDirection:'row-reverse',justifyContent:'space-between',alignItems:'center',marginTop:6,marginBottom:2},
 sectionTitle:{fontSize:17,fontWeight:'900',color:COLORS.text,textAlign:'right',writingDirection:'rtl'},
 cardTitle:{fontSize:16,fontWeight:'800',color:COLORS.text,textAlign:'right',writingDirection:'rtl'},
 badge:{paddingHorizontal:9,paddingVertical:5,borderRadius:999,alignSelf:'flex-start'},
 badgeText:{fontSize:11,fontWeight:'800',writingDirection:'rtl'},
 rowCard:{marginBottom:10},
 unread:{borderColor:'#fda29b',borderWidth:1.5},
 rowTop:{flexDirection:'row-reverse',alignItems:'center',justifyContent:'space-between',gap:8},
 rowTitle:{fontSize:17,fontWeight:'900',color:COLORS.text,textAlign:'right',writingDirection:'rtl',marginTop:10},
 rowBody:{fontSize:14,color:COLORS.text,textAlign:'right',writingDirection:'rtl',lineHeight:22,marginTop:8},
 meta:{fontSize:12,color:COLORS.muted,textAlign:'right',writingDirection:'rtl',marginTop:4},
 time:{fontSize:11,color:COLORS.muted},
 inlineActions:{marginTop:10,alignItems:'flex-start'},
 empty:{padding:24,alignItems:'center',gap:6},
 emptyTitle:{fontSize:17,fontWeight:'800',color:COLORS.text,textAlign:'center',writingDirection:'rtl'},
 listHead:{flexDirection:'row-reverse',justifyContent:'space-between',alignItems:'center',marginBottom:10},
 screenTitle:{fontSize:24,fontWeight:'900',color:COLORS.text,textAlign:'right',writingDirection:'rtl'},
 filterBox:{padding:12,backgroundColor:COLORS.card,borderBottomWidth:1,borderColor:COLORS.border},
 pills:{gap:7,flexDirection:'row-reverse',paddingVertical:2},
 pill:{paddingHorizontal:13,paddingVertical:8,borderRadius:999,backgroundColor:'#fff',borderWidth:1,borderColor:COLORS.border},
 pillActive:{backgroundColor:COLORS.primary},
 pillText:{color:COLORS.text,fontSize:12,fontWeight:'700'},
 pillTextActive:{color:'#fff'},
 listContent:{padding:14,paddingBottom:24},
 countText:{color:COLORS.muted,textAlign:'right',writingDirection:'rtl',marginBottom:10},
 progressLine:{height:7,borderRadius:999,backgroundColor:'#eaecf0',overflow:'hidden',marginTop:10},
 progressFill:{height:'100%',backgroundColor:COLORS.success,borderRadius:999},
 answerRow:{paddingVertical:10,borderBottomWidth:1,borderBottomColor:'#f2f4f7'},
 answerLabel:{fontSize:12,color:COLORS.muted,textAlign:'right',writingDirection:'rtl',marginTop:8},
 answerValue:{fontSize:15,fontWeight:'700',color:COLORS.text,textAlign:'right',writingDirection:'rtl',marginTop:3},
 bigPercent:{fontSize:34,fontWeight:'900',color:COLORS.success,textAlign:'right'},
 stageActions:{flexDirection:'row-reverse',flexWrap:'wrap',gap:7,marginTop:12},
 messageWrap:{marginVertical:5,flexDirection:'row'},
 messageIncoming:{justifyContent:'flex-start'},
 messageOutgoing:{justifyContent:'flex-end'},
 messageBubble:{maxWidth:'86%',borderRadius:16,padding:11},
 bubbleIncoming:{backgroundColor:'#fff',borderWidth:1,borderColor:COLORS.border,borderBottomLeftRadius:4},
 bubbleOutgoing:{backgroundColor:'#eaf1ff',borderBottomRightRadius:4},
 messageWho:{fontSize:10,fontWeight:'800',color:COLORS.muted,textAlign:'right'},
 messageText:{fontSize:14,color:COLORS.text,textAlign:'right',writingDirection:'rtl',lineHeight:21,marginTop:3},
 messageTime:{fontSize:9,color:COLORS.muted,textAlign:'left',marginTop:5},
 messageError:{fontSize:11,color:COLORS.danger,textAlign:'right',writingDirection:'rtl',marginTop:5},
 link:{color:COLORS.primary,fontWeight:'700',textAlign:'right',marginTop:6},
 composer:{backgroundColor:'#fff',borderTopWidth:1,borderTopColor:COLORS.border,padding:10,flexDirection:'row-reverse',alignItems:'flex-end',gap:8},
 composerInput:{flex:1,minHeight:42,maxHeight:110,borderWidth:1,borderColor:'#d0d5dd',borderRadius:14,paddingHorizontal:12,paddingVertical:9,color:COLORS.text},
 divider:{height:1,backgroundColor:COLORS.border,marginVertical:13},
 profileName:{fontSize:22,fontWeight:'900',color:COLORS.text,textAlign:'right',writingDirection:'rtl'},
 tabBar:{minHeight:66,backgroundColor:'#fff',borderTopWidth:1,borderTopColor:COLORS.border,flexDirection:'row-reverse',alignItems:'stretch'},
 tab:{flex:1,alignItems:'center',justifyContent:'center',paddingVertical:9},
 tabLabelWrap:{position:'relative',alignItems:'center'},
 tabText:{fontSize:12,color:COLORS.muted,fontWeight:'700',writingDirection:'rtl'},
 tabTextActive:{color:COLORS.primary,fontWeight:'900'},
 tabDot:{position:'absolute',right:-18,top:-10,minWidth:20,height:20,borderRadius:10,backgroundColor:COLORS.danger,alignItems:'center',justifyContent:'center',paddingHorizontal:4},
 tabDotText:{color:'#fff',fontSize:9,fontWeight:'900'}
});
