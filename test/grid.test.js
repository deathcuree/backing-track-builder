import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, autoStep } from '../shared/grid.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} != ${b}`);

function song(overrides = {}) {
  return {
    endBar: 8,
    tempo: [{ bar: 1, bpm: 120 }],
    meter: [{ bar: 1, beats: 4, unit: 4 }],
    ...overrides,
  };
}

describe('buildGrid', () => {
  test('4/4 at 120: two-second bars', () => {
    const g = buildGrid(song());
    assert.equal(g.bars.length, 8);
    assert.deepEqual(g.bars[0], { bar: 1, startSec: 0, sec: 2, beats: 4, unit: 4, bpm: 120 });
    near(g.bars[7].startSec, 14);
    near(g.endSec, 16);
  });

  test('spec example: 4/4 at 120, then 6/4 at 60 from bar 3', () => {
    const g = buildGrid(song({
      tempo: [{ bar: 1, bpm: 120 }, { bar: 3, bpm: 60 }],
      meter: [{ bar: 1, beats: 4, unit: 4 }, { bar: 3, beats: 6, unit: 4 }],
    }));
    near(g.bars[2].startSec, 4);
    near(g.bars[2].sec, 6);
    assert.equal(g.bars[2].beats, 6);
    assert.equal(g.bars[2].bpm, 60);
    near(g.secAt([3, 2, 1]), 5);
    near(g.secAt([1, 1, 3]), 0.25);
    near(g.endSec, 4 + 6 * 6);
  });

  test('BPM counts quarter notes: 6/8 at 120 has 0.25 s eighths', () => {
    const g = buildGrid(song({ meter: [{ bar: 1, beats: 6, unit: 8 }] }));
    near(g.bars[0].sec, 1.5);
    near(g.secAt([1, 2, 1]), 0.25);
    near(g.secAt([1, 1, 2]), 0.125);
    near(g.secAt([2, 1, 1]), 1.5);
  });

  test('a tempo change alone changes bar length from its bar', () => {
    const g = buildGrid(song({ tempo: [{ bar: 1, bpm: 120 }, { bar: 3, bpm: 60 }] }));
    near(g.bars[1].sec, 2);
    near(g.bars[2].sec, 4);
    near(g.bars[3].startSec, 8);
  });

  test('a single 2/4 bar inside 4/4', () => {
    const g = buildGrid(song({
      meter: [{ bar: 1, beats: 4, unit: 4 }, { bar: 2, beats: 2, unit: 4 }, { bar: 3, beats: 4, unit: 4 }],
    }));
    near(g.bars[1].sec, 1);
    near(g.bars[2].startSec, 3);
    assert.equal(g.bars[2].beats, 4);
  });

  test('positionAt finds bar, beat, sixteenth and fraction', () => {
    const g = buildGrid(song());
    assert.deepEqual(g.positionAt(0), { bar: 1, beat: 1, sixteenth: 1, fraction: 0 });
    assert.deepEqual(g.positionAt(3.125), { bar: 2, beat: 3, sixteenth: 2, fraction: 0.5625 });
  });

  test('positionAt clamps to the song', () => {
    const g = buildGrid(song());
    assert.deepEqual(g.positionAt(-5), { bar: 1, beat: 1, sixteenth: 1, fraction: 0 });
    const end = g.positionAt(1000);
    assert.equal(end.bar, 8);
    assert.equal(end.beat, 4);
    assert.equal(end.sixteenth, 4);
  });

  test('positionAt(secAt(p)) round-trips across meter and tempo changes', () => {
    const g = buildGrid(song({
      endBar: 12,
      tempo: [{ bar: 1, bpm: 68 }, { bar: 5, bpm: 97 }],
      meter: [{ bar: 1, beats: 6, unit: 4 }, { bar: 4, beats: 7, unit: 8 }, { bar: 9, beats: 5, unit: 4 }],
    }));
    for (const b of g.bars) {
      const perBeat = 16 / b.unit;
      for (let beat = 1; beat <= b.beats; beat++) {
        for (let six = 1; six <= perBeat; six++) {
          const p = g.positionAt(g.secAt([b.bar, beat, six]));
          assert.deepEqual([p.bar, p.beat, p.sixteenth], [b.bar, beat, six]);
        }
      }
    }
  });

  test('rejects songs it cannot time', () => {
    assert.throws(() => buildGrid(song({ tempo: [] })), RangeError);
    assert.throws(() => buildGrid(song({ meter: [{ bar: 2, beats: 4, unit: 4 }] })), RangeError);
    assert.throws(() => buildGrid(song({ endBar: 0 })), RangeError);
  });
});

describe('snapping', () => {
  // 4/4 at 120: a sixteenth is 0.125 s, a bar 2 s.
  const g = buildGrid(song({ endBar: 4 }));

  test('snap to sixteenths, eighths and quarters rounds to the nearest grid point', () => {
    assert.deepEqual(g.snap(0.3, 1), [1, 1, 3]);
    assert.deepEqual(g.snap(0.3, 2), [1, 1, 3]);
    assert.deepEqual(g.snap(0.3, 4), [1, 2, 1]);
    assert.deepEqual(g.snap(0.2, 4), [1, 1, 1]);
    assert.deepEqual(g.snap(2.8, 4), [2, 3, 1]);
  });

  test('rounding past the last grid point of a bar goes to the next downbeat', () => {
    assert.deepEqual(g.snap(1.9, 4), [2, 1, 1]);
  });

  test('snap to bars', () => {
    assert.deepEqual(g.snap(0.9, 'bar'), [1, 1, 1]);
    assert.deepEqual(g.snap(1.1, 'bar'), [2, 1, 1]);
  });

  test('clamped inside the song', () => {
    assert.deepEqual(g.snap(-3, 4), [1, 1, 1]);
    assert.deepEqual(g.snap(7.99, 4), [4, 4, 1]);
    assert.deepEqual(g.snap(100, 1), [4, 4, 4]);
    assert.deepEqual(g.snap(100, 'bar'), [4, 1, 1]);
  });

  test('x/8: a quarter step is two eighths, and a beat has two sixteenths', () => {
    const g8 = buildGrid(song({ meter: [{ bar: 1, beats: 7, unit: 8 }] }));
    assert.deepEqual(g8.snap(0.3, 2), [1, 2, 1]);
    assert.deepEqual(g8.snap(0.3, 1), [1, 2, 1]);
    assert.deepEqual(g8.snap(0.55, 4), [1, 3, 1]);
    // 7/8 = 14 sixteenths; the last quarter-step point inside the bar is at 12 (beat 7)
    assert.deepEqual(g8.snap(1.6, 4), [1, 7, 1]);
  });

  test('nearestBar picks the closest downbeat inside the song', () => {
    assert.equal(g.nearestBar(2.9), 2);
    assert.equal(g.nearestBar(3.1), 3);
    assert.equal(g.nearestBar(-1), 1);
    assert.equal(g.nearestBar(99), 4);
  });

  test('autoStep: the finest step whose lines are at least 12 px apart', () => {
    assert.equal(autoStep(13), 1);
    assert.equal(autoStep(7), 2);
    assert.equal(autoStep(4), 4);
    assert.equal(autoStep(2), 'bar');
  });
});
