// WAV export: renders a saved song offline (no count-in, from bar 1) into a stereo backup file:
// left = click + guide, right = stems at their saved volume/mute and offset. Uses the same
// schedule and stem timing as live playback, so the file matches what the band hears.
import { buildSchedule, stemStart } from '/shared/schedule.js';
import { encodeWav } from '/shared/wav.js';
import { createExportRouting, dbToGain } from './routing.js';

const SAMPLE_RATE = 44100;
// The safety limiter delays audio slightly (6 ms in Chrome) and needs a moment to settle, so the
// song is rendered after a short silent pre-roll and the file is cut to start exactly at bar 1.
const PREROLL_SEC = 0.1;

/**
 * @returns {Promise<{ channels: Float32Array[], sampleRate: number, seconds: number, warnings: string[] }>}
 */
export async function renderSong(song, catalog) {
  const schedule = buildSchedule(song, catalog, { countIn: false });
  const songFrames = Math.ceil(schedule.totalSec * SAMPLE_RATE);
  const prerollFrames = Math.round(PREROLL_SEC * SAMPLE_RATE);
  const latencyFrames = await measureLatency();
  const ctx = new OfflineAudioContext(2, prerollFrames + latencyFrames + songFrames, SAMPLE_RATE);
  const t0 = prerollFrames / SAMPLE_RATE;
  const routing = createExportRouting(ctx);
  const warnings = [...schedule.warnings];

  const buffers = new Map();
  await Promise.all([...new Set(schedule.events.map((e) => e.sample))].map(async (sample) => {
    try {
      buffers.set(sample, await decode(ctx, '/samples/' + sample.split('/').map(encodeURIComponent).join('/')));
    } catch {
      warnings.push(`Could not load sample ${sample}; it is silent in the export.`);
    }
  }));
  for (const e of schedule.events) {
    const buffer = buffers.get(e.sample);
    if (!buffer) continue;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = dbToGain(e.gainDb);
    src.connect(gain).connect(routing.clickGuide);
    src.start(t0 + e.t);
  }

  const { delaySec, fileOffsetSec } = stemStart(0, song.stemOffsetMs);
  await Promise.all(song.stems.filter((s) => !s.muted).map(async (stem) => {
    let buffer;
    try {
      buffer = await decode(ctx, `/api/songs/${song.id}/stems/${encodeURIComponent(stem.file)}`);
    } catch {
      warnings.push(`Stem "${stem.name}" could not be loaded; it is missing from the export.`);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = dbToGain(stem.volumeDb);
    src.connect(gain).connect(routing.stems);
    src.start(t0 + delaySec, fileOffsetSec);
  }));

  const rendered = await ctx.startRendering();
  const start = prerollFrames + latencyFrames;
  return {
    channels: [0, 1].map((c) => rendered.getChannelData(c).slice(start, start + songFrames)),
    sampleRate: SAMPLE_RATE,
    seconds: schedule.totalSec,
    warnings: warnings.sort(),
  };
}

/** Renders, encodes and saves the export on the server. @returns file name, bytes and warnings */
export async function exportSong(song, catalog) {
  const { channels, sampleRate, seconds, warnings } = await renderSong(song, catalog);
  const bytes = encodeWav(channels, sampleRate);
  const res = await fetch(`/api/exports/${song.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: bytes,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return { file: data.file, bytes, seconds, warnings };
}

// How many frames the output chain delays audio: one sample sent through it after the pre-roll.
let latencyCache;
async function measureLatency() {
  if (latencyCache !== undefined) return latencyCache;
  const frames = Math.round(PREROLL_SEC * SAMPLE_RATE);
  const ctx = new OfflineAudioContext(2, frames * 2, SAMPLE_RATE);
  const routing = createExportRouting(ctx);
  const impulse = ctx.createBuffer(1, 1, SAMPLE_RATE);
  impulse.getChannelData(0)[0] = 0.5;
  const src = ctx.createBufferSource();
  src.buffer = impulse;
  src.connect(routing.clickGuide);
  src.start(frames / SAMPLE_RATE);
  const left = (await ctx.startRendering()).getChannelData(0);
  const arrived = left.findIndex((v) => Math.abs(v) > 1e-6);
  latencyCache = arrived < frames ? 0 : arrived - frames;
  return latencyCache;
}

async function decode(ctx, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ctx.decodeAudioData(await res.arrayBuffer());
}
