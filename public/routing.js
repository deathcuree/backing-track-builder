// Output routing. Split L/R mode (spec §2.6): the left channel is the in-ear feed, the right
// channel is the main (audience) feed. Every track has a strip: its volume/mute, then a switch
// to the in-ear bus, the main bus or both (the track's output setting).
//   track ─► volume/mute ─┬─► to in-ears ─► in-ears bus ─► master ─► limiter ─► L
//                          └─► to main ────► main bus ────► master ─► limiter ─► R
// Each output ends in a safety limiter: many tracks summed would otherwise clip (distort) in the
// band's ears. Both feeds pass through the same limiter type, so timing between them is unchanged.
// Works with AudioContext and OfflineAudioContext.

const RAMP_SEC = 0.01; // level changes settle within ~50 ms without zipper noise

export function createRouting(ctx, mix = {}) {
  const merger = ctx.createChannelMerger(2);
  const inEars = monoBus(ctx);
  const main = monoBus(ctx);
  const inEarsMaster = ctx.createGain();
  const mainMaster = ctx.createGain();
  const [inEarsLimit, inEarsOut] = limiter(ctx);
  const [mainLimit, mainOut] = limiter(ctx);
  inEars.connect(inEarsMaster).connect(inEarsLimit);
  main.connect(mainMaster).connect(mainLimit);
  inEarsOut.connect(merger, 0, 0);
  mainOut.connect(merger, 0, 1);
  merger.connect(ctx.destination);
  inEarsMaster.gain.value = levelGain(mix.inEarsDb ?? 0);
  mainMaster.gain.value = levelGain(mix.mainDb ?? 0);

  return {
    /** Track strips connect to these buses. */
    inEars,
    main,
    /** The merged stereo output (L = in-ears, R = main), for metering. */
    output: merger,
    /** Master levels. @param {{ inEarsDb?: number, mainDb?: number }} levels */
    setMix({ inEarsDb, mainDb }) {
      if (inEarsDb !== undefined) setLevel(ctx, inEarsMaster.gain, inEarsDb);
      if (mainDb !== undefined) setLevel(ctx, mainMaster.gain, mainDb);
    },
    dispose() {
      for (const node of [merger, inEars, main, inEarsMaster, mainMaster, inEarsLimit, inEarsOut, mainLimit, mainOut]) {
        node.disconnect();
      }
    },
  };
}

/**
 * Export layout (spec §2.7): the same left = in-ears / right = main split as live playback, each
 * side ending in the same safety limiter, without the master levels (those are for the room).
 */
export function createExportRouting(ctx) {
  const merger = ctx.createChannelMerger(2);
  const inEars = monoBus(ctx);
  const main = monoBus(ctx);
  const [leftLimit, leftOut] = limiter(ctx);
  const [rightLimit, rightOut] = limiter(ctx);
  inEars.connect(leftLimit);
  main.connect(rightLimit);
  leftOut.connect(merger, 0, 0);
  rightOut.connect(merger, 0, 1);
  merger.connect(ctx.destination);
  return { inEars, main };
}

/**
 * One track's strip into `buses` ({ inEars, main }). Connect the track's sources to `input`.
 * @param {{ volumeDb: number, muted: boolean, output: 'inEars'|'main'|'both' }} track
 */
export function createTrackStrip(ctx, buses, track) {
  const input = ctx.createGain();
  const toInEars = ctx.createGain();
  const toMain = ctx.createGain();
  input.connect(toInEars).connect(buses.inEars);
  input.connect(toMain).connect(buses.main);
  const apply = ({ volumeDb, muted, output }, set) => {
    set(input.gain, muted ? -Infinity : volumeDb);
    set(toInEars.gain, output === 'main' ? -Infinity : 0);
    set(toMain.gain, output === 'inEars' ? -Infinity : 0);
  };
  apply(track, (param, db) => { param.value = levelGain(db); });
  return {
    input,
    /** Live change of volume, mute or output (heard within ~50 ms). */
    set(next) {
      apply(next, (param, db) => setLevel(ctx, param, db));
    },
    dispose() {
      for (const node of [input, toInEars, toMain]) node.disconnect();
    },
  };
}

export function dbToGain(db) {
  return 10 ** (db / 20);
}

/** Smoothly moves an AudioParam to `db` (−60 dB and below is silence). */
export function setLevel(ctx, param, db) {
  param.setTargetAtTime(levelGain(db), ctx.currentTime, RAMP_SEC);
}

function levelGain(db) {
  return db <= -60 ? 0 : dbToGain(db);
}

const LIMIT_THRESHOLD_DB = -3;
const LIMIT_RATIO = 20;
// The Web Audio compressor always adds makeup gain of -0.6 × (its output level for a 0 dBFS
// input); undo it so signals below the threshold pass at exactly their original level.
const MAKEUP_DB = -0.6 * (LIMIT_THRESHOLD_DB - LIMIT_THRESHOLD_DB / LIMIT_RATIO);

// Catches peaks just below full scale; unity gain below -3 dBFS. Returns [input, output].
function limiter(ctx) {
  const l = ctx.createDynamicsCompressor();
  l.threshold.value = LIMIT_THRESHOLD_DB;
  l.knee.value = 0;
  l.ratio.value = LIMIT_RATIO;
  l.attack.value = 0.001;
  l.release.value = 0.1;
  l.channelCount = 1;
  l.channelCountMode = 'explicit';
  const undoMakeup = ctx.createGain();
  undoMakeup.gain.value = dbToGain(-MAKEUP_DB);
  l.connect(undoMakeup);
  return [l, undoMakeup];
}

function monoBus(ctx) {
  const bus = ctx.createGain();
  bus.channelCount = 1;
  bus.channelCountMode = 'explicit';
  bus.channelInterpretation = 'speakers';
  return bus;
}
