import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import youtubedl from 'youtube-dl-exec';
import { GoogleGenAI, Modality } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import { EdgeTTS } from 'node-edge-tts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure ffmpeg path is set
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}
if (ffprobeStatic.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

function parseTime(timeStr: string) {
  const [time, ms] = timeStr.split(',');
  const [hours, minutes, seconds] = time.split(':');
  return (parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds)) * 1000 + parseInt(ms || '0');
}

function parseSrt(srt: string) {
  const blocks = srt.replace(/\r/g, '').split('\n\n').filter(Boolean);
  const parsed = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 3) continue;
    const timeLine = lines[1];
    if (!timeLine.includes('-->')) continue;
    const [startStr, endStr] = timeLine.split(' --> ');
    const start = parseTime(startStr);
    const end = parseTime(endStr);
    const text = lines.slice(2).join(' ');
    if (text.trim()) {
      parsed.push({ start, end, text });
    }
  }
  return parsed;
}

function generateSilentWav(durationSeconds: number, filePath: string) {
  const sampleRate = 24000; // MUST match TTS sample rate (24000) for concat demuxer
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = Math.floor(durationSeconds * sampleRate) * blockAlign;
  const chunkSize = 36 + dataSize;

  const buffer = Buffer.alloc(44 + dataSize);
  
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(chunkSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  
  fs.writeFileSync(filePath, buffer);
}

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const upload = multer({ dest: 'uploads/' });

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

app.post('/api/extract-audio', upload.single('video'), async (req, res) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'Please upload a video file.' });
  }

  const jobId = Date.now().toString();
  const workDir = path.join(__dirname, 'uploads', jobId);
  fs.mkdirSync(workDir, { recursive: true });

  const origVideo = path.join(workDir, 'orig_video.mp4');
  const origAudio = path.join(workDir, 'orig_audio.mp3');

  try {
    // 1. Get Video
    if (file) {
      console.log(`Using uploaded file: ${file.path}`);
      fs.copyFileSync(file.path, origVideo);
    } else {
      throw new Error('No video file provided.');
    }

    // 2. Extract Audio
    console.log('Extracting audio...');
    await new Promise<void>((resolve, reject) => {
      ffmpeg(origVideo)
        .output(origAudio)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('32k')
        .audioChannels(1)
        .audioFrequency(16000)
        .duration(300) // Limit to 5 minutes to prevent OOM and huge payloads
        .on('end', () => resolve())
        .on('error', reject)
        .run();
    });

    // Read audio as base64
    const audioBuffer = fs.readFileSync(origAudio);
    const audioBase64 = audioBuffer.toString('base64');

    res.json({
      audioBase64,
      jobId
    });

  } catch (error: any) {
    console.error('Extraction error:', error);
    res.status(500).json({ error: error.message || 'An error occurred during extraction.' });
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
});

app.post('/api/standard-tts', async (req, res) => {
  try {
    const { text, lang = 'my' } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }
    
    // Subtitle blocks are usually short, but we truncate just in case to prevent crashes.
    const safeText = text.length > 500 ? text.substring(0, 497) + '...' : text;
    
    const tts = new EdgeTTS({
      voice: 'my-MM-ThihaNeural',
      lang: 'my-MM',
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    });

    const tempFilePath = path.join(__dirname, 'uploads', `temp_tts_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp3`);
    
    await tts.ttsPromise(safeText, tempFilePath);
    
    const audioBuffer = fs.readFileSync(tempFilePath);
    const base64 = audioBuffer.toString('base64');
    
    // Clean up temp file
    fs.unlinkSync(tempFilePath);
    
    res.json({ audioBase64: base64 });
  } catch (error: any) {
    console.error('Edge TTS error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate TTS' });
  }
});

app.post('/api/dub-video', async (req, res) => {
  const { srtContent, jobId, audioBlocks } = req.body;

  if (!srtContent || !jobId || !audioBlocks) {
    return res.status(400).json({ error: 'Missing SRT content, jobId, or audioBlocks.' });
  }

  const workDir = path.join(__dirname, 'uploads', jobId);
  const origVideo = path.join(workDir, 'orig_video.mp4');
  let myanmarAudio = path.join(workDir, 'myanmar_audio.wav');
  const subsFile = path.join(workDir, 'subs.srt');
  const finalVideo = path.join(workDir, 'final_video.mp4');

  if (!fs.existsSync(origVideo)) {
    return res.status(400).json({ error: 'Original video not found. Please restart the process.' });
  }

  try {
    fs.writeFileSync(subsFile, srtContent);

    // 4. Process Synchronized TTS
    console.log('Processing synchronized TTS...');

    const concatListPath = path.join(workDir, 'concat.txt');
    let concatContent = '';
    let currentTime = 0;

    for (let i = 0; i < audioBlocks.length; i++) {
      const block = audioBlocks[i];
      console.log(`Processing block ${i + 1}/${audioBlocks.length}`);

      const rawTtsPath = path.join(workDir, `raw_tts_${i}.wav`);
      const audioBuffer = Buffer.from(block.audioBase64, 'base64');
      
      if (block.format === 'pcm' || !block.format) {
        const rawPcmPath = path.join(workDir, `raw_tts_${i}.pcm`);
        fs.writeFileSync(rawPcmPath, audioBuffer);

        // Convert raw PCM to WAV
        await new Promise<void>((resolve, reject) => {
          ffmpeg()
            .input(rawPcmPath)
            .inputOptions([
              '-f', 's16le',
              '-ar', '24000',
              '-ac', '1'
            ])
            .audioCodec('pcm_s16le')
            .save(rawTtsPath)
            .on('end', () => resolve())
            .on('error', reject);
        });
      } else {
        // It's already MP3 from Edge TTS, convert to WAV
        const tempMp3Path = path.join(workDir, `temp_tts_${i}.mp3`);
        fs.writeFileSync(tempMp3Path, audioBuffer);
        await new Promise<void>((resolve, reject) => {
          ffmpeg(tempMp3Path)
            .audioCodec('pcm_s16le')
            .save(rawTtsPath)
            .on('end', () => resolve())
            .on('error', reject);
        });
      }

      // Get Duration
      const actualDuration = await new Promise<number>((resolve, reject) => {
        ffmpeg.ffprobe(rawTtsPath, (err, metadata) => {
          if (err) reject(err);
          else resolve(metadata.format.duration || 0);
        });
      });

      // 2. Calculate Tempo and Process
      // We MUST finish by block.end to prevent cascading desync.
      // By calculating targetDuration based on currentTime, we self-correct any drift from previous blocks.
      let targetDuration = (block.end / 1000) - currentTime;
      if (targetDuration <= 0.1) targetDuration = 0.1; // Safeguard against division by zero
      
      let speed = actualDuration / targetDuration;

      // STRICT SPEED CAPS FOR CONSISTENT PACING
      if (speed < 0.8) {
        speed = 0.8;
      }
      if (speed > 1.5) {
        speed = 1.5;
      }

      const newDuration = actualDuration / speed;

      const processedTtsPath = path.join(workDir, `processed_tts_${i}.wav`);
      
      let filter = '';
      if (speed === 1) {
        filter = 'anull';
      } else {
        let remaining = speed;
        while (remaining > 2.0) {
          filter += 'atempo=2.0,';
          remaining /= 2.0;
        }
        while (remaining < 0.5) {
          filter += 'atempo=0.5,';
          remaining /= 0.5;
        }
        filter += `atempo=${remaining}`;
      }

      await new Promise<void>((resolve, reject) => {
        ffmpeg(rawTtsPath)
          .audioFilter(filter)
          .audioFrequency(24000)
          .audioChannels(1)
          .save(processedTtsPath)
          .on('end', () => resolve())
          .on('error', reject);
      });

      concatContent += `file 'processed_tts_${i}.wav'\n`;
      // Advance currentTime by the actual processed duration.
      currentTime += newDuration;
    }

    fs.writeFileSync(concatListPath, concatContent);

    // Concat all audio
    console.log('Concatenating audio...');
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(concatListPath)
        .inputOptions([
          '-f', 'concat',
          '-safe', '0'
        ])
        .outputOptions([
          '-c', 'copy'
        ])
        .save(myanmarAudio)
        .on('end', () => resolve())
        .on('error', reject);
    });

    // 5. Merge Video, Audio, and Subtitles
    console.log('Merging final video...');
    
    // Adjust audio duration to match video
    const origVideoDuration = await new Promise<number>((resolve, reject) => {
      ffmpeg.ffprobe(origVideo, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration || 0);
      });
    });

    const myanmarAudioDuration = await new Promise<number>((resolve, reject) => {
      ffmpeg.ffprobe(myanmarAudio, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration || 0);
      });
    });

    if (Math.abs(myanmarAudioDuration - origVideoDuration) > 0.1) {
      const adjustedAudio = path.join(workDir, 'adjusted_audio.wav');
      await new Promise<void>((resolve, reject) => {
        ffmpeg(myanmarAudio)
          .outputOptions(['-t', origVideoDuration.toString()])
          .audioFilter('apad')
          .save(adjustedAudio)
          .on('end', () => resolve())
          .on('error', reject);
      });
      myanmarAudio = adjustedAudio;
    }

    const escapedSubsPath = subsFile.replace(/\\/g, '/').replace(/:/g, '\\:');
    const escapedFontsDir = __dirname.replace(/\\/g, '/').replace(/:/g, '\\:');

    await new Promise<void>((resolve, reject) => {
      ffmpeg(origVideo)
        .input(myanmarAudio)
        .videoFilters(`subtitles=${escapedSubsPath}:fontsdir=${escapedFontsDir}:force_style='Fontname=Noto Sans Myanmar,Fontsize=20'`)
        .outputOptions([
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-y'
        ])
        .save(finalVideo)
        .on('end', () => resolve())
        .on('error', (err) => {
          console.error('FFmpeg merge error:', err);
          reject(err);
        });
    });

    console.log('Process complete!');
    
    res.download(finalVideo, 'translated_video.mp4', (err) => {
      if (err && (err as any).code !== 'EPIPE') {
        console.error('Download error details:', {
          message: err.message,
          code: (err as any).code,
          stack: err.stack
        });
      }
      fs.rmSync(workDir, { recursive: true, force: true });
    });

  } catch (error: any) {
    console.error('Dubbing error:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: error.message || 'An error occurred during dubbing.',
        debug: {
          backendKeyLength: process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.length : 0,
          backendKeyStart: process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.substring(0, 5) : null
        }
      });
    }
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Global error handler to ensure JSON responses
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Express error:', err);
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Payload too large. Please try a shorter video.' });
    }
    res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
