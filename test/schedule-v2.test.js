import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSchedule, initialPlayState, nextPosition, barEvents, clipStart, sectionAt,
} from '../shared/schedule-v2.js';
import { newSong } from '../shared/song-v2.js';

const catalog = {
  clicks: {
    Classic: { accents: 'c/A', quarter: 'c/Q', eighth: 'c/E', sixteenth: 'c/S' },
    Digital: { accents: 'd/A', sixteenth: 'd/S' },
  },
  guides: {
    en: {
      section: { Intro: 'en/Intro', 'Verse 1': 'en/Verse 1', Chorus: 'en/Chorus' },
      cue: { Build: 'en/Build' },
      count: { 1: 'en/1', 2: 'en/2', 3: 'en/3', 4: 'en/4', 5: 'en/5', 6: 'en/6' },
      languageOnly: [],
    },
    es: {
      section: { Intro: 'es/Intro' },
      cue: {},
      count: { 1: 'es/1', 2: 'es/2', 3: 'es/3' },
      languageOnly: [],
    },
  },
};

function song(overrides = {}) {
  const s = newSong();
  s.id = 't';
  s.title = 'T';
  s.endBar = 2;
  return Object.assign(s, overrides);
}

const cuesTrack = (s) => s.tracks.find((t) => t.type === 'cues');
const clickTrack = (s) => s.tracks.find((t) => t.type === 'click');
const clicks = (s) => s.events.filter((e) => e.kind === 'click');
const cues = (s) => s.events.filter((e) => e.kind === 'cue');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} != ${b}`);

describe('buildSchedule: click', () => {
  test('4/4 at 120: a hit on every beat, accent on beat 1, from bar 1 to the end bar', () => {
    const s = buildSchedule(song(), catalog);
    const c = clicks(s);
    assert.equal(c.length, 8);
    c.forEach((e, i) => {
      near(e.t, i * 0.5);
      assert.equal(e.track, 'click');
      assert.equal(e.bar, i < 4 ? 1 : 2);
      near(e.offset, (i % 4) * 0.5);
      assert.equal(e.role, i % 4 === 0 ? 'accent' : 'beat');
      assert.equal(e.sample, i % 4 === 0 ? 'c/A' : 'c/Q');
      assert.equal('gainDb' in e, false, 'volume is applied per track by the player');
    });
    near(s.totalSec, 4);
  });

  test('eighth and sixteenth subdivisions in 4/4', () => {
    const s8 = song({ endBar: 1 });
    clickTrack(s8).subdivision = 'eighth';
    const c8 = clicks(buildSchedule(s8, catalog));
    assert.deepEqual(c8.map((e) => e.role), ['accent', 'eighth', 'beat', 'eighth', 'beat', 'eighth', 'beat', 'eighth']);
    near(c8[1].t, 0.25);

    const s16 = song({ endBar: 1 });
    clickTrack(s16).subdivision = 'sixteenth';
    const c16 = clicks(buildSchedule(s16, catalog));
    assert.equal(c16.length, 16);
    assert.deepEqual(c16.slice(0, 4).map((e) => e.role), ['accent', 'sixteenth', 'eighth', 'sixteenth']);
    near(c16[1].t, 0.125);
  });

  test('x/8: a hit on every eighth; eighth subdivision adds nothing, sixteenth adds one per beat', () => {
    const s = song({ endBar: 1, meter: [{ bar: 1, beats: 6, unit: 8 }] });
    const c = clicks(buildSchedule(s, catalog));
    assert.equal(c.length, 6);
    near(c[1].t, 0.25);
    near(buildSchedule(s, catalog).totalSec, 1.5);

    clickTrack(s).subdivision = 'eighth';
    assert.equal(clicks(buildSchedule(s, catalog)).length, 6);

    clickTrack(s).subdivision = 'sixteenth';
    const c16 = clicks(buildSchedule(s, catalog));
    assert.equal(c16.length, 12);
    assert.deepEqual(c16.slice(0, 3).map((e) => e.role), ['accent', 'sixteenth', 'beat']);
    near(c16[1].t, 0.125);
  });

  test('follows meter and tempo markers', () => {
    const s = buildSchedule(song({
      endBar: 3,
      tempo: [{ bar: 1, bpm: 120 }, { bar: 3, bpm: 60 }],
      meter: [{ bar: 1, beats: 4, unit: 4 }, { bar: 3, beats: 6, unit: 4 }],
    }), catalog);
    const bar3 = clicks(s).filter((e) => e.bar === 3);
    assert.deepEqual(bar3.map((e) => e.t), [4, 5, 6, 7, 8, 9]);
    assert.deepEqual(bar3.map((e) => e.role), ['accent', 'beat', 'beat', 'beat', 'beat', 'beat']);
    near(s.totalSec, 10);
  });

  test('missing click sounds fall back to Classic with a warning', () => {
    const s = song({ endBar: 1 });
    clickTrack(s).sound = 'Digital';
    const out = buildSchedule(s, catalog);
    assert.deepEqual(clicks(out).map((e) => e.sample), ['d/A', 'c/Q', 'c/Q', 'c/Q']);
    assert.deepEqual(out.warnings, ['Digital has no quarter click; using Classic for those hits.']);
  });
});

describe('buildSchedule: cues', () => {
  test('each cue clip plays its sample once at its position', () => {
    const s = song({ endBar: 4, meter: [{ bar: 1, beats: 6, unit: 4 }], tempo: [{ bar: 1, bpm: 60 }] });
    cuesTrack(s).clips = [
      { at: [2, 1, 1], type: 'count', key: '1' },
      { at: [1, 3, 3], type: 'cue', key: 'Build' },
      { at: [3, 6, 1], type: 'section', key: 'Chorus' },
    ];
    const c = cues(buildSchedule(s, catalog));
    assert.deepEqual(c.map((e) => [e.t, e.bar, e.offset, e.role, e.sample, e.track]), [
      [2.5, 1, 2.5, 'cue', 'en/Build', 'cues'],
      [6, 2, 0, 'count', 'en/1', 'cues'],
      [17, 3, 5, 'section', 'en/Chorus', 'cues'],
    ]);
  });

  test('language fallback: English for sections and cues, never for counts', () => {
    const s = song();
    cuesTrack(s).language = 'es';
    cuesTrack(s).clips = [
      { at: [1, 1, 1], type: 'section', key: 'Intro' },
      { at: [1, 2, 1], type: 'section', key: 'Verse 1' },
      { at: [1, 3, 1], type: 'count', key: '5' },
      { at: [1, 4, 1], type: 'cue', key: 'Nope' },
    ];
    const out = buildSchedule(s, catalog);
    assert.deepEqual(cues(out).map((e) => e.sample), ['es/Intro', 'en/Verse 1']);
    assert.deepEqual(out.warnings, [
      'No es count "5"; that beat is silent.',
      'No es section "Verse 1"; using English.',
      'No recording for cue "Nope"; skipped.',
    ]);
  });

  test('at the same time, the click comes before the cue', () => {
    const s = song();
    cuesTrack(s).clips = [{ at: [1, 1, 1], type: 'count', key: '1' }];
    const out = buildSchedule(s, catalog);
    assert.deepEqual(out.events.slice(0, 2).map((e) => e.kind), ['click', 'cue']);
  });
});

describe('buildSchedule: clips and sections', () => {
  test('audio clips are listed per track', () => {
    const s = song();
    s.tracks.push(
      { id: 'a1', type: 'audio', name: 'Song', color: 2, volumeDb: 0, muted: false, output: 'both', clip: { file: 'Song.wav', startSec: 3.214 } },
      { id: 'a2', type: 'audio', name: 'Empty', color: 3, volumeDb: 0, muted: false, output: 'both', clip: null },
    );
    assert.deepEqual(buildSchedule(s, catalog).clips, [{ track: 'a1', file: 'Song.wav', startSec: 3.214 }]);
  });

  test('locators become sections, sorted, each ending before the next or at the end bar', () => {
    const s = song({ endBar: 10, locators: [{ bar: 7, name: 'Chorus' }, { bar: 3, name: 'Intro' }] });
    assert.deepEqual(buildSchedule(s, catalog).sections, [
      { name: 'Intro', startBar: 3, endBar: 6, startSec: 4, endSec: 12 },
      { name: 'Chorus', startBar: 7, endBar: 10, startSec: 12, endSec: 20 },
    ]);
  });

  test('sectionAt finds the section a bar is in, or -1 before the first locator', () => {
    const s = buildSchedule(song({ endBar: 10, locators: [{ bar: 3, name: 'Intro' }, { bar: 7, name: 'Chorus' }] }), catalog);
    assert.equal(sectionAt(s, 2), -1);
    assert.equal(sectionAt(s, 3), 0);
    assert.equal(sectionAt(s, 6), 0);
    assert.equal(sectionAt(s, 10), 1);
  });
});

describe('live transitions', () => {
  // 4/4 at 120 (2 s bars), 8 bars; sections: A bars 1–4, B bars 5–8.
  const sched = () => buildSchedule(song({ endBar: 8, locators: [{ bar: 1, name: 'A' }, { bar: 5, name: 'B' }] }), catalog);
  const end = (s, st) => nextPosition(s, st, { type: 'barEnd' });

  test('starts at bar 1 or at a chosen bar', () => {
    const s = sched();
    assert.deepEqual(initialPlayState(s), { bar: 1, pendingJump: null, loop: null, elapsedSec: 0 });
    assert.equal(initialPlayState(s, { fromBar: 5 }).bar, 5);
    assert.throws(() => initialPlayState(s, { fromBar: 9 }), RangeError);
  });

  test('barEnd advances and adds the finished bar to the elapsed time; ends after the end bar', () => {
    const s = sched();
    let st = initialPlayState(s, { fromBar: 7 });
    let r = end(s, st);
    assert.equal(r.state.bar, 8);
    assert.equal(r.state.elapsedSec, 2);
    st = r.state;
    r = end(s, st);
    assert.equal(r.end, true);
  });

  test('elapsed time follows bar lengths across tempo and meter changes', () => {
    const s = buildSchedule(song({
      endBar: 3,
      tempo: [{ bar: 1, bpm: 120 }, { bar: 3, bpm: 60 }],
      meter: [{ bar: 1, beats: 4, unit: 4 }, { bar: 2, beats: 3, unit: 4 }],
    }), catalog);
    let st = initialPlayState(s);
    st = end(s, st).state;
    st = end(s, st).state;
    near(st.elapsedSec, 2 + 1.5);
    assert.equal(st.bar, 3);
  });

  test('jump: lands at the target locator on the next bar line; same again cancels; another replaces', () => {
    const s = sched();
    let st = initialPlayState(s);
    st = nextPosition(s, st, { type: 'jump', section: 1 }).state;
    assert.equal(st.pendingJump, 1);
    assert.equal(nextPosition(s, st, { type: 'jump', section: 1 }).state.pendingJump, null);
    assert.equal(nextPosition(s, st, { type: 'jump', section: 0 }).state.pendingJump, 0);
    const r = end(s, st);
    assert.equal(r.jumped, true);
    assert.equal(r.state.bar, 5);
    assert.equal(r.state.pendingJump, null);
    assert.equal(r.state.elapsedSec, 2);
    assert.throws(() => nextPosition(s, st, { type: 'jump', section: 2 }), RangeError);
  });

  test('jump returns no announcement', () => {
    const s = sched();
    const r = nextPosition(s, initialPlayState(s), { type: 'jump', section: 1 });
    assert.equal('announce' in r, false);
  });

  test('a jump releases the loop', () => {
    const s = sched();
    let st = nextPosition(s, initialPlayState(s), { type: 'loop', range: { section: 0 } }).state;
    st = nextPosition(s, st, { type: 'jump', section: 1 }).state;
    assert.equal(end(s, st).state.loop, null);
  });

  test('loop a section: after its last bar, back to its first', () => {
    const s = sched();
    let st = nextPosition(s, initialPlayState(s, { fromBar: 3 }), { type: 'loop', range: { section: 0 } }).state;
    assert.deepEqual(st.loop, { startBar: 1, endBar: 4, section: 0 });
    st = end(s, st).state; // 3 -> 4
    const r = end(s, st); // 4 -> 1
    assert.equal(r.looped, true);
    assert.equal(r.state.bar, 1);
    assert.deepEqual(r.state.loop, st.loop);
  });

  test('loop a bar range; clearing it continues normally', () => {
    const s = sched();
    let st = nextPosition(s, initialPlayState(s, { fromBar: 6 }), { type: 'loop', range: { startBar: 6, endBar: 6 } }).state;
    let r = end(s, st);
    assert.equal(r.looped, true);
    assert.equal(r.state.bar, 6);
    st = nextPosition(s, r.state, { type: 'loop', range: null }).state;
    r = end(s, st);
    assert.equal(r.state.bar, 7);
  });

  test('invalid loop ranges throw', () => {
    const s = sched();
    const st = initialPlayState(s);
    assert.throws(() => nextPosition(s, st, { type: 'loop', range: { startBar: 5, endBar: 4 } }), RangeError);
    assert.throws(() => nextPosition(s, st, { type: 'loop', range: { startBar: 1, endBar: 9 } }), RangeError);
    assert.throws(() => nextPosition(s, st, { type: 'loop', range: { section: 5 } }), RangeError);
  });

  test('no drift: 10 000 loops of two bars at different tempos', () => {
    const s = buildSchedule(song({
      endBar: 2,
      tempo: [{ bar: 1, bpm: 68 }, { bar: 2, bpm: 97 }],
      meter: [{ bar: 1, beats: 6, unit: 4 }],
    }), catalog);
    let st = nextPosition(s, initialPlayState(s), { type: 'loop', range: { startBar: 1, endBar: 2 } }).state;
    for (let i = 0; i < 20000; i++) st = end(s, st).state;
    // Bar 1: 6 quarters at 68 = 90/17 s; bar 2: 6 quarters at 97 = 360/97 s.
    const expected = (10000 * (90 * 97 + 360 * 17)) / (17 * 97);
    assert.ok(Math.abs(st.elapsedSec - expected) < 1e-6, `${st.elapsedSec} vs ${expected}`);
    assert.equal(st.bar, 1);
  });

  test('barEvents: the events of the current bar with offsets from its downbeat', () => {
    const s = sched();
    const ev = barEvents(s, { ...initialPlayState(s), bar: 2 });
    assert.equal(ev.length, 4);
    assert.deepEqual(ev.map((e) => e.offset), [0, 0.5, 1, 1.5]);
    assert.ok(ev.every((e) => e.bar === 2));
  });
});

describe('clipStart', () => {
  test('spec examples', () => {
    assert.deepEqual(clipStart(3.214, 0), { delaySec: 3.214, fileOffsetSec: 0 });
    assert.deepEqual(clipStart(3.214, 10), { delaySec: 0, fileOffsetSec: 6.786 });
    assert.deepEqual(clipStart(-2, 0), { delaySec: 0, fileOffsetSec: 2 });
  });
});
