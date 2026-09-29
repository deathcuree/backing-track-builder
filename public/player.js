// Live player: plays a song's click and guide through Web Audio.
// A 25 ms timer schedules whole bars as they come within 150 ms of the audio clock. Which bar
// comes next is decided by nextPosition (shared/schedule.js), and bar start times are computed
// from whole-bar counts, so long songs and loops never drift.
import { buildSchedule, initialPlayState, nextPosition, barEvents } from '/shared/schedule.js';
import { createRouting } from './routing.js';

const TIMER_MS = 25;
const HORIZON_SEC = 0.15;
const START_DELAY_SEC = 0.1;

export class Player {
  /**
   * @param {{ onPosition?: (pos: { bar: number, beat: number, countIn: boolean } | null) => void,
   *           onStateChange?: (playing: boolean) => void }} handlers
   */
  constructor({ onPosition = () => {}, onStateChange = () => {} } = {}) {
    this.onPosition = onPosition;
    this.onStateChange = onStateChange;
    this.ctx = null;
    this.routing = null;
    this.buffers = new Map(); // sample path -> AudioBuffer (kept across songs; samples are small)
    this.sources = new Set();
    this.playing = false;
  }

  /**
   * Prepares a song: builds its schedule and decodes every sample it uses.
   * @returns {Promise<string[]>} warnings (schedule fallbacks and samples that failed to load)
   */
  async load(song, catalog) {
    this.stop();
    this.song = song;
    this.schedule = buildSchedule(song, catalog);
    const ctx = this.#context();
    const needed = [...new Set(this.schedule.events.map((e) => e.sample))].filter((s) => !this.buffers.has(s));
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
    ];
  }

  async play() {
    if (this.playing || !this.schedule) return;
    const ctx = this.#context();
    await ctx.resume();
    this.state = initialPlayState(this.song);
    this.startTime = ctx.currentTime + START_DELAY_SEC;
    this.nextBarTime = this.startTime;
    this.barLog = []; // { bar, start } for the playhead
    this.endTime = null;
    this.playing = true;
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
    this.onPosition(null);
    this.onStateChange(false);
  }

  toggle() {
    return this.playing ? this.stop() : this.play();
  }

  #context() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.routing = createRouting(this.ctx);
    }
    return this.ctx;
  }

  #tick() {
    const { ctx, schedule } = this;
    while (this.endTime === null && this.nextBarTime < ctx.currentTime + HORIZON_SEC) {
      this.#scheduleBar(this.nextBarTime);
      this.barLog.push({ bar: this.state.bar, start: this.nextBarTime });
      if (this.barLog.length > 8) this.barLog.shift();
      const next = nextPosition(this.song, this.state, { type: 'barEnd' });
      if (next.end) {
        this.endTime = this.nextBarTime + schedule.barSec;
        break;
      }
      this.state = next.state;
      this.nextBarTime = this.startTime + this.state.barsElapsed * schedule.barSec;
    }
    if (this.endTime !== null && ctx.currentTime >= this.endTime) this.stop();
  }

  #scheduleBar(barTime) {
    for (const e of barEvents(this.schedule, this.state)) {
      const buffer = this.buffers.get(e.sample);
      if (!buffer) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const gain = this.ctx.createGain();
      gain.gain.value = 10 ** (e.gainDb / 20);
      src.connect(gain).connect(this.routing.clickGuide);
      src.onended = () => {
        this.sources.delete(src);
        gain.disconnect();
      };
      this.sources.add(src);
      src.start(barTime + e.offset);
    }
  }

  #animate() {
    const now = this.ctx.currentTime;
    const current = this.barLog.findLast((b) => b.start <= now);
    if (current) {
      const beats = this.song.meter[0];
      const beat = Math.min(beats, Math.floor(((now - current.start) / this.schedule.barSec) * beats) + 1);
      const fraction = (now - current.start) / this.schedule.barSec;
      this.onPosition({ bar: current.bar, beat, fraction, countIn: current.bar < 1 });
    }
    this.frame = requestAnimationFrame(() => this.#animate());
  }
}

// "guides/es/Song Sections/Spanish - Coro 1 (Chorus 1).wav" -> URL-safe path under /samples/
function sampleUrl(sample) {
  return '/samples/' + sample.split('/').map(encodeURIComponent).join('/');
}
