// Live player: plays a version-2 song through Web Audio — the generated click, the cue clips and
// the audio clips — each through its track's strip (volume, mute, output; see routing.js).
// A 25 ms timer schedules whole bars as they come within 150 ms of the audio clock. Which bar
// comes next is decided by nextPosition (shared/schedule.js), and a bar starts at the start time
// plus the time of the bars already played, so long songs and loops never drift.
//
// `prev` is the last scheduled bar (normally the one you hear); `state` is the next, not yet
// scheduled bar. Audio clips play continuously; at a jump or loop they restart with a 10 ms
// crossfade at the new position.
import { buildSchedule, initialPlayState, nextPosition, barEvents, clipStart } from '/shared/schedule.js';
import { createRouting, createTrackStrip } from './routing.js';

const TIMER_MS = 25;
const HORIZON_SEC = 0.15;
const START_DELAY_SEC = 0.1;
const SEAM_FADE_SEC = 0.01;

export class Player {
  /**
   * @param {{ onPosition?: (pos: { bar: number, beat: number, sixteenth: number, fraction: number,
   *             songSec: number } | null) => void,
   *           onStateChange?: (playing: boolean) => void }} handlers
   */
  constructor({ onPosition = () => {}, onStateChange = () => {} } = {}) {
    this.onPosition = onPosition;
    this.onStateChange = onStateChange;
    this.ctx = null;
    this.routing = null;
    this.buffers = new Map(); // sample path -> AudioBuffer (kept across songs; samples are small)
    this.audio = new Map(); // "<song id>/<file>" -> Promise<AudioBuffer>, open song only (audio is big)
    this.strips = new Map(); // track id -> strip of the loaded song
    this.sources = new Set();
    this.clipSegments = []; // { src, gain } for the audio clips currently playing
    this.mix = {};
    this.loop = null; // { startBar, endBar } while looping
    this.playing = false;
  }

  /**
   * Decoded audio of an imported file (cached). Also used to draw waveforms before playing.
   * @returns {Promise<AudioBuffer>}
   */
  audioBuffer(songId, file) {
    const key = `${songId}/${file}`;
    if (!this.audio.has(key)) {
      const loading = (async () => {
        const res = await fetch(`/api/songs/${songId}/stems/${encodeURIComponent(file)}`);
        if (!res.ok) throw new Error(res.status === 404 ? 'file is missing' : `HTTP ${res.status}`);
        return this.#context().decodeAudioData(await res.arrayBuffer());
      })();
      loading.catch(() => this.audio.delete(key)); // let a later attempt retry
      this.audio.set(key, loading);
    }
    return this.audio.get(key);
  }

  /** Releases decoded audio of any other song, or of files the song no longer uses. */
  keepAudio(songId, files) {
    const wanted = new Set(files.map((f) => `${songId}/${f}`));
    for (const key of this.audio.keys()) if (!wanted.has(key)) this.audio.delete(key);
  }

  /**
   * Prepares a song: builds its schedule, decodes every sample and audio file it uses, and sets up
   * one strip per track. Plays a snapshot: later edits apply at the next load, except track levels
   * and outputs (setTrack).
   * @returns {Promise<string[]>} warnings (sample fallbacks, samples or audio that failed to load)
   */
  async load(song, catalog) {
    this.stop();
    this.songId = song.id;
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
        failed.push(`Could not load sample ${sample}; it will be silent.`);
      }
    }));

    this.keepAudio(song.id, this.schedule.clips.map((c) => c.file));
    this.clipBuffers = new Map();
    await Promise.all(this.schedule.clips.map(async (clip) => {
      try {
        this.clipBuffers.set(clip.track, await this.audioBuffer(song.id, clip.file));
      } catch (err) {
        const name = song.tracks.find((t) => t.id === clip.track)?.name ?? clip.file;
        failed.push(`Audio "${name}" could not be loaded (${err.message || 'unsupported audio'}); playing without it.`);
      }
    }));

    for (const strip of this.strips.values()) strip.dispose();
    this.strips = new Map(song.tracks.map((t) => [t.id, createTrackStrip(ctx, this.routing, t)]));
    return [...this.schedule.warnings, ...failed.sort()];
  }

  /** Live change of a track's volume, mute or output. */
  setTrack(track) {
    this.strips.get(track.id)?.set(track);
  }

  /** Live master levels of the in-ear and main outputs. */
  setMix(mix) {
    this.mix = { ...this.mix, ...mix };
    this.routing?.setMix(this.mix);
  }

  /**
   * Loop `range` (whole bars), or stop looping with null. While playing, it applies from the next
   * bar line: after the range's last bar, playback goes back to its first.
   */
  setLoop(range) {
    this.loop = range;
    if (!this.playing || !this.prev) return;
    this.prev = this.#withLoop(this.prev);
    this.#recomputeNext();
  }

  /**
   * Starts `offsetSec` seconds into bar `fromBar` (0 = its downbeat), like Ableton playing from the
   * insert marker. The bar is scheduled as if it had started earlier; what lies before the start
   * point is skipped.
   */
  async play({ fromBar = 1, offsetSec = 0 } = {}) {
    if (this.playing || !this.schedule) return;
    const ctx = this.#context();
    await ctx.resume();
    this.state = this.#withLoop(initialPlayState(this.schedule, { fromBar }));
    this.prev = null;
    this.seamNext = false;
    const startAt = ctx.currentTime + START_DELAY_SEC;
    this.startTime = startAt - offsetSec; // when bar `fromBar` would have begun
    this.skipBefore = startAt - 0.001;
    this.nextBarTime = this.startTime;
    this.barLog = []; // { bar, start } for the playhead
    this.endTime = null;
    this.playing = true;
    this.#startClips(this.#barSec(fromBar) + offsetSec, startAt, false);
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
    this.clipSegments = [];
    this.onPosition(null);
    this.onStateChange(false);
  }

  #context() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.routing = createRouting(this.ctx, this.mix);
    }
    return this.ctx;
  }

  // The loop range applied to a play state; a range outside the loaded song is ignored.
  #withLoop(state) {
    try {
      return nextPosition(this.schedule, state, { type: 'loop', range: this.loop }).state;
    } catch {
      return nextPosition(this.schedule, state, { type: 'loop', range: null }).state;
    }
  }

  #barSec(bar) {
    return this.schedule.grid.bars[bar - 1].startSec;
  }

  #tick() {
    const { ctx } = this;
    while (this.endTime === null && this.nextBarTime < ctx.currentTime + HORIZON_SEC) {
      if (this.seamNext) this.#seamClips(this.nextBarTime, this.#barSec(this.state.bar));
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
    const next = nextPosition(this.schedule, this.prev, { type: 'barEnd' });
    if (next.end) {
      this.endTime = this.startTime + this.prev.elapsedSec + this.schedule.grid.bars[this.prev.bar - 1].sec;
      for (const { src } of this.clipSegments) src.stop(this.endTime);
      return;
    }
    this.endTime = null;
    this.state = next.state;
    this.seamNext = Boolean(next.jumped || next.looped);
    this.nextBarTime = this.startTime + this.state.elapsedSec;
  }

  #scheduleBar(barTime) {
    for (const e of barEvents(this.schedule, this.state)) {
      const buffer = this.buffers.get(e.sample);
      const strip = this.strips.get(e.track);
      const when = barTime + e.offset;
      if (buffer && strip && when >= this.skipBefore) this.#playOneShot(buffer, strip.input, when);
    }
  }

  #playOneShot(buffer, destination, when) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(destination);
    src.onended = () => {
      this.sources.delete(src);
      src.disconnect();
    };
    this.sources.add(src);
    src.start(when);
  }

  // Starts every loaded audio clip so that song time `songSec` plays at context time `when`,
  // optionally fading in over 10 ms (at jump/loop seams).
  #startClips(songSec, when, fadeIn) {
    for (const clip of this.schedule.clips) {
      const buffer = this.clipBuffers.get(clip.track);
      const strip = this.strips.get(clip.track);
      const { delaySec, fileOffsetSec } = clipStart(clip.startSec, songSec);
      if (!buffer || !strip || fileOffsetSec >= buffer.duration) continue;
      const at = when + delaySec;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const gain = this.ctx.createGain();
      if (fadeIn) {
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(1, at + SEAM_FADE_SEC);
      }
      src.connect(gain).connect(strip.input);
      src.onended = () => {
        this.sources.delete(src);
        gain.disconnect();
      };
      this.sources.add(src);
      this.clipSegments.push({ src, gain });
      src.start(at, fileOffsetSec);
    }
  }

  // At a jump/loop: fade the playing clips out over the 10 ms before `when`, then start them
  // again from song time `songSec`.
  #seamClips(when, songSec) {
    for (const { src, gain } of this.clipSegments) {
      gain.gain.setValueAtTime(1, when - SEAM_FADE_SEC);
      gain.gain.linearRampToValueAtTime(0, when);
      src.stop(when + SEAM_FADE_SEC);
    }
    this.clipSegments = [];
    this.#startClips(songSec, when, true);
  }

  #animate() {
    const now = this.ctx.currentTime;
    const current = this.barLog.findLast((b) => b.start <= now);
    if (current) {
      const bar = this.schedule.grid.bars[current.bar - 1];
      const songSec = bar.startSec + Math.min(bar.sec, now - current.start);
      this.onPosition({ ...this.schedule.grid.positionAt(songSec), songSec });
    }
    this.frame = requestAnimationFrame(() => this.#animate());
  }
}

// "guides/es/Song Sections/Spanish - Coro 1 (Chorus 1).wav" -> URL-safe path under /samples/
function sampleUrl(sample) {
  return '/samples/' + sample.split('/').map(encodeURIComponent).join('/');
}
