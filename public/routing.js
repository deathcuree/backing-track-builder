// Output routing. Split L/R mode (spec §2.6): the left channel is the in-ear feed, the right
// channel is the main (audience) feed. Click and guide connect only to the in-ear bus, so they can
// never reach the main output. Works with AudioContext and OfflineAudioContext.

export function createRouting(ctx) {
  const merger = ctx.createChannelMerger(2);
  const inEar = monoBus(ctx);
  const main = monoBus(ctx);
  inEar.connect(merger, 0, 0);
  main.connect(merger, 0, 1);
  merger.connect(ctx.destination);
  return {
    /** Click and guide: in-ears only. */
    clickGuide: inEar,
    dispose() {
      merger.disconnect();
      inEar.disconnect();
      main.disconnect();
    },
  };
}

function monoBus(ctx) {
  const bus = ctx.createGain();
  bus.channelCount = 1;
  bus.channelCountMode = 'explicit';
  bus.channelInterpretation = 'speakers';
  return bus;
}
