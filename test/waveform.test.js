import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peaks, peakRange } from '../shared/waveform.js';

const f32 = (a) => Float32Array.from(a);

test('min and max per bucket; the last bucket may be short', () => {
  const p = peaks([f32([0, 0.5, -0.25, 1, -1])], 2);
  assert.equal(p.bucketSize, 2);
  assert.deepEqual([...p.min], [0, -0.25, -1]);
  assert.deepEqual([...p.max], [0.5, 1, -1]);
});

test('channels are combined: the lowest min and highest max of any channel', () => {
  const p = peaks([f32([0.5, 0.5, 0, 0]), f32([-0.5, 0.25, 0, 0.75])], 2);
  assert.deepEqual([...p.min], [-0.5, 0]);
  assert.deepEqual([...p.max], [0.5, 0.75]);
});

test('no samples, no buckets', () => {
  const p = peaks([f32([])], 256);
  assert.equal(p.min.length, 0);
});

test('peakRange merges buckets for one pixel column, clamped to the data', () => {
  const p = peaks([f32([0.1, -0.2, 0.3, -0.4, 0.5, -0.6])], 2);
  assert.deepEqual(peakRange(p, 0, 2), { min: Math.fround(-0.4), max: Math.fround(0.3) });
  assert.deepEqual(peakRange(p, 2.5, 99), { min: Math.fround(-0.6), max: Math.fround(0.5) });
  assert.equal(peakRange(p, 5, 9), null);
  assert.equal(peakRange(p, -3, -1), null);
});
