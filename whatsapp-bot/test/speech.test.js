import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {SpeechTranscriber,cleanTranscript,audioExtension} from '../src/speech.js';

test('speech helpers clean Whisper text and choose audio extensions',()=>{
 assert.equal(cleanTranscript('  أهلاً   بيك [BLANK_AUDIO]  '),'أهلاً بيك');
 assert.equal(audioExtension('audio/ogg; codecs=opus'),'.ogg');
 assert.equal(audioExtension('audio/mpeg'),'.mp3');
 assert.equal(audioExtension('audio/mp4'),'.m4a');
});

test('local speech transcriber converts audio then reads Whisper text',async()=>{
 const calls=[];
 const runner=async(bin,args)=>{
  calls.push({bin,args});
  if(bin==='fake-ffmpeg'){
   await fs.writeFile(args.at(-1),Buffer.from('wav'));
   return {stdout:'',stderr:''};
  }
  if(bin==='fake-whisper'){
   const prefix=args[args.indexOf('-of')+1];
   await fs.writeFile(prefix+'.txt','  التأمين الطبي بيبدأ من أول يوم  ');
   return {stdout:'',stderr:''};
  }
  throw new Error('unexpected binary');
 };
 const speech=new SpeechTranscriber({
  binary:'fake-whisper',model:'fake-model.bin',ffmpeg:'fake-ffmpeg',
  language:'ar',threads:2,runner,skipAvailabilityCheck:true
 });
 assert.equal(await speech.init(),true);
 const text=await speech.transcribe(Buffer.from('ogg data'),'audio/ogg');
 assert.equal(text,'التأمين الطبي بيبدأ من أول يوم');
 assert.equal(calls.length,2);
 assert.ok(calls[1].args.includes('-l'));
 assert.ok(calls[1].args.includes('ar'));
});
