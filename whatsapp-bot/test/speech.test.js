import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {SpeechTranscriber,cleanTranscript,audioExtension,transcriptResult} from '../src/speech.js';

test('speech helpers clean Whisper text and choose audio extensions',()=>{
 assert.equal(cleanTranscript('  أهلاً   بيك [BLANK_AUDIO]  '),'أهلاً بيك');
 assert.equal(audioExtension('audio/ogg; codecs=opus'),'.ogg');
 assert.equal(audioExtension('audio/mpeg'),'.mp3');
 assert.equal(audioExtension('audio/mp4'),'.m4a');
});

test('confidence parser rejects uncertain transcripts and accepts strong ones',()=>{
 const strong=transcriptResult({transcription:[{text:' التأمين الطبي بيبدأ من أول يوم',tokens:[
  {text:' التأمين',p:.91},{text:' الطبي',p:.88},{text:' بيبدأ',p:.84},{text:' من',p:.9},{text:' أول',p:.86},{text:' يوم',p:.92}
 ]}]},.56);
 assert.equal(strong.text,'التأمين الطبي بيبدأ من أول يوم');
 assert.equal(strong.trusted,true);
 assert.ok(strong.confidence>.8);

 const weak=transcriptResult({transcription:[{text:' كلام غير واضح',tokens:[
  {text:' كلام',p:.31},{text:' غير',p:.28},{text:' واضح',p:.4}
 ]}]},.56);
 assert.equal(weak.trusted,false);
 assert.ok(weak.confidence<.56);
});

test('local speech transcriber uses Arabic recruitment prompt and returns confidence metadata',async()=>{
 const calls=[];
 const runner=async(bin,args)=>{
  calls.push({bin,args});
  if(bin==='fake-ffmpeg'){
   await fs.writeFile(args.at(-1),Buffer.from('wav'));
   return {stdout:'',stderr:''};
  }
  if(bin==='fake-whisper'){
   const prefix=args[args.indexOf('-of')+1];
   await fs.writeFile(prefix+'.json',JSON.stringify({transcription:[{
    text:' التأمين الطبي بيبدأ من أول يوم',
    tokens:[{text:' التأمين',p:.9},{text:' الطبي',p:.9},{text:' بيبدأ',p:.86},{text:' من',p:.9},{text:' أول',p:.91},{text:' يوم',p:.94}]
   }]}));
   return {stdout:'',stderr:''};
  }
  throw new Error('unexpected binary');
 };
 const speech=new SpeechTranscriber({
  binary:'fake-whisper',model:'fake-model.bin',ffmpeg:'fake-ffmpeg',
  language:'ar',threads:2,runner,skipAvailabilityCheck:true
 });
 assert.equal(await speech.init(),true);
 const result=await speech.transcribe(Buffer.from('ogg data'),'audio/ogg');
 assert.equal(result.text,'التأمين الطبي بيبدأ من أول يوم');
 assert.equal(result.trusted,true);
 assert.ok(result.confidence>.8);
 assert.equal(calls.length,2);
 assert.ok(calls[1].args.includes('-l'));
 assert.ok(calls[1].args.includes('ar'));
 assert.ok(calls[1].args.includes('-bs'));
 assert.ok(calls[1].args.includes('--prompt'));
 assert.ok(calls[1].args.includes('-ojf'));
});
