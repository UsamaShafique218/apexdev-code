import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { parseModelList } from '../src/llm/models';
import { expandMentions, findMentions } from '../src/ui/mentions';
import { cleanTranscript, normalizeWav, transcribe } from '../src/voice/transcribe';

describe('parseModelList', () => {
  it('reads OpenAI-style lists and drops non-chat models', () => {
    const ids = parseModelList({
      data: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'gpt-4o-mini' }, { id: 'tts-1' }, { id: 'dall-e-3' }],
    });
    assert.deepEqual(ids, ['gpt-4o', 'gpt-4o-mini']);
  });

  it('strips the Gemini models/ prefix and sorts numerically', () => {
    const ids = parseModelList({ data: [{ id: 'models/gemini-2.5-flash' }, { id: 'models/gemini-10-pro' }, { id: 'models/embedding-001' }, { id: 'models/gemini-2.5-flash' }] });
    assert.deepEqual(ids, ['gemini-2.5-flash', 'gemini-10-pro']);
  });

  it('copes with odd shapes', () => {
    assert.deepEqual(parseModelList({ models: ['llama3', 'qwen2.5-coder'] }), ['llama3', 'qwen2.5-coder']);
    assert.deepEqual(parseModelList(null), []);
    assert.deepEqual(parseModelList({ data: 'nope' }), []);
  });
});

describe('mentions', () => {
  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apexdev-mentions-'));
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src', 'app.ts'), 'export const answer = 42;\n');
    await fs.writeFile(path.join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 3]));
  });
  after(() => fs.rm(dir, { recursive: true, force: true }));

  it('finds @paths and ignores e-mail addresses and punctuation', () => {
    assert.deepEqual(findMentions('look at @src/app.ts, and @README.md. mail me@example.com'), ['src/app.ts', 'README.md']);
    assert.deepEqual(findMentions('@a @a'), ['a']);
  });

  it('attaches file contents and folder listings', async () => {
    const out = await expandMentions('Explain @src/app.ts and @src', dir);
    assert.deepEqual(out.attached, ['src/app.ts', 'src']);
    assert.match(out.text, /^Explain @src\/app\.ts and @src\n/);
    assert.match(out.text, /<attached_file path="src\/app\.ts">\nexport const answer = 42;/);
    assert.match(out.text, /<attached_folder path="src">\napp\.ts\n<\/attached_folder>/);
  });

  it('leaves unknown mentions alone and does not inline binaries', async () => {
    const missing = await expandMentions('ping @nobody', dir);
    assert.equal(missing.text, 'ping @nobody');
    assert.deepEqual(missing.attached, []);
    const binary = await expandMentions('@logo.bin', dir);
    assert.match(binary.text, /binary file, 4 bytes/);
  });
});

describe('transcribe', () => {
  const realFetch = globalThis.fetch;
  let calls: Array<{ url: string; init: RequestInit }> = [];
  const respond = (status: number, body: unknown) => {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  };
  afterEach(() => {
    globalThis.fetch = realFetch;
    calls = [];
  });
  const wav = Buffer.alloc(64);

  it('sends audio to the chat model as input_audio', async () => {
    respond(200, { choices: [{ message: { content: '"Transcript: login page bana do"' } }] });
    const text = await transcribe(wav, { baseUrl: 'https://api.test/v1/', apiKey: 'k', model: 'gemini-x', mode: 'chat' });
    assert.equal(text, 'login page bana do');
    assert.equal(calls[0].url, 'https://api.test/v1/chat/completions');
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.model, 'gemini-x');
    assert.deepEqual(body.messages[0].content[0], { type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } });
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer k');
  });

  it('uses /audio/transcriptions in whisper mode', async () => {
    respond(200, { text: ' hello world ' });
    const text = await transcribe(wav, { baseUrl: 'https://api.test/v1', model: 'whisper-1', mode: 'whisper' });
    assert.equal(text, 'hello world');
    assert.equal(calls[0].url, 'https://api.test/v1/audio/transcriptions');
    assert.ok(calls[0].init.body instanceof FormData);
  });

  it('explains a 400 from a model without audio input', async () => {
    respond(400, { error: { message: 'audio not supported' } });
    await assert.rejects(
      transcribe(wav, { baseUrl: 'https://api.test/v1', model: 'm', mode: 'chat' }),
      /400\): audio not supported.*voice\.transcription/,
    );
  });

  it('cleans labels and quotes', () => {
    assert.equal(cleanTranscript('  “kya haal hai”  '), 'kya haal hai');
    assert.equal(cleanTranscript('Transcription: run tests'), 'run tests');
  });
});

describe('normalizeWav', () => {
  const makeWav = (samples: number[]) => {
    const wav = Buffer.alloc(44 + samples.length * 2);
    wav.write('RIFF', 0, 'ascii');
    wav.writeUInt32LE(36 + samples.length * 2, 4);
    wav.write('WAVEfmt ', 8, 'ascii');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); // PCM
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36, 'ascii');
    wav.writeUInt32LE(samples.length * 2, 40);
    samples.forEach((s, i) => wav.writeInt16LE(s, 44 + i * 2));
    return wav;
  };
  const samplesOf = (wav: Buffer) => Array.from({ length: (wav.length - 44) / 2 }, (_, i) => wav.readInt16LE(44 + i * 2));

  it('boosts quiet speech to about 90% peak', () => {
    const out = samplesOf(normalizeWav(makeWav([0, 2000, -3000, 1000])));
    assert.equal(Math.max(...out.map(Math.abs)), Math.round(0.9 * 32767));
    assert.equal(out[1], Math.round(2000 * ((0.9 * 32767) / 3000)));
  });

  it('caps the gain so near-silence is not blown up', () => {
    assert.deepEqual(samplesOf(normalizeWav(makeWav([0, 100, -50]))), [0, 2000, -1000]);
  });

  it('leaves loud audio and non-WAV data untouched', () => {
    const loud = makeWav([0, 30000, -29000]);
    assert.equal(normalizeWav(loud), loud);
    const junk = Buffer.alloc(64);
    assert.equal(normalizeWav(junk), junk);
  });
});
