// Live player: plays a song's click, guide and stems through Web Audio.
// A 25 ms timer schedules whole bars as they come within 150 ms of the audio clock. Which bar
// comes next is decided by nextPosition (shared/schedule.js), and bar start times are computed
// from whole-bar counts, so long songs and loops never drift.
//
// `prev` is the last scheduled bar (normally the one you hear); `state` is the next, not yet
// scheduled bar. Jump and loop requests change `prev` and recompute `state`, so they take effect
// on the next downbeat. Only a request in the last ~150 ms of a bar lands one bar later, because
// the next bar is already scheduled by then. Stems restart at jumps/loops with a 10 ms crossfade.
import { buildSchedule, initialPlayState, nextPosition, barEvents, stemStart, secAtBar } from '/shared/schedule.js';
import { createRouting, dbToGain, setLevel } from './routing.js';

const TIMER_MS = 25;
const HORIZON_SEC = 0.15;
const START_DELAY_SEC = 0.1;
const SEAM_FADE_SEC = 0.01;

export class Player {
  /**
   * @param {{ onPosition?: (pos: { bar: number, beat: number, fraction: number, countIn: boolean,
   *             section: number, pendingJump: number|null, loop: number|null } | null) => void,
   *           onStateChange?: (playing: boolean) => void }} handlers
   */
  constructor({ onPosition = () => {}, onStateChange = () => {} } = {}) {
    this.onPosition = onPosition;
    this.onStateChange = onStateChange;
    this.ctx = null;
    this.routing = null;
    this.buffers = new Map(); // sample path -> AudioBuffer (kept across songs; samples are small)
    this.stemBuffers = new Map(); // "<song id>/<file>" -> AudioBuffer, current song only (stems are big)
    this.stemGains = new Map(); // file -> GainNode for the loaded song
    this.sources = new Set();
    this.stemSegments = []; // { src, gain } for the stems currently playing
    this.mix = {};
    this.playing = false;
  }

  /**
   * Prepares a song: builds its schedule and decodes every sample and stem it uses.
   * Stems of any other song are released, so only one song's stems are ever in memory.
   * @returns {Promise<string[]>} warnings (schedule fallbacks, samples or stems that failed to load,
   *   stems shorter than the song)
   */
  async load(song, catalog) {
    this.stop();
    this.song = song;
    this.schedule = buildSchedule(song, catalog);
    const ctx = this.#context();
    // Section cues too: a jump can announce any section, even one whose cue isn't scheduled.
    const samples = [...this.schedule.events.map((e) => e.sample), ...this.schedule.sections.map((s) => s.cueSample)];
    const needed = [...new Set(samples)].filter((s) => s && !this.buffers.has(s));
    const failed = [];
    await Promise.all(needed.map(async (sample) => {
      try {
        const res = await fetch(sampleUrl(sample));
        if (!res.ok) throw new Error(res.status);
        this.buffers.set(sample, await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch {
        failed.push(sample);
      }
    }));
    return [
      ...this.schedule.warnings,
      ...failed.sort().map((s) => `Could not load sample ${s}; it will be silent.`),
      ...(await this.#loadStems(song)),
    ];
  }

  /** Live stem level change (applies within ~50 ms). */
  setStemGain({ file, volumeDb, muted }) {
    const gain = this.stemGains.get(file);
    if (gain) setLevel(this.ctx, gain.gain, muted ? -Infinity : volumeDb);
  }

  /** Live master levels: stems in the in-ears and stems to the main output. */
  setMix(mix) {
    this.mix = { ...this.mix, ...mix };
    this.routing?.setMix(this.mix);
  }

  /**
   * Jump to section `index` at the next downbeat. Pressing the same section again cancels;
   * another section replaces it. Pressed in the first half of a bar, the target's name is spoken
   * on the next beat so the band hears where they're going.
   */
  jump(index) {
    if (!this.playing || !this.prev) return;
    const { barSec } = this.schedule;
    const prevStart = this.startTime + this.prev.barsElapsed * barSec;
    const fraction = Math.min(1, Math.max(0, (this.ctx.currentTime - prevStart) / barSec));
    const r = nextPosition(this.song, this.prev, { type: 'jump', section: index, barFraction: fraction });
    this.prev = r.state;
    this.#recomputeNext();
    if (r.announce !== null) this.#announce(r.announce, prevStart);
  }

  /** Loop the section being heard (or release the loop). */
  toggleLoop() {
    if (!this.playing || !this.prev) return;
    this.prev = nextPosition(this.song, this.prev, { type: 'loop' }).state;
    this.#recomputeNext();
  }

  /** Forget decoded stems (after a stem file is uploaded or replaced). */
  forgetStems() {
    this.stemBuffers.clear();
  }

  async play() {
    if (this.playing || !this.schedule) return;
    const ctx = this.#context();
    await ctx.resume();
    this.state = initialPlayState(this.song);
    this.prev = null;
    this.seamNext = false;
    this.startTime = ctx.currentTime + START_DELAY_SEC;
    this.nextBarTime = this.startTime;
    this.barLog = []; // { bar, start } for the playhead
    this.endTime = null;
    this.playing = true;
    this.#startStems(-this.schedule.countInBars * this.schedule.barSec, this.startTime, false);
    this.timer = setInterval(() => this.#tick(), TIMER_MS);
    this.#tick();
    this.#animate();
    this.onStateChange(true);
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    cancelAnimationFrame(this.frame);
    for (const src of this.sources) {
      src.onended = null;
      src.stop();
      src.disconnect();
    }
    this.sources.clear();
    this.stemSegments = [];
    this.onPosition(null);
    this.onStateChange(false);
  }

  toggle() {
    return this.playing ? this.stop() : this.play();
  }

  #context() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.routing = createRouting(this.ctx, this.mix);
    }
    return this.ctx;
  }

  #tick() {
    const { ctx } = this;
    while (this.endTime === null && this.nextBarTime < ctx.currentTime + HORIZON_SEC) {
      if (this.seamNext) this.#seamStems(this.nextBarTime, secAtBar(this.song, this.state.bar));
      this.#scheduleBar(this.nextBarTime);
      this.barLog.push({ bar: this.state.bar, start: this.nextBarTime });
      if (this.barLog.length > 8) this.barLog.shift();
      this.prev = this.state;
      this.#recomputeNext();
    }
    if (this.endTime !== null && ctx.currentTime >= this.endTime) this.stop();
  }

  // Decides the bar after `prev` (again, after a jump/loop request changed `prev`).
  #recomputeNext() {
    const { barSec } = this.schedule;
    const next = nextPosition(this.song, this.prev, { type: 'barEnd' });
    const nextStart = this.startTime + (this.prev.barsElapsed + 1) * barSec;
    if (next.end) {
      this.endTime = nextStart;
      for (const { src } of this.stemSegments) src.stop(this.endTime);
      return;
    }
    this.endTime = null;
    this.state = next.state;
    this.seamNext = Boolean(next.jumped || next.looped);
    this.nextBarTime = nextStart;
  }

  // Speaks section `index`'s name on the next beat of the bar that started at `barStart`.
  #announce(index, barStart) {
    const sample = this.schedule.sections[index]?.cueSample;
    const buffer = sample && this.buffers.get(sample);
    if (!buffer) return;
    const beatSec = this.schedule.barSec / this.song.meter[0];
    const now = this.ctx.currentTime;
    const at = barStart + Math.ceil((now + 0.02 - barStart) / beatSec) * beatSec;
    this.#playOneShot(buffer, this.song.guide?.volumeDb ?? 0, at);
  }

  #scheduleBar(barTime) {
    for (const e of barEvents(this.schedule, this.state)) {
      const buffer = this.buffers.get(e.sample);
      if (buffer) this.#playOneShot(buffer, e.gainDb, barTime + e.offset);
    }
  }

  #playOneShot(buffer, gainDb, when) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = dbToGain(gainDb);
    src.connect(gain).connect(this.routing.clickGuide);
    src.onended = () => {
      this.sources.delete(src);
      gain.disconnect();
    };
    this.sources.add(src);
    src.start(when);
  }

  async #loadStems(song) {
    const ctx = this.ctx;
    const keyOf = (file) => `${song.id}/${file}`;
    const wanted = new Set(song.stems.map((s) => keyOf(s.file)));
    for (const key of this.stemBuffers.keys()) if (!wanted.has(key)) this.stemBuffers.delete(key);
    for (const gain of this.stemGains.values()) gain.disconnect();
    this.stemGains.clear();

    const warnings = [];
    const songSec = this.schedule.totalBars * this.schedule.barSec;
    await Promise.all(song.stems.map(async (stem) => {
      const key = keyOf(stem.file);
      if (!this.stemBuffers.has(key)) {
        try {
          const res = await fetch(`/api/songs/${song.id}/stems/${encodeURIComponent(stem.file)}`);
          if (!res.ok) throw new Error(res.status === 404 ? 'file is missing' : `HTTP ${res.status}`);
          this.stemBuffers.set(key, await ctx.decodeAudioData(await res.arrayBuffer()));
        } catch (err) {
          warnings.push(`Stem "${stem.name}" could not be loaded (${err.message || 'unsupported audio'}); playing without it.`);
          return;
        }
      }
      const gain = ctx.createGain();
      gain.gain.value = stem.muted ? 0 : dbToGain(stem.volumeDb);
      gain.connect(this.routing.stems);
      this.stemGains.set(stem.file, gain);
      const needed = songSec - (song.stemOffsetMs ?? 0) / 1000;
      const length = this.stemBuffers.get(key).duration;
      if (length < needed - 0.05) {
        warnings.push(`Stem "${stem.name}" is ${clock(length)} but the song needs ${clock(needed)}; it ends early.`);
      }
    }));
    return warnings.sort();
  }

  // Starts every loaded stem so that song time `songSec` plays at context time `when`,
  // optionally fading in over 10 ms (at jump/loop seams).
  #startStems(songSec, when, fadeIn) {
    const { delaySec, fileOffsetSec } = stemStart(songSec, this.song.stemOffsetMs);
    const at = when + delaySec;
    for (const stem of this.song.stems) {
      const buffer = this.stemBuffers.get(`${this.song.id}/${stem.file}`);
      const stemGain = this.stemGains.get(stem.file);
      if (!buffer || !stemGain || fileOffsetSec >= buffer.duration) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const gain = this.ctx.createGain();
      if (fadeIn) {
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(1, at + SEAM_FADE_SEC);
      }
      src.connect(gain).connect(stemGain);
      src.onended = () => {
        this.sources.delete(src);
        gain.disconnect();
      };
      this.sources.add(src);
      this.stemSegments.push({ src, gain });
      src.start(at, fileOffsetSec);
    }
  }

  // At a jump/loop: fade the playing stems out over the 10 ms before `when`, then start them
  // again from song time `songSec`.
  #seamStems(when, songSec) {
    for (const { src, gain } of this.stemSegments) {
      gain.gain.setValueAtTime(1, when - SEAM_FADE_SEC);
      gain.gain.linearRampToValueAtTime(0, when);
      src.stop(when + SEAM_FADE_SEC);
    }
    this.stemSegments = [];
    this.#startStems(songSec, when, true);
  }

  #animate() {
    const now = this.ctx.currentTime;
    const current = this.barLog.findLast((b) => b.start <= now);
    if (current) {
      const beats = this.song.meter[0];
      const beat = Math.min(beats, Math.floor(((now - current.start) / this.schedule.barSec) * beats) + 1);
      const fraction = (now - current.start) / this.schedule.barSec;
      const section = this.schedule.sections.findLastIndex((sec) => sec.startBar <= current.bar);
      this.onPosition({
        bar: current.bar, beat, fraction, countIn: current.bar < 1, section,
        pendingJump: this.prev?.pendingJump ?? null, loop: this.prev?.loop ?? null,
      });
    }
    this.frame = requestAnimationFrame(() => this.#animate());
  }
}

function clock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// "guides/es/Song Sections/Spanish - Coro 1 (Chorus 1).wav" -> URL-safe path under /samples/
function sampleUrl(sample) {
  return '/samples/' + sample.split('/').map(encodeURIComponent).join('/');
}
