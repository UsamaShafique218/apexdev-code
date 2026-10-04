export interface TranscribeOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** `chat`: send the audio to a multimodal chat model. `whisper`: OpenAI-style /audio/transcriptions. */
  mode: 'chat' | 'whisper';
  signal?: AbortSignal;
}

const INSTRUCTIONS =
  'Transcribe this audio word for word. Reply with the transcript only — no quotes, labels, translation or comments. ' +
  'Write exactly what the speaker says in the language they speak: English stays English. ' +
  'Only when they speak Urdu or Hindi, write those words in Roman Urdu (Latin letters, the way people type in chat). ' +
  'Never guess: if there is no clear speech, reply with an empty message.';

/** Turns recorded WAV audio into text using the configured provider. */
export async function transcribe(recording: Buffer, options: TranscribeOptions): Promise<string> {
  const audio = normalizeWav(recording);
  const base = options.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

  let response: Response;
  if (options.mode === 'whisper') {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', options.model);
    form.append('response_format', 'json');
    response = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers, body: form, signal: options.signal });
  } else {
    headers['Content-Type'] = 'application/json';
    response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      signal: options.signal,
      body: JSON.stringify({
        model: options.model,
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'input_audio', input_audio: { data: audio.toString('base64'), format: 'wav' } },
              { type: 'text', text: INSTRUCTIONS },
            ],
          },
        ],
      }),
    });
  }

  const body = await response.text();
  if (!response.ok) {
    const hint =
      response.status === 400 && options.mode === 'chat'
        ? ' This model may not accept audio — pick another model or set apexdev.voice.transcription to "whisper".'
        : '';
    throw new Error(`Transcription failed (${response.status}): ${apiError(body)}${hint}`);
  }
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error('Transcription failed: the API returned something that is not JSON.');
  }
  const text: unknown = options.mode === 'whisper' ? json.text : json.choices?.[0]?.message?.content;
  return typeof text === 'string' ? cleanTranscript(text) : '';
}

export function cleanTranscript(text: string): string {
  const label = /^transcript(ion)?\s*:\s*/i;
  return text
    .trim()
    .replace(label, '')
    .replace(/^["“](.*)["”]$/s, '$1')
    .trim()
    .replace(label, '')
    .trim();
}

/**
 * Raises quiet 16-bit PCM recordings to a healthy level (peak ≈ 90%, at most 20× gain).
 * Laptop mics often record speech at a few percent of full scale, which speech models
 * then mishear or fill in with guesses. Anything that is not 16-bit PCM WAV is returned unchanged.
 */
export function normalizeWav(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return wav;
  let pcm16 = false;
  for (let at = 12; at + 8 <= wav.length; ) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    const start = at + 8;
    if (id === 'fmt ' && start + 16 <= wav.length) pcm16 = wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 14) === 16;
    if (id === 'data') {
      if (!pcm16) return wav;
      const end = Math.min(start + size, wav.length) & ~1;
      let peak = 0;
      for (let i = start; i < end; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
      const gain = peak ? Math.min(20, (0.9 * 32767) / peak) : 1;
      if (gain < 1.2) return wav;
      const out = Buffer.from(wav);
      for (let i = start; i < end; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(wav.readInt16LE(i) * gain))), i);
      return out;
    }
    at = start + size + (size & 1);
  }
  return wav;
}

function apiError(body: string): string {
  try {
    const json = JSON.parse(body);
    const error = Array.isArray(json) ? json[0]?.error : json.error;
    return (typeof error === 'string' ? error : error?.message) || body.slice(0, 300);
  } catch {
    return body.slice(0, 300) || 'request failed';
  }
}
