import assert from 'node:assert/strict';
import test from 'node:test';
import { appendPcmWavSilence } from '../voice/speech-service.js';

function pcmWav(sampleRate: number, samples: number): Buffer {
  const dataLength = samples * 2;
  const audio = Buffer.alloc(44 + dataLength);
  audio.write('RIFF', 0, 'ascii');
  audio.writeUInt32LE(36 + dataLength, 4);
  audio.write('WAVEfmt ', 8, 'ascii');
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(sampleRate, 24);
  audio.writeUInt32LE(sampleRate * 2, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36, 'ascii');
  audio.writeUInt32LE(dataLength, 40);
  return audio;
}

test('adds 2 seconds of silence to mono PCM WAV for SAPI phrase finalization', () => {
  const input = pcmWav(16_000, 100);
  const result = appendPcmWavSilence(input);

  assert.ok(result);
  assert.equal(result.length, input.length + 64_000);
  assert.equal(result.readUInt32LE(4), result.length - 8);
  assert.equal(result.readUInt32LE(40), result.length - 44);
  assert.deepEqual(result.subarray(input.length), Buffer.alloc(64_000));
});

test('does not rewrite unsupported WAV formats', () => {
  const input = pcmWav(16_000, 100);
  input.writeUInt16LE(2, 22);
  assert.equal(appendPcmWavSilence(input), null);
});
