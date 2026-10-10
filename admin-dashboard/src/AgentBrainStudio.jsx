import {useMemo,useState} from 'react';
import {
 BrainCircuit,BookOpen,Database,Activity,Cpu,ShieldCheck,Network,
 RefreshCw,ArrowLeft,Clock3,Zap,GitBranch,AlertTriangle,CheckCircle2
} from 'lucide-react';
import './AgentBrainStudio.css';

const number=value=>Number.isFinite(Number(value))?Number(value):0;
const format=value=>number(value).toLocaleString('en-US');
const percent=value=>value===null||value===undefined?'—':number(value)+'%';
const dateLabel=value=>{
 const d=new Date(value||'');
 return Number.isNaN(d.getTime())?'بدون وقت':d.toLocaleString('ar-EG',{dateStyle:'short',timeStyle:'short'});
};
const short=(value,max=100)=>String(value||'').slice(0,max);
const ACTION_LABELS={
 ask_next:'سؤال متابعة',answer_question:'الرد على سؤال',save_facts:'حفظ معلومات',
 compare_places:'مقارنة مناطق العمل',compare_places_followup:'استكمال المقارنة',
 compare_area_modes:'مقارنة أنظمة الشغل',explain_area_mode:'شرح تفاصيل وظيفة',
 handoff:'تحويل لموظف',clarify:'طلب توضيح',historical_residence_recall:'استرجاع من الذاكرة',
 ask_question:'سؤال للمتقدم',qualification:'تقييم التأهيل',stop:'إيقاف الرد'
};
const MODE_LABELS={llm_assist:'LLM مساعد',llm_live:'LLM مباشر',deterministic:'قواعد النظام',fallback:'خطة احتياطية'};
const readableAction=value=>ACTION_LABELS[String(value||'')]||short(value||'قرار غير مصنف',52);
const readableMode=value=>MODE_LABELS[String(value||'')]||short(value||'غير محدد',36);
const NODES=Array.from({length:100},(_,i)=>{
 const theta=i*2.399963229728653,rad=Math.sqrt((i+.5)/100);
 return {x:500+Math.cos(theta)*190*rad,y:282+Math.sin(theta)*120*rad,r:i%9===0?3.1:1.5,delay:(i%13)*.24};
});
const EDGES=NODES.map((node,i)=>({
 from:node,to:NODES[(i*7+17)%NODES.length],id:'edge-'+i
})).filter((edge,i)=>i%2===0&&Math.abs(edge.from.x-edge.to.x)<135&&Math.abs(edge.from.y-edge.to.y)<90);
const MODULE_META=[
 {key:'memory',title:'المعرفة والذاكرة',Icon:Database,view:'knowledge'},
 {key:'context',title:'سياق المحادثات',Icon:GitBranch,view:'knowledge'},
 {key:'decisions',title:'مسار القرارات',Icon:Activity,view:'decisions'},
 {key:'llm',title:'عقل LLM',Icon:Cpu,view:'settings'},
 {key:'quality',title:'الحماية والجودة',Icon:ShieldCheck,view:'quality'},
 {key:'performance',title:'الأداء والاستجابة',Icon:Zap,view:'performance'}
];
export function brainStudioModules(state={}){
 const stats=state.stats||{},a=state.agent_stats||{},llm=state.llm||{},settings=state.settings||{},quality=state.quality||{};
 return {
  memory:{
   metric:format(stats.active),unit:'معلومة نشطة',
   description:'المعلومات المسجلة والمشتركة التي يستخدمها الـAgent. تقدر تبحث فيها وتراجع حالتها من صفحة المعرفة.',
   rows:[['Shared Brain',format(stats.shared_breadfast)+' معلومة'],
    ['تعارضات المعرفة',format(stats.conflicts)],['معلومات قديمة',format(stats.stale)],
    ['استخدامات المعرفة',format(stats.usage)]]
  },
  context:{
   metric:settings.agent_hybrid_memory_enabled===false?'معطلة':'مفعّلة',
   unit:'الذاكرة الهجينة',
   description:'سجل الرسائل الكامل موجود داخل محادثات المتقدمين، مع فهرسة واسترجاع حسب السياق. لا تعرض هذه الشاشة نصوص المتقدمين أو تدّعي قراءة كل المحادثات لحظيًا.',
   rows:[['الرسائل الحديثة للـPlanner',settings.agent_context_messages==null?'—':format(settings.agent_context_messages)],
    ['استخراج الحقائق',settings.agent_fact_extraction_enabled===false?'غير مفعّل':'مفعّل'],
    ['التعامل مع الذاكرة',settings.agent_hybrid_memory_enabled===false?'غير مفعّل':'مفعّل']]
  },
  decisions:{
   metric:format(a.decisions_24h),unit:'قرار مسجل · 24 ساعة',
   description:'ملخص آخر القرارات المسجلة في قاعدة البيانات مع أنماط اتخاذ القرار وسجل التدقيق.',
   rows:[['قرارات LLM',format(a.llm_decisions_24h)],['متوسط الثقة',percent(a.avg_confidence_24h)],
    ['معدل الرجوع لخطة احتياطية',percent(a.fallback_rate_24h)],['قرارات 30 يوم',format(stats.turns_30d)]]
  },
  llm:{
   metric:llm.configured?(llm.enabled?'متصل ومفعّل':'متصل غير مفعّل'):'غير متصل',
   unit:llm.model||'LLM Provider',
   description:'الحالة الحقيقية لمزود النموذج وإعداداته. شكل الشبكة العصبية لا يمثل ما يحدث داخل النموذج فعليًا.',
   rows:[['الموديل',llm.model||settings.agent_llm_model||'غير محدد'],
    ['وضع التشغيل',settings.agent_llm_mode||'—'],
    ['LLM Enabled',llm.enabled?'نعم':'لا'],
    ['درجة حرارة الرد',settings.agent_llm_temperature??'—']]
  },
  quality:{
   metric:format(stats.conflicts),unit:'تعارض معرفة',
   description:'مراجعة تعارض المعلومات واختبارات الجودة قبل اعتماد الإجابات أو تعديل منطق الرد.',
   rows:[['حالات اختبار الجودة',format((quality.cases||[]).length)],
    ['تشغيلات الاختبار المسجلة',format((quality.recent_runs||[]).length)],
    ['معلومات قديمة',format(stats.stale)],
    ['تحويلات للموظفين · 30 يوم',format(stats.handoffs_30d)]]
  },
  performance:{
   metric:percent(stats.autonomy_rate_30d),unit:'معدل الاستقلال · 30 يوم',
   description:'أرقام مستمدة من سجل نشاط النظام، وليست قياسًا لذكاء النموذج أو وعيه.',
   rows:[['قرارات آخر 24 ساعة',format(a.decisions_24h)],
    ['متوسط زمن LLM',a.avg_latency_ms==null?'—':format(a.avg_latency_ms)+' ms'],
    ['معدل الرجوع الاحتياطي',percent(a.fallback_rate_24h)],
    ['إجمالي قرارات 30 يوم',format(stats.turns_30d)]]
  }
 };
}
function NeuralCore({activity=0}){
 const energy=Math.min(5,Math.max(1,Math.round(Math.log2(number(activity)+1))));
 return <svg className="abs-brain-art" viewBox="0 0 1000 570" preserveAspectRatio="xMidYMid meet" role="img" aria-label="رسم متحرك توضيحي لشبكة عصبية رقمية، وليس تمثيلًا مباشرًا لعمل النموذج">
  <defs>
   <radialGradient id="abs-pulse"><stop offset="0" stopColor="#45d9ff" stopOpacity=".23"/><stop offset=".58" stopColor="#1388e8" stopOpacity=".075"/><stop offset="1" stopColor="#003458" stopOpacity="0"/></radialGradient>
   <linearGradient id="abs-brain-fill" x1="0" x2="1" y1="0" y2="1"><stop stopColor="#113c62" stopOpacity=".6"/><stop offset=".48" stopColor="#0b5b86" stopOpacity=".26"/><stop offset="1" stopColor="#031e34" stopOpacity=".6"/></linearGradient>
   <linearGradient id="abs-brain-trace" x1="0" x2="1"><stop stopColor="#167ba9"/><stop offset=".45" stopColor="#95f3ff"/><stop offset="1" stopColor="#39bbf1"/></linearGradient>
   <filter id="abs-glow"><feGaussianBlur stdDeviation="6"/></filter>
  </defs>
  <g className="abs-background-grid">{Array.from({length:13},(_,i)=><line key={'h'+i} x1="0" y1={i*48} x2="1000" y2={i*48}/>)}
   {Array.from({length:23},(_,i)=><line key={'v'+i} x1={i*45} y1="0" x2={i*45} y2="570"/>)}</g>
  <circle cx="500" cy="277" r="258" fill="url(#abs-pulse)" className="abs-pulse" style={{animationDuration:(8-energy*.6)+'s'}}/>
  {[185,237,289].map((r,i)=><ellipse key={r} cx="500" cy="280" rx={r+65} ry={r*.55} fill="none" className={'abs-orbit abs-orbit-'+i}/>)}
  <g className="abs-spokes">
   {MODULE_META.map((m,i)=>{
    const a=(-152+i*56)*Math.PI/180;
    const x=500+Math.cos(a)*395,y=282+Math.sin(a)*217;
    const bx=500+Math.cos(a)*170,by=282+Math.sin(a)*110;
    return <g key={m.key}><path d={'M '+bx+' '+by+' Q '+(500+Math.cos(a)*265)+' '+(282+Math.sin(a)*25)+' '+x+' '+y} className="abs-synapse"/><circle cx={x} cy={y} r="3" className="abs-spoke-dot"/></g>;
   })}
  </g>
  <g className="abs-brain-shape">
   <path d="M494 150 C475 119 445 126 428 133 C387 105 352 143 348 160 C314 162 295 187 307 220 C278 245 291 280 310 290 C292 326 318 365 346 367 C348 395 375 409 397 404 C427 431 459 407 479 395 C489 426 496 435 498 451 C504 435 506 421 512 397 C545 420 574 417 594 396 C626 405 648 388 655 368 C690 363 700 323 679 296 C709 274 703 243 685 224 C697 198 673 166 653 164 C633 130 602 120 570 134 C536 112 515 128 494 150 Z" fill="url(#abs-brain-fill)" stroke="url(#abs-brain-trace)" strokeWidth="2.2"/>
   <path d="M496 145 Q486 235 497 282 Q509 359 498 447" fill="none" stroke="#90f7ff" strokeWidth="1.7" opacity=".78"/>
   <path d="M390 154 C411 184 385 197 416 224 S447 266 429 287 S399 335 431 365 M344 212 Q386 240 359 279 Q350 311 390 317 M454 160 Q438 203 459 214 T451 289 Q467 315 454 352 M611 150 Q582 188 608 215 Q639 243 607 275 Q583 302 604 344 M665 214 Q627 243 660 275 Q680 310 628 334 M547 150 Q564 190 544 216 T561 293 Q574 320 546 366" stroke="#62defe" fill="none" strokeWidth="1.8" opacity=".72"/>
   <path d="M453 390 C448 430 457 452 481 450 C497 488 523 493 550 451 L544 400 M481 449 C470 467 471 487 489 508 Q512 520 539 492" stroke="#33bfe8" strokeWidth="1.7" fill="none" opacity=".78"/>
  </g>
  <g className="abs-neural-edges">{EDGES.map(edge=><line key={edge.id} x1={edge.from.x} y1={edge.from.y} x2={edge.to.x} y2={edge.to.y}/>)}</g>
  <g className="abs-neural-nodes">{NODES.map((dot,i)=><circle key={i} cx={dot.x} cy={dot.y} r={dot.r} style={{animationDelay:dot.delay+'s'}}/>)}</g>
  <g className="abs-core-glow"><circle cx="500" cy="282" r="48" filter="url(#abs-glow)"/><circle cx="500" cy="282" r="30"/></g>
  <g className="abs-core-badge"><circle cx="500" cy="282" r="52"/><circle cx="500" cy="282" r="39"/><path d="M479 280c-12-17 10-28 20-12 10-16 31-5 22 12 12 16-10 28-20 14-10 14-31 2-22-14Z" fill="none" stroke="#bcf9ff" strokeWidth="2"/><path d="M499 266v32 M483 282h34" stroke="#a6f7ff" strokeWidth="1.2"/></g>
  <text x="500" y="547" textAnchor="middle" className="abs-core-caption">SPEED BRAIN · VISUAL MONITOR</text>
 </svg>;
}
export default function AgentBrainStudio({state={},onNavigate,reload,updatedAt}){
 const [active,setActive]=useState('memory');
 const [showAllActivity,setShowAllActivity]=useState(false);
 const modules=useMemo(()=>brainStudioModules(state),[state]);
 const details=modules[active];
 const stats=state.stats||{},a=state.agent_stats||{},llm=state.llm||{};
 const knowledgeCount=Number(stats.active||0);
 const first=MODULE_META.slice(0,3),last=MODULE_META.slice(3);
 const moduleCard=meta=>{
  const m=modules[meta.key],selected=active===meta.key;
  return <button key={meta.key} type="button" aria-pressed={selected}
   onClick={()=>setActive(meta.key)} className={'abs-node-card'+(selected?' selected':'')}>
   <span className="abs-node-icon"><meta.Icon size={21}/></span>
   <span className="abs-node-copy"><strong>{meta.title}</strong><span>{m.metric}</span><small>{m.unit}</small></span>
   <span className="abs-node-light"/>
  </button>;
 };
 const activity=(state.decisions||[]).slice(0,5);
 return <div className="abs-studio" dir="rtl">
  <header className="abs-head">
   <div><span className="abs-eyebrow"><Network size={15}/> NEURAL CONTROL ROOM</span><h2>العقل التفاعلي</h2><p>مراقبة المعرفة والذاكرة والقرارات والجودة من مصادر الـAgent الحقيقية.</p></div>
   <div className="abs-head-actions"><span className={'abs-status'+(llm.configured&&llm.enabled?' connected':'')}><i/>{llm.configured?(llm.enabled?'LLM مفعّل':'LLM متصل غير مفعّل'):'العقل القاعدي يعمل · LLM غير متصل'}</span>
    <button type="button" onClick={reload}><RefreshCw size={17}/> تحديث البيانات</button></div>
  </header>
  <div className="abs-metrics">
   <div><Database size={17}/><span>المعرفة النشطة</span><strong>{format(knowledgeCount)}</strong></div>
   <div><Activity size={17}/><span>القرارات · 24 ساعة</span><strong>{format(a.decisions_24h)}</strong></div>
   <div><Network size={17}/><span>ذاكرة مشتركة</span><strong>{format(stats.shared_breadfast)}</strong></div>
   <div><AlertTriangle size={17}/><span>التعارضات</span><strong>{format(stats.conflicts)}</strong></div>
  </div>
  <div className="abs-workspace">
   <aside className="abs-node-column" aria-label="وحدات العقل">{first.map(moduleCard)}</aside>
   <section className="abs-neural-scene">
    <div className="abs-scene-top"><span><i/> مكوّنات الوكيل الذكي</span><small>مخطط تفاعلي توضيحي</small></div>
    <NeuralCore activity={a.decisions_24h}/>
    <div className="abs-scene-footer"><span><CheckCircle2 size={15}/> مرتبط ببيانات الـAgent الحالية</span><span>{updatedAt?'آخر تحديث '+dateLabel(updatedAt):'تحميل البيانات الحالية'}</span></div>
   </section>
   <aside className="abs-node-column" aria-label="وحدات المراقبة">{last.map(moduleCard)}</aside>
  </div>
  <div className="abs-lower">
   <section className="abs-detail-card">
    <div className="abs-section-heading"><span><BookOpen size={19}/> تفاصيل الوحدة المحددة</span><span className="abs-verified">بيانات مسجلة</span></div>
    <div className="abs-detail-header"><h3>{MODULE_META.find(x=>x.key===active)?.title}</h3><div><strong>{details.metric}</strong><small>{details.unit}</small></div></div>
    <p>{details.description}</p>
    <div className="abs-detail-table">{details.rows.map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <button type="button" className="abs-open-btn" onClick={()=>onNavigate(MODULE_META.find(x=>x.key===active)?.view||'dashboard')}>
      فتح الصفحة الأصلية <ArrowLeft size={17}/>
    </button>
   </section>
   <section className="abs-activity-card">
    <div className="abs-section-heading"><span><Activity size={19}/> آخر قرارات مسجلة</span><span>سجل النشاط</span></div>
    {activity.length?<div className={'abs-activity-list'+(showAllActivity?' expanded':'')}>{activity.map((d,i)=><div key={d.id||i}>
      <span className="abs-activity-bullet"/><div><strong>{readableAction(d.action)}</strong>
       <small>{readableMode(d.planner_mode)} · {dateLabel(d.created_at)}</small></div>
      <span>{d.confidence==null?'—':Math.round(number(d.confidence)*100)+'%'}</span>
    </div>)}</div>:<p className="abs-empty">مفيش قرارات مسجلة لعرضها حاليًا. ده مش معناه إن الـAgent متوقف؛ بيانات التتبع قد تكون غير متاحة.</p>}
    {activity.length>3&&<button type="button" className="abs-more-activity" aria-expanded={showAllActivity}
       onClick={()=>setShowAllActivity(value=>!value)}>{showAllActivity?'عرض أقل':'عرض المزيد من القرارات'}</button>}
    <p className="abs-activity-help">نسبة الثقة تقدير داخلي للقرار وليست نسبة دقة مؤكدة.</p>
    <button type="button" className="abs-open-btn" onClick={()=>onNavigate('decisions')}>تفاصيل القرارات <ArrowLeft size={17}/></button>
   </section>
  </div>
  <footer className="abs-disclaimer"><Clock3 size={14}/> الرسوم المتحركة محاكاة بصرية لشبكة عصبية، وليست عرضًا للأفكار الداخلية للنموذج. المقاييس المعروضة مأخوذة من واجهة بيانات الـAgent ولا تتضمن محادثات شخصية.</footer>
 </div>;
}
