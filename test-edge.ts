import { EdgeTTS } from 'node-edge-tts';

async function test() {
  const tts = new EdgeTTS({
    voice: 'my-MM-ThihaNeural',
    lang: 'my-MM',
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
  });
  await tts.ttsPromise('မင်္ဂလာပါ', './test.mp3');
  console.log('done');
}
test().catch(console.error);
