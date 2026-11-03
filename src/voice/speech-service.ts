import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { appPath, pythonCommandWithRequiredModule } from '../runtime/platform.js';

const execFileAsync = promisify(execFile);
const speechScriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'voice', 'windows-speech.ps1');
const voskScriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'voice', 'vosk-transcribe.py');
const VOSK_MODEL_DIRECTORY = 'vosk-model-small-en-us-0.15';

export type VoiceStyle = 'natural' | 'robotic' | 'alien';
export type SpeechRecognitionMode = 'dictation' | 'wake';
export type SpeechRecognitionEngine = 'vosk' | 'windows-sapi';

export interface SpeechVoiceOption {
  id: string;
  label: string;
  language: string;
  engine: 'windows-sapi';
}

export interface SpeechCapabilities {
  transcriptionAvailable: boolean;
  recognitionEngine: SpeechRecognitionEngine | null;
  synthesisAvailable: boolean;
  voices: SpeechVoiceOption[];
}

interface WindowsVoice {
  name: string;
  language: string;
  gender: string;
}

export interface SpeechSynthesisRequest {
  text: string;
  voiceId: string;
  rate: number;
  pitch: number;
  volume: number;
  style: VoiceStyle;
}

export interface SpeechSynthesisResult {
  path: string;
  voice: string;
  engine: 'Windows System.Speech';
}

const SPEECH_TRAILING_SILENCE_MS = 2_000;
const MAX_PADDED_WAV_BYTES = 8 * 1024 * 1024;
let voskPythonCommandPromise: Promise<{ file: string; args: string[] } | null> | undefined;
let voskWorkerPromise: Promise<VoskWorker> | undefined;

interface VoskWorkerResponse {
  requestId?: string;
  ready?: boolean;
  error?: string;
  [key: string]: unknown;
}

interface VoskWorker {
  child: ChildProcessWithoutNullStreams;
  pending: Map<string, { resolve: (response: VoskWorkerResponse) => void; reject: (failure: Error) => void }>;
}

const PROFILE_VOICES = [
  { id: 'preset:nova', label: 'Nova style', gender: 'female', preferredVoice: 'Microsoft Zira Desktop' },
  { id: 'preset:alloy', label: 'Alloy style', gender: 'female', preferredVoice: 'Microsoft Zira Desktop' },
  { id: 'preset:echo', label: 'Echo style', gender: 'male', preferredVoice: 'Microsoft David Desktop' },
  { id: 'preset:fable', label: 'Fable style', gender: 'female', preferredVoice: 'Microsoft Zira Desktop' },
  { id: 'preset:onyx', label: 'Onyx style', gender: 'male', preferredVoice: 'Microsoft David Desktop' },
  { id: 'preset:shimmer', label: 'Shimmer style', gender: 'female', preferredVoice: 'Microsoft Zira Desktop' },
] as const;

let windowsVoicesPromise: Promise<WindowsVoice[]> | undefined;
let windowsRecognizersPromise: Promise<string[]> | undefined;

export async function getSpeechCapabilities(): Promise<SpeechCapabilities> {
  if (process.platform !== 'win32') {
    return {
      transcriptionAvailable: false,
      recognitionEngine: null,
      synthesisAvailable: false,
      voices: [],
    };
  }

  const [voices, recognizers, voskPythonCommand] = await Promise.all([
    getWindowsVoices(),
    getWindowsRecognizers(),
    getVoskPythonCommand(),
  ]);
  if (voskPythonCommand) {
    void getVoskWorker(voskPythonCommand).catch(failure => {
      console.error('[voice] Could not start the offline Vosk worker:', failure);
    });
  }
  const recognitionEngine = voskPythonCommand ? 'vosk' : recognizers.length ? 'windows-sapi' : null;
  return {
    transcriptionAvailable: recognitionEngine !== null,
    recognitionEngine,
    synthesisAvailable: voices.length > 0,
    voices: getVoiceOptions(voices),
  };
}

export async function transcribeWindowsAudio(
  audioPath: string,
  mode: SpeechRecognitionMode = 'dictation',
  agentName = '',
): Promise<{
  text: string;
  language: string;
  duration: number;
  processingTime: number;
  isEmpty: boolean;
  confidence?: number;
}> {
  if (process.platform !== 'win32') {
    throw new Error('Local Windows speech recognition is unavailable on this platform.');
  }
  let inputPath = audioPath;
  let temporaryDirectory = '';
  try {
    const voskPythonCommand = await getVoskPythonCommand();
    if (path.extname(audioPath).toLocaleLowerCase() !== '.wav') {
      temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'symbiote-speech-convert-'));
      inputPath = path.join(temporaryDirectory, `recording-${randomUUID()}.wav`);
      const conversionArguments = [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        audioPath,
      ];
      if (!voskPythonCommand) {
        conversionArguments.push('-af', `apad=pad_dur=${SPEECH_TRAILING_SILENCE_MS / 1000}`);
      }
      conversionArguments.push(
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        inputPath,
      );
      await execFileAsync(process.env.SYMBIOTE_FFMPEG_BIN ?? 'ffmpeg', conversionArguments, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 1_000_000,
      });
    } else {
      const audio = await fs.promises.readFile(audioPath);
      const paddedAudio = voskPythonCommand ? null : appendPcmWavSilence(audio);
      if (paddedAudio) {
        temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'symbiote-speech-pad-'));
        inputPath = path.join(temporaryDirectory, `recording-${randomUUID()}.wav`);
        await fs.promises.writeFile(inputPath, paddedAudio, { flag: 'wx', mode: 0o600 });
      }
    }

    const result = voskPythonCommand
      ? parseJsonObject(await runVosk(inputPath, mode, agentName, voskPythonCommand), 'Offline Vosk recognition')
      : parseJsonObject(
        await runPowerShell('transcribe', ['-InputPath', inputPath, '-Mode', mode, '-AgentName', agentName]),
        'Windows speech recognition',
      );
    const text = typeof result.text === 'string' ? result.text : '';
    const confidence = typeof result.confidence === 'number' && Number.isFinite(result.confidence)
      ? result.confidence
      : undefined;
    return {
      text,
      language: typeof result.language === 'string' ? result.language : 'en-US',
      duration: finiteNumber(result.duration),
      processingTime: finiteNumber(result.processingTime),
      isEmpty: text.trim().length === 0,
      ...(confidence === undefined ? {} : { confidence }),
    };
  } finally {
    if (temporaryDirectory) await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function getVoskModelPath(): string {
  const configuredPath = process.env.SYMBIOTE_VOICE_MODEL;
  return configuredPath
    ? path.resolve(configuredPath)
    : appPath('models', VOSK_MODEL_DIRECTORY);
}

async function getVoskPythonCommand(): Promise<{ file: string; args: string[] } | null> {
  const modelPath = getVoskModelPath();
  if (!fs.existsSync(path.join(modelPath, 'am', 'final.mdl'))) return null;
  if (!voskPythonCommandPromise) {
    const configuredPython = process.env.SYMBIOTE_VOICE_PYTHON ?? process.env.SYMBIOTE_PYTHON;
    voskPythonCommandPromise = Promise.resolve().then(() => configuredPython
      ? { file: configuredPython, args: [voskScriptPath] }
      : pythonCommandWithRequiredModule(voskScriptPath, 'vosk'))
      .catch(failure => {
        console.error('[voice] Offline Vosk is unavailable; falling back to Windows speech recognition:', failure);
        return null;
      });
  }
  return voskPythonCommandPromise;
}

async function runVosk(
  audioPath: string,
  mode: SpeechRecognitionMode,
  agentName: string,
  command: { file: string; args: string[] },
): Promise<string> {
  const worker = await getVoskWorker(command);
  const requestId = randomUUID();
  const response = await new Promise<VoskWorkerResponse>((resolve, reject) => {
    const requestTimeout = setTimeout(() => {
      const request = worker.pending.get(requestId);
      if (!request) return;
      worker.pending.delete(requestId);
      request.reject(new Error('Offline Vosk recognition timed out.'));
    }, 120_000);
    requestTimeout.unref();
    worker.pending.set(requestId, {
      resolve: result => {
        clearTimeout(requestTimeout);
        resolve(result);
      },
      reject: failure => {
        clearTimeout(requestTimeout);
        reject(failure);
      },
    });
    worker.child.stdin.write(`${JSON.stringify({ requestId, audio: audioPath, mode, agentName })}\n`, error => {
      if (!error) return;
      const request = worker.pending.get(requestId);
      if (!request) return;
      worker.pending.delete(requestId);
      request.reject(error);
    });
  });
  if (response.error) throw new Error(response.error);
  const { requestId: _requestId, ...result } = response;
  return JSON.stringify(result);
}

function getVoskWorker(command: { file: string; args: string[] }): Promise<VoskWorker> {
  if (voskWorkerPromise) return voskWorkerPromise;

  const workerPromise = new Promise<VoskWorker>((resolve, reject) => {
    const child = spawn(command.file, [
      ...command.args,
      '--server',
      '--model',
      getVoskModelPath(),
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const worker: VoskWorker = { child, pending: new Map() };
    const lines = createInterface({ input: child.stdout });
    let ready = false;
    let failed = false;
    const startupTimeout = setTimeout(() => fail(new Error('Offline Vosk worker did not finish loading its model in time.')), 120_000);
    startupTimeout.unref();

    const rejectPending = (failure: Error) => {
      for (const request of worker.pending.values()) request.reject(failure);
      worker.pending.clear();
    };
    const fail = (failure: Error) => {
      if (failed) return;
      failed = true;
      clearTimeout(startupTimeout);
      if (!ready) reject(failure);
      rejectPending(failure);
      child.kill();
      if (voskWorkerPromise === workerPromise) voskWorkerPromise = undefined;
    };

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => console.error(`[voice] Vosk: ${String(chunk).trimEnd()}`));
    lines.on('line', line => {
      let response: VoskWorkerResponse;
      try {
        response = parseJsonObject(line, 'Offline Vosk worker response');
      } catch (failure) {
        fail(failure instanceof Error ? failure : new Error(String(failure)));
        return;
      }
      if (response.ready === true && !ready) {
        ready = true;
        clearTimeout(startupTimeout);
        resolve(worker);
        return;
      }
      if (typeof response.requestId !== 'string') {
        fail(new Error('Offline Vosk worker returned a response without a request ID.'));
        return;
      }
      const request = worker.pending.get(response.requestId);
      if (!request) {
        console.warn(`[voice] Ignoring an unknown Vosk worker response: ${response.requestId}`);
        return;
      }
      worker.pending.delete(response.requestId);
      request.resolve(response);
    });
    child.on('error', failure => fail(failure));
    child.on('exit', (code, signal) => {
      const failure = new Error(`Offline Vosk worker exited (${signal ?? code ?? 'unknown status'}).`);
      clearTimeout(startupTimeout);
      if (!ready) reject(failure);
      rejectPending(failure);
      if (voskWorkerPromise === workerPromise) voskWorkerPromise = undefined;
    });
    process.once('exit', () => child.kill());
  });

  voskWorkerPromise = workerPromise;
  void workerPromise.catch(() => {
    if (voskWorkerPromise === workerPromise) voskWorkerPromise = undefined;
  });
  return workerPromise;
}

export function appendPcmWavSilence(audio: Buffer): Buffer | null {
  if (audio.length < 44 || audio.length > MAX_PADDED_WAV_BYTES
    || audio.toString('ascii', 0, 4) !== 'RIFF'
    || audio.toString('ascii', 8, 12) !== 'WAVE'
    || audio.toString('ascii', 12, 16) !== 'fmt '
    || audio.readUInt32LE(16) !== 16
    || audio.readUInt16LE(20) !== 1
    || audio.readUInt16LE(22) !== 1
    || audio.readUInt16LE(34) !== 16
    || audio.toString('ascii', 36, 40) !== 'data') return null;

  const sampleRate = audio.readUInt32LE(24);
  const dataLength = audio.readUInt32LE(40);
  if (sampleRate === 0 || dataLength !== audio.length - 44) return null;

  const silenceLength = Math.ceil(sampleRate * SPEECH_TRAILING_SILENCE_MS / 1000) * 2;
  const padded = Buffer.alloc(audio.length + silenceLength);
  audio.copy(padded);
  padded.writeUInt32LE(36 + dataLength + silenceLength, 4);
  padded.writeUInt32LE(dataLength + silenceLength, 40);
  return padded;
}

export async function synthesizeWindowsSpeech(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
  if (process.platform !== 'win32') {
    throw new Error('Microsoft System.Speech synthesis is available only on Windows.');
  }
  const text = request.text.trim();
  if (!text || text.length > 10_000) throw new Error('Speech text must contain between 1 and 10,000 characters.');
  if (!Number.isFinite(request.rate) || request.rate < 0.6 || request.rate > 1.6) {
    throw new Error('Speech speed must be between 0.6 and 1.6.');
  }
  if (!Number.isFinite(request.pitch) || request.pitch < 0.5 || request.pitch > 2) {
    throw new Error('Speech pitch must be between 0.5 and 2.');
  }
  if (!Number.isFinite(request.volume) || request.volume < 0 || request.volume > 1) {
    throw new Error('Speech volume must be between 0 and 1.');
  }
  if (!['natural', 'robotic', 'alien'].includes(request.style)) {
    throw new Error('Unsupported speech style.');
  }

  const voices = await getWindowsVoices();
  const selectedVoice = resolveVoice(voices, request.voiceId);
  if (!selectedVoice) throw new Error('The selected Windows speech voice is not available.');

  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'symbiote-speech-'));
  const inputPath = path.join(directory, 'request.json');
  const outputPath = path.join(directory, `speech-${randomUUID()}.wav`);
  const style = request.style;
  const styleRate = request.rate * (style === 'robotic' ? 0.9 : style === 'alien' ? 1.1 : 1);
  const stylePitch = request.pitch * (style === 'robotic' ? 0.78 : style === 'alien' ? 1.25 : 1);
  const synthesisInput = {
    text,
    voice: selectedVoice.name,
    rate: Math.max(0.6, Math.min(1.6, styleRate)),
    pitch: Math.max(0.5, Math.min(2, stylePitch)),
    volume: request.volume,
  };

  try {
    await fs.promises.writeFile(inputPath, JSON.stringify(synthesisInput), { flag: 'wx', mode: 0o600 });
    await runPowerShell('synthesize', ['-InputPath', inputPath, '-OutputPath', outputPath]);
    const stats = await fs.promises.stat(outputPath);
    if (stats.size <= 44) throw new Error('Windows speech synthesis returned an empty audio file.');
    return {
      path: outputPath,
      voice: selectedVoice.name,
      engine: 'Windows System.Speech',
    };
  } catch (failure) {
    await fs.promises.rm(directory, { recursive: true, force: true });
    throw failure;
  }
}

export async function removeSpeechFile(filePath: string): Promise<void> {
  await fs.promises.rm(path.dirname(filePath), { recursive: true, force: true });
}

async function getWindowsVoices(): Promise<WindowsVoice[]> {
  if (process.platform !== 'win32') return [];
  if (!windowsVoicesPromise) {
    windowsVoicesPromise = runPowerShell('voices')
      .then(stdout => {
        const parsed = JSON.parse(stdout.trim()) as WindowsVoice[] | WindowsVoice;
        const voices = Array.isArray(parsed) ? parsed : [parsed];
        return voices.filter(voice => typeof voice.name === 'string' && typeof voice.language === 'string');
      })
      .catch(failure => {
        windowsVoicesPromise = undefined;
        throw failure;
      });
  }
  return windowsVoicesPromise;
}

async function getWindowsRecognizers(): Promise<string[]> {
  if (!windowsRecognizersPromise) {
    windowsRecognizersPromise = runPowerShell('recognizers')
      .then(stdout => {
        const parsed: unknown = JSON.parse(stdout.trim());
        const recognizers = Array.isArray(parsed) ? parsed : [parsed];
        return recognizers.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      })
      .catch(failure => {
        windowsRecognizersPromise = undefined;
        throw failure;
      });
  }
  return windowsRecognizersPromise;
}

function getVoiceOptions(voices: WindowsVoice[]): SpeechVoiceOption[] {
  const systemOptions = voices.map(voice => ({
    id: `system:${voice.name}`,
    label: `${voice.name} · ${voice.language}`,
    language: voice.language,
    engine: 'windows-sapi' as const,
  }));
  const profileOptions = PROFILE_VOICES.flatMap(profile => {
    const voice = voices.find(item => item.name === profile.preferredVoice)
      ?? voices.find(item => item.gender.toLocaleLowerCase() === profile.gender)
      ?? voices[0];
    return voice ? [{
      id: profile.id,
      label: `${profile.label} · ${voice.name}`,
      language: voice.language,
      engine: 'windows-sapi' as const,
    }] : [];
  });
  return [...profileOptions, ...systemOptions];
}

function resolveVoice(voices: WindowsVoice[], voiceId: string): WindowsVoice | undefined {
  if (voiceId.startsWith('system:')) {
    return voices.find(voice => voice.name === voiceId.slice('system:'.length));
  }
  const profile = PROFILE_VOICES.find(item => item.id === voiceId);
  if (!profile) return voices[0];
  return voices.find(voice => voice.name === profile.preferredVoice)
    ?? voices.find(voice => voice.gender.toLocaleLowerCase() === profile.gender)
    ?? voices[0];
}

async function runPowerShell(action: string, extraArguments: string[] = []): Promise<string> {
  if (!fs.existsSync(speechScriptPath)) {
    throw new Error(`The local Windows speech helper is missing: ${speechScriptPath}`);
  }
  try {
    const { stdout } = await execFileAsync(process.env.SYMBIOTE_POWERSHELL_BIN ?? 'powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      speechScriptPath,
      '-Action',
      action,
      ...extraArguments,
    ], { encoding: 'utf8', windowsHide: true, timeout: 90_000, maxBuffer: 1_000_000 });
    return stdout;
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    const stderr = readStderr(failure);
    throw new Error(`Windows speech ${action} failed: ${stderr || message}`);
  }
}

function parseJsonObject(value: string, operation: string): Record<string, unknown> {
  let result: unknown;
  try {
    result = JSON.parse(value.trim());
  } catch (failure) {
    throw new Error(`${operation} returned invalid JSON: ${failure instanceof Error ? failure.message : String(failure)}`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`${operation} returned an invalid response.`);
  }
  return result as Record<string, unknown>;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readStderr(failure: unknown): string {
  if (!failure || typeof failure !== 'object' || !('stderr' in failure)) return '';
  return typeof failure.stderr === 'string' ? failure.stderr.trim() : '';
}
