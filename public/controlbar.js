// Control Bar (top): tempo and time signature at bar 1, tap tempo, transport, position, zoom,
// import/export and save. Edits go to the song's bar-1 markers through the handlers.
import { LIMITS, METER_UNITS } from '/shared/song.js';
import { options, formatPosition, clock } from './ui.js';

const TAP_RESET_MS = 2000;
const TAPS_AVERAGED = 4;

/**
 * @param {HTMLElement} el
 * @param {{ onTempo: (bpm: number) => void, onMeter: (beats: number, unit: number) => void,
 *           onView: (view: 'arrangement'|'session') => void,
 *           onPlay: () => void, onLoop: () => void, onGrid: (value: 'auto'|'bar'|number) => void, onZoom: (factor: number) => void, onImport: () => void,
 *           onExport: () => void, onSave: () => void }} handlers
 */
export function createControlBar(el, handlers) {
  const beatChoices = Array.from({ length: LIMITS.beats[1] - LIMITS.beats[0] + 1 }, (_, i) => LIMITS.beats[0] + i);
  el.innerHTML = `
    <div class="cb-group">
      <label class="cb-label" for="cb-bpm">BPM</label>
      <input id="cb-bpm" class="cb-bpm" type="number" min="${LIMITS.bpm[0]}" max="${LIMITS.bpm[1]}" step="0.1" title="Tempo at bar 1 (quarter notes per minute)">
      <button id="cb-tap" type="button" title="Tap tempo">Tap</button>
      <select id="cb-beats" aria-label="Beats per bar at bar 1">${options(beatChoices, 4)}</select>
      <span aria-hidden="true">/</span>
      <select id="cb-unit" aria-label="Beat unit at bar 1">${options(METER_UNITS, 4)}</select>
    </div>
    <div class="cb-group cb-transport">
      <button id="cb-play" type="button" class="cb-play" aria-pressed="false" title="Play / Stop (Space)">▶</button>
      <output id="cb-position" class="cb-position" title="Position (bar. beat. sixteenth)">1. 1. 1</output>
      <output id="cb-time" class="cb-time">0:00</output>
      <button id="cb-loop" type="button" aria-pressed="false" title="Loop the brace on the bar ruler (Shift-drag the ruler to set it)">Loop</button>
    </div>
    <div class="cb-group">
      <label class="cb-label" for="cb-grid">Grid</label>
      <select id="cb-grid" title="Snap for cues (hold Cmd/Ctrl while dragging for sixteenths)">
        <option value="auto">Auto</option><option value="bar">1 Bar</option><option value="4">1/4</option><option value="2">1/8</option><option value="1">1/16</option>
      </select>
      <button id="cb-zoom-out" type="button" title="Zoom out (−)" aria-label="Zoom out">−</button>
      <button id="cb-zoom-in" type="button" title="Zoom in (+)" aria-label="Zoom in">+</button>
    </div>
    <div class="cb-title" id="cb-title"></div>
    <div class="cb-group cb-views" role="group" aria-label="View (Tab switches)">
      <button id="cb-view-arrangement" type="button" aria-pressed="true" title="Arrangement View (Tab)">Arrangement</button>
      <button id="cb-view-session" type="button" aria-pressed="false" title="Session View (Tab)">Session</button>
    </div>
    <div class="cb-group">
      <button id="cb-import" type="button" title="Add audio files as new tracks">Import audio</button>
      <button id="cb-export" type="button">Export WAV</button>
      <span id="cb-save-state" class="cb-save-state"></span>
      <button id="cb-save" type="button" class="primary">Save</button>
    </div>`;

  const $ = (id) => el.querySelector(`#${id}`);
  let taps = [];

  $('cb-bpm').addEventListener('input', () => handlers.onTempo($('cb-bpm').value === '' ? NaN : Number($('cb-bpm').value)));
  const meterChanged = () => handlers.onMeter(Number($('cb-beats').value), Number($('cb-unit').value));
  $('cb-beats').addEventListener('change', meterChanged);
  $('cb-unit').addEventListener('change', meterChanged);
  $('cb-tap').addEventListener('click', tap);
  $('cb-play').addEventListener('click', handlers.onPlay);
  $('cb-loop').addEventListener('click', handlers.onLoop);
  $('cb-view-arrangement').addEventListener('click', () => handlers.onView('arrangement'));
  $('cb-view-session').addEventListener('click', () => handlers.onView('session'));
  $('cb-grid').addEventListener('change', () => {
    const v = $('cb-grid').value;
    handlers.onGrid(v === 'auto' || v === 'bar' ? v : Number(v));
  });
  $('cb-zoom-in').addEventListener('click', () => handlers.onZoom(1.5));
  $('cb-zoom-out').addEventListener('click', () => handlers.onZoom(1 / 1.5));
  $('cb-import').addEventListener('click', handlers.onImport);
  $('cb-export').addEventListener('click', handlers.onExport);
  $('cb-save').addEventListener('click', handlers.onSave);

  return {
    /** Shows the song's bar-1 tempo and meter (fields being typed in are left alone). */
    render(song) {
      $('cb-title').textContent = song.title || 'Untitled';
      const bpm = song.tempo?.[0]?.bpm;
      if (document.activeElement !== $('cb-bpm')) $('cb-bpm').value = Number.isFinite(bpm) ? bpm : '';
      const meter = song.meter?.[0];
      if (meter) {
        $('cb-beats').value = meter.beats;
        $('cb-unit').value = meter.unit;
      }
    },
    setPlaying(playing) {
      $('cb-play').textContent = playing ? '■' : '▶';
      $('cb-play').setAttribute('aria-pressed', String(playing));
      $('cb-play').classList.toggle('on', playing);
    },
    setView(view) {
      $('cb-view-arrangement').setAttribute('aria-pressed', String(view === 'arrangement'));
      $('cb-view-session').setAttribute('aria-pressed', String(view === 'session'));
    },
    setLoop(on) {
      $('cb-loop').setAttribute('aria-pressed', String(on));
    },
    /** @param {{ bar: number, beat: number, sixteenth: number }} pos @param {number} songSec */
    setPosition(pos, songSec) {
      $('cb-position').value = formatPosition(pos);
      $('cb-time').value = clock(songSec);
    },
    setSaveState(text, dirty) {
      $('cb-save-state').textContent = text;
      $('cb-save-state').classList.toggle('dirty', dirty);
    },
    setButtons({ save, import: canImport, importTitle, exportEnabled, exportTitle }) {
      $('cb-save').disabled = !save;
      $('cb-import').disabled = !canImport;
      $('cb-import').title = importTitle;
      $('cb-export').disabled = !exportEnabled;
      $('cb-export').title = exportTitle;
    },
  };

  // Average of the last few tap intervals; a pause longer than 2 s starts over.
  function tap() {
    const now = performance.now();
    if (taps.length && now - taps.at(-1) > TAP_RESET_MS) taps = [];
    taps.push(now);
    taps = taps.slice(-(TAPS_AVERAGED + 1));
    if (taps.length < 2) return;
    const avgMs = (taps.at(-1) - taps[0]) / (taps.length - 1);
    const bpm = Math.round((60000 / avgMs) * 10) / 10;
    const clamped = Math.min(LIMITS.bpm[1], Math.max(LIMITS.bpm[0], bpm));
    $('cb-bpm').value = clamped;
    handlers.onTempo(clamped);
  }
}
