// 16-bit PCM WAV encoder. Pure: channel sample arrays in, file bytes out (browser and Node).

/**
 * @param {Float32Array[]} channels samples in -1…1 per channel, all the same length
 * @param {number} sampleRate e.g. 44100
 * @returns {Uint8Array} a complete .wav file
 */
export function encodeWav(channels, sampleRate) {
  const frames = channels[0]?.length ?? 0;
  if (channels.some((c) => c.length !== frames)) throw new Error('All channels must have the same length');
  const blockAlign = channels.length * 2;
  const dataSize = frames * blockAlign;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const text = (offset, s) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));

  text(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let f = 0; f < frames; f++) {
    for (const channel of channels) {
      view.setInt16(offset, toInt16(channel[f]), true);
      offset += 2;
    }
  }
  return bytes;
}

// Full scale is asymmetric in 16-bit: -32768…32767. Out-of-range values are clipped; NaN is silence.
function toInt16(v) {
  if (!(v === v)) return 0; // NaN
  const x = Math.max(-1, Math.min(1, v));
  return Math.round(x < 0 ? x * 32768 : x * 32767);
}
