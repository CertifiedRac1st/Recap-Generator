import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';

async function test() {
  console.log('API Key:', process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.substring(0, 5) + '...' : 'undefined');
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: 'Hello',
    });
    console.log('Success:', response.text);
  } catch (e) {
    console.error('Error:', e);
  }
}

test();
