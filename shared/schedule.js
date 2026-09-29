// Timing engine: turns a song into timed click/guide events, and decides which bar plays next
// during live playback (jumps, loops). Pure and deterministic; used by the player, the WAV
// export and the tests, so live playback and export can never disagree about timing.
//
// Time frames:
// - Schedule time (events[].t, sections[].startSec, totalSec): seconds from the start of the
//   render, i.e. the first count-in bar. Song bar 1 starts at `t0`.
// - Song time (secAtBar, barAt): seconds from bar 1, ignoring count-in.
// Bars are 1-based song bars; count-in bars are numbered 0, -1, … counting backwards.

const TICKS_PER_BEAT = 4; // sixteenth-note resolution; all times derive from integer ticks
const FALLBACK_CLICK = 'Classic';
const FALLBACK_LANGUAGE = 'en';

/**
 * @returns {{
 *   events: { t: number, bar: number, offset: number, kind: 'click'|'guide',
 *             role: 'accent'|'beat'|'eighth'|'sixteenth'|'section'|'cue'|'count',
 *             sample: string, gainDb: number, section?: number }[],
 *   sections: { name: string, startBar: number, bars: number, startSec: number, endSec: number,
 *               cueSample: string|null }[],
 *   t0: number, barSec: number, countInBars: number, totalBars: number, totalSec: number,
 *   warnings: string[]
 * }}
 */
export function buildSchedule(song, catalog, { countIn = true } = {}) {
  const timing = timingOf(song);
  const { beats, secPerTick } = timing;
  const countInBars = countIn ? (song.countInBars ?? 0) : 0;
  const warnings = new Set();
  const events = [];
  const clickGain = song.click?.volumeDb ?? 0;
  const guideGain = song.guide?.volumeDb ?? 0;
  const halfBarBeat = Math.ceil(beats / 2) + 1; // where a second voice in the same bar starts

  const click = clickResolver(catalog, song.click?.sound ?? FALLBACK_CLICK, warnings);
  const guide = guideResolver(catalog, song.guide?.language ?? FALLBACK_LANGUAGE, warnings);

  const barStartTick = (bar) => (bar - 1 + countInBars) * beats * TICKS_PER_BEAT;
  const push = (bar, offsetTicks, fields) => {
    const tick = barStartTick(bar) + offsetTicks;
    events.push({ t: tick * secPerTick, bar, offset: offsetTicks * secPerTick, ...fields });
  };

  // Sections and the bar each section's cue is spoken in (the bar before it starts).
  const sectionCueBars = new Set();
  let startBar = 1;
  const sections = song.sections.map((section, index) => {
    const cueBar = startBar - 1;
    const sample = guide('section', section.name);
    if (sample && (index > 0 || countInBars > 0)) {
      sectionCueBars.add(cueBar);
      push(cueBar, 0, { kind: 'guide', role: 'section', section: index, sample, gainDb: guideGain });
    }
    const out = {
      name: section.name,
      startBar,
      bars: section.bars,
      startSec: barStartTick(startBar) * secPerTick,
      endSec: barStartTick(startBar + section.bars) * secPerTick,
      cueSample: sample,
    };
    startBar += section.bars;
    return out;
  });
  const totalBars = startBar - 1;

  // Click: every bar, count-in included.
  const subdivision = song.click?.subdivision ?? 'quarter';
  for (let bar = 1 - countInBars; bar <= totalBars; bar++) {
    for (let beat = 0; beat < beats; beat++) {
      const at = beat * TICKS_PER_BEAT;
      const hit = (dt, role) => {
        const sample = click(role);
        if (sample) push(bar, at + dt, { kind: 'click', role: ROLE_NAMES[role], sample, gainDb: clickGain });
      };
      hit(0, beat === 0 ? 'accents' : 'quarter');
      if (subdivision === 'sixteenth') hit(1, 'sixteenth');
      if (subdivision === 'eighth' || subdivision === 'sixteenth') hit(2, 'eighth');
      if (subdivision === 'sixteenth') hit(3, 'sixteenth');
    }
  }

  // Count-in voice: beat numbers; the second half only in the bar where section 1's cue speaks.
  for (let bar = 1 - countInBars; bar <= 0; bar++) {
    const firstBeat = sectionCueBars.has(bar) ? halfBarBeat : 1;
    for (let beat = firstBeat; beat <= beats; beat++) {
      const sample = guide('count', String(beat));
      if (sample) push(bar, (beat - 1) * TICKS_PER_BEAT, { kind: 'guide', role: 'count', sample, gainDb: guideGain });
    }
  }

  // Dynamic cues: on the downbeat, or mid-bar when a section cue already speaks in that bar.
  for (const cue of song.cues ?? []) {
    if (cue.bar < 1 || cue.bar > totalBars) {
      warnings.add(`Cue "${cue.name}" at bar ${cue.bar} is past the end of the song (${totalBars} bars); skipped.`);
      continue;
    }
    const sample = guide('cue', cue.name);
    if (!sample) continue;
    const beat = sectionCueBars.has(cue.bar) ? halfBarBeat : 1;
    push(cue.bar, (beat - 1) * TICKS_PER_BEAT, { kind: 'guide', role: 'cue', sample, gainDb: guideGain });
  }

  events.sort(compareEvents);
  return {
    events,
    sections,
    t0: barStartTick(1) * secPerTick,
    barSec: timing.barSec,
    countInBars,
    totalBars,
    totalSec: barStartTick(totalBars + 1) * secPerTick,
    warnings: [...warnings].sort(),
  };
}

/** Seconds from the start of bar 1 to the start of `bar`. */
export function secAtBar(song, bar) {
  return (bar - 1) * timingOf(song).barSec;
}

/** Bar playing at `sec` seconds after the start of bar 1 (count-in bars are ≤ 0). */
export function barAt(song, sec) {
  return Math.floor(sec / timingOf(song).barSec) + 1;
}

/** Live playback state before the first bar plays. */
export function initialPlayState(song, { countIn = true } = {}) {
  const countInBars = countIn ? (song.countInBars ?? 0) : 0;
  return { bar: 1 - countInBars, pendingJump: null, loop: null, barsElapsed: 0 };
}

/**
 * Live playback transitions. Actions:
 * - { type: 'jump', section, barFraction } — queue a jump to section index at the next downbeat.
 *   Same section again cancels; another section replaces. Requests in the first half of the bar
 *   return `announce: section` so the player speaks the target's cue before the jump.
 * - { type: 'loop' } — toggle looping the section containing the current bar.
 * - { type: 'barEnd' } — the current bar finished; move to the next bar.
 *   Returns `jumped`, `looped`, or `end` (song finished; state unchanged).
 * Elapsed time is `barsElapsed` whole bars, so looping forever cannot accumulate drift.
 */
export function nextPosition(song, state, action) {
  const sections = sectionBars(song);
  switch (action.type) {
    case 'jump': {
      if (!sections[action.section]) throw new RangeError(`No section ${action.section}`);
      if (state.pendingJump === action.section) {
        return { state: { ...state, pendingJump: null }, announce: null };
      }
      return {
        state: { ...state, pendingJump: action.section },
        announce: action.barFraction < 0.5 ? action.section : null,
      };
    }
    case 'loop': {
      if (state.loop !== null) return { state: { ...state, loop: null } };
      const current = sections.findIndex((s) => state.bar >= s.startBar && state.bar <= s.endBar);
      return { state: { ...state, loop: current === -1 ? null : current } };
    }
    case 'barEnd': {
      const barsElapsed = state.barsElapsed + 1;
      if (state.pendingJump !== null) {
        const target = sections[state.pendingJump];
        return {
          state: { ...state, bar: target.startBar, pendingJump: null, loop: null, barsElapsed },
          jumped: true,
        };
      }
      const looped = state.loop !== null ? sections[state.loop] : null;
      if (looped && state.bar === looped.endBar) {
        return { state: { ...state, bar: looped.startBar, barsElapsed }, looped: true };
      }
      if (state.bar >= sections.at(-1).endBar) return { state, end: true };
      return { state: { ...state, bar: state.bar + 1, barsElapsed } };
    }
    default:
      throw new Error(`Unknown action: ${action.type}`);
  }
}

/**
 * Where stem audio is when song time `songSec` (bar 1 = 0 s) plays at some moment `when`:
 * start the stems at `when + delaySec`, `fileOffsetSec` seconds into their files.
 * A positive `stemOffsetMs` makes stems start later than the click.
 */
export function stemStart(songSec, stemOffsetMs = 0) {
  const fileSec = round(songSec - stemOffsetMs / 1000);
  return fileSec >= 0 ? { delaySec: 0, fileOffsetSec: fileSec } : { delaySec: -fileSec, fileOffsetSec: 0 };
}

// Keeps ms-level offsets exact (8 - 0.1 = 7.9, not 7.8999999999999995).
function round(sec) {
  return Math.round(sec * 1e9) / 1e9;
}

const barIndexCache = new WeakMap();

/**
 * Events to play in `state.bar`, with `offset` seconds from that bar's downbeat.
 * While looping, the next section's cue in the loop's last bar is left out.
 */
export function barEvents(schedule, state) {
  let byBar = barIndexCache.get(schedule);
  if (!byBar) {
    byBar = new Map();
    for (const e of schedule.events) {
      if (!byBar.has(e.bar)) byBar.set(e.bar, []);
      byBar.get(e.bar).push(e);
    }
    barIndexCache.set(schedule, byBar);
  }
  const events = byBar.get(state.bar) ?? [];
  const looped = state.loop !== null ? schedule.sections[state.loop] : null;
  if (looped && state.bar === looped.startBar + looped.bars - 1) {
    return events.filter((e) => e.role !== 'section');
  }
  return events;
}

const ROLE_NAMES = { accents: 'accent', quarter: 'beat', eighth: 'eighth', sixteenth: 'sixteenth' };
const KIND_ORDER = { click: 0, guide: 1 };

function compareEvents(a, b) {
  return a.t - b.t || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.sample < b.sample ? -1 : a.sample > b.sample ? 1 : 0);
}

function timingOf(song) {
  const [beats] = song.meter ?? [];
  if (!(song.bpm > 0) || !Number.isFinite(song.bpm)) throw new RangeError(`Invalid BPM: ${song.bpm}`);
  if (!Number.isInteger(beats) || beats < 1) throw new RangeError(`Invalid time signature: ${song.meter}`);
  if (!song.sections?.length) throw new RangeError('A song needs at least one section');
  for (const s of song.sections) {
    if (!Number.isInteger(s.bars) || s.bars < 1) throw new RangeError(`Section "${s.name}" needs at least 1 bar`);
  }
  const secPerTick = 60 / (song.bpm * TICKS_PER_BEAT);
  return { beats, secPerTick, barSec: (beats * 60) / song.bpm };
}

function sectionBars(song) {
  let startBar = 1;
  return song.sections.map((s) => {
    const out = { startBar, endBar: startBar + s.bars - 1 };
    startBar += s.bars;
    return out;
  });
}

function clickResolver(catalog, sound, warnings) {
  const cache = new Map();
  return (role) => {
    if (cache.has(role)) return cache.get(role);
    let sample = catalog.clicks[sound]?.[role] ?? null;
    if (!sample) {
      sample = catalog.clicks[FALLBACK_CLICK]?.[role] ?? null;
      warnings.add(sample
        ? `${sound} has no ${role === 'accents' ? 'accent' : role} click; using ${FALLBACK_CLICK} for those hits.`
        : `No ${role} click available; those hits are silent.`);
    }
    cache.set(role, sample);
    return sample;
  };
}

function guideResolver(catalog, language, warnings) {
  return (type, key) => {
    const own = catalog.guides[language]?.[type]?.[key];
    if (own) return own;
    if (type === 'count') {
      warnings.add(`No ${language} count "${key}"; that beat is silent.`);
      return null;
    }
    const fallback = catalog.guides[FALLBACK_LANGUAGE]?.[type]?.[key];
    if (fallback && language !== FALLBACK_LANGUAGE) {
      warnings.add(`No ${language} ${type} "${key}"; using English.`);
      return fallback;
    }
    warnings.add(`No recording for ${type} "${key}"; skipped.`);
    return null;
  };
}
