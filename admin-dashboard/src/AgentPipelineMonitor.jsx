import {useCallback,useEffect,useState} from 'react';
import {Activity,RefreshCw,MessageCircle,CheckCircle2,AlertTriangle,Clock3} from 'lucide-react';
import {api} from './api';
import './AgentPipelineMonitor.css';

const STEP_LABELS={
 received:'استقبال الرسالة',memory:'تحديث ذاكرة المحادثة',
 knowledge:'تحميل معلومات الوظائف',understanding:'تحليل النموذج (اختياري)',
 decision:'اختيار الرد',response:'تجهيز الرد',delivery:'إرسال واتساب'
};
const STATE_LABELS={
 done:'اكتملت',skipped:'لم تُستخدم',degraded:'جزئي / تعذّر',failed:'فشلت',
 sent:'تم الإرسال',queued:'في طابور الإرسال',sending:'جارٍ الإرسال',
 processing_failed:'تعذرت المعالجة',
 uncertain:'حالة الإرسال غير مؤكدة',cancelled:'أُلغي الرد',not_recorded:'لا توجد حالة إرسال مسجلة'
};
const ACTION_LABELS={
 ask_next:'سؤال متابعة',answer_question:'الرد على سؤال',save_facts:'حفظ معلومات',
 compare_places:'مقارنة المناطق',compare_places_followup:'متابعة المقارنة',
 clarify:'طلب توضيح',explain_area_mode:'تفاصيل نظام شغل',
 answer_contextual_shift:'الرد على سؤال المواعيد',
 initial_job_requirements:'الرد على شروط الوظيفة',
 clarify_nearby_origin:'توضيح مكان السكن',
 handoff:'تحويل لموظف',processing_failure:'تعذرت معالجة الرسالة',flow_turn:'قرار من قواعد النظام',
 knowledge_answer:'رد من قاعدة المعرفة',answer_and_continue:'الرد واستكمال التقديم',
 contextual_area_details:'تفاصيل منطقة العمل'
};
const formatDate=x=>{
 const d=new Date(x);
 return Number.isNaN(d.getTime())?'—':d.toLocaleString('ar-EG',{dateStyle:'short',timeStyle:'short'});
};
const stageColor=status=>status==='done'||status==='sent'?'success':
 status==='failed'||status==='uncertain'||status==='degraded'||status==='processing_failed'?'warning':
 status==='queued'||status==='sending'?'active':'neutral';
const actionLabel=x=>ACTION_LABELS[x]||String(x||'قرار مسجل').replace(/_/g,' ').slice(0,60);
function stageDescription(stage){
 if(stage.status==='failed')return 'توقفت المعالجة عند هذه المرحلة، وسيطبق النظام سياسة إعادة المحاولة.';
 if(stage.key==='received')return 'الوقت بين حفظ رسالة المتقدم وبدء معالجتها';
 if(stage.key==='memory')return stage.indexed?'تم تشغيل فهرسة الذاكرة المسجلة':'فهرسة الذاكرة لم تكتمل أو لم تُشغّل';
 if(stage.key==='knowledge')return 'تم تحميل '+(stage.items||0)+' معلومة وإحضار '+(stage.historical_excerpts||0)+' مقاطع تاريخية مرتبطة';
 if(stage.key==='understanding')return stage.used_llm?'استُخدم النموذج اللغوي في التحليل':'لم يُستخدم النموذج اللغوي في هذه المرحلة؛ قد يكون القرار مبنيًا على قواعد النظام';
 if(stage.key==='decision')return 'الإجراء التشغيلي: '+actionLabel(stage.action);
 if(stage.key==='response')return stage.queued?'تم تجهيز رد في طابور واتساب':'تم تنفيذ القرار بدون رد صادر';
 if(stage.key==='delivery')return STATE_LABELS[stage.status]||'حالة غير معروفة';
 return '';
}
export default function AgentPipelineMonitor(){
 const [traces,setTraces]=useState([]);
 const [selected,setSelected]=useState(null);
 const [error,setError]=useState('');
 const [loading,setLoading]=useState(true);
 const [observedAt,setObservedAt]=useState(null);
 const refresh=useCallback(async()=>{
  try{
   const result=await api('/agent/pipeline');
   const list=Array.isArray(result?.traces)?result.traces:[];
   setTraces(list);
   setObservedAt(result?.observed_at||null);
   setSelected(prev=>list.some(t=>t.event_id===prev)?prev:list[0]?.event_id||null);
   setError('');
  }catch(e){setError(e?.message||'تعذر تحميل السجل');}
  finally{setLoading(false);}
 },[]);
 useEffect(()=>{
  let active=true;
  // Unmount cancels future polls; state updates for an in-flight request are
  // non-sensitive and React ignores them after teardown.
  if(active)refresh();
  const interval=setInterval(()=>{if(active)refresh();},20000);
  return ()=>{active=false;clearInterval(interval);};
 },[refresh]);
 const row=traces.find(x=>x.event_id===selected)||null;
 const steps=row?.stages||[];
 const timeline=steps.length?[
  ...steps,
  {key:'delivery',status:row.delivery,duration_ms:null}
 ]:[];
 return <section className="apm-monitor" aria-label="تتبّع مراحل معالجة الرسائل" dir="rtl">
  <header className="apm-header">
   <div><span className="apm-overline"><Activity size={15}/> REAL MESSAGE PIPELINE</span>
    <h3>رحلة الرسالة داخل الـAgent</h3>
    <p>كل خطوة مسجلة من التنفيذ الفعلي، مش حركة تجميلية ولا عرض لأفكار النموذج الداخلية.</p>
   </div>
   <button type="button" onClick={refresh} disabled={loading} className="apm-refresh"><RefreshCw size={16}/> تحديث المسار</button>
  </header>
  {error&&<div className="apm-error" role="alert"><AlertTriangle size={15}/> {error}</div>}
  <div className="apm-layout">
   <div className="apm-list">
    <div className="apm-subheading"><MessageCircle size={16}/> آخر الرسائل التي عالجها الـAgent</div>
    {loading&&<p className="apm-empty">جارٍ تحميل سجل التشغيل...</p>}
    {!loading&&!traces.length&&<p className="apm-empty">مفيش أحداث معالجة محفوظة حاليًا. أول رسالة جديدة يعالجها الـAgent هتظهر هنا.</p>}
    {traces.slice(0,12).map((item,i)=><button key={item.event_id} type="button"
     className={'apm-message'+(item.event_id===selected?' selected':'')}
     aria-pressed={item.event_id===selected} onClick={()=>setSelected(item.event_id)}>
      <span className="apm-message-num">#{String(item.message_id||'').slice(-6)||i+1}</span>
      <span className="apm-message-main"><strong>{actionLabel(item.action)}</strong>
       <small>{formatDate(item.created_at)}</small></span>
      <span className={'apm-dot '+stageColor(item.delivery)} title={STATE_LABELS[item.delivery]||item.delivery}/>
     </button>)}
   </div>
   <div className="apm-track-wrap">
    {row? <>
     <div className="apm-selected-head">
      <div><strong>{actionLabel(row.action)}</strong><small>{formatDate(row.created_at)}</small></div>
      <span className={'apm-delivery '+stageColor(row.delivery)}>{STATE_LABELS[row.delivery]||row.delivery}</span>
     </div>
     {row.historic_trace?<div className="apm-empty"><Clock3 size={19}/> القرار ده اتسجل قبل تشغيل تتبع المراحل الجديد. حالة إرسال واتساب متاحة، لكن مش هنفترض تفاصيل مراحل لم تتسجل وقتها.</div>:
     <ol className="apm-stage-list">{timeline.map((stage,index)=><li key={stage.key} className={'apm-stage '+stageColor(stage.status)}>
      <span className="apm-step-number">{stage.status==='done'||stage.status==='sent'?<CheckCircle2 size={18}/>:index+1}</span>
      <span className="apm-stage-content"><strong>{STEP_LABELS[stage.key]||stage.key}</strong>
       <small>{stageDescription(stage)}</small></span>
      <span className="apm-step-meta"><span>{STATE_LABELS[stage.status]||'—'}</span>
       {stage.duration_ms!=null&&<small>{stage.duration_ms.toLocaleString('en-US')} ms</small>}</span>
     </li>)}</ol>}
    </>:<p className="apm-empty">اختار رسالة من القائمة علشان تشوف المراحل الفعلية المسجلة.</p>}
   </div>
  </div>
  <footer className="apm-footer">بيتم تحديث السجل كل 20 ثانية أثناء فتح الصفحة. «تم الإرسال» معناها إن واتساب أكد الإرسال للنظام، مش بالضرورة إن المتقدم قرأه. السجل لا يحتوي على نصوص المتقدمين.</footer>
 </section>;
}
