import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSchedule, secAtBar, barAt, initialPlayState, nextPosition, barEvents,
} from '../shared/schedule.js';

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
  return {
    version: 1, id: 't', title: 'T', bpm: 120, meter: [4, 4],
    click: { sound: 'Classic', subdivision: 'quarter', volumeDb: 0 },
    guide: { language: 'en', volumeDb: 0 },
    countInBars: 1,
    sections: [{ name: 'Intro', bars: 4 }, { name: 'Verse 1', bars: 8 }],
    cues: [], stems: [], stemOffsetMs: 0,
    ...overrides,
  };
}

const clicks = (s) => s.events.filter((e) => e.kind === 'click');
const guides = (s) => s.events.filter((e) => e.kind === 'guide');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} != ${b}`);

describe('buildSchedule', () => {
  // AC 2: 4/4 @120, [Intro 4, Verse 1 8], count-in 1. t0 = 2.0 s.
  test('AC 2: click grid, accents, section cues and end time', () => {
    const s = buildSchedule(song(), catalog);
    assert.equal(s.t0, 2);
    const c = clicks(s);
    assert.equal(c.length, 13 * 4);
    c.forEach((e, i) => near(e.t, i * 0.5, `click ${i}`));
    for (const e of c) assert.equal(e.sample, e.t % 2 === 0 ? 'c/A' : 'c/Q');
    const g = guides(s);
    assert.deepEqual(g.filter((e) => e.role === 'section').map((e) => [e.t, e.sample, e.bar]),
      [[0, 'en/Intro', 0], [8, 'en/Verse 1', 4]]);
    assert.equal(s.totalSec, 26);
    assert.deepEqual(s.sections.map(({ name, startBar, bars, startSec, endSec }) =>
      ({ name, startBar, bars, startSec, endSec })), [
      { name: 'Intro', startBar: 1, bars: 4, startSec: 2, endSec: 10 },
      { name: 'Verse 1', startBar: 5, bars: 8, startSec: 10, endSec: 26 },
    ]);
  });

  test('count-in voice gives the first half of the bar holding the Intro cue to the cue', () => {
    const one = guides(buildSchedule(song(), catalog)).filter((e) => e.role === 'count');
    assert.deepEqual(one.map((e) => [e.t, e.sample]), [[1, 'en/3'], [1.5, 'en/4']]);

    const two = buildSchedule(song({ countInBars: 2 }), catalog);
    assert.equal(two.t0, 4);
    assert.deepEqual(guides(two).map((e) => [e.t, e.sample]), [
      [0, 'en/1'], [0.5, 'en/2'], [1, 'en/3'], [1.5, 'en/4'],
      [2, 'en/Intro'], [3, 'en/3'], [3.5, 'en/4'],
      [10, 'en/Verse 1'],
    ]);
  });

  test('no count-in: song starts at 0 and section 1 has no cue', () => {
    for (const s of [buildSchedule(song({ countInBars: 0 }), catalog),
      buildSchedule(song({ countInBars: 2 }), catalog, { countIn: false })]) {
      assert.equal(s.t0, 0);
      assert.equal(s.totalSec, 24);
      near(clicks(s)[0].t, 0);
      assert.deepEqual(guides(s).map((e) => [e.t, e.sample]), [[6, 'en/Verse 1']]);
    }
  });

  test('AC 3: 6/8 @120 has 6 hits per bar 0.5 s apart, accent first', () => {
    const s = buildSchedule(song({ meter: [6, 8], countInBars: 0, sections: [{ name: 'Intro', bars: 2 }] }), catalog);
    const c = clicks(s);
    assert.equal(c.length, 12);
    c.forEach((e, i) => near(e.t, i * 0.5));
    assert.deepEqual(c.slice(0, 7).map((e) => e.sample), ['c/A', 'c/Q', 'c/Q', 'c/Q', 'c/Q', 'c/Q', 'c/A']);
    assert.equal(s.totalSec, 6);
  });

  test('AC 4: eighth and sixteenth subdivisions', () => {
    const base = { countInBars: 0, sections: [{ name: 'Intro', bars: 1 }] };
    const e8 = clicks(buildSchedule(song({ ...base, click: { sound: 'Classic', subdivision: 'eighth' } }), catalog));
    assert.deepEqual(e8.map((e) => [e.t, e.sample]), [
      [0, 'c/A'], [0.25, 'c/E'], [0.5, 'c/Q'], [0.75, 'c/E'],
      [1, 'c/Q'], [1.25, 'c/E'], [1.5, 'c/Q'], [1.75, 'c/E'],
    ]);
    const e16 = clicks(buildSchedule(song({ ...base, click: { sound: 'Classic', subdivision: 'sixteenth' } }), catalog));
    assert.equal(e16.length, 16);
    assert.deepEqual(e16.slice(0, 5).map((e) => [e.t, e.sample]), [
      [0, 'c/A'], [0.125, 'c/S'], [0.25, 'c/E'], [0.375, 'c/S'], [0.5, 'c/Q'],
    ]);
  });

  test('AC 5: dynamic cue on its downbeat, moved to beat 3 when a section cue shares the bar', () => {
    const s = buildSchedule(song({ cues: [{ name: 'Build', bar: 6 }, { name: 'Build', bar: 4 }] }), catalog);
    const cues = guides(s).filter((e) => e.role === 'cue');
    assert.deepEqual(cues.map((e) => [e.t, e.bar]), [[2 + 6 + 1, 4], [2 + 10, 6]]);
  });

  test('collision beat in odd meters is ceil(n/2)+1', () => {
    const s = buildSchedule(song({ meter: [7, 8], countInBars: 0, cues: [{ name: 'Build', bar: 4 }] }), catalog);
    const cue = guides(s).find((e) => e.role === 'cue');
    near(cue.t, 3 * 3.5 + 4 * 0.5); // bar 4 starts at 10.5 s, beat 5
  });

  test('volumes are carried on events', () => {
    const s = buildSchedule(song({ click: { sound: 'Classic', subdivision: 'quarter', volumeDb: -6 },
      guide: { language: 'en', volumeDb: -3 } }), catalog);
    assert.ok(clicks(s).every((e) => e.gainDb === -6));
    assert.ok(guides(s).every((e) => e.gainDb === -3));
  });

  test('fallbacks: missing click role uses Classic, missing language item uses English, missing count is silent', () => {
    const s = buildSchedule(song({
      click: { sound: 'Digital', subdivision: 'eighth' },
      guide: { language: 'es' },
      cues: [{ name: 'Build', bar: 2 }],
    }), catalog);
    const c = clicks(s);
    assert.deepEqual(c.slice(0, 3).map((e) => e.sample), ['d/A', 'c/E', 'c/Q']);
    const g = guides(s);
    assert.deepEqual(g.map((e) => e.sample), ['es/Intro', 'es/3', 'en/Build', 'en/Verse 1']);
    assert.deepEqual(s.warnings, [
      'Digital has no eighth click; using Classic for those hits.',
      'Digital has no quarter click; using Classic for those hits.',
      'No es count "4"; that beat is silent.',
      'No es cue "Build"; using English.',
      'No es section "Verse 1"; using English.',
    ]);
  });

  test('unknown guide names and cues past the last bar are skipped with warnings', () => {
    const s = buildSchedule(song({
      sections: [{ name: 'Intro', bars: 2 }, { name: 'Mystery', bars: 2 }],
      cues: [{ name: 'Build', bar: 5 }, { name: 'Nope', bar: 1 }],
    }), catalog);
    assert.deepEqual(guides(s).map((e) => e.sample), ['en/Intro', 'en/3', 'en/4']);
    assert.deepEqual(s.warnings, [
      'Cue "Build" at bar 5 is past the end of the song (4 bars); skipped.',
      'No recording for cue "Nope"; skipped.',
      'No recording for section "Mystery"; skipped.',
    ]);
    assert.equal(s.sections[1].cueSample, null);
  });

  test('rejects songs that cannot be timed', () => {
    assert.throws(() => buildSchedule(song({ bpm: 0 }), catalog), RangeError);
    assert.throws(() => buildSchedule(song({ meter: [0, 4] }), catalog), RangeError);
    assert.throws(() => buildSchedule(song({ sections: [{ name: 'Intro', bars: 0 }] }), catalog), RangeError);
    assert.throws(() => buildSchedule(song({ sections: [] }), catalog), RangeError);
  });

  test('deterministic and does not modify the song', () => {
    const input = song({ cues: [{ name: 'Build', bar: 4 }] });
    const frozen = structuredClone(input);
    deepFreeze(input);
    assert.deepEqual(buildSchedule(input, catalog), buildSchedule(input, catalog));
    assert.deepEqual(input, frozen);
  });

  test('decimal BPM stays on grid over a long song', () => {
    const s = buildSchedule(song({ bpm: 72.5, countInBars: 0, sections: [{ name: 'Intro', bars: 400 }] }), catalog);
    const c = clicks(s);
    near(c.at(-1).t, 1599 * 60 / 72.5);
  });
});

describe('secAtBar / barAt (song time, bar 1 = 0 s)', () => {
  test('convert between bars and seconds', () => {
    const s = song();
    assert.equal(secAtBar(s, 1), 0);
    assert.equal(secAtBar(s, 5), 8);
    assert.equal(barAt(s, 8), 5);
    assert.equal(barAt(s, 7.999), 4);
    assert.equal(barAt(s, -0.1), 0);
  });
});

describe('nextPosition', () => {
  const three = song({ sections: [{ name: 'Intro', bars: 4 }, { name: 'Verse 1', bars: 8 }, { name: 'Chorus', bars: 8 }] });
  const barEnd = { type: 'barEnd' };

  function run(state, n) {
    const bars = [];
    for (let i = 0; i < n; i++) {
      ({ state } = nextPosition(three, state, barEnd));
      bars.push(state.bar);
    }
    return { state, bars };
  }

  test('starts in the count-in and plays bars in order to the end', () => {
    let state = initialPlayState(three);
    assert.equal(state.bar, 0);
    const r = run(state, 20);
    assert.deepEqual(r.bars, Array.from({ length: 20 }, (_, i) => i + 1));
    const last = nextPosition(three, r.state, barEnd);
    assert.equal(last.end, true);
    state = initialPlayState(three, { countIn: false });
    assert.equal(state.bar, 1);
  });

  test('jump lands on the next downbeat; first-half request announces the target', () => {
    let { state } = run(initialPlayState(three), 2); // in bar 2
    const early = nextPosition(three, state, { type: 'jump', section: 2, barFraction: 0.3 });
    assert.equal(early.announce, 2);
    state = early.state;
    const next = nextPosition(three, state, barEnd);
    assert.equal(next.state.bar, 13);
    assert.equal(next.jumped, true);
    assert.equal(next.state.pendingJump, null);

    const late = nextPosition(three, next.state, { type: 'jump', section: 0, barFraction: 0.5 });
    assert.equal(late.announce, null);
    assert.equal(nextPosition(three, late.state, barEnd).state.bar, 1);
  });

  test('a different jump replaces the pending one; the same one cancels it', () => {
    let { state } = run(initialPlayState(three), 2);
    state = nextPosition(three, state, { type: 'jump', section: 2, barFraction: 0.1 }).state;
    state = nextPosition(three, state, { type: 'jump', section: 1, barFraction: 0.2 }).state;
    assert.equal(state.pendingJump, 1);
    assert.equal(nextPosition(three, state, barEnd).state.bar, 5);

    const cancelled = nextPosition(three, state, { type: 'jump', section: 1, barFraction: 0.9 });
    assert.equal(cancelled.state.pendingJump, null);
    assert.equal(cancelled.announce, null);
    assert.equal(nextPosition(three, cancelled.state, barEnd).state.bar, 3);
  });

  test('AC 7: loop repeats a section 50 times without drift, then release continues', () => {
    let { state } = run(initialPlayState(three), 1); // bar 1 (Intro, bars 1-4)
    state = nextPosition(three, state, { type: 'loop' }).state;
    assert.equal(state.loop, 0);
    const r = run(state, 4 * 50);
    const expected = Array.from({ length: 200 }, (_, i) => [2, 3, 4, 1][i % 4]);
    assert.deepEqual(r.bars, expected);
    // Elapsed time is counted in whole bars (count-in + bar 1 + 200 looped bars), so it cannot drift.
    assert.equal(r.state.barsElapsed, 201);

    state = nextPosition(three, r.state, { type: 'loop' }).state; // release in bar 1
    assert.equal(state.loop, null);
    assert.deepEqual(run(state, 4).bars, [2, 3, 4, 5]);
  });

  test('jump to a section that does not exist is rejected immediately', () => {
    assert.throws(() => nextPosition(three, initialPlayState(three), { type: 'jump', section: 3, barFraction: 0 }), RangeError);
  });

  test('jump clears a loop; loop during count-in is ignored', () => {
    let { state } = run(initialPlayState(three), 6); // bar 6, Verse 1
    state = nextPosition(three, state, { type: 'loop' }).state;
    state = nextPosition(three, state, { type: 'jump', section: 2, barFraction: 0.8 }).state;
    const next = nextPosition(three, state, barEnd).state;
    assert.equal(next.bar, 13);
    assert.equal(next.loop, null);

    const counting = nextPosition(three, initialPlayState(three), { type: 'loop' });
    assert.equal(counting.state.loop, null);
  });
});

describe('barEvents', () => {
  const three = song({ sections: [{ name: 'Intro', bars: 4 }, { name: 'Verse 1', bars: 8 }, { name: 'Chorus', bars: 8 }] });
  const schedule = buildSchedule(three, catalog);

  test('returns a bar\'s events with offsets from the bar start', () => {
    const state = { ...initialPlayState(three), bar: 4 };
    const ev = barEvents(schedule, state);
    assert.deepEqual(ev.map((e) => [e.offset, e.kind, e.sample]), [
      [0, 'click', 'c/A'], [0, 'guide', 'en/Verse 1'], [0.5, 'click', 'c/Q'], [1, 'click', 'c/Q'], [1.5, 'click', 'c/Q'],
    ]);
    assert.deepEqual(barEvents(schedule, initialPlayState(three)).map((e) => e.offset), [0, 0, 0.5, 1, 1, 1.5, 1.5]);
  });

  test('looping suppresses the next section\'s cue in the loop\'s last bar only', () => {
    const state = { ...initialPlayState(three), bar: 4, loop: 0 };
    assert.ok(!barEvents(schedule, state).some((e) => e.role === 'section'));
    assert.equal(barEvents(schedule, { ...state, loop: 1 }).filter((e) => e.role === 'section').length, 1);
  });
});

function deepFreeze(o) {
  Object.values(o).forEach((v) => typeof v === 'object' && v && deepFreeze(v));
  return Object.freeze(o);
}
