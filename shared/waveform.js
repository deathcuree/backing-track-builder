// Waveform peaks for drawing audio clips: the lowest and highest sample in each bucket of
// `bucketSize` samples, over all channels. Pure; computed once per file, then merged per pixel
// column at any zoom with peakRange.

/**
 * @param {Float32Array[]} channels sample data per channel (e.g. AudioBuffer.getChannelData)
 * @param {number} bucketSize samples per bucket
 * @returns {{ min: Float32Array, max: Float32Array, bucketSize: number }}
 */
export function peaks(channels, bucketSize) {
  const length = Math.max(0, ...channels.map((c) => c.length));
  const buckets = Math.ceil(length / bucketSize);
  const min = new Float32Array(buckets).fill(Infinity);
  const max = new Float32Array(buckets).fill(-Infinity);
  for (const data of channels) {
    for (let b = 0; b < buckets; b++) {
      const end = Math.min(data.length, (b + 1) * bucketSize);
      let lo = min[b];
      let hi = max[b];
      for (let i = b * bucketSize; i < end; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[b] = lo;
      max[b] = hi;
    }
  }
  return { min, max, bucketSize };
}

/** Merged min/max of buckets [from, to) (fractions round outwards), or null when none are inside. */
export function peakRange({ min, max }, from, to) {
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(min.length, Math.ceil(to));
  if (start >= end) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (let b = start; b < end; b++) {
    if (min[b] < lo) lo = min[b];
    if (max[b] > hi) hi = max[b];
  }
  return { min: lo, max: hi };
}
