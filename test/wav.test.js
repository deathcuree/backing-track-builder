import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav } from '../shared/wav.js';

// Independent reader, written from the WAV (RIFF) format description, not from the encoder.
function readWav(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o, n) => String.fromCharCode(...bytes.subarray(o, o + n));
  const channels = v.getUint16(22, true);
  const dataSize = v.getUint32(40, true);
  const frames = dataSize / (channels * 2);
  const samples = Array.from({ length: channels }, () => []);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) samples[c].push(v.getInt16(44 + (f * channels + c) * 2, true));
  }
  return {
    riff: str(0, 4), riffSize: v.getUint32(4, true), wave: str(8, 4), fmt: str(12, 4), fmtSize: v.getUint32(16, true),
    format: v.getUint16(20, true), channels, sampleRate: v.getUint32(24, true), byteRate: v.getUint32(28, true),
    blockAlign: v.getUint16(32, true), bits: v.getUint16(34, true), data: str(36, 4), dataSize, samples,
  };
}

test('writes a standard 16-bit PCM stereo header', () => {
  const bytes = encodeWav([new Float32Array(3), new Float32Array(3)], 44100);
  const w = readWav(bytes);
  assert.equal(bytes.length, 44 + 3 * 2 * 2);
  assert.deepEqual(
    { riff: w.riff, riffSize: w.riffSize, wave: w.wave, fmt: w.fmt, fmtSize: w.fmtSize, format: w.format,
      channels: w.channels, sampleRate: w.sampleRate, byteRate: w.byteRate, blockAlign: w.blockAlign, bits: w.bits,
      data: w.data, dataSize: w.dataSize },
    { riff: 'RIFF', riffSize: 36 + 12, wave: 'WAVE', fmt: 'fmt ', fmtSize: 16, format: 1,
      channels: 2, sampleRate: 44100, byteRate: 44100 * 4, blockAlign: 4, bits: 16, data: 'data', dataSize: 12 },
  );
});

test('interleaves left then right and converts samples to 16-bit', () => {
  const left = Float32Array.from([0, 0.5, 1, -1, 2]);
  const right = Float32Array.from([-0.5, 0.25, -2, 1e-6, NaN]);
  const w = readWav(encodeWav([left, right], 48000));
  assert.equal(w.sampleRate, 48000);
  assert.deepEqual(w.samples[0], [0, 16384, 32767, -32768, 32767]);
  assert.deepEqual(w.samples[1], [-16384, 8192, -32768, 0, 0]);
});

test('a click at a sample position stays at that exact position', () => {
  const left = new Float32Array(44100);
  left[22050] = 1;
  const w = readWav(encodeWav([left, new Float32Array(44100)], 44100));
  assert.equal(w.samples[0].findIndex((s) => s !== 0), 22050);
});

test('channels of different lengths are rejected', () => {
  assert.throws(() => encodeWav([new Float32Array(2), new Float32Array(3)], 44100), /same length/);
});
