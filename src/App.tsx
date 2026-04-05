import React, { useState, useRef } from 'react';
import { Video, Upload, Loader2, Download, AlertCircle } from 'lucide-react';
import { GoogleGenAI, Modality } from '@google/genai';

function parseTime(timeStr: string) {
  const [time, ms] = timeStr.split(',');
  const [hours, minutes, seconds] = time.split(':');
  return (parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds)) * 1000 + parseInt(ms || '0');
}

function parseSrt(srt: string) {
  // Normalize line endings and split by double newline or more
  const blocks = srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\s*\n/);
  const parsed = [];

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    // Find the line with the timestamp
    let timeLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('-->')) {
            timeLineIndex = i;
            break;
        }
    }
    
    if (timeLineIndex === -1) continue;

    const timeLine = lines[timeLineIndex];
    const [startStr, endStr] = timeLine.split('-->').map(s => s.trim());
    
    if (!startStr || !endStr) continue;

    const start = parseTime(startStr);
    const end = parseTime(endStr);
    
    // Text is everything after the timeline
    const text = lines.slice(timeLineIndex + 1).join(' ').trim();
    
    if (text) {
      parsed.push({ start, end, text });
    }
  }
  return parsed;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [ttsEngine, setTtsEngine] = useState<'gemini' | 'standard'>('gemini');
  const [voice, setVoice] = useState('Kore');
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState('');
  const [resultUrl, setResultUrl] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResultUrl('');
    setStatusMessage('');
    
    if (!file) {
      setError('Please select a video file');
      return;
    }

    setIsProcessing(true);

    try {
      // Step 1: Extract Audio
      setStatusMessage('Extracting audio from video...');
      const formData = new FormData();
      formData.append('video', file);

      const extractResponse = await fetch('/api/extract-audio', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });

      if (!extractResponse.ok) {
        const errorData = await extractResponse.json().catch(() => ({ error: 'Unknown error occurred' }));
        throw new Error(errorData.error || `Server error: ${extractResponse.status}`);
      }

      let audioBase64, jobId;
      try {
        const text = await extractResponse.text();
        try {
          const data = JSON.parse(text);
          audioBase64 = data.audioBase64;
          jobId = data.jobId;
        } catch (parseErr) {
          console.error("Failed to parse JSON. Raw response:", text.substring(0, 500));
          throw new Error(`Failed to parse server response. Raw: ${text.substring(0, 100)}...`);
        }
      } catch (err: any) {
        throw new Error(err.message || 'Failed to parse server response. The server might be overloaded or returning an invalid format.');
      }

      // Step 2: Call Gemini for Transcription and Translation
      setStatusMessage('Translating with Gemini...');
      
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const prompt = `
      Transcribe the audio and translate it into natural-sounding Myanmar (Burmese) language.
      Maintain the engaging, dramatic tone of a movie recap.
      
      CRITICAL INSTRUCTION: The Burmese text will be used for voice dubbing. You MUST ensure the spoken duration of the Burmese translation closely matches the original English audio length.
      
      For each subtitle block, the amount of text should be proportional to the duration of the block.
      - If the Burmese translation is too short for the block's duration, add natural conversational filler words or elaborate to fill the time.
      - If the Burmese translation is too long for the block's duration, summarize it to fit the time.
      
      The goal is to have the Burmese audio perfectly match the timing of the original English audio.
      
      Output ONLY a valid SRT subtitle file format with the translated text. Do not include any markdown formatting like \`\`\`srt or \`\`\`.
      `;

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [
          {
            inlineData: {
              data: audioBase64,
              mimeType: 'audio/mp3'
            }
          },
          { text: prompt }
        ],
        config: {
          systemInstruction: "You are an expert translator and subtitle editor, specializing in creating perfectly timed, natural-sounding voiceover scripts for video dubbing.",
        }
      });

      let srtContent = response.text || '';
      srtContent = srtContent.replace(/^```srt\n?/m, '').replace(/^```\n?/m, '').replace(/```$/m, '').trim();

      // Step 3: Generate TTS for each subtitle block
      setStatusMessage('Generating voiceover audio...');
      const blocks = parseSrt(srtContent);
      if (blocks.length === 0) {
        throw new Error('No valid subtitle blocks found in SRT.');
      }

      const audioBlocks = [];
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        setStatusMessage(`Generating voiceover audio (${i + 1}/${blocks.length})...`);
        
        let base64Audio = null;
        let retries = 3;
        
        while (retries > 0 && !base64Audio) {
          try {
            if (ttsEngine === 'gemini') {
              const ttsResponse = await ai.models.generateContent({
                model: "gemini-2.5-flash-preview-tts",
                contents: [{ parts: [{ text: block.text }] }],
                config: {
                  responseModalities: [Modality.AUDIO],
                  speechConfig: {
                    voiceConfig: {
                      prebuiltVoiceConfig: { voiceName: voice },
                    },
                  },
                },
              });

              const candidate = ttsResponse.candidates?.[0];
              base64Audio = candidate?.content?.parts?.[0]?.inlineData?.data;
              
              if (!base64Audio) {
                console.warn(`No audio data for block ${i + 1}. Finish reason: ${candidate?.finishReason}`);
                break;
              }
            } else {
              const ttsRes = await fetch('/api/standard-tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: block.text, lang: 'my' }),
                credentials: 'include',
              });
              
              if (!ttsRes.ok) {
                const errData = await ttsRes.json().catch(() => ({}));
                throw new Error(errData.error || 'Edge TTS failed');
              }
              
              const data = await ttsRes.json();
              base64Audio = data.audioBase64;
              
              if (!base64Audio) {
                throw new Error('No audio data returned from Edge TTS');
              }
            }
          } catch (err) {
            console.warn(`Error generating TTS for block ${i + 1}, retries left: ${retries - 1}`, err);
            retries--;
            if (retries > 0) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }

        if (!base64Audio) {
          console.warn(`Skipping block ${i + 1} due to TTS failure. The video will have silence here.`);
          continue;
        }
        
        audioBlocks.push({
          start: block.start,
          end: block.end,
          audioBase64: base64Audio,
          format: ttsEngine === 'gemini' ? 'pcm' : 'mp3'
        });
      }

      // Step 4: Dub Video
      setStatusMessage('Merging video and audio...');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1800000); // 30 minute timeout

      const dubResponse = await fetch('/api/dub-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          srtContent, 
          jobId, 
          audioBlocks
        }),
        signal: controller.signal,
        credentials: 'include',
      }).finally(() => clearTimeout(timeoutId));

      if (!dubResponse.ok) {
        const errorData = await dubResponse.json().catch(() => ({ error: 'Unknown error occurred' }));
        const debugInfo = errorData.debug ? ` | Debug: ${JSON.stringify(errorData.debug)}` : '';
        throw new Error((errorData.error || `Server error: ${dubResponse.status}`) + debugInfo);
      }

      // Get the video blob
      const blob = await dubResponse.blob();
      const url = URL.createObjectURL(blob);
      setResultUrl(url);
      
    } catch (err: any) {
      setError(err.message || 'An error occurred during processing');
    } finally {
      setIsProcessing(false);
      setStatusMessage('');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8 font-sans">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center p-3 bg-blue-100 rounded-full mb-4">
            <Video className="w-8 h-8 text-blue-600" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900">Video Translator & Dubber</h1>
          <p className="mt-3 text-lg text-gray-500">
            Automate video translation and dubbing (English to Myanmar) for movie recaps.
          </p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="p-6 sm:p-8">
            <form onSubmit={handleSubmit} className="space-y-6">
              
              {/* Input Fields */}
              <div className="min-h-[100px] flex flex-col gap-4">
                <div className="w-full">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Upload MP4 Video
                  </label>
                  <div 
                    className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-gray-300 border-dashed rounded-md hover:border-blue-400 transition-colors cursor-pointer"
                    onClick={() => !isProcessing && fileInputRef.current?.click()}
                  >
                    <div className="space-y-1 text-center">
                      <Upload className="mx-auto h-12 w-12 text-gray-400" />
                      <div className="flex text-sm text-gray-600 justify-center">
                        <span className="relative rounded-md font-medium text-blue-600 hover:text-blue-500 focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-blue-500">
                          <span>{file ? file.name : 'Upload a file'}</span>
                          <input
                            ref={fileInputRef}
                            className="hidden"
                            type="file"
                            accept="video/mp4,video/x-m4v,video/*"
                            onChange={(e) => setFile(e.target.files?.[0] || null)}
                            disabled={isProcessing}
                          />
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* TTS Engine Selection */}
                <div className="w-full">
                  <label htmlFor="ttsEngine" className="block text-sm font-medium text-gray-700 mb-1">
                    TTS Engine
                  </label>
                  <select
                    id="ttsEngine"
                    value={ttsEngine}
                    onChange={(e) => setTtsEngine(e.target.value as any)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 bg-white"
                    disabled={isProcessing}
                  >
                    <option value="gemini">Gemini 2.5 Flash (High Quality, Expressive)</option>
                    <option value="standard">Edge TTS (Thiha - Male Voice)</option>
                  </select>
                </div>

                {/* Voice Selection (Only for Gemini) */}
                {ttsEngine === 'gemini' && (
                  <div className="w-full">
                    <label htmlFor="voice" className="block text-sm font-medium text-gray-700 mb-1">
                      Voice Actor
                    </label>
                    <select
                      id="voice"
                      value={voice}
                      onChange={(e) => setVoice(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 bg-white"
                      disabled={isProcessing}
                    >
                      <option value="Puck">Puck (Male, Energetic)</option>
                      <option value="Charon">Charon (Male, Deep)</option>
                      <option value="Kore">Kore (Female, Clear)</option>
                      <option value="Fenrir">Fenrir (Male, Strong)</option>
                      <option value="Zephyr">Zephyr (Female, Soft)</option>
                    </select>
                  </div>
                )}
              </div>

              {/* Error Message */}
              {error && (
                <div className="rounded-md bg-red-50 p-4 flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-red-400 mt-0.5" />
                  <div className="text-sm text-red-700">{error}</div>
                </div>
              )}

              {/* Submit Button */}
              <button
                type="submit"
                disabled={isProcessing || !file}
                className="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    {statusMessage || 'Processing Video (This may take a few minutes)...'}
                  </>
                ) : (
                  'Translate & Dub Video'
                )}
              </button>
            </form>
          </div>
          
          {/* Result Section */}
          {resultUrl && (
            <div className="bg-gray-50 border-t border-gray-200 p-6 sm:p-8">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Result</h3>
              <div className="aspect-video bg-black rounded-lg overflow-hidden mb-4">
                <video 
                  src={resultUrl} 
                  controls 
                  className="w-full h-full object-contain"
                />
              </div>
              <a
                href={resultUrl}
                download="translated_video.mp4"
                className="w-full flex justify-center items-center py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                <Download className="w-4 h-4 mr-2" />
                Download Video
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
