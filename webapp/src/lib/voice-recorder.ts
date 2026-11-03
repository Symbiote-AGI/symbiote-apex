const TARGET_SAMPLE_RATE = 16_000;

export interface PcmWavRecorder {
  take(): Blob;
  stop(): Promise<Blob>;
}

export interface PcmWavRecorderSetup {
  audioContext: AudioContext;
  activation: Promise<void>;
}

export interface PcmWavAnalysis {
  durationSeconds: number;
  rms: number;
  peak: number;
  trailingSilenceMs: number;
}

export async function combinePcmWav(first: Blob, second: Blob): Promise<Blob> {
  const [firstBuffer, secondBuffer] = await Promise.all([first.arrayBuffer(), second.arrayBuffer()]);
  const firstView = validatePcmWav(firstBuffer);
  const secondView = validatePcmWav(secondBuffer);
  if (firstView.getUint32(24, true) !== secondView.getUint32(24, true)) {
    throw new Error('PCM WAV recordings must use the same sample rate.');
  }
  const firstDataLength = firstView.getUint32(40, true);
  const secondDataLength = secondView.getUint32(40, true);
  const buffer = new ArrayBuffer(44 + firstDataLength + secondDataLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(new Uint8Array(firstBuffer, 0, 44), 0);
  bytes.set(new Uint8Array(firstBuffer, 44, firstDataLength), 44);
  bytes.set(new Uint8Array(secondBuffer, 44, secondDataLength), 44 + firstDataLength);
  const view = new DataView(buffer);
  view.setUint32(4, 36 + firstDataLength + secondDataLength, true);
  view.setUint32(40, firstDataLength + secondDataLength, true);
  return new Blob([buffer], { type: 'audio/wav' });
}

export async function tailPcmWav(audio: Blob, durationMs: number): Promise<Blob> {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError('The retained audio duration must be positive.');
  }
  const buffer = await audio.arrayBuffer();
  const sourceView = validatePcmWav(buffer);
  const sampleRate = sourceView.getUint32(24, true);
  const dataLength = sourceView.getUint32(40, true);
  const sampleCount = Math.floor(dataLength / 2);
  const retainedSamples = Math.min(sampleCount, Math.ceil(sampleRate * durationMs / 1000));
  const retainedBytes = retainedSamples * 2;
  const bufferOut = new ArrayBuffer(44 + retainedBytes);
  const bytes = new Uint8Array(bufferOut);
  bytes.set(new Uint8Array(buffer, 0, 44), 0);
  bytes.set(new Uint8Array(buffer, 44 + dataLength - retainedBytes, retainedBytes), 44);
  const view = new DataView(bufferOut);
  view.setUint32(4, 36 + retainedBytes, true);
  view.setUint32(40, retainedBytes, true);
  return new Blob([bufferOut], { type: 'audio/wav' });
}

export async function analyzePcmWav(audio: Blob): Promise<PcmWavAnalysis> {
  const buffer = await audio.arrayBuffer();
  const view = validatePcmWav(buffer);
  const sampleCount = Math.floor(view.getUint32(40, true) / 2);
  const sampleRate = view.getUint32(24, true);
  if (sampleRate <= 0 || sampleCount === 0) {
    return { durationSeconds: 0, rms: 0, peak: 0, trailingSilenceMs: 0 };
  }

  let squaredTotal = 0;
  let peak = 0;
  let lastActiveSample = -1;
  for (let index = 0; index < sampleCount; index++) {
    const sample = view.getInt16(44 + index * 2, true) / 32_768;
    const magnitude = Math.abs(sample);
    squaredTotal += sample * sample;
    peak = Math.max(peak, magnitude);
  }
  const silenceThreshold = Math.max(0.002, peak * 0.12);
  for (let index = 0; index < sampleCount; index++) {
    if (Math.abs(view.getInt16(44 + index * 2, true) / 32_768) >= silenceThreshold) lastActiveSample = index;
  }
  return {
    durationSeconds: sampleCount / sampleRate,
    rms: Math.sqrt(squaredTotal / sampleCount),
    peak,
    trailingSilenceMs: lastActiveSample < 0
      ? sampleCount / sampleRate * 1000
      : (sampleCount - lastActiveSample - 1) / sampleRate * 1000,
  };
}

function validatePcmWav(buffer: ArrayBuffer): DataView {
  if (buffer.byteLength < 44) throw new Error('The PCM WAV recording is invalid.');
  const view = new DataView(buffer);
  if (view.getUint32(0, false) !== 0x52494646
    || view.getUint32(8, false) !== 0x57415645
    || view.getUint16(20, true) !== 1
    || view.getUint16(22, true) !== 1
    || view.getUint16(34, true) !== 16
    || view.getUint32(40, true) > buffer.byteLength - 44) {
    throw new Error('The PCM WAV recording is invalid.');
  }
  return view;
}

export function encodePcmWav(frames: readonly Float32Array[], sampleRate: number): Blob {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError('The audio sample rate must be a positive number.');
  }

  const inputLength = frames.reduce((length, frame) => length + frame.length, 0);
  const input = new Float32Array(inputLength);
  let inputOffset = 0;
  for (const frame of frames) {
    input.set(frame, inputOffset);
    inputOffset += frame.length;
  }

  const outputLength = Math.floor(input.length * TARGET_SAMPLE_RATE / sampleRate);
  const samples = new Int16Array(outputLength);
  if (sampleRate > TARGET_SAMPLE_RATE) {
    const ratio = sampleRate / TARGET_SAMPLE_RATE;
    for (let outputIndex = 0; outputIndex < outputLength; outputIndex++) {
      const start = Math.floor(outputIndex * ratio);
      const end = Math.min(input.length, Math.max(start + 1, Math.floor((outputIndex + 1) * ratio)));
      let total = 0;
      for (let inputIndex = start; inputIndex < end; inputIndex++) total += input[inputIndex];
      samples[outputIndex] = toPcmSample(total / (end - start));
    }
  } else {
    for (let outputIndex = 0; outputIndex < outputLength; outputIndex++) {
      const inputPosition = outputIndex * sampleRate / TARGET_SAMPLE_RATE;
      const left = Math.floor(inputPosition);
      const right = Math.min(input.length - 1, left + 1);
      const fraction = inputPosition - left;
      samples[outputIndex] = toPcmSample(input[left] * (1 - fraction) + input[right] * fraction);
    }
  }

  const buffer = new ArrayBuffer(44 + samples.byteLength);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.byteLength, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.byteLength, true);
  for (let index = 0; index < samples.length; index++) view.setInt16(44 + index * 2, samples[index], true);
  return new Blob([buffer], { type: 'audio/wav' });
}

export function preparePcmWavRecorder(): PcmWavRecorderSetup {
  if (typeof window === 'undefined') {
    throw new Error('PCM audio recording is not supported by this browser.');
  }

  const audioWindow = window as Window & { webkitAudioContext?: typeof AudioContext };
  const AudioContextConstructor = window.AudioContext ?? audioWindow.webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error('PCM audio recording is not supported by this browser.');
  }

  const audioContext = new AudioContextConstructor();
  const activation = audioContext.state === 'suspended' ? audioContext.resume() : Promise.resolve();
  void activation.catch(() => undefined);
  return { audioContext, activation };
}

export async function disposePcmWavRecorderSetup(setup: PcmWavRecorderSetup): Promise<void> {
  if (setup.audioContext.state !== 'closed') await setup.audioContext.close();
}

export async function createPcmWavRecorder(
  stream: MediaStream,
  setup: PcmWavRecorderSetup = preparePcmWavRecorder(),
): Promise<PcmWavRecorder> {
  const { audioContext } = setup;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let mute: GainNode | null = null;
  try {
    await setup.activation;
    if (audioContext.state === 'suspended') await audioContext.resume();
    if (audioContext.state !== 'running') {
      throw new Error('Browser audio capture is paused. Interact with the page and retry dictation.');
    }

    const frames: Float32Array[] = [];
    source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    mute = audioContext.createGain();
    mute.gain.value = 0;
    processor.onaudioprocess = event => frames.push(event.inputBuffer.getChannelData(0).slice());

    source.connect(processor);
    processor.connect(mute);
    mute.connect(audioContext.destination);

    let stopped = false;
    const take = () => {
      const capturedFrames = frames.splice(0, frames.length);
      return encodePcmWav(capturedFrames, audioContext.sampleRate);
    };
    const stop = async () => {
      if (stopped) return new Blob([], { type: 'audio/wav' });
      stopped = true;
      if (processor) processor.onaudioprocess = null;
      const audio = take();
      source?.disconnect();
      processor?.disconnect();
      mute?.disconnect();
      await disposePcmWavRecorderSetup(setup);
      return audio;
    };

    return { take, stop };
  } catch (failure) {
    source?.disconnect();
    processor?.disconnect();
    mute?.disconnect();
    await disposePcmWavRecorderSetup(setup);
    throw failure;
  }
}

export async function audioBlobToBase64(audio: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The audio recording could not be read.'));
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('The audio recording could not be encoded.'));
    reader.readAsDataURL(audio);
  });
  const separator = dataUrl.indexOf(',');
  if (separator < 0) throw new Error('The audio recording could not be encoded.');
  return dataUrl.slice(separator + 1);
}

function toPcmSample(value: number): number {
  const sample = Math.max(-1, Math.min(1, value));
  return Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
}
