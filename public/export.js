// WAV export: renders a saved song offline from bar 1 to the song end into a stereo backup file:
// left = tracks routed to the in-ears (or both), right = tracks routed to main (or both), each at
// its saved volume and mute. Uses the same schedule and clip timing as live playback, so the file
// matches what the band hears. Solo and the master levels are live-only and don't apply.
import { buildSchedule, clipStart } from '/shared/schedule.js';
import { encodeWav } from '/shared/wav.js';
import { createExportRouting, createTrackStrip } from './routing.js';

const SAMPLE_RATE = 44100;
// The safety limiter delays audio slightly (6 ms in Chrome) and needs a moment to settle, so the
// song is rendered after a short silent pre-roll and the file is cut to start exactly at bar 1.
const PREROLL_SEC = 0.1;

/**
 * @returns {Promise<{ channels: Float32Array[], sampleRate: number, seconds: number, warnings: string[] }>}
 */
export async function renderSong(song, catalog) {
  const schedule = buildSchedule(song, catalog);
  const songFrames = Math.ceil(schedule.totalSec * SAMPLE_RATE);
  const prerollFrames = Math.round(PREROLL_SEC * SAMPLE_RATE);
  const latencyFrames = await measureLatency();
  const ctx = new OfflineAudioContext(2, prerollFrames + latencyFrames + songFrames, SAMPLE_RATE);
  const t0 = prerollFrames / SAMPLE_RATE;
  const routing = createExportRouting(ctx);
  const strips = new Map(song.tracks.map((t) => [t.id, createTrackStrip(ctx, routing, t)]));
  const audible = (trackId) => !song.tracks.find((t) => t.id === trackId)?.muted;
  const warnings = [...schedule.warnings];

  const buffers = new Map();
  const samples = new Set(schedule.events.filter((e) => audible(e.track)).map((e) => e.sample));
  await Promise.all([...samples].map(async (sample) => {
    try {
      buffers.set(sample, await decode(ctx, '/samples/' + sample.split('/').map(encodeURIComponent).join('/')));
    } catch {
      warnings.push(`Could not load sample ${sample}; it is silent in the export.`);
    }
  }));
  for (const e of schedule.events) {
    const buffer = buffers.get(e.sample);
    if (!buffer || !audible(e.track)) continue;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(strips.get(e.track).input);
    src.start(t0 + e.t);
  }

  await Promise.all(schedule.clips.filter((c) => audible(c.track)).map(async (clip) => {
    let buffer;
    try {
      buffer = await decode(ctx, `/api/songs/${song.id}/stems/${encodeURIComponent(clip.file)}`);
    } catch {
      const name = song.tracks.find((t) => t.id === clip.track)?.name ?? clip.file;
      warnings.push(`Audio "${name}" could not be loaded; it is missing from the export.`);
      return;
    }
    const { delaySec, fileOffsetSec } = clipStart(clip.startSec, 0);
    if (fileOffsetSec >= buffer.duration) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(strips.get(clip.track).input);
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
  src.connect(routing.inEars);
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
