import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

/** Longest recording before it stops by itself. */
export const MAX_RECORDING_MS = 120_000;

/**
 * Records the microphone in the extension host. Webviews cannot open the microphone,
 * so audio is captured by a small native helper and handed back as a WAV buffer.
 * Windows uses the built-in MCI API through PowerShell; macOS/Linux use `rec` (SoX) or `arecord`.
 */
export class VoiceRecorder {
  private proc?: ChildProcess;
  private file?: string;
  private output = '';
  private exited?: Promise<void>;

  constructor(
    private readonly scriptPath: string,
    private readonly tempDir: string,
  ) {}

  get recording(): boolean {
    return Boolean(this.proc);
  }

  async start(): Promise<void> {
    if (this.proc) throw new Error('Already recording.');
    await fs.mkdir(this.tempDir, { recursive: true });
    const file = path.join(this.tempDir, `voice-${randomBytes(4).toString('hex')}.wav`);
    const proc = spawnRecorder(this.scriptPath, file);
    this.proc = proc;
    this.file = file;
    this.output = '';
    proc.stdout?.on('data', (d) => (this.output += d.toString()));
    proc.stderr?.on('data', (d) => (this.output += d.toString()));
    this.exited = new Promise((resolve) => proc.once('close', () => resolve()));
    proc.once('close', () => {
      if (this.proc === proc) this.proc = undefined;
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The recorder did not start within 15 s.')), 15_000);
        const done = (err?: Error) => {
          clearTimeout(timer);
          proc.stdout?.off('data', check);
          err ? reject(err) : resolve();
        };
        // PowerShell reports READY; SoX/arecord just start writing, so a short wait is enough.
        const check = () => {
          if (this.output.includes('READY')) done();
          else if (this.output.includes('ERROR')) done(new Error(recorderError(this.output)));
        };
        proc.stdout?.on('data', check);
        proc.once('error', (err) => done(new Error(missingRecorderMessage(err))));
        proc.once('close', (code) => done(new Error(recorderError(this.output) || `The recorder exited (code ${code}).`)));
        if (process.platform !== 'win32') setTimeout(() => this.proc === proc && done(), 400);
      });
    } catch (err) {
      this.cancel();
      throw err;
    }
  }

  /** Stops recording and returns the WAV audio. */
  async stop(): Promise<Buffer> {
    const proc = this.proc;
    const file = this.file;
    if (!proc || !file) throw new Error('Not recording.');
    if (process.platform === 'win32') proc.stdin?.end('save\n');
    else proc.kill('SIGINT');
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 10_000))]);
    this.proc = undefined;
    try {
      const audio = await fs.readFile(file);
      if (audio.length <= 44) throw new Error('No audio was recorded. Check that a microphone is connected and allowed.');
      return audio;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(recorderError(this.output) || 'No audio was recorded. Check that a microphone is connected and allowed.');
      }
      throw err;
    } finally {
      void fs.rm(file, { force: true });
    }
  }

  cancel(): void {
    const proc = this.proc;
    this.proc = undefined;
    if (proc) {
      if (process.platform === 'win32') proc.stdin?.end('cancel\n');
      else proc.kill('SIGINT');
      setTimeout(() => proc.exitCode === null && proc.kill(), 3000);
    }
    if (this.file) void fs.rm(this.file, { force: true });
  }
}

function spawnRecorder(scriptPath: string, file: string): ChildProcess {
  if (process.platform === 'win32') {
    return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Out', file], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  if (process.platform === 'darwin') {
    return spawn('rec', ['-q', '-r', '16000', '-c', '1', '-b', '16', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return spawn('arecord', ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', file], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function recorderError(output: string): string {
  const line = output.split(/\r?\n/).find((l) => l.startsWith('ERROR'));
  if (!line) return '';
  const message = line.slice(6).trim();
  return /MCI error 328|no device|not found|cannot find/i.test(message)
    ? `No microphone was found. Connect one and allow apps to use it in Windows Settings → Privacy → Microphone. (${message})`
    : message;
}

function missingRecorderMessage(err: Error): string {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return err.message;
  return process.platform === 'darwin'
    ? 'Voice input on macOS needs SoX: install it with `brew install sox`.'
    : 'Voice input on Linux needs `arecord` (package alsa-utils).';
}
