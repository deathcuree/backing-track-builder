// Output routing. Split L/R mode (spec §2.6): the left channel is the in-ear feed, the right
// channel is the main (audience) feed.
//   click + guide ──────────────────────────► in-ear (L)
//   stems ──► in-ear stems level ───────────► in-ear (L)
//        └──► main stems level ─────────────► main   (R)
// Click and guide connect only to the in-ear bus, so they can never reach the main output.
// Each output ends in a safety limiter: click + guide + many stems summed would otherwise clip
// (distort) in the band's ears. Both feeds pass through the same limiter type, so timing between
// click and stems is unchanged. Works with AudioContext and OfflineAudioContext.

const RAMP_SEC = 0.01; // level changes settle within ~50 ms without zipper noise

export function createRouting(ctx, mix = {}) {
  const merger = ctx.createChannelMerger(2);
  const inEar = monoBus(ctx);
  const main = monoBus(ctx);
  const [inEarLimit, inEarOut] = limiter(ctx);
  const [mainLimit, mainOut] = limiter(ctx);
  inEar.connect(inEarLimit);
  main.connect(mainLimit);
  inEarOut.connect(merger, 0, 0);
  mainOut.connect(merger, 0, 1);
  merger.connect(ctx.destination);

  const stems = ctx.createGain();
  const stemsToInEar = ctx.createGain();
  const stemsToMain = ctx.createGain();
  stems.connect(stemsToInEar).connect(inEar);
  stems.connect(stemsToMain).connect(main);

  const routing = {
    /** Click and guide: in-ears only. */
    clickGuide: inEar,
    /** All stems: to in-ears and main, each at its own master level. */
    stems,
    /** The merged stereo output (L = in-ear, R = main), for metering. */
    output: merger,
    /** @param {{ inEarStemsDb?: number, mainStemsDb?: number }} levels */
    setMix({ inEarStemsDb, mainStemsDb }) {
      if (inEarStemsDb !== undefined) setLevel(ctx, stemsToInEar.gain, inEarStemsDb);
      if (mainStemsDb !== undefined) setLevel(ctx, stemsToMain.gain, mainStemsDb);
    },
    dispose() {
      for (const node of [merger, inEar, main, inEarLimit, inEarOut, mainLimit, mainOut, stems, stemsToInEar, stemsToMain]) {
        node.disconnect();
      }
    },
  };
  stemsToInEar.gain.value = dbToGain(mix.inEarStemsDb ?? 0);
  stemsToMain.gain.value = dbToGain(mix.mainStemsDb ?? 0);
  return routing;
}

/**
 * Export layout (spec §2.7) for a backup file played through a Y-cable:
 *   click + guide ──► left      stems ──► right
 * Each side ends in the same safety limiter as live playback.
 */
export function createExportRouting(ctx) {
  const merger = ctx.createChannelMerger(2);
  const left = monoBus(ctx);
  const right = monoBus(ctx);
  const [leftLimit, leftOut] = limiter(ctx);
  const [rightLimit, rightOut] = limiter(ctx);
  left.connect(leftLimit);
  right.connect(rightLimit);
  leftOut.connect(merger, 0, 0);
  rightOut.connect(merger, 0, 1);
  merger.connect(ctx.destination);
  return { clickGuide: left, stems: right };
}

export function dbToGain(db) {
  return 10 ** (db / 20);
}

/** Smoothly moves an AudioParam to `db` (−60 dB and below is silence). */
export function setLevel(ctx, param, db) {
  param.setTargetAtTime(db <= -60 ? 0 : dbToGain(db), ctx.currentTime, RAMP_SEC);
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
