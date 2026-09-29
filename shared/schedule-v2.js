// Timing engine for version-2 songs: turns the grid, the click track and the cue clips into timed
// events, lists the audio clips and locator sections, and decides which bar plays next during
// playback (jumps, loops). Pure and deterministic; used by the player, the WAV export and the
// tests, so playback and export can never disagree about timing.
//
// Times are song seconds (bar 1 = 0 s). Events carry their track id but no gain: volume, mute,
// solo and output are applied per track by the player.
import { buildGrid } from './grid.js';

const FALLBACK_CLICK = 'Classic';
const FALLBACK_LANGUAGE = 'en';

/**
 * @returns {{
 *   events: { t: number, bar: number, offset: number, track: string, kind: 'click'|'cue',
 *             role: 'accent'|'beat'|'eighth'|'sixteenth'|'section'|'cue'|'count', sample: string }[],
 *   clips: { track: string, file: string, startSec: number }[],
 *   sections: { name: string, startBar: number, endBar: number, startSec: number, endSec: number }[],
 *   grid: ReturnType<typeof buildGrid>, totalSec: number, warnings: string[]
 * }}
 */
export function buildSchedule(song, catalog) {
  const grid = buildGrid(song);
  const warnings = new Set();
  const events = [];

  const click = song.tracks.find((t) => t.type === 'click');
  if (click) {
    const sampleFor = clickResolver(catalog, click.sound ?? FALLBACK_CLICK, warnings);
    for (const b of grid.bars) {
      const perBeat = 16 / b.unit;
      const sixteenthSec = 15 / b.bpm;
      for (let beat = 0; beat < b.beats; beat++) {
        for (let k = 0; k < perBeat; k++) {
          const role = k === 0 ? (beat === 0 ? 'accents' : 'quarter') : noteValue(k, perBeat);
          if (!clickPlays(role, click.subdivision)) continue;
          const sample = sampleFor(role);
          if (!sample) continue;
          const offset = (beat * perBeat + k) * sixteenthSec;
          events.push({ t: b.startSec + offset, bar: b.bar, offset, track: click.id, kind: 'click', role: ROLE_NAMES[role], sample });
        }
      }
    }
  }

  const cues = song.tracks.find((t) => t.type === 'cues');
  if (cues) {
    const guide = guideResolver(catalog, cues.language ?? FALLBACK_LANGUAGE, warnings);
    for (const clip of cues.clips) {
      const sample = guide(clip.type, clip.key);
      if (!sample) continue;
      const t = grid.secAt(clip.at);
      const bar = clip.at[0];
      events.push({ t, bar, offset: t - grid.bars[bar - 1].startSec, track: cues.id, kind: 'cue', role: clip.type, sample });
    }
  }

  const clips = song.tracks
    .filter((t) => t.type === 'audio' && t.clip)
    .map((t) => ({ track: t.id, file: t.clip.file, startSec: t.clip.startSec }));

  const locators = [...song.locators].sort((a, b) => a.bar - b.bar);
  const sections = locators.map((l, i) => {
    const endBar = (locators[i + 1]?.bar ?? song.endBar + 1) - 1;
    const last = grid.bars[endBar - 1];
    return { name: l.name, startBar: l.bar, endBar, startSec: grid.bars[l.bar - 1].startSec, endSec: last.startSec + last.sec };
  });

  events.sort(compareEvents);
  return { events, clips, sections, grid, totalSec: grid.endSec, warnings: [...warnings].sort() };
}

/** Index of the section containing `bar`, or -1 before the first locator. */
export function sectionAt(schedule, bar) {
  return schedule.sections.findLastIndex((s) => s.startBar <= bar);
}

/** Playback state before the first bar plays. `elapsedSec` is the time of the bars already played. */
export function initialPlayState(schedule, { fromBar = 1 } = {}) {
  if (!Number.isInteger(fromBar) || fromBar < 1 || fromBar > schedule.grid.bars.length) {
    throw new RangeError(`Bar ${fromBar} is outside the song`);
  }
  return { bar: fromBar, pendingJump: null, loop: null, elapsedSec: 0 };
}

/**
 * Playback transitions. Actions:
 * - { type: 'jump', section } — queue a jump to that locator at the next bar line.
 *   Same section again cancels; another section replaces.
 * - { type: 'loop', range } — `range` is { startBar, endBar }, { section } or null (no loop).
 * - { type: 'barEnd' } — the current bar finished; move to the next bar.
 *   Returns `jumped`, `looped`, or `end` (song finished; state unchanged).
 * A jump releases the loop. The next bar starts `elapsedSec` after playback started.
 */
export function nextPosition(schedule, state, action) {
  const { sections } = schedule;
  const lastBar = schedule.grid.bars.length;
  switch (action.type) {
    case 'jump': {
      if (!sections[action.section]) throw new RangeError(`No section ${action.section}`);
      const pendingJump = state.pendingJump === action.section ? null : action.section;
      return { state: { ...state, pendingJump } };
    }
    case 'loop': {
      const { range } = action;
      if (range === null) return { state: { ...state, loop: null } };
      if ('section' in range) {
        const s = sections[range.section];
        if (!s) throw new RangeError(`No section ${range.section}`);
        return { state: { ...state, loop: { startBar: s.startBar, endBar: s.endBar, section: range.section } } };
      }
      const { startBar, endBar } = range;
      if (!Number.isInteger(startBar) || !Number.isInteger(endBar) || startBar < 1 || endBar < startBar || endBar > lastBar) {
        throw new RangeError(`Invalid loop: bars ${startBar}–${endBar}`);
      }
      return { state: { ...state, loop: { startBar, endBar, section: null } } };
    }
    case 'barEnd': {
      const elapsedSec = state.elapsedSec + schedule.grid.bars[state.bar - 1].sec;
      if (state.pendingJump !== null) {
        const target = sections[state.pendingJump];
        return { state: { ...state, bar: target.startBar, pendingJump: null, loop: null, elapsedSec }, jumped: true };
      }
      if (state.loop && state.bar === state.loop.endBar) {
        return { state: { ...state, bar: state.loop.startBar, elapsedSec }, looped: true };
      }
      if (state.bar >= lastBar) return { state, end: true };
      return { state: { ...state, bar: state.bar + 1, elapsedSec } };
    }
    default:
      throw new Error(`Unknown action: ${action.type}`);
  }
}

const barIndexCache = new WeakMap();

/** Events to play in `state.bar`, with `offset` seconds from that bar's downbeat. */
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
  return byBar.get(state.bar) ?? [];
}

/**
 * Where an audio clip is when song time `songSec` plays at some moment `when`: start the clip at
 * `when + delaySec`, `fileOffsetSec` seconds into its file. `clipStartSec` is the song time of the
 * file's first sample (negative skips the file's beginning).
 */
export function clipStart(clipStartSec, songSec) {
  const fileSec = round(songSec - clipStartSec);
  return fileSec >= 0 ? { delaySec: 0, fileOffsetSec: fileSec } : { delaySec: -fileSec, fileOffsetSec: 0 };
}

// Keeps ms-level offsets exact (10 - 3.214 = 6.786, not 6.7860000000000005).
function round(sec) {
  return Math.round(sec * 1e9) / 1e9;
}

// Sixteenth k (1…perBeat-1) of a beat: an eighth when it falls on half a quarter, else a sixteenth.
// In x/8 a beat is already an eighth, so its only subdivision is a sixteenth.
function noteValue(k, perBeat) {
  return perBeat === 4 && k === 2 ? 'eighth' : 'sixteenth';
}

function clickPlays(role, subdivision) {
  if (role === 'accents' || role === 'quarter') return true;
  if (role === 'eighth') return subdivision === 'eighth' || subdivision === 'sixteenth';
  return subdivision === 'sixteenth';
}

const ROLE_NAMES = { accents: 'accent', quarter: 'beat', eighth: 'eighth', sixteenth: 'sixteenth' };
const KIND_ORDER = { click: 0, cue: 1 };

function compareEvents(a, b) {
  return a.t - b.t || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.sample < b.sample ? -1 : a.sample > b.sample ? 1 : 0);
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
