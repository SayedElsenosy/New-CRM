import {useCallback,useEffect,useMemo,useState} from 'react';
import {
  Activity,ArrowLeft,BarChart3,BellRing,BookOpen,BrainCircuit,CalendarDays,
  CheckCircle2,ClipboardCheck,Cpu,Database,FileText,Gauge,Globe2,MessageCircle,
  Megaphone,Play,Plus,RefreshCw,Search,Send,Settings2,ShieldCheck,Sparkles,
  Target,Users,Zap
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

function MetricCard({title,value,caption,Icon,tone='cyan'}){
  return <article className={'v2-metric '+tone}>
    <span className="v2-metric-icon"><Icon size={27}/></span>
    <div><small>{title}</small><strong>{value}</strong><em>{caption}</em></div>
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

export function ReferenceOverviewPage({version=0,officeId='',alerts={},onAlert,onTab,onSelect}){
  const [data,setData]=useState(null),[error,setError]=useState('');
  const load=useCallback(async()=>{try{const p=new URLSearchParams();if(officeId)p.set('office_id',officeId);setData(await api('/dashboard'+(p.toString()?'?'+p:'')));setError('');}catch(e){setError(e.message);}},[officeId]);
  useEffect(()=>{load();},[load,version]);
  const metrics=data?.metrics||{},areas=data?.area_distribution||[],recent=data?.recent||[];
  return <div className="v2-page v2-dashboard">
    <section className="v2-hero v2-dashboard-hero">
      <div className="v2-hero-copy"><h1>لوحة التحكم</h1><p>متابعة وإدارة توظيف الطيارين والكادر اللوجستي بسهولة</p></div>
      <img src="/reference/hero-rider.webp" alt="" aria-hidden="true"/>
    </section>
    {error&&<div className="v2-error">{error}<button onClick={load}><RefreshCw size={15}/> إعادة المحاولة</button></div>}
    <div className="v2-metrics">
      <MetricCard title="إجمالي الطيارين" value={fmt(metrics.total)} caption="كل الطلبات المسجلة" Icon={Users}/>
      <MetricCard title="طلبات جديدة" value={fmt(metrics.new_today)} caption="طلبات اليوم" Icon={ClipboardCheck} tone="orange"/>
      <MetricCard title="الطيارون النشطون" value={fmt(metrics.active_candidates)} caption="داخل مسار التوظيف" Icon={Activity}/>
      <MetricCard title="مقابلات اليوم" value={fmt(metrics.interviews_today)} caption="المواعيد المجدولة" Icon={CalendarDays} tone="orange"/>
    </div>
    <div className="v2-middle">
      <section className="v2-panel v2-performance">
        <header><div><h2>أداء التوظيف</h2><p>نمو الطلبات خلال آخر 6 أشهر</p></div><button onClick={load}><RefreshCw size={14}/> آخر 30 يوم</button></header>
        <LineChart data={data?.growth||[]}/>
      </section>
      <section className="v2-panel v2-geo">
        <header><div><h2>التوزيع الجغرافي</h2><p>أكثر المناطق من حيث الطيارين</p></div><span className="live">LIVE</span></header>
        <div className="v2-geo-body">
          <div className="v2-map"><img src="/reference/geo-map.webp" alt="خريطة توزيع الطيارين"/></div>
          <div className="v2-ranking"><strong>أكثر المناطق من حيث الطيارين</strong>{areas.slice(0,5).map((x,i)=><div key={x.name}><span><i className={i%2?'cyan':'orange'}/>{x.name}</span><b>{fmt(x.count)}</b></div>)}{!areas.length&&<small>لسه مفيش بيانات مناطق كفاية</small>}</div>
        </div>
      </section>
    </div>
    <div className="v2-bottom">
      <section className="v2-panel v2-alerts">
        <header><div><h2>التنبيهات</h2><p>الحالات اللي محتاجة متابعة</p></div><span className="count">{alerts.open_count||0}</span></header>
        {(alerts.items||[]).slice(0,4).length?<div className="v2-alert-list">{alerts.items.slice(0,4).map((item,i)=><button key={item.id} onClick={()=>onAlert?.(item)}><span className={'ico tone-'+i}><BellRing size={16}/></span><div><strong>{item.applicant_name||'متقدم يحتاج متابعة'}</strong><small>{item.body||'افتح الحالة لمراجعتها'} · {date(item.created_at)}</small></div><ArrowLeft size={14}/></button>)}</div>:<div className="v2-empty"><CheckCircle2 size={28}/><strong>مفيش تنبيهات مفتوحة</strong><small>كل الحالات تحت السيطرة.</small></div>}
      </section>
      <section className="v2-panel v2-recent">
        <header><div><h2>أحدث المتقدمين</h2><p>آخر الطلبات المسجلة</p></div><button className="link" onClick={()=>onTab?.('applicants')}>عرض الكل <ArrowLeft size={14}/></button></header>
        <RecentApplicants items={recent} onSelect={onSelect}/>
      </section>
      <section className="v2-panel v2-actions">
        <header><div><h2>إجراءات سريعة</h2><p>أكثر العمليات استخدامًا</p></div><Zap size={19}/></header>
        <button className="action orange" onClick={()=>onTab?.('applicants')}><Plus/><div><strong>إضافة طيار</strong><small>إضافة طلب طيار جديد للنظام</small></div><Users/></button>
        <button className="action cyan" onClick={()=>onTab?.('campaigns')}><ArrowLeft/><div><strong>إنشاء إعلان</strong><small>نشر وإدارة حملات التوظيف</small></div><Megaphone/></button>
        <div className="action-pair"><button onClick={()=>onTab?.('interviews')}><CalendarDays/><span>جدولة مقابلة</span></button><button onClick={()=>onTab?.('applicants')}><FileText/><span>استيراد بيانات</span></button></div>
      </section>
    </div>
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
