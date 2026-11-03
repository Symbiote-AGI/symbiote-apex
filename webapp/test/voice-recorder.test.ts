import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzePcmWav, combinePcmWav, encodePcmWav, tailPcmWav } from '../src/lib/voice-recorder.ts';

test('encodes mono 16-bit PCM WAV at the speech service sample rate', async () => {
  const audio = encodePcmWav([new Float32Array([-1, 0, 1])], 16_000);
  const view = new DataView(await audio.arrayBuffer());

  assert.equal(audio.type, 'audio/wav');
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint16(34, true), 16);
  assert.deepEqual(
    [view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)],
    [-32_768, 0, 32_767],
  );
});

test('downsamples high-rate audio without dropping the final output sample', async () => {
  const audio = encodePcmWav([new Float32Array([1, 1, -1, -1])], 32_000);
  const view = new DataView(await audio.arrayBuffer());

  assert.equal(audio.size, 48);
  assert.deepEqual([view.getInt16(44, true), view.getInt16(46, true)], [32_767, -32_768]);
});

test('measures recorded speech level and trailing silence', async () => {
  const audio = encodePcmWav([new Float32Array([0.25, 0.25, 0, 0])], 16_000);
  const analysis = await analyzePcmWav(audio);

  assert.equal(analysis.durationSeconds, 4 / 16_000);
  assert.ok(analysis.rms > 0.17 && analysis.rms < 0.18);
  assert.ok(analysis.peak > 0.24 && analysis.peak < 0.26);
  assert.equal(analysis.trailingSilenceMs, 0.125);
});

test('keeps a short WAV overlap for wake phrases split across capture windows', async () => {
  const previous = await tailPcmWav(encodePcmWav([new Float32Array([0.25, 0.25, 0.25, 0.25])], 16_000), 0.125);
  const current = encodePcmWav([new Float32Array([-0.25, -0.25])], 16_000);
  const combined = await combinePcmWav(previous, current);
  const view = new DataView(await combined.arrayBuffer());

  assert.equal(view.getUint32(40, true), 8);
  assert.deepEqual(
    Array.from({ length: 4 }, (_, index) => view.getInt16(44 + index * 2, true)),
    [8192, 8192, -8192, -8192],
  );
});
