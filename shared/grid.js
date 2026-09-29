// Bar/beat grid of a version-2 song: where every bar starts and how long it lasts, from the tempo
// and meter markers the user placed by hand. Pure; shared by the timing engine, the UI and tests.
//
// Positions are [bar, beat, sixteenth], all 1-based, as Ableton shows them ("17.3.1"). A beat is
// the meter's unit (a quarter in x/4, an eighth in x/8), so a beat holds 16 / unit sixteenths.
// BPM always counts quarter notes (Ableton's convention): a sixteenth lasts 15 / bpm seconds.
// Times are song seconds: bar 1 starts at 0.

const EPSILON = 1e-9; // absorbs float error when turning seconds back into grid positions

/**
 * @param {{ endBar: number, tempo: { bar: number, bpm: number }[],
 *           meter: { bar: number, beats: number, unit: number }[] }} song
 * @returns {{
 *   bars: { bar: number, startSec: number, sec: number, beats: number, unit: number, bpm: number }[],
 *   endSec: number,
 *   secAt: (at: [number, number, number]) => number,
 *   positionAt: (sec: number) => { bar: number, beat: number, sixteenth: number, fraction: number },
 * }} `bars[i]` is bar i + 1
 */
export function buildGrid(song) {
  const { endBar, tempo, meter } = song;
  if (!Number.isInteger(endBar) || endBar < 1) throw new RangeError(`Invalid end bar: ${endBar}`);
  if (!tempo?.length || tempo[0].bar !== 1) throw new RangeError('The first tempo marker must be at bar 1');
  if (!meter?.length || meter[0].bar !== 1) throw new RangeError('The first meter marker must be at bar 1');

  const bars = [];
  let startSec = 0;
  let t = 0;
  let m = 0;
  for (let bar = 1; bar <= endBar; bar++) {
    while (tempo[t + 1]?.bar <= bar) t++;
    while (meter[m + 1]?.bar <= bar) m++;
    const { bpm } = tempo[t];
    const { beats, unit } = meter[m];
    if (!(bpm > 0)) throw new RangeError(`Invalid BPM at bar ${bar}: ${bpm}`);
    if (!(beats > 0) || !(unit > 0)) throw new RangeError(`Invalid time signature at bar ${bar}`);
    const sec = (beats * (16 / unit) * 15) / bpm;
    bars.push({ bar, startSec, sec, beats, unit, bpm });
    startSec += sec;
  }
  const endSec = startSec;

  return {
    bars,
    endSec,
    secAt([bar, beat, sixteenth]) {
      const b = bars[bar - 1];
      if (!b) throw new RangeError(`Bar ${bar} is outside the song`);
      const sixteenths = (beat - 1) * (16 / b.unit) + (sixteenth - 1);
      return b.startSec + (sixteenths * 15) / b.bpm;
    },
    positionAt(sec) {
      if (!(sec > 0)) return { bar: 1, beat: 1, sixteenth: 1, fraction: 0 };
      if (sec >= endSec) return lastPosition(bars.at(-1));
      const b = bars[findBar(bars, sec)];
      const within = sec - b.startSec;
      const perBeat = 16 / b.unit;
      const sixteenths = Math.floor((within * b.bpm) / 15 + EPSILON);
      if (sixteenths >= b.beats * perBeat) return lastPosition(b);
      return {
        bar: b.bar,
        beat: Math.floor(sixteenths / perBeat) + 1,
        sixteenth: (sixteenths % perBeat) + 1,
        fraction: Math.max(0, within / b.sec),
      };
    },
  };
}

function lastPosition(b) {
  return { bar: b.bar, beat: b.beats, sixteenth: 16 / b.unit, fraction: 1 };
}

// Index of the last bar starting at or before `sec` (allowing float error at bar lines).
function findBar(bars, sec) {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].startSec <= sec + EPSILON) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
