import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function command(bin,args,{timeoutMs=180000}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(bin,args,{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',settled=false;
  const timer=setTimeout(()=>{if(!settled)child.kill('SIGKILL');},timeoutMs);
  child.stdout.on('data',d=>stdout+=d.toString());
  child.stderr.on('data',d=>stderr+=d.toString());
  child.on('error',e=>{settled=true;clearTimeout(timer);reject(e);});
  child.on('close',code=>{
   if(settled)return;settled=true;clearTimeout(timer);
   if(code===0)resolve({stdout,stderr});
   else reject(new Error((stderr||stdout||`${bin} exited with ${code}`).slice(-2000)));
  });
 });
}

export function cleanTranscript(value){
 return String(value||'').replace(/\[(?:BLANK_AUDIO|MUSIC|SILENCE)\]/gi,'').replace(/\s+/g,' ').trim();
}

export function audioExtension(mime){
 const m=String(mime||'').toLowerCase();
 if(m.includes('mpeg')||m.includes('mp3'))return '.mp3';
 if(m.includes('mp4')||m.includes('m4a'))return '.m4a';
 if(m.includes('aac'))return '.aac';
 if(m.includes('wav'))return '.wav';
 return '.ogg';
}

export function transcriptResult(json,minConfidence=.56){
 const segments=Array.isArray(json?.transcription)?json.transcription:[];
 const text=cleanTranscript(segments.map(x=>x?.text||'').join(' '));
 const probs=[];
 for(const segment of segments){
  for(const token of segment?.tokens||[]){
   const p=Number(token?.p),tokenText=String(token?.text||'');
   if(Number.isFinite(p)&&p>=0&&p<=1&&tokenText&&!/^<\|.*\|>$/.test(tokenText.trim()))probs.push(p);
  }
 }
 const confidence=probs.length?probs.reduce((n,p)=>n+p,0)/probs.length:0;
 const lowShare=probs.length?probs.filter(p=>p<.35).length/probs.length:1;
 const trusted=Boolean(text)&&probs.length>=2&&confidence>=minConfidence&&lowShare<=.4;
 return {text:text.slice(0,10000),confidence:Math.round(confidence*1000)/1000,trusted,low_share:Math.round(lowShare*1000)/1000};
}

const DEFAULT_PROMPT='محادثة عربية مصرية طبيعية عن التوظيف والدليفري في مصر. كلمات متوقعة: سبيد دليفري، بريدفاست، دليفري، مندوب توصيل، موتوسيكل، رخصة، تأمين طبي، تأمين اجتماعي، مرتب، قبض، شيفت، أكتوبر، الشيخ زايد، حدائق الأهرام، الفردوس، الشروق، العبور، مدينتي، القاهرة الجديدة، المعادي، مدينة نصر، محاضرة، تعيين.';

export class SpeechTranscriber{
 constructor({
  binary=process.env.WHISPER_BIN||'/opt/whisper/whisper-cli',
  model=process.env.WHISPER_MODEL||'/opt/whisper/models/ggml-small-q8_0.bin',
  ffmpeg=process.env.FFMPEG_BIN||'ffmpeg',
  language=process.env.WHISPER_LANGUAGE||'ar',
  threads=Number(process.env.WHISPER_THREADS||2),
  maxSeconds=Number(process.env.WHISPER_MAX_SECONDS||180),
  minConfidence=Number(process.env.WHISPER_MIN_CONFIDENCE||.56),
  prompt=process.env.WHISPER_PROMPT||DEFAULT_PROMPT,
  beamSize=Number(process.env.WHISPER_BEAM_SIZE||5),
  runner=command,
  skipAvailabilityCheck=false
 }={}){
  Object.assign(this,{binary,model,ffmpeg,language,threads,maxSeconds,minConfidence,prompt,beamSize,runner,skipAvailabilityCheck});
  this.available=false;this.error=null;
 }
 async init(){
  try{
   if(!this.skipAvailabilityCheck){await fs.access(this.binary);await fs.access(this.model);}
   this.available=true;this.error=null;
  }catch(e){
   this.available=false;this.error='محرك تحويل الصوت إلى نص غير متاح حالياً.';
   console.warn('Speech transcription unavailable:',e.code||e.name);
  }
  return this.available;
 }
 snapshot(){return {available:this.available,error:this.error,language:this.language,model:path.basename(this.model),min_confidence:this.minConfidence};}
 classifyError(e){const m=String(e?.message||e||'').toLowerCase();if(m.includes('killed')||m.includes('sigkill')||m.includes('137')||m.includes('cannot allocate')||m.includes('memory'))return 'resource_limit';if(m.includes('timed')||m.includes('timeout'))return 'timeout';return 'transcription_failed';}
 async transcribe(buffer,mime){
  if(!this.available)throw new Error(this.error||'Speech transcription unavailable');
  if(!Buffer.isBuffer(buffer)||!buffer.length)throw new Error('Empty audio');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'speed-voice-'));
  const input=path.join(dir,'input'+audioExtension(mime)),wav=path.join(dir,'audio.wav'),prefix=path.join(dir,'transcript');
  try{
   await fs.writeFile(input,buffer,{mode:0o600});
   await this.runner(this.ffmpeg,[
    '-nostdin','-hide_banner','-loglevel','error','-y','-i',input,
    '-t',String(Math.max(5,Math.min(600,this.maxSeconds))),
    '-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',wav
   ],{timeoutMs:90000});
   const args=[
    '-m',this.model,'-f',wav,'-l',this.language,
    '-t',String(Math.max(1,Math.min(8,this.threads))),
    '-bs',String(Math.max(1,Math.min(8,this.beamSize))),
    '-nt','-np','-ojf','-of',prefix
   ];
   if(this.prompt)args.push('--prompt',this.prompt);
   await this.runner(this.binary,args,{timeoutMs:300000});
   const json=JSON.parse(await fs.readFile(prefix+'.json','utf8'));
   const result=transcriptResult(json,this.minConfidence);
   if(!result.text)throw new Error('No speech detected');
   return result;
  }finally{
   await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
 }
}
