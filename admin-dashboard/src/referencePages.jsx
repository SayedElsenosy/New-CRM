import {useCallback,useEffect,useMemo,useState} from 'react';
import {
  Activity,ArrowLeft,BarChart3,BellRing,BookOpen,BrainCircuit,CalendarDays,
  CheckCircle2,ClipboardCheck,Cpu,Database,FileText,Gauge,Globe2,MessageCircle,
  Megaphone,Play,Plus,RefreshCw,Search,Send,Settings2,ShieldCheck,Sparkles,
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
  const clean=data.length?data:[{label:'مايو',count:0,accepted:0},{label:'يونيو',count:0,accepted:0},{label:'يوليو',count:0,accepted:0},{label:'أغسطس',count:0,accepted:0},{label:'سبتمبر',count:0,accepted:0},{label:'أكتوبر',count:0,accepted:0}];
  const width=620,height=220,padX=36,padTop=24,padBottom=38;
  const max=Math.max(1,...clean.flatMap(x=>[n(x.count),n(x.accepted)]));
  const step=clean.length>1?(width-padX*2)/(clean.length-1):0,usable=height-padTop-padBottom;
  const pts=key=>clean.map((d,i)=>({x:padX+i*step,y:padTop+usable-(n(d[key])/max)*usable,label:d.label||String(d.key||'')}));
  const a=pts('count'),b=pts('accepted'),poly=x=>x.map(p=>p.x+','+p.y).join(' ');
  const area=x=>x.length?padX+','+(height-padBottom)+' '+poly(x)+' '+x.at(-1).x+','+(height-padBottom):'';
  return <div className="v2-chart"><div className="v2-chart-legend"><span className="orange">طلبات التوظيف</span><span className="cyan">المقبولين</span></div>
    <svg viewBox={'0 0 '+width+' '+height} role="img" aria-label="أداء التوظيف">
      {[0,.25,.5,.75,1].map((r,i)=><line key={i} x1={padX} x2={width-padX} y1={padTop+usable*r} y2={padTop+usable*r} className="grid"/>)}
      <polygon points={area(a)} className="area orange"/><polygon points={area(b)} className="area cyan"/>
      <polyline points={poly(a)} className="line orange"/><polyline points={poly(b)} className="line cyan"/>
      {a.map((p,i)=><g key={i}><circle cx={p.x} cy={p.y} r="4.3" className="point orange"/><text x={p.x} y={height-12} textAnchor="middle">{p.label}</text></g>)}
      {b.map((p,i)=><circle key={'b'+i} cx={p.x} cy={p.y} r="3.5" className="point cyan"/>)}
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
  const top=areas.slice(0,4),max=Math.max(1,...top.map(x=>n(x.count)));
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

  return <div className="v2-page webv2-home">
    <section className="webv2-hero">
      <div className="webv2-hero-art" aria-hidden="true"><img src="/reference/hero-rider.webp" alt=""/></div>
      <div className="webv2-hero-copy">
        <span className="eyebrow">مساحة العمل اليومية</span>
        <h1>أهلًا {profileName.split(' ')[0]||'سيد'}، خلّينا نبدأ يومك.</h1>
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
      <MetricCard title="نسبة الدقة" value={a.avg_confidence_24h==null?'—':Math.round(n(a.avg_confidence_24h))+'%'} caption="متوسط الثقة" Icon={Target}/>
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
  const items=(state.knowledge||[]).filter(x=>!q||((x.question||'')+' '+(x.answer||'')).toLowerCase().includes(q.toLowerCase()));
  const add=async e=>{e.preventDefault();setBusy(true);try{await send('/intelligence/knowledge',{question:form.question,answer:form.answer,keywords:form.keywords.split(/[،,]/).map(x=>x.trim()).filter(Boolean),active:true});setForm({question:'',answer:'',keywords:''});await reload();setError('');}catch(err){setError(err.message);}finally{setBusy(false);}};
  return <div className="v2-agent-detail"><div className="detail-head"><div><h2>مخزن المعرفة</h2><p>كل المعلومات اللي يقدر الـAgent يرجع لها في الرد والقرار.</p></div><div className="search"><Search size={16}/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="ابحث في المعرفة..."/></div></div>{error&&<div className="v2-error">{error}</div>}<div className="v2-knowledge-layout"><form className="v2-detail-card" onSubmit={add}><h3>إضافة مصدر معرفة</h3><label>السؤال أو الموضوع<input required value={form.question} onChange={e=>setForm({...form,question:e.target.value})}/></label><label>الإجابة<textarea required rows={6} value={form.answer} onChange={e=>setForm({...form,answer:e.target.value})}/></label><label>كلمات مفتاحية<input value={form.keywords} onChange={e=>setForm({...form,keywords:e.target.value})} placeholder="مرتب، منطقة، مواعيد"/></label><button disabled={busy}><Plus size={15}/> {busy?'جارٍ الإضافة...':'إضافة للمعرفة'}</button></form><div className="v2-knowledge-list">{items.map(k=><article key={k.id}><div><span>{k.knowledge_scope||'office'}</span><em>{k.memory_status||'verified'}</em></div><h3>{k.question}</h3><p>{k.answer}</p><footer><span>ثقة {Math.round(n(k.confidence||.8)*100)}%</span><span>{fmt(k.usage_count)} استخدام</span></footer></article>)}{!items.length&&<div className="v2-empty">مفيش نتائج.</div>}</div></div></div>;
}

function AgentTest({state}){
  const [text,setText]=useState(''),[result,setResult]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const run=async e=>{e.preventDefault();setBusy(true);try{setResult(await send('/agent/test-plan',{text}));setError('');}catch(err){setError(err.message);setResult(null);}finally{setBusy(false);}};
  return <div className="v2-agent-detail"><div className="detail-head"><div><h2>تدريب واختبار الوكيل</h2><p>جرّب رسالة حقيقية قبل ما تغيّر وضع التشغيل.</p></div></div>{error&&<div className="v2-error">{error}</div>}<div className="v2-test-grid"><form className="v2-detail-card" onSubmit={run}><label>رسالة المتقدم<textarea required rows={9} value={text} onChange={e=>setText(e.target.value)} placeholder="مثال: أنا من مدينة العبور ومعايا مكنة وعايز أعرف أنهي منطقة أفضل..."/></label><button disabled={busy||!state.llm?.configured}><Play size={15}/> {busy?'جارٍ التحليل...':'حلّل الرسالة'}</button>{!state.llm?.configured&&<small>الـLLM Provider غير متصل حاليًا؛ الاختبار هيتفعل بعد إضافة بيانات المزود.</small>}</form><section className="v2-detail-card result"><h3>نتيجة الـPlanner</h3>{result?.plan?<><strong>{result.plan.action} · {Math.round(n(result.plan.confidence)*100)}%</strong><p>{result.plan.summary||'—'}</p><pre>{JSON.stringify(result.plan,null,2)}</pre></>:<div className="v2-empty">نتيجة الاختبار هتظهر هنا.</div>}</section></div></div>;
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
    <div className="v2-agent-toolbar"><button className={view==='dashboard'?'active':''} onClick={()=>setView('dashboard')}><BrainCircuit/> الرئيسية</button><button className={view==='knowledge'?'active':''} onClick={()=>setView('knowledge')}><Database/> المعرفة</button><button className={view==='decisions'?'active':''} onClick={()=>setView('decisions')}><Activity/> القرارات</button><button className={view==='test'?'active':''} onClick={()=>setView('test')}><Play/> التدريب</button><button className={view==='settings'?'active':''} onClick={()=>setView('settings')}><Settings2/> الإعدادات</button><span className={'v2-agent-state '+(state.llm?.configured?'on':'')}><i/>{state.llm?.configured?'LLM READY':'CORE ACTIVE'}</span></div>
    {error&&<div className="v2-error">{error}<button onClick={load}><RefreshCw size={15}/> إعادة المحاولة</button></div>}
    {view==='dashboard'&&<AgentDashboard state={state} onView={setView}/>}
    {view==='knowledge'&&<AgentKnowledge state={state} reload={load}/>}
    {view==='test'&&<AgentTest state={state}/>}
    {view==='settings'&&<AgentSettings state={state} reload={load} action={action}/>}
    {view==='decisions'&&<AgentDecisions state={state}/>}
  </div>;
}
