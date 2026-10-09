import {useCallback,useEffect,useMemo,useState} from 'react';
import {
  Activity,ArrowLeft,BarChart3,BellRing,BookOpen,BrainCircuit,CalendarDays,
  CheckCircle2,ClipboardCheck,Cpu,Database,FileText,Gauge,Globe2,MessageCircle,
  Megaphone,Play,Plus,RefreshCw,Search,Send,Settings2,ShieldCheck,Sparkles,MessageCircleQuestion,
  Target,Users,Zap,MapPin,TrendingUp,Briefcase,Clock3,FolderOpen,ChevronLeft,CalendarCheck,UserPlus,Bot,MessageSquare,Filter
} from 'lucide-react';
import {api,send,date,personName} from './api';

const n=value=>Number(value||0);
const fmt=value=>n(value).toLocaleString('en-US');

function Spark({tone='cyan'}){
  const path=tone==='orange'
    ?'M2 26 C14 29 20 15 31 20 S47 26 56 17 S72 8 80 14 S92 20 99 8'
    :'M2 28 C13 25 21 27 30 20 S46 12 55 16 S68 27 78 18 S91 7 99 10';
  return <svg className={'v2-spark '+tone} viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true"><path d={path}/><circle cx="99" cy={tone==='orange'?8:10} r="2.4"/></svg>;
}

function MetricCard({title,value,caption,Icon,tone='cyan',trend=''}) {
  return <article className={'v2-metric '+tone}>
    <span className="v2-metric-icon"><Icon size={27}/></span>
    <div><small>{title}</small><strong>{value}</strong><em>{caption}</em>{trend&&<b className="v2-metric-trend"><TrendingUp size={12}/>{trend}</b>}</div>
    <Spark tone={tone}/>
  </article>;
}

function LineChart({data=[]}){
  const clean=data.length?[...data].reverse():[{label:'أكتوبر',count:0,accepted:0},{label:'سبتمبر',count:0,accepted:0},{label:'أغسطس',count:0,accepted:0},{label:'يوليو',count:0,accepted:0},{label:'يونيو',count:0,accepted:0},{label:'مايو',count:0,accepted:0}];
  const width=620,height=220,padX=36,padTop=24,padBottom=38;
  const max=Math.max(1,...clean.flatMap(x=>[n(x.count),n(x.accepted)]));
  const step=clean.length>1?(width-padX*2)/(clean.length-1):0,usable=height-padTop-padBottom;
  const pts=key=>clean.map((d,i)=>({x:padX+i*step,y:padTop+usable-(n(d[key])/max)*usable,label:d.label||String(d.key||'')}));
  const a=pts('count'),b=pts('accepted'),poly=x=>x.map(p=>p.x+','+p.y).join(' ');
  const area=x=>x.length?padX+','+(height-padBottom)+' '+poly(x)+' '+x.at(-1).x+','+(height-padBottom):'';
  return <div className="v2-chart"><div className="v2-chart-legend"><span className="cyan">الطلبات</span><span className="orange">المقبولون</span></div>
    <svg viewBox={'0 0 '+width+' '+height} role="img" aria-label="أداء التوظيف">
      {[0,.25,.5,.75,1].map((r,i)=><line key={i} x1={padX} x2={width-padX} y1={padTop+usable*r} y2={padTop+usable*r} className="grid"/>)}
      <polygon points={area(a)} className="area cyan"/><polygon points={area(b)} className="area orange"/>
      <polyline points={poly(a)} className="line cyan"/><polyline points={poly(b)} className="line orange"/>
      {a.map((p,i)=><g key={i}><circle cx={p.x} cy={p.y} r="4.3" className="point cyan"/><text x={p.x} y={height-12} textAnchor="middle">{p.label}</text></g>)}
      {b.map((p,i)=><circle key={'b'+i} cx={p.x} cy={p.y} r="3.5" className="point orange"/>)}
    </svg>
  </div>;
}


const AREA_COORDS=[
  {keys:['الشيخ زايد','زايد','sheikh zayed'],x:19,y:45},{keys:['اكتوبر','اكتوبر 6','6 اكتوبر','السادس من اكتوبر','october'],x:12,y:64},
  {keys:['حدائق الاهرام','الاهرام','الهرم','haram'],x:28,y:68},{keys:['المهندسين','مهندسين'],x:38,y:45},{keys:['المعادي','معادي'],x:48,y:72},
  {keys:['المقطم','مقطم'],x:59,y:68},{keys:['مدينة نصر','مدينه نصر','نصر'],x:65,y:45},{keys:['مصر الجديدة','مصر الجديده','هليوبوليس'],x:60,y:30},
  {keys:['التجمع','التجمع الخامس','القاهرة الجديدة','القاهره الجديده'],x:78,y:51},{keys:['الرحاب','رحاب'],x:82,y:37},
  {keys:['مدينتي','مدينتى'],x:88,y:30},{keys:['الشروق','شروق'],x:91,y:48},{keys:['العبور','عبور'],x:75,y:20},
  {keys:['الفردوس','فردوس'],x:20,y:57},{keys:['حدائق اكتوبر','حدايق اكتوبر'],x:16,y:72}
];
const areaNorm=value=>String(value||'').toLowerCase().replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي').replace(/[^\u0600-\u06ff\w ]/g,' ').replace(/\s+/g,' ').trim();
const hashPoint=(name,index)=>{let h=0;for(const ch of areaNorm(name))h=(h*31+ch.charCodeAt(0))>>>0;return{x:18+((h+index*17)%70),y:20+(((h>>>5)+index*23)%58)};};
const pointFor=(name,index)=>{const q=areaNorm(name),hit=AREA_COORDS.find(p=>p.keys.some(k=>q.includes(areaNorm(k))||areaNorm(k).includes(q)));return hit?{x:hit.x,y:hit.y}:hashPoint(name,index);};

function DynamicAreaMap({areas=[]}){
  const points=useMemo(()=>areas.slice(0,8).map((area,index)=>({...area,...pointFor(area.name,index),tone:index%2?'cyan':'orange'})),[areas]);
  const [selected,setSelected]=useState('');
  useEffect(()=>{if(points.length&&!points.some(p=>p.name===selected))setSelected(points[0].name);},[points,selected]);
  return <div className="v2-live-map">
    <div className="v2-map-toolbar"><span><MapPin size={13}/> توزيع مباشر</span><b>{fmt(points.reduce((s,p)=>s+n(p.count),0))} مرشح</b></div>
    <svg className="v2-map-base" viewBox="0 0 600 350" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="districtFill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#06304a"/><stop offset="1" stopColor="#031724"/></linearGradient></defs>
      <path className="district west" d="M24 66 L172 34 240 79 224 154 268 218 205 318 52 285 18 190 Z"/>
      <path className="district center" d="M229 76 L355 34 404 103 375 170 414 233 341 319 260 218 224 153 Z"/>
      <path className="district east" d="M390 78 L532 48 583 122 548 207 576 292 421 319 414 232 376 169 Z"/>
      <path className="nile" d="M318 0 C301 62 325 112 309 167 C294 219 314 268 288 350"/>
      <path className="road" d="M45 113 C150 92 208 134 291 126 S431 86 555 111"/>
      <path className="road" d="M62 244 C170 216 232 245 326 225 S461 196 552 225"/>
      <path className="road" d="M138 40 C190 113 190 189 142 306"/>
      <path className="road" d="M455 45 C429 110 446 174 492 300"/>
      <circle className="ring r1" cx="300" cy="172" r="52"/><circle className="ring r2" cx="300" cy="172" r="88"/>
    </svg>
    <div className="v2-map-points">
      {points.map((p,index)=><button key={p.name} type="button" className={'v2-map-pin '+p.tone+(selected===p.name?' active':'')} style={{left:p.x+'%',top:p.y+'%'}} onClick={()=>setSelected(p.name)} title={p.name+' · '+fmt(p.count)}>
        <span className="pin-dot"><MapPin size={selected===p.name?21:17}/></span>
        <span className="pin-label"><b>{p.name}</b><strong>{fmt(p.count)}</strong></span>
      </button>)}
    </div>
    {!points.length&&<div className="v2-map-empty">أول ما المرشحين يختاروا مناطق العمل، التوزيع هيظهر هنا تلقائيًا.</div>}
  </div>;
}

function RecentApplicants({items=[],onSelect}){
  return <div className="v2-people">
    <div className="v2-people-head"><span>الاسم</span><span>رقم الهاتف</span><span>المنطقة</span><span>الحالة</span></div>
    {items.length?items.slice(0,5).map(a=><button key={a.id} onClick={()=>onSelect?.(a.id)}>
      <span className="person"><i>{personName(a)[0]}</i><b>{personName(a)}</b></span>
      <span dir="ltr">{a.phone||'—'}</span>
      <span>{a.qualification?.preferred_work_area||'—'}</span>
      <span className={'status '+(a.recruitment_stage||'new')}>{a.recruitment_stage==='hired'?'تم التعيين':a.recruitment_stage==='accepted'?'تم القبول':a.recruitment_stage==='interview'?'مقابلة':a.recruitment_stage==='review'?'قيد المراجعة':'جديد'}</span>
    </button>):<div className="v2-empty">لسه مفيش طلبات مسجلة.</div>}
  </div>;
}

function WebV2Kpi({title,value,Icon,tone='cyan',caption=''}) {
  return <article className={'webv2-kpi '+tone}>
    <div className="webv2-kpi-copy"><span>{title}</span><strong>{value}</strong>{caption&&<small>{caption}</small>}</div>
    <span className="webv2-kpi-icon"><Icon size={27}/></span>
  </article>;
}

function WebV2AreaBars({areas=[]}) {
  const valid=areas.filter(x=>{const q=areaNorm(x?.name);return q&& !q.includes('لا توجد') && !q.includes('لا يوجد') && !q.includes('غير مناسب') && !q.includes('مش مناسب');});
  const top=valid.slice(0,4),max=Math.max(1,...top.map(x=>n(x.count)));
  return <section className="webv2-card webv2-areas">
    <header><h2><MapPin size={17}/> مناطق العمل</h2><button type="button"><Filter size={15}/></button></header>
    <div className="webv2-area-list">
      {top.length?top.map(x=><div key={x.name} className="webv2-area-row">
        <span>{x.name}</span><div className="bar"><i style={{width:Math.max(8,Math.round((n(x.count)/max)*100))+'%'}}/></div><b>{fmt(x.count)}</b>
      </div>):<div className="webv2-empty-mini">لسه مفيش بيانات كفاية لمناطق العمل.</div>}
    </div>
  </section>;
}

function WebV2Applicants({items=[],onSelect}) {
  return <section className="webv2-card webv2-applicants">
    <header><div><h2><Users size={18}/> أحدث المتقدمين</h2><p>أحدث الطلبات المسجلة</p></div><button className="webv2-link">عرض الكل <ChevronLeft size={15}/></button></header>
    <div className="webv2-table">
      <div className="head"><span>المرشح</span><span>المنطقة</span><span>الحالة</span><span>الإجراء</span></div>
      {items.length?items.slice(0,4).map(a=>{
        const stage=a.recruitment_stage||'new';
        const label=stage==='hired'?'تم القبول':stage==='accepted'?'تم القبول':stage==='interview'?'مقابلة':stage==='review'?'قيد المراجعة':'جديد';
        return <div className="row" key={a.id}>
          <span className="candidate"><i>{personName(a)[0]||'م'}</i><b>{personName(a)}</b></span>
          <span>{a.qualification?.preferred_work_area||'—'}</span>
          <span><em className={'stage '+stage}>{label}</em></span>
          <span><button onClick={()=>onSelect?.(a.id)}><FolderOpen size={14}/> فتح الملف</button></span>
        </div>;
      }):<div className="webv2-empty-mini">لسه مفيش متقدمين.</div>}
    </div>
  </section>;
}

function WebV2Today({interviews=[],alerts={},onTab,onAlert}) {
  const list=interviews.slice(0,2);
  return <section className="webv2-card webv2-today">
    <header><h2><Clock3 size={17}/> متابعة اليوم</h2></header>
    <button className="webv2-needs-reply" onClick={()=>alerts.items?.[0]&&onAlert?.(alerts.items[0])}>
      <span><b>{alerts.open_count||0}</b> حالات تحتاج رد</span><ChevronLeft size={18}/>
    </button>
    <div className="webv2-today-list">
      {list.map(x=><button key={x.id} onClick={()=>onTab?.('interviews')}>
        <span><CalendarDays size={16}/></span>
        <div><strong>{x.applicant_name||'مرشح'}</strong><small>{x.office?.name||'مقابلة توظيف'}</small></div>
        <time>{new Date(x.scheduled_at).toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit',timeZone:'Africa/Cairo'})}</time>
      </button>)}
      {!list.length&&<div className="webv2-empty-mini">مفيش مقابلات قريبة.</div>}
    </div>
    <div className="webv2-today-actions"><button onClick={()=>onTab?.('interviews')}><CalendarCheck size={15}/> كل المقابلات</button><button onClick={()=>onTab?.('applicants')}><MessageSquare size={15}/> المحادثات</button></div>
  </section>;
}

export function ReferenceOverviewPage({version=0,officeId='',alerts={},onAlert,onTab,onSelect,profileName='سيد'}){
  const [data,setData]=useState(null),[error,setError]=useState('');
  const load=useCallback(async()=>{try{const p=new URLSearchParams();if(officeId)p.set('office_id',officeId);setData(await api('/dashboard'+(p.toString()?'?'+p:'')));setError('');}catch(e){setError(e.message);}},[officeId]);
  useEffect(()=>{load();},[load,version]);
  const metrics=data?.metrics||{},growth=data?.growth||[],areas=data?.area_distribution||[],recent=data?.recent||[],upcoming=data?.upcoming_interviews||[];
  const firstName=(profileName.split(' ')[0]||'سيد').trim();
  const displayFirstName=/^[A-Za-z]+$/.test(firstName)?firstName.charAt(0).toUpperCase()+firstName.slice(1):firstName;

  return <div className="v2-page webv2-home">
    <section className="webv2-hero">
      <div className="webv2-hero-art" aria-hidden="true"><img src="data:image/webp;base64,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" alt=""/></div>
      <div className="webv2-hero-copy">
        <span className="eyebrow">مساحة العمل اليومية</span>
        <h1>أهلًا {displayFirstName}، خلّينا نبدأ يومك.</h1>
        <p>كل طلب، محادثة، ومقابلة في مكان واحد.</p>
        <div className="webv2-hero-actions">
          <button className="primary" onClick={()=>onTab?.('applicants')}><UserPlus size={18}/> إضافة مرشح</button>
          <button onClick={()=>onTab?.('interviews')}><CalendarDays size={18}/> جدولة مقابلة</button>
        </div>
      </div>
    </section>

    {error&&<div className="v2-error">{error}<button onClick={load}><RefreshCw size={15}/> إعادة المحاولة</button></div>}

    <section className="webv2-kpis">
      <WebV2Kpi title="إجمالي المتقدمين" value={fmt(metrics.total)} Icon={Users}/>
      <WebV2Kpi title="طلبات اليوم" value={fmt(metrics.new_today)} Icon={FileText}/>
      <WebV2Kpi title="مقابلات اليوم" value={fmt(metrics.interviews_today)} Icon={CalendarDays} tone="orange"/>
      <WebV2Kpi title="تم تعيينهم" value={fmt(metrics.hired)} Icon={Users} tone="green"/>
    </section>

    <section className="webv2-main-grid">
      <div className="webv2-left-stack">
        <WebV2AreaBars areas={areas}/>
        <button className="webv2-agent-tile" onClick={()=>onTab?.('agent')}>
          <span className="agent-icon"><Bot size={30}/></span>
          <div><strong>AI Agent</strong><small>إدارة مساعد التوظيف</small></div>
          <ChevronLeft size={24}/>
        </button>
        <WebV2Today interviews={upcoming} alerts={alerts} onTab={onTab} onAlert={onAlert}/>
      </div>

      <div className="webv2-right-stack">
        <section className="webv2-card webv2-performance">
          <header><div><h2><BarChart3 size={18}/> أداء التوظيف</h2><p>الطلبات والمقبولون خلال آخر 6 أشهر</p></div><span>آخر ٦ أشهر</span></header>
          <LineChart data={growth}/>
        </section>
        <WebV2Applicants items={recent} onSelect={onSelect}/>
      </div>
    </section>
  </div>;
}

function AgentMiniChart({decisions=[]}){
  const hours=Array.from({length:8},(_,i)=>i),counts=hours.map((_,i)=>decisions.filter(d=>{const h=new Date(d.created_at).getHours();return h>=i*3&&h<(i+1)*3;}).length),max=Math.max(1,...counts);
  return <div className="v2-agent-mini-chart">{counts.map((v,i)=><i key={i} style={{height:(18+v/max*72)+'%'}}/>)}</div>;
}

function AgentDashboard({state,onView}){
  const stats=state.stats||{},a=state.agent_stats||{},llm=state.llm||{},decisions=state.decisions||[],knowledge=state.knowledge||[];
  const health=Math.max(0,Math.min(100,Math.round((n(stats.autonomy_rate_30d)*.55)+(Math.min(100,n(stats.shared_breadfast)*8)*.25)+(Math.max(0,100-n(stats.conflicts)*12)*.2))));
  return <>
    <div className="v2-agent-metrics">
      <MetricCard title="المهام المنفذة" value={fmt(a.decisions_24h)} caption="قرار خلال آخر 24 ساعة" Icon={ClipboardCheck}/>
      <MetricCard title="قرارات LLM اليوم" value={fmt(a.llm_decisions_24h)} caption={llm.configured?'العقل الخارجي متصل':'يعمل بالقواعد الحالية'} Icon={MessageCircle} tone="orange"/>
      <MetricCard title="متوسط الثقة" value={a.avg_confidence_24h==null?'—':Math.round(n(a.avg_confidence_24h))+'%'} caption="متوسط الثقة" Icon={Target}/>
      <MetricCard title="مصادر المعرفة" value={fmt(stats.active||knowledge.filter(x=>x.active!==false).length)} caption="معلومة نشطة" Icon={BookOpen} tone="orange"/>
    </div>
    <div className="v2-agent-main-grid">
      <div className="v2-agent-left">
        <section className="v2-panel v2-agent-performance"><header><div><h2>أداء الوكيل</h2><p>نشاط القرارات خلال اليوم</p></div><button><BarChart3 size={16}/> آخر 24 ساعة</button></header><AgentMiniChart decisions={decisions}/><div className="v2-agent-performance-meta"><span>Fallback <b>{n(a.fallback_rate_24h)}%</b></span><span>LLM latency <b>{a.avg_latency_ms?fmt(a.avg_latency_ms)+'ms':'—'}</b></span><span>Health <b>{health}%</b></span></div></section>
        <section className="v2-panel v2-knowledge-sources"><header><div><h2>مصادر المعرفة</h2><p>كل ما يستخدمه الـAgent في اتخاذ القرار</p></div><button onClick={()=>onView('knowledge')}><Plus size={15}/> إضافة مصدر جديد</button></header><div className="source-grid">
          <button onClick={()=>onView('knowledge')}><Database/><strong>قاعدة البيانات</strong><small>{fmt(stats.active)} سجل</small></button>
          <button onClick={()=>onView('knowledge')}><MessageCircle/><strong>الأسئلة الشائعة</strong><small>{fmt(stats.shared_breadfast)} Shared</small></button>
          <button onClick={()=>onView('knowledge')}><FileText/><strong>ملفات PDF</strong><small>جاهز للربط</small></button>
          <button onClick={()=>onView('knowledge')}><Globe2/><strong>الموقع الإلكتروني</strong><small>مصدر خارجي</small></button>
        </div></section>
        <section className="v2-panel v2-system"><header><div><h2>حالة النظام</h2><p>سلامة المكونات الأساسية</p></div></header><div className="system-row"><span><i className="on"/><WifiIcon/> متصل</span><span><i className={llm.configured?'on':'warn'}/><Cpu/> {llm.configured?'LLM جاهز':'Core جاهز'}</span><span><i className="on"/><RefreshCw/> تحديث مباشر</span></div></section>
      </div>
      <section className="v2-agent-brain-panel">
        <img src="/reference/ai-brain.webp" alt="العقل الذكي"/>
        <div className="v2-brain-chip top-right"><Sparkles/><strong>التعلم المستمر</strong><small>تطوير المعرفة تلقائيًا</small></div>
        <div className="v2-brain-chip mid-right"><BrainCircuit/><strong>فهم الأسئلة</strong><small>تحليل اللغة والسياق</small></div>
        <div className="v2-brain-ring"><strong>{health}%</strong><small>مستوى التعلم</small></div>
        <div className="v2-brain-footer">
          <header><h2>آخر المحادثات</h2><button onClick={()=>onView('decisions')}>عرض الكل</button></header>
          <div>{decisions.slice(0,5).map(d=><button key={d.id} onClick={()=>onView('decisions')}><span>{d.action||'قرار'}</span><b>{d.input_text||'—'}</b><em>{d.confidence==null?'—':Math.round(n(d.confidence)*100)+'%'}</em></button>)}{!decisions.length&&<small>لسه مفيش Decision Traces.</small>}</div>
        </div>
      </section>
      <section className="v2-panel v2-agent-actions"><header><div><h2>الإجراءات السريعة</h2><p>إدارة وتشغيل الـAgent</p></div><Zap/></header>
        <button className="action orange" onClick={()=>onView('test')}><ArrowLeft/><div><strong>تدريب الوكيل</strong><small>اختبار المعرفة والأداء</small></div><Play/></button>
        <button className="action cyan" onClick={()=>onView('knowledge')}><ArrowLeft/><div><strong>إضافة مصدر معرفة</strong><small>إضافة معلومات جديدة</small></div><Database/></button>
        <button className="action dark" onClick={()=>onView('test')}><ArrowLeft/><div><strong>اختبار الرد</strong><small>اختبار إجابات الوكيل</small></div><MessageCircle/></button>
        <button className="action dark" onClick={()=>onView('settings')}><ArrowLeft/><div><strong>نشر الوكيل</strong><small>تفعيل الوكيل على القنوات</small></div><Send/></button>
      </section>
    </div>
  </>;
}

function WifiIcon(){return <Activity size={18}/>;}

function AgentKnowledge({state,reload}){
 const [q,setQ]=useState(''),[form,setForm]=useState({question:'',answer:'',keywords:''}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [reviewDraft,setReviewDraft]=useState({});
 const items=(state.knowledge||[]).filter(x=>!q||((x.question||'')+' '+(x.answer||'')).toLowerCase().includes(q.toLowerCase()));
 const pending=(state.suggestions||[]).filter(x=>x.status==='pending').slice(0,35);
 const add=async e=>{e.preventDefault();setBusy(true);try{
  await send('/intelligence/knowledge',{question:form.question,answer:form.answer,keywords:form.keywords.split(/[،,]/).map(x=>x.trim()).filter(Boolean),active:true});
  setForm({question:'',answer:'',keywords:''});await reload();setError('');
 }catch(err){setError(err.message);}finally{setBusy(false);}};
 const review=async(item,approve)=>{
  if(!approve&&!window.confirm('رفض اقتراح المعرفة ده؟'))return;
  const edited=reviewDraft[item.id]||{};
  const question=String(edited.question??item.question??'').trim(),answer=String(edited.answer??item.answer??'').trim();
  if(approve&&(!question||!answer)){setError('اكتب السؤال والإجابة الصحيحة قبل الاعتماد.');return;}
  setBusy(true);
  try{
   await send('/intelligence/suggestions/'+item.id+'/'+(approve?'approve':'reject'),approve?{question,answer}:{});
   await reload();setError('');
  }catch(err){setError(err.message);}finally{setBusy(false);}
 };
 return <div className="v2-agent-detail v2-expert-knowledge">
  <div className="detail-head"><div><h2>مخزن المعرفة</h2><p>كل المعلومات اللي يقدر الـAgent يرجع لها في الرد والقرار، مع مراجعة الاقتراحات الجديدة قبل الاعتماد.</p></div>
   <div className="search"><Search size={16}/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="ابحث في المعرفة..."/></div>
  </div>
  {error&&<div className="v2-error" role="alert">{error}</div>}
  <div className="v2-knowledge-layout">
   <form className="v2-detail-card" onSubmit={add}>
    <h3>إضافة مصدر معرفة</h3>
    <label>السؤال أو الموضوع<input required value={form.question} onChange={e=>setForm({...form,question:e.target.value})}/></label>
    <label>الإجابة<textarea required rows={6} value={form.answer} onChange={e=>setForm({...form,answer:e.target.value})}/></label>
    <label>كلمات مفتاحية<input value={form.keywords} onChange={e=>setForm({...form,keywords:e.target.value})} placeholder="مرتب، منطقة، مواعيد"/></label>
    <button disabled={busy}><Plus size={15}/> {busy?'جارٍ الإضافة...':'إضافة للمعرفة'}</button>
   </form>
   <div className="v2-knowledge-list">
    {items.map(k=><article key={k.id}>
     <div><span>{k.knowledge_scope||'office'}</span><em>{k.memory_status||'verified'}</em></div>
     <h3>{k.question}</h3><p>{k.answer}</p>
     <footer><span>ثقة {Math.round(n(k.confidence||.8)*100)}%</span><span>{fmt(k.usage_count)} استخدام</span></footer>
    </article>)}
    {!items.length&&<div className="v2-empty">مفيش نتائج.</div>}
   </div>
  </div>
  <section className="v2-detail-card v2-expert-suggestions">
   <div className="v2-quality-section-head"><div><h3><ShieldCheck size={18}/> مراجعة أسئلة المتقدمين الجديدة</h3>
    <p>الاقتراحات دي من محادثاتنا اللي رد عليها مسؤول. راجع السؤال والإجابة وشيل أي بيانات شخصية أو تفاصيل غير مؤكدة قبل الاعتماد.</p></div>
    <strong>{pending.length} في انتظار المراجعة</strong>
   </div>
   {pending.length?<div className="v2-expert-suggestion-list">{pending.map(item=>{
    const edited=reviewDraft[item.id]||{};
    return <article key={item.id}>
     <span>اقتراح من محادثة مكتب {item.office_id?'(خاص بالمكتب)':'(عام)'}</span>
     <label>السؤال بعد المراجعة<textarea rows={2} maxLength={2000} value={edited.question??item.question??''} onChange={e=>setReviewDraft(v=>({...v,[item.id]:{...v[item.id],question:e.target.value}}))}/></label>
     <label>الإجابة الصحيحة المعتمدة<textarea rows={3} maxLength={4000} value={edited.answer??item.answer??''} onChange={e=>setReviewDraft(v=>({...v,[item.id]:{...v[item.id],answer:e.target.value}}))}/></label>
     <div className="v2-expert-review-actions">
      <button type="button" disabled={busy} onClick={()=>review(item,true)}><CheckCircle2 size={16}/> اعتماد بعد المراجعة</button>
      <button type="button" className="reject" disabled={busy} onClick={()=>review(item,false)}>رفض الاقتراح</button>
     </div>
    </article>;
   })}</div>:<p className="v2-quality-muted">مفيش اقتراحات في انتظار المراجعة حاليًا.</p>}
  </section>
 </div>;
}

function AgentTest({state}){
  const [text,setText]=useState(''),[result,setResult]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const run=async e=>{e.preventDefault();setBusy(true);try{setResult(await send('/agent/test-plan',{text}));setError('');}catch(err){setError(err.message);setResult(null);}finally{setBusy(false);}};
  return <div className="v2-agent-detail"><div className="detail-head"><div><h2>تدريب واختبار الوكيل</h2><p>جرّب رسالة حقيقية قبل ما تغيّر وضع التشغيل.</p></div></div>{error&&<div className="v2-error">{error}</div>}<div className="v2-test-grid"><form className="v2-detail-card" onSubmit={run}><label>رسالة المتقدم<textarea required rows={9} value={text} onChange={e=>setText(e.target.value)} placeholder="مثال: أنا من مدينة العبور ومعايا مكنة وعايز أعرف أنهي منطقة أفضل..."/></label><button disabled={busy||!state.llm?.configured}><Play size={15}/> {busy?'جارٍ التحليل...':'حلّل الرسالة'}</button>{!state.llm?.configured&&<small>الـLLM Provider غير متصل حاليًا؛ الاختبار هيتفعل بعد إضافة بيانات المزود.</small>}</form><section className="v2-detail-card result"><h3>نتيجة الـPlanner</h3>{result?.plan?<><strong>{result.plan.action} · {Math.round(n(result.plan.confidence)*100)}%</strong><p>{result.plan.summary||'—'}</p><pre>{JSON.stringify(result.plan,null,2)}</pre></>:<div className="v2-empty">نتيجة الاختبار هتظهر هنا.</div>}</section></div></div>;
}


function AgentQualityCenter({state,reload,onReviewKnowledge}){
  const [days,setDays]=useState(7),[metrics,setMetrics]=useState(null),[result,setResult]=useState(null);
  const [loading,setLoading]=useState(false),[running,setRunning]=useState(false),[error,setError]=useState('');
  const [customBusy,setCustomBusy]=useState(false),[shownCases,setShownCases]=useState(60),[draft,setDraft]=useState({title:'',input_text:'',expected_action:''});
  const load=useCallback(async()=>{
    setLoading(true);
    try{
      const data=await api('/agent/quality/metrics?days='+days);
      setMetrics(data);
      setError('');
    }catch(e){setError(e.message);}
    finally{setLoading(false);}
  },[days]);
  useEffect(()=>{load();},[load]);
  const runSuite=async()=>{
    setRunning(true);
    try{
      const report=await send('/agent/quality/suite/run',{});
      setResult(report);setShownCases(60);setError('');
      await load();
    }catch(e){setError(e.message);}
    finally{setRunning(false);}
  };
  const createCase=async e=>{
    e.preventDefault();setCustomBusy(true);
    try{
      await send('/agent/quality/cases',{
       title:draft.title,input_text:draft.input_text,
       expected:draft.expected_action?{action:draft.expected_action}:{},tags:['quality-center']
      });
      setDraft({title:'',input_text:'',expected_action:''});await reload();setError('');
    }catch(err){setError(err.message);}
    finally{setCustomBusy(false);}
  };
  const runCase=async id=>{
    setCustomBusy(true);
    try{await send('/agent/quality/cases/'+id+'/run',{});await reload();setError('');}
    catch(err){setError(err.message);}
    finally{setCustomBusy(false);}
  };
  const deleteCase=async id=>{
    if(!window.confirm('حذف حالة الاختبار؟'))return;
    setCustomBusy(true);
    try{await send('/agent/quality/cases/'+id,{},'DELETE');await reload();setError('');}
    catch(err){setError(err.message);}
    finally{setCustomBusy(false);}
  };
  const fmtPct=x=>x===null||x===undefined?'—':Number(x).toLocaleString('en-US',{maximumFractionDigits:1})+'%';
  const op=metrics?.operational||{},ev=metrics?.evaluation||{},usage=metrics?.usage||{},expert=state?.expert||{},expertMetrics=metrics?.expert||{};
  const history=metrics?.builtin?.last_runs||[];
  const conversations=metrics?.conversation||{},patterns=conversations.patterns||[];
  const totalCalls=op.tool_calls||0;
  return <div className="v2-agent-detail v2-quality-center">
    <div className="detail-head">
      <div><h2>مركز جودة الـ Agent</h2><p>بيانات تشغيل حقيقية + اختبارات آمنة بمرشحين افتراضيين. المراقبة هنا لا تغيّر بيانات أي مرشح.</p></div>
      <div className="v2-quality-controls">
        <label>فترة القياس <select value={days} onChange={e=>setDays(Number(e.target.value))}><option value={1}>آخر 24 ساعة</option><option value={7}>آخر 7 أيام</option><option value={30}>آخر 30 يوم</option></select></label>
        <button type="button" onClick={load} disabled={loading}><RefreshCw size={17}/> {loading?'جارٍ التحديث':'تحديث'}</button>
      </div>
    </div>
    {error&&<div className="v2-error" role="alert">{error}</div>}
    {metrics?.sample?.truncated&&<div className="v2-quality-notice">المعروض عينة محدودة من آخر السجلات؛ ممكن بعض المعدلات لا تمثل كل الرسائل في الفترة.</div>}
    <div className="v2-quality-metrics">
      {[
        {label:'رسائل تم تحليلها',value:metrics?fmt(op.turns):'—',foot:'سجلات Agent خلال الفترة'},
        {label:'نجاح أدوات الـ CRM',value:metrics?fmtPct(op.tool_success_rate):'—',foot:totalCalls+' تنفيذ أداة'},
        {label:'التحويل لمسؤول',value:metrics?fmtPct(op.handoff_rate):'—',foot:(op.handoffs||0)+' حالة من رسائل البوت'},
        {label:'الـ LLM Fallback',value:metrics?fmtPct(op.fallback_rate):'—',foot:'من قرارات التخطيط المسجلة'},
        {label:'اجتياز تقييمات الـ LLM',value:metrics?fmtPct(ev.pass_rate):'—',foot:(ev.evaluated||0)+' حالة تم تقييمها'}
      ].map(x=><article key={x.label} className="v2-quality-metric"><small>{x.label}</small><strong>{x.value}</strong><span>{x.foot}</span></article>)}
    </div>
    <section className="v2-detail-card v2-conversation-intelligence">
      <div className="v2-quality-section-head">
        <div>
          <h3><MessageCircleQuestion size={19}/> ذكاء المحادثات الفعلية</h3>
          <p>رصد احتمالي من أنواع أخطاء التشغيل، بدون نقل نص الرسائل أو أرقام المتقدمين للتقرير. النتائج للمراجعة البشرية مش للتعلّم التلقائي.</p>
        </div>
        <button type="button" onClick={onReviewKnowledge}><ShieldCheck size={16}/> راجع اقتراحات المعرفة</button>
      </div>
      <div className="v2-conversation-stats">
        <div><small>الأدوار اللي تم فحصها</small><strong>{fmt(conversations.sampled_turns)}</strong></div>
        <div><small>مؤشر حالات محتاجة مراجعة</small><strong>{fmtPct(conversations.flag_rate)}</strong></div>
        <div><small>حالات مرصودة بعلامات</small><strong>{fmt(conversations.flagged_turns)}</strong></div>
        <div><small>سياسة التعلّم</small><strong>اعتماد بشري</strong></div>
      </div>
      <p className="v2-quality-muted">المؤشرات دي مش نسبة أخطاء مؤكدة؛ بتكشف احتمالات لمراجعتها. المتقدمون الحقيقيون لا يدخلون تلقائيًا إلى اختبارات التدريب.</p>
      <div className="v2-conversation-patterns">
       {patterns.map(p=><article className={'v2-conversation-pattern severity-'+p.severity} key={p.key}>
         <div><strong>{p.label}</strong><small>{p.severity==='high'?'أولوية عالية':p.severity==='medium'?'أولوية متوسطة':'للمتابعة'}</small></div>
         <b>{fmt(p.count)}</b>
         <p>{p.advice}</p>
       </article>)}
       {!patterns.length&&<div className="v2-quality-muted">لسه ما اتسجلتش علامات كفاية في الفترة المحددة. العلامات الجديدة بتظهر مع الرسائل اللي هتتسجل بعد التحديث.</div>}
      </div>
      <div className="v2-conversation-trends">
        <h4>متابعة الإشارات يوميًا</h4>
        <div>{(conversations.day_trend||[]).map(row=><span key={row.day}><small>{row.day.slice(5)}</small><strong>{row.flagged}/{row.turns}</strong></span>)}</div>
      </div>
    </section>
    <div className="v2-quality-layout">
      <section className="v2-detail-card">
        <div className="v2-quality-section-head"><div><h3>اختبارات المحادثات المصرية</h3><p>تُشغّل الحالات داخل النظام ببيانات وهمية؛ بدون رسائل حقيقية وبدون طلبات LLM.</p></div><button type="button" onClick={runSuite} disabled={running}><Play size={16}/>{running?'جارٍ تشغيل الاختبارات':'تشغيل الاختبارات'}</button></div>
        {result&&<div className="v2-quality-suite-summary" role="status"><strong>{result.passed} / {result.total} حالة اجتازت الاختبار</strong><span>نسبة الاجتياز: {fmtPct(result.pass_rate)} · {result.duration_ms} ms</span></div>}
        {result?.results?.length>0&&<div className="v2-quality-suite-list">
          {result.results.slice(0,shownCases).map(test=><div key={test.id} className={'v2-quality-case '+(test.passed?'pass':'fail')}><span className="quality-state">{test.passed?<CheckCircle2 size={17}/>:<Activity size={17}/>}</span><div><strong>{test.title}</strong><small>{test.category}</small>{!test.passed&&test.problems?.map((p,i)=><p key={i}>{p}</p>)}</div><b>{test.passed?'ناجح':'فشل'}</b></div>)}
        </div>}
        {result?.results?.length>shownCases&&<button className="v2-expert-more" type="button" onClick={()=>setShownCases(n=>n+80)}>عرض {Math.min(80,result.results.length-shownCases)} حالة إضافية من {result.results.length}</button>}
        {!result&&<p className="v2-quality-muted">اضغط «تشغيل الاختبارات» لقياس القواعد الحالية. ده اختبار آلي أساسي، مش تقييم بشري لكل الردود أو ضمان دقة 100%.</p>}
        <h3 className="v2-quality-subtitle">آخر مرات تشغيل الاختبارات</h3>
        {history.length?<div className="v2-quality-history">{history.map((h,i)=><div key={i}><span>{date(h.created_at)}</span><strong>{h.passed}/{h.total} حالة</strong><span>{fmtPct(h.pass_rate)}</span></div>)}</div>:<p className="v2-quality-muted">مافيش تشغيلات محفوظة لسه.</p>}
      </section>
      <section className="v2-detail-card">
        <h3>استخدام الـ LLM والأدوات</h3>
        <p className="v2-quality-muted">القياس من الاستخدام المبلغ عنه في استجابة المزود، مش تقدير افتراضي للتكلفة.</p>
        <div className="v2-quality-usage">
          <div><small>استدعاءات LLM المسجلة</small><strong>{fmt(usage.llm_calls_observed)}</strong></div>
          <div><small>Input Tokens المرصودة</small><strong>{fmt(usage.prompt_tokens_observed)}</strong></div>
          <div><small>Output Tokens المرصودة</small><strong>{fmt(usage.completion_tokens_observed)}</strong></div>
          <div><small>التكلفة الفعلية</small><strong>غير متاحة</strong></div>
        </div>
        <p className="v2-quality-muted">{usage.note||'عرض التوكنز يعتمد على دعم المزود لإحصائيات الاستخدام.'}</p>
        <h3 className="v2-quality-subtitle">تفاصيل نجاح أدوات الـ CRM</h3>
        <div className="v2-quality-tools">
          {(metrics?.tools||[]).map(t=><div key={t.name}><span dir="ltr">{t.name}</span><b>{t.success}/{t.total}</b></div>)}
          {!(metrics?.tools||[]).length&&<p className="v2-quality-muted">مفيش استدعاءات أدوات في الفترة المحددة.</p>}
        </div>
        <h3 className="v2-quality-subtitle">أسباب التدخل البشري</h3>
        <div className="v2-quality-tools">
          {(metrics?.handoff_reasons||[]).map(t=><div key={t.reason}><span>{t.reason}</span><b>{t.count}</b></div>)}
          {!(metrics?.handoff_reasons||[]).length&&<p className="v2-quality-muted">مفيش حالات تحويل مسجلة خلال الفترة.</p>}
        </div>
      </section>
    </div>
    <section className="v2-detail-card v2-expert-brain">
      <div className="v2-quality-section-head"><div><h3><BrainCircuit size={20}/> Recruitment Expert Brain</h3><p className="v2-quality-muted">معرفة عامة متخصصة في توظيف الدليفري، مع سيناريوهات مصرية افتراضية وتقديم بيانات المكتب الموثقة دائمًا على أي نصيحة عامة.</p></div>
      <div className="v2-expert-summary"><strong>{fmt(expert.topics)} موضوع</strong><strong>{fmt(expert.synthetic_examples)} صياغة تدريبية</strong></div></div>
      <div className="v2-expert-metrics">
        <span>إجابات الخبير في الفترة: <b>{fmt(expertMetrics.answers)}</b></span>
        <span>من مصدر مكتب معتمد: <b>{fmt(expertMetrics.office_verified)}</b></span>
        <span>إرشادات عامة: <b>{fmt(expertMetrics.general_guidance)}</b></span>
      </div>
      <details className="v2-expert-coverage">
        <summary>عرض مجالات المعرفة وأسئلة التدريب ({expert.categories?.length||0})</summary>
        <div className="v2-expert-topic-list">{(expert.categories||[]).map(t=><article key={t.id}>
          <strong>{t.label}</strong>
          <small>{fmt(t.examples)} صياغة · {t.policy==='office_verified'?'الشروط الخاصة بالمكتب تتطلب مصدرًا موثقًا':'إرشاد عام آمن'}</small>
          <p>{(t.examples_preview||[]).join(' · ')}</p>
        </article>)}</div>
      </details>
      <p className="v2-quality-muted">الأسئلة الحقيقية للمتقدمين مش بتتنقل للمكتبة دي تلقائيًا كحقائق. تصحيح المعلومات الخاصة بالمكتب يعتمد على إجابات الموظفين المراجعة ونظام المعرفة الحالي.</p>
    </section>
    <section className="v2-detail-card v2-quality-custom">
      <div className="v2-quality-section-head"><div><h3>حالات تقييم مخصصة للـ Planner</h3><p className="v2-quality-muted">اكتب سيناريو افتراضيًا والقرار المتوقع. التشغيل ده يحتاج LLM متصل، بخلاف الاختبارات الآلية المجانية فوق.</p></div></div>
      <form onSubmit={createCase} className="v2-quality-custom-form">
        <label>اسم السيناريو<input required minLength={2} maxLength={200} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})} placeholder="مثلاً: متقدم بيصحح منطقة الشغل"/></label>
        <label>رسالة افتراضية<textarea required minLength={2} maxLength={4000} rows={3} value={draft.input_text} onChange={e=>setDraft({...draft,input_text:e.target.value})} placeholder="استخدم أمثلة وهمية فقط، من غير أرقام تليفون أو بيانات حقيقية."/></label>
        <label>القرار المتوقع<select value={draft.expected_action} onChange={e=>setDraft({...draft,expected_action:e.target.value})}>
          <option value="">اختبار استكشافي بدون تقييم Pass/Fail</option>
          {['answer_question','save_facts','ask_next','clarify','recommend_area','compare_areas','change_answer','resume_flow','handoff','none'].map(x=><option value={x} key={x}>{x}</option>)}
        </select></label>
        <button type="submit" disabled={customBusy}>إضافة حالة الاختبار</button>
      </form>
      <div className="v2-quality-history v2-quality-custom-list">
      {(state?.quality?.cases||[]).slice(0,30).map(c=>{
        const last=(state?.quality?.recent_runs||[]).find(x=>x.case_id===c.id);
        return <div key={c.id}><span><strong>{c.title}</strong><small>{(c.tags||[]).join(' · ')}</small></span>
        <span>{!last?'لم تُختبر بعد':last.passed===true?'PASS':last.passed===false?'FAIL':'استكشافي'}</span>
        <button type="button" onClick={()=>runCase(c.id)} disabled={customBusy||!state.llm?.configured}>اختبار LLM</button>
        <button type="button" className="quality-remove" onClick={()=>deleteCase(c.id)} disabled={customBusy}>حذف</button>
        </div>;
      })}
      {!(state?.quality?.cases||[]).length&&<p className="v2-quality-muted">لا توجد حالات مخصصة محفوظة حتى الآن.</p>}
      </div>
    </section>
    <section className="v2-detail-card v2-quality-chart">
      <h3>نشاط الـ Agent اليومي</h3>
      <p className="v2-quality-muted">عدد الأدوار المسجلة يوميًا، ومش مؤشر على جودة الإجابة لوحده.</p>
      <div className="v2-quality-bars">{(metrics?.daily||[]).map(row=>{
        const max=Math.max(1,...(metrics?.daily||[]).map(x=>x.turns));
        return <div key={row.day}><span title={row.turns+' رسالة'} style={{height:Math.max(6,Math.round(row.turns/max*130))+'px'}}/><small>{row.day.slice(5)}</small><b>{row.turns}</b></div>;
      })}{!(metrics?.daily||[]).length&&<p className="v2-quality-muted">لسه مفيش بيانات كفاية للرسم.</p>}</div>
    </section>
  </div>;
}

function AgentPerformance(){
 const [days,setDays]=useState(7),[report,setReport]=useState(null),[pilotBusy,setPilotBusy]=useState(false);
 const [officeId,setOfficeId]=useState(''),[capacity,setCapacity]=useState(50);
 const [loading,setLoading]=useState(false),[error,setError]=useState('');
 const load=useCallback(async()=>{
  setLoading(true);
  try{const data=await api('/agent/performance?days='+days+(officeId?'&office_id='+encodeURIComponent(officeId):''));
   setReport(data);if(!officeId&&data.office_id)setOfficeId(data.office_id);setError('');}
  catch(e){setError(e.message);}
  finally{setLoading(false);}
 },[days,officeId]);
 useEffect(()=>{load();},[load]);
 useEffect(()=>{const selected=(report?.offices||[]).find(x=>x.id===officeId);
  if(selected?.pilot_capacity)setCapacity(selected.pilot_capacity);
 },[officeId,report?.offices]);
 const pilotAction=async active=>{
  if(!window.confirm(active
   ?('بدء مراقبة أول '+capacity+' متقدم جديد في المكتب المحدد؟ مش هيتم إرسال رسائل جماعية أو تغيير تشغيل البوت.')
   :'إيقاف متابعة التجربة؟ ده مش هيوقف البوت الأساسي.'))return;
  setPilotBusy(true);
  try{await send('/agent/pilot/'+(active?'start':'stop'),{office_id:officeId,...(active?{capacity}:{})});await load();setError('');}
  catch(e){setError(e.message);}
  finally{setPilotBusy(false);}
 };
 const pct=x=>x==null?'—':Number(x).toLocaleString('en-US',{maximumFractionDigits:1})+'%';
 const funnel=report?.funnel||{},volume=report?.volume||{},accuracy=report?.accuracy||{},pilot=report?.pilot;
 const pilotObservation=report?.pilot_observation;
 const office=(report?.offices||[]).find(x=>x.id===officeId);
 const officeReady=Boolean(officeId&&report?.office_id===officeId&&!loading);
 const offices=report?.offices||[];
 const counts=funnel.by_stage||{},cohort=report?.sample?.cohort_applicants||0;
 const cards=[
  {label:'تسجيلات جديدة',value:report?fmt(funnel.registered):'—',desc:'متقدمون أُنشئت ملفاتهم خلال الفترة'},
  {label:'إكمال بيانات التقديم',value:pct(funnel.completion_rate),desc:fmt(funnel.form_completed)+' ملفات مكتملة حاليًا، مش قبول أو تعيين'},
  {label:'متقدمون تفاعلوا',value:pct(funnel.engagement_rate),desc:fmt(funnel.engaged)+' متقدمين بعتوا رسالة خلال الفترة'},
  {label:'توقف أكثر من 24 ساعة',value:pct(funnel.stalled_rate),desc:fmt(funnel.stalled_24h)+' من غير المكتملين'},
  {label:'دقة المراجعة البشرية',value:pct(accuracy.accuracy_rate),desc:'لسه محتاجين تقييمات بشرية موثّقة'},
  {label:'زمن إكمال التقديم',value:volume.completion_duration_minutes==null?'غير متاح':fmt(volume.completion_duration_minutes)+' د',desc:'مش بنحسبه من وقت آخر تعديل على الملف'}
 ];
 return <div className="v2-agent-detail v2-pilot-performance">
  <div className="detail-head">
   <div><h2>أداء التوظيف والتجارب حسب المكتب</h2><p>لكل مكتب عينة مستقلة وتشغيل ومؤشرات منفصلة. متابعة الرسائل الواردة فقط؛ مش حملة مراسلات تلقائية.</p></div>
   <div className="v2-quality-controls">
    <label>المكتب <select value={officeId} onChange={e=>setOfficeId(e.target.value)}>{offices.map(x=><option value={x.id} key={x.id}>{x.name}</option>)}</select></label>
    <label>الفترة <select value={days} onChange={e=>setDays(Number(e.target.value))}><option value={1}>آخر يوم</option><option value={7}>آخر 7 أيام</option><option value={30}>آخر 30 يوم</option></select></label>
    <button type="button" onClick={load} disabled={loading}><RefreshCw size={16}/>{loading?'جارٍ التحميل':'تحديث'}</button>
   </div>
  </div>
  {error&&<div className="v2-error" role="alert">{error}</div>}
  {report?.partial_sample&&<div className="v2-quality-notice">عدد السجلات أكبر من حد القراءة؛ الأرقام المعروضة من عينة فقط، والنسب غير متاحة علشان ما تدّيش نتيجة مضللة.</div>}
  <div className="v2-pilot-stat-grid">{cards.map(x=><article key={x.label}><small>{x.label}</small><strong>{x.value}</strong><p>{x.desc}</p></article>)}</div>
  <div className="v2-pilot-panels">
   <section className="v2-detail-card">
    <h3><TrendingUp size={18}/> مراحل التقديم الحالية</h3>
    <p className="v2-quality-muted">النسب خاصة بالمتقدمين اللي اتسجلوا خلال الفترة المحددة، حسب حالتهم الحالية. دي مش نسب قبول التوظيف.</p>
    <div className="v2-pilot-bars">
    {[
     {key:'new',label:'جديد'},
     {key:'incomplete',label:'لم يكمل'},
     {key:'complete',label:'أكمل البيانات'},
     {key:'lecture',label:'المحاضرة'},
     {key:'working',label:'بدأ الشغل'},
     {key:'unknown',label:'حالة أخرى'}
    ].map(x=>{
     const n=counts[x.key]||0;
     return <div key={x.key}><div><span>{x.label}</span><b>{fmt(n)}</b></div><progress max={Math.max(1,cohort)} value={n}/></div>;
    })}
    </div>
   </section>
   <section className="v2-detail-card">
    <h3><Clock3 size={18}/> نشاط المحادثات</h3>
    <div className="v2-pilot-facts">
     <div><span>الرسائل الواردة من متقدمي الفترة</span><b>{fmt(volume.inbound_messages)}</b></div>
     <div><span>رسائل رد البوت</span><b>{fmt(volume.bot_messages)}</b></div>
     <div><span>متوسط الوارد لكل ملف</span><b>{volume.avg_inbound_per_applicant==null?'—':volume.avg_inbound_per_applicant}</b></div>
     <div><span>وسيط زمن تخطيط الـLLM</span><b>{volume.median_planner_latency_ms==null?'—':fmt(volume.median_planner_latency_ms)+' ms'}</b></div>
    </div>
    <p className="v2-quality-muted">زمن التخطيط مش مدة إكمال طلب التوظيف. الحالات القديمة أو البيانات غير المكتملة مش بنعوضها بتقديرات.</p>
   </section>
  </div>
  {report?.office_quality&&<section className="v2-detail-card">
   <h3><Activity size={18}/> جودة تشغيل الـAgent — {report.office_name}</h3>
   <div className="v2-pilot-facts">
    <div><span>أدوار الـAgent المرصودة</span><b>{fmt(report.office_quality.operational?.turns)}</b></div>
    <div><span>التحويل للتدخل البشري</span><b>{pct(report.office_quality.operational?.handoff_rate)}</b></div>
    <div><span>نجاح أدوات الـCRM</span><b>{pct(report.office_quality.operational?.tool_success_rate)}</b></div>
    <div><span>دقة الإجابات المعتمدة</span><b>—</b></div>
   </div>
   <p className="v2-quality-muted">النتائج للمكتب المختار فقط، ومن المحادثات المرصودة ضمن العينة. دقة الإجابات تحتاج مراجعة بشرية؛ عدم توفر قيمة مش معناه صفر أخطاء. {report.office_quality.sample?.truncated?'تنبيه: البيانات المعروضة عينة جزئية.':''}</p>
  </section>}
  <section className="v2-detail-card v2-office-pilot-directory">
   <div className="v2-quality-section-head"><div><h3><Briefcase size={19}/> مقارنة تجارب المكاتب</h3>
    <p>كل مكتب جديد يبدأ بدون تجربة مفعّلة. اضغط على المكتب علشان تظهر تفاصيله وتتحكم في عدد المتقدمين.</p>
   </div></div>
   <div className="v2-office-pilot-list">{offices.map(item=>
    <button type="button" key={item.id} onClick={()=>setOfficeId(item.id)} className={officeId===item.id?'selected':''}>
     <strong>{item.name}</strong>
     <span>{item.pilot_active?'شغالة':'متوقفة'}</span>
     <span>{fmt(item.enrolled)} / {fmt(item.pilot_capacity)}</span>
     <small>{item.linked_accounts} رقم واتساب نشط</small>
    </button>
   )}</div>
   {!offices.length&&<p className="v2-quality-muted">لسه مفيش مكاتب مسجلة. أضف مكتب واربط رقم واتساب من إدارة المكاتب.</p>}
  </section>
  <section className="v2-detail-card v2-pilot-observation">
   <div className="v2-quality-section-head">
    <div><h3><Users size={20}/> تجربة المكتب: {office?.name||'—'}</h3>
     <p>كل مكتب له تجربة محددة بعدد تختاره، بتبدأ فقط لما تفعلها. واتساب الوارد الجديد فقط، ومش هيأثر على باقي المكاتب.</p>
    </div>
    <strong className={pilotObservation?.active?'running':'inactive'}>{pilotObservation?.active?'المراقبة شغالة':'المراقبة متوقفة'}</strong>
   </div>
   <div className="v2-pilot-observation-stats">
    {[
     {label:'دخلوا التجربة',value:pilotObservation?fmt(pilotObservation.enrolled):'—',foot:'من أصل '+(pilotObservation?.capacity||capacity)},
     {label:'أماكن متبقية',value:pilotObservation?fmt(pilotObservation.remaining):'—',foot:'حد مستقل للمكتب'},
     {label:'أكملوا بياناتهم',value:fmt(pilotObservation?.form_completed),foot:'حالة البيانات الحالية'},
     {label:'احتاجوا تدخل موظف',value:fmt(pilotObservation?.staff_intervention_candidates),foot:'من متقدمي التجربة فقط'}
    ].map(x=><article key={x.label}><small>{x.label}</small><strong>{x.value}</strong><span>{x.foot}</span></article>)}
   </div>
   <div className="v2-office-pilot-selector">
    <label>عدد المتقدمين في التجربة <select value={capacity} disabled={pilotBusy||pilotObservation?.active} onChange={e=>setCapacity(Number(e.target.value))}>{[10,25,50,100,200].map(n=><option value={n} key={n}>{n} متقدم</option>)}</select></label>
    {office&&office.linked_accounts===0&&<span>اربط رقم واتساب نشط بالمكتب الأول علشان تقدر تبدأ.</span>}
    {office&&!office.agent_enabled&&<span>Agent المكتب متوقف حاليًا؛ شغّله من إعدادات المكتب الأول.</span>}
   </div>
   <div className="v2-pilot-actions">
    <button type="button" disabled={pilotBusy||!officeReady||!pilotObservation||pilotObservation.active||!office?.active||!office?.agent_enabled||!office?.linked_accounts} onClick={()=>pilotAction(true)}>
      <Play size={16}/> {pilotBusy?'جارٍ الحفظ':'بدء التجربة على الرسائل الجديدة'}
    </button>
    <button type="button" className="stop" disabled={pilotBusy||!officeReady||!pilotObservation||!pilotObservation.active} onClick={()=>pilotAction(false)}>
      <ShieldCheck size={16}/> إيقاف مراقبة التجربة
    </button>
   </div>
   <p className="v2-quality-muted">إيقاف متابعة المكتب ده لا يوقف البوت أو أي تجربة في مكتب تاني. لتغيير حجم العينة بعد البدء، أوقف المراقبة وابدأ تجربة جديدة. اللي خارج العينة يفضل على تشغيل البوت المعتاد.</p>
  </section>
  <section className="v2-detail-card v2-pilot-gate">
    <div className="v2-quality-section-head">
     <div><h3><ShieldCheck size={20}/> ضوابط التشغيل المتقدم</h3><p>متابعة المكتب الحالي منفصلة عن باقي المكاتب. إرسال حملات استباقية أو تغيير طريقة توظيف المتقدمين مش جزء من التجربة.</p></div>
     <strong>التوسع التلقائي غير مفعّل</strong>
    </div>
    <div className="v2-pilot-checks">{(pilot?.checks||[]).map(c=><div key={c.id}>
     {c.ready?<CheckCircle2 size={18} className="ready"/>:<Clock3 size={18}/>}
     <span>{c.label}</span><b>{c.ready?'متحقق':'لم يُتحقق بعد'}</b>
    </div>)}</div>
    <p className="v2-quality-muted">القائمة دي تخص المراسلة الاستباقية والتوسع غير المقيد. تشغيل متابعة مكتب جديد من زر التجربة مش هيبعت رسائل إضافية؛ وكل مكتب جديد يبدأ متوقف افتراضيًا.</p>
    <a href="https://supabase.com/dashboard/project/oflepwasoawmuspxgnal/database/backups" target="_blank" rel="noreferrer">مراجعة إعدادات Backup في Supabase</a>
  </section>
  <section className="v2-detail-card">
    <h3>تسجيلات كل يوم</h3>
    <p className="v2-quality-muted">توزيع حسب يوم إنشاء الملف، واكتمال البيانات حسب الحالة الحالية، مش تاريخ الإكمال الفعلي.</p>
    <div className="v2-pilot-days">{(report?.daily_cohort||[]).map(d=><div key={d.day}><small>{d.day}</small><span>سجّل {d.registered}</span><strong>مكتمل حاليًا {d.currently_completed}</strong></div>)}
    {!(report?.daily_cohort||[]).length&&<p className="v2-quality-muted">لا توجد بيانات في الفترة المختارة.</p>}</div>
  </section>
 </div>;
}

function AgentSettings({state,reload,action}){
  const [form,setForm]=useState({...state.settings}),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>setForm({...state.settings}),[state.settings]);
  const save=async e=>{e.preventDefault();setBusy(true);const fn=async()=>{await send('/agent/settings',form,'PUT');await reload();};try{if(action)await action(fn,'تم حفظ إعدادات AI Agent');else await fn();setError('');}catch(err){setError(err.message);}finally{setBusy(false);}};
  return <div className="v2-agent-detail"><div className="detail-head"><div><h2>إعدادات AI Agent</h2><p>التحكم في الـLLM والذاكرة وطريقة الرد من مكان واحد.</p></div></div>{error&&<div className="v2-error">{error}</div>}<form className="v2-settings-grid" onSubmit={save}><section className="v2-detail-card"><h3><Cpu/> LLM Brain</h3><label className="check"><input type="checkbox" checked={form.agent_llm_enabled===true} disabled={!state.llm?.configured} onChange={e=>setForm({...form,agent_llm_enabled:e.target.checked})}/> تشغيل عقل LLM</label><label>وضع التشغيل<select value={form.agent_llm_mode||'shadow'} onChange={e=>setForm({...form,agent_llm_mode:e.target.value})}><option value="shadow">Shadow</option><option value="assist">Assist</option><option value="live">Live</option></select></label><label>Provider<input value={form.agent_llm_provider||''} onChange={e=>setForm({...form,agent_llm_provider:e.target.value})}/></label><label>Model<input value={form.agent_llm_model||''} onChange={e=>setForm({...form,agent_llm_model:e.target.value})}/></label></section><section className="v2-detail-card"><h3><Gauge/> Decision Control</h3><label>درجة الحرارة<input type="number" step=".05" min="0" max="1" value={form.agent_llm_temperature??.2} onChange={e=>setForm({...form,agent_llm_temperature:Number(e.target.value)})}/></label><label>مهلة الاستجابة ms<input type="number" min="1000" max="30000" value={form.agent_llm_timeout_ms||10000} onChange={e=>setForm({...form,agent_llm_timeout_ms:Number(e.target.value)})}/></label><label>حد ثقة الـPlanner<input type="number" step=".01" min=".5" max=".95" value={form.agent_planner_confidence_threshold??.72} onChange={e=>setForm({...form,agent_planner_confidence_threshold:Number(e.target.value)})}/></label><label>عدد رسائل السياق<input type="number" min="4" max="30" value={form.agent_context_messages||12} onChange={e=>setForm({...form,agent_context_messages:Number(e.target.value)})}/></label></section><section className="v2-detail-card"><h3><Database/> Memory</h3><label className="check"><input type="checkbox" checked={form.agent_hybrid_memory_enabled!==false} onChange={e=>setForm({...form,agent_hybrid_memory_enabled:e.target.checked})}/> ذاكرة هجينة</label><label className="check"><input type="checkbox" checked={form.agent_llm_rerank_enabled!==false} onChange={e=>setForm({...form,agent_llm_rerank_enabled:e.target.checked})}/> إعادة ترتيب المعرفة</label><label className="check"><input type="checkbox" checked={form.agent_fact_extraction_enabled!==false} onChange={e=>setForm({...form,agent_fact_extraction_enabled:e.target.checked})}/> استخراج Facts</label><label className="check"><input type="checkbox" checked={form.agent_next_best_action_enabled!==false} onChange={e=>setForm({...form,agent_next_best_action_enabled:e.target.checked})}/> Next Best Action</label></section><section className="v2-detail-card wide"><h3><MessageCircle/> أسلوب الرد</h3><label>النبرة<input value={form.agent_tone||'egyptian_natural'} onChange={e=>setForm({...form,agent_tone:e.target.value})}/></label><label>تعليمات النظام<textarea rows={6} value={form.agent_system_instructions||''} onChange={e=>setForm({...form,agent_system_instructions:e.target.value})}/></label><label>Fallback<textarea rows={3} value={form.ai_fallback||''} onChange={e=>setForm({...form,ai_fallback:e.target.value})}/></label></section><button className="v2-save" disabled={busy}><Settings2 size={17}/> {busy?'جارٍ الحفظ...':'حفظ الإعدادات'}</button></form></div>;
}

function AgentDecisions({state}){
  return <div className="v2-agent-detail"><div className="detail-head"><div><h2>آخر نشاطات العقل</h2><p>كل القرارات المسجلة مع الثقة والسرعة وطريقة التخطيط.</p></div></div><div className="v2-decision-table"><div className="head"><span>الوقت</span><span>المدخل</span><span>القرار</span><span>الوضع</span><span>الثقة</span></div>{(state.decisions||[]).slice(0,50).map(d=><div key={d.id}><span>{date(d.created_at)}</span><span>{d.input_text||'—'}</span><span>{d.action||'—'}</span><span>{d.planner_mode||'—'}</span><span>{d.confidence==null?'—':Math.round(n(d.confidence)*100)+'%'}</span></div>)}</div></div>;
}

export function ReferenceAIAgentPage({action}){
  const [state,setState]=useState(null),[view,setView]=useState('dashboard'),[error,setError]=useState('');
  const load=useCallback(async()=>{try{setState(await api('/agent'));setError('');}catch(e){setError(e.message);}},[]);
  useEffect(()=>{load();},[load]);
  if(!state)return <div className="v2-agent-loading"><BrainCircuit size={44}/><strong>جارٍ تشغيل AI Agent...</strong>{error&&<small>{error}</small>}</div>;
  return <div className="v2-page v2-agent">
    <section className="v2-hero v2-agent-hero"><div className="v2-hero-copy"><h1>الوكيل الذكي</h1><p>إدارة وتدريب ومتابعة أداء الوكيل الذكي داخل المنصة</p></div><img src="/reference/hero-rider.webp" alt="" aria-hidden="true"/></section>
    <div className="v2-agent-toolbar"><button className={view==='dashboard'?'active':''} onClick={()=>setView('dashboard')}><BrainCircuit/> الرئيسية</button><button className={view==='knowledge'?'active':''} onClick={()=>setView('knowledge')}><Database/> المعرفة</button><button className={view==='decisions'?'active':''} onClick={()=>setView('decisions')}><Activity/> القرارات</button><button className={view==='test'?'active':''} onClick={()=>setView('test')}><Play/> التدريب</button><button className={view==='quality'?'active':''} onClick={()=>setView('quality')}><ShieldCheck/> مركز الجودة</button><button className={view==='performance'?'active':''} onClick={()=>setView('performance')}><TrendingUp/> الأداء والتجربة</button><button className={view==='settings'?'active':''} onClick={()=>setView('settings')}><Settings2/> الإعدادات</button><span className={'v2-agent-state '+(state.llm?.configured?'on':'')}><i/>{state.llm?.configured?'LLM READY':'CORE ACTIVE'}</span></div>
    {error&&<div className="v2-error">{error}<button onClick={load}><RefreshCw size={15}/> إعادة المحاولة</button></div>}
    {view==='dashboard'&&<AgentDashboard state={state} onView={setView}/>}
    {view==='knowledge'&&<AgentKnowledge state={state} reload={load}/>}
    {view==='test'&&<AgentTest state={state}/>}
    {view==='quality'&&<AgentQualityCenter state={state} reload={load} onReviewKnowledge={()=>setView('knowledge')}/>}
    {view==='performance'&&<AgentPerformance/>}
    {view==='settings'&&<AgentSettings state={state} reload={load} action={action}/>}
    {view==='decisions'&&<AgentDecisions state={state}/>}
  </div>;
}
