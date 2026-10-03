import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function command(bin,args,{timeoutMs=180000}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(bin,args,{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',settled=false;
  const timer=setTimeout(()=>{if(!settled){child.kill('SIGKILL');}},timeoutMs);
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

export class SpeechTranscriber{
 constructor({
  binary=process.env.WHISPER_BIN||'/opt/whisper/whisper-cli',
  model=process.env.WHISPER_MODEL||'/opt/whisper/models/ggml-base.bin',
  ffmpeg=process.env.FFMPEG_BIN||'ffmpeg',
  language=process.env.WHISPER_LANGUAGE||'ar',
  threads=Number(process.env.WHISPER_THREADS||2),
  maxSeconds=Number(process.env.WHISPER_MAX_SECONDS||180),
  runner=command,
  skipAvailabilityCheck=false
 }={}){
  Object.assign(this,{binary,model,ffmpeg,language,threads,maxSeconds,runner,skipAvailabilityCheck});
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
 snapshot(){return {available:this.available,error:this.error,language:this.language,model:path.basename(this.model)};}
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
   await this.runner(this.binary,[
    '-m',this.model,'-f',wav,'-l',this.language,
    '-t',String(Math.max(1,Math.min(8,this.threads))),
    '-nt','-np','-otxt','-of',prefix
   ],{timeoutMs:240000});
   const text=cleanTranscript(await fs.readFile(prefix+'.txt','utf8'));
   if(!text)throw new Error('No speech detected');
   return text.slice(0,10000);
  }finally{
   await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
 }
}
