// Arrangement View (center), laid out like Ableton's: rulers and the locator/tempo/meter strips on
// top, one lane per track with its header and mixer strip on the right, the time ruler and the
// In-ears/Main masters at the bottom, and a playhead.
//
// Time runs left to right at `pps` pixels per second. Bars are placed from the grid, so tempo and
// meter changes show as wider or narrower bars. Rulers, grid lines and waveforms are drawn on
// canvases that cover only the visible part (a song can be thousands of screens wide when zoomed
// in); clips, cues, locators and markers are elements so they can be clicked.
import { OUTPUTS, LIMITS } from '/shared/song.js';
import { peakRange } from '/shared/waveform.js';
import { esc, options, formatDb, clock, TRACK_COLORS, OUTPUT_NAMES } from './ui.js';

const HEADER_PX = 260;
const PPS_RANGE = [2, 1000];
const END_MARGIN_PX = 400;
const CUE_ROWS = 3;
const CUE_ROW_PX = 18;
const CLIP_TITLE_PX = 14;
const STRIPS = [['locator', 'Locators'], ['tempo', 'Tempo'], ['meter', 'Time sig.']];

/**
 * @param {HTMLElement} el
 * @param {{ onSelect: (sel: { kind: string, ref: object } | null) => void,
 *           onStartBar: (bar: number) => void, onTrackChange: (track: object) => void,
 *           onMasterChange: (key: 'inEarsDb'|'mainDb', db: number) => void,
 *           onAdd: (kind: 'locator'|'tempo'|'meter') => void,
 *           getPeaks: (track: object) => { peaks: object, sampleRate: number, duration: number } | null }} handlers
 */
export function createArrangement(el, handlers) {
  el.innerHTML = `
    <div class="arr-scroll">
      <div class="arr-inner">
        <div class="arr-head">
          <div class="arr-row ruler-row">
            <div class="lane" data-ruler="bars"><canvas data-draw="bars"></canvas><div class="start-marker" title="Start bar"></div></div>
            <div class="hdr hdr-strip"><span class="hdr-title">Bar</span><span class="muted small">Click to set the start</span></div>
          </div>
          ${STRIPS.map(([kind, label]) => `
            <div class="arr-row strip-row" data-strip="${kind}">
              <div class="lane" data-lane="${kind}"><canvas data-draw="strip"></canvas><div class="items"></div></div>
              <div class="hdr hdr-strip">
                <span class="hdr-title">${label}</span>
                <button type="button" data-add="${kind}" title="Add a ${label.toLowerCase().replace('.', '')} ${kind === 'locator' ? '' : 'marker '}at the start bar">+</button>
              </div>
            </div>`).join('')}
        </div>
        <div class="arr-tracks"></div>
        <div class="arr-foot">
          <div class="arr-row time-row">
            <div class="lane"><canvas data-draw="time"></canvas></div>
            ${masterHeader('inEarsDb', 'In-ears', 'Left channel: what the band hears')}
          </div>
          <div class="arr-row time-row">
            <div class="lane"></div>
            ${masterHeader('mainDb', 'Main', 'Right channel: the audience')}
          </div>
        </div>
        <div class="playhead" hidden></div>
      </div>
    </div>`;

  const scroll = el.querySelector('.arr-scroll');
  const inner = el.querySelector('.arr-inner');
  const tracksEl = el.querySelector('.arr-tracks');
  const playhead = el.querySelector('.playhead');
  const startMarker = el.querySelector('.start-marker');
  let pps = 40;
  let view = null; // last render input
  let trackSignature = '';
  let refs = {}; // kind -> objects, indexed by the items' data-i
  let drawFrame = 0;
  let playheadSec = null;

  new ResizeObserver(() => redraw()).observe(scroll);
  scroll.addEventListener('scroll', () => redraw(), { passive: true });

  scroll.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY * 0.002), e.clientX);
  }, { passive: false });

  el.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) return handlers.onAdd(add.dataset.add);
    const ruler = e.target.closest('[data-ruler="bars"]');
    if (ruler && view) return handlers.onStartBar(view.grid.positionAt(laneX(e, ruler) / pps).bar);
    const item = e.target.closest('[data-kind]');
    if (item) {
      const ref = item.dataset.kind === 'track' ? trackById(item.dataset.track) : refs[item.dataset.kind]?.[item.dataset.i];
      return handlers.onSelect(ref ? { kind: item.dataset.kind, ref } : null);
    }
    if (e.target.closest('.hdr-mixer, .hdr-master, .hdr-strip')) return;
    if (e.target.closest('.lane')) handlers.onSelect(null);
  });

  el.addEventListener('input', (e) => {
    const master = e.target.closest('[data-master]');
    if (master) {
      const db = Number(master.value);
      master.nextElementSibling.value = formatDb(db);
      return handlers.onMasterChange(master.dataset.master, db);
    }
    const field = e.target.closest('[data-field]');
    const track = field && trackById(field.closest('[data-track]')?.dataset.track);
    if (!track) return;
    if (field.dataset.field === 'volumeDb') {
      track.volumeDb = Number(field.value);
      field.nextElementSibling.value = formatDb(track.volumeDb);
    } else if (field.dataset.field === 'output') {
      track.output = field.value;
    }
    handlers.onTrackChange(track);
  });

  el.addEventListener('click', (e) => {
    const mute = e.target.closest('[data-field="muted"]');
    const track = mute && trackById(mute.closest('[data-track]')?.dataset.track);
    if (!track) return;
    track.muted = !track.muted;
    mute.setAttribute('aria-pressed', String(track.muted));
    handlers.onTrackChange(track);
  });

  return {
    /**
     * @param {{ song: object, grid: object, selection: { kind: string, ref: object } | null,
     *           invalid: Set<object>, startBar: number, mix: { inEarsDb: number, mainDb: number } }} next
     */
    render(next) {
      view = next;
      layout();
    },
    /** @param {number|null} sec song time, or null to hide @param {boolean} follow scroll to keep it visible */
    setPlayhead(sec, follow = false) {
      playheadSec = sec;
      placePlayhead();
      if (sec === null || !follow) return;
      const x = sec * pps;
      const width = scroll.clientWidth - HEADER_PX;
      if (x < scroll.scrollLeft || x > scroll.scrollLeft + width - 40) scroll.scrollLeft = Math.max(0, x - 40);
    },
    /** Zooms by `factor` around the playhead or the start of the view. */
    zoom(factor) {
      const rect = scroll.getBoundingClientRect();
      const x = playheadSec !== null ? playheadSec * pps - scroll.scrollLeft : 0;
      zoomAt(factor, rect.left + Math.max(0, Math.min(x, scroll.clientWidth - HEADER_PX)));
    },
    /** Zooms so the whole song fits the view, and scrolls to the start. */
    fit() {
      if (!view) return;
      const width = Math.max(200, scroll.clientWidth - HEADER_PX - 40);
      pps = clampPps(width / view.grid.endSec);
      scroll.scrollLeft = 0;
      layout();
    },
    /** Redraws canvases (e.g. when a waveform finished loading). */
    redraw,
  };

  function contentWidth() {
    return Math.max(scroll.clientWidth - HEADER_PX, view.grid.endSec * pps + END_MARGIN_PX);
  }

  function zoomAt(factor, clientX) {
    if (!view) return;
    const left = scroll.getBoundingClientRect().left;
    const px = clientX - left;
    const sec = (scroll.scrollLeft + px) / pps;
    const next = clampPps(pps * factor);
    if (next === pps) return;
    pps = next;
    inner.style.width = `${contentWidth() + HEADER_PX}px`;
    scroll.scrollLeft = Math.max(0, sec * pps - px);
    layout();
  }

  // Places everything for the current song, selection and zoom. Track headers are rebuilt only
  // when tracks are added, removed or renamed, so a slider being dragged is never replaced.
  function layout() {
    const { song, grid } = view;
    inner.style.width = `${contentWidth() + HEADER_PX}px`;
    renderStrips();
    const signature = JSON.stringify(song.tracks.map((t) => [t.id, t.type, t.name, t.color]));
    if (signature !== trackSignature) {
      trackSignature = signature;
      tracksEl.innerHTML = song.tracks.map(trackRow).join('');
    }
    for (const t of song.tracks) syncTrack(t);
    for (const input of el.querySelectorAll('[data-master]')) {
      const db = view.mix[input.dataset.master] ?? 0;
      if (document.activeElement !== input) input.value = db;
      input.nextElementSibling.value = formatDb(db);
    }
    startMarker.style.left = `${grid.bars[Math.min(view.startBar, grid.bars.length) - 1].startSec * pps}px`;
    placePlayhead();
    redraw();
  }

  function trackById(id) {
    return view?.song.tracks.find((t) => t.id === id);
  }

  function laneX(event, lane) {
    return event.clientX - lane.getBoundingClientRect().left;
  }

  function classes(ref, extra = '') {
    const { selection, invalid } = view;
    return [extra, selection?.ref === ref ? 'selected' : '', invalid.has(ref) ? 'invalid' : ''].join(' ');
  }

  function barX(bar) {
    const b = view.grid.bars[bar - 1];
    return b ? b.startSec * pps : null;
  }

  function renderStrips() {
    const { song } = view;
    refs = { locator: song.locators, tempo: song.tempo, meter: song.meter };
    const html = {
      locator: song.locators.map((l, i) => item('locator', i, l, barX(l.bar), esc(l.name), 'loc')),
      tempo: song.tempo.map((m, i) => item('tempo', i, m, barX(m.bar), esc(m.bpm), 'mk')),
      meter: song.meter.map((m, i) => item('meter', i, m, barX(m.bar), `${esc(m.beats)}/${esc(m.unit)}`, 'mk')),
    };
    for (const [kind] of STRIPS) el.querySelector(`[data-lane="${kind}"] .items`).innerHTML = html[kind].join('');
  }

  function item(kind, i, ref, x, label, cls) {
    if (x === null) return '';
    return `<button type="button" class="${classes(ref, cls)}" data-kind="${kind}" data-i="${i}" style="left:${x}px" title="${label}">${label}</button>`;
  }

  function trackRow(t) {
    const color = TRACK_COLORS[t.color] ?? TRACK_COLORS[0];
    return `
      <div class="arr-row track-row track-${t.type}" data-track="${esc(t.id)}" style="--track-color:${color}">
        <div class="lane" data-kind="track" data-track="${esc(t.id)}"><canvas data-draw="lane"></canvas><div class="items"></div></div>
        <div class="hdr">
          <button type="button" class="hdr-name" data-kind="track" data-track="${esc(t.id)}" title="Select ${esc(t.name)}">${esc(t.name)}</button>
          <div class="hdr-mixer">
            <input type="range" data-field="volumeDb" min="${LIMITS.volumeDb[0]}" max="${LIMITS.volumeDb[1]}" step="1" aria-label="${esc(t.name)} volume">
            <output class="small"></output>
            <button type="button" class="mute" data-field="muted" aria-label="Mute ${esc(t.name)}" title="Mute">M</button>
            <select data-field="output" aria-label="${esc(t.name)} output" title="Output">${options(OUTPUTS, t.output, (o) => OUTPUT_NAMES[o])}</select>
          </div>
        </div>
      </div>`;
  }

  // Header values and lane items of one track (the header elements are kept while you use them).
  function syncTrack(t) {
    const row = tracksEl.querySelector(`[data-track="${CSS.escape(t.id)}"]`);
    if (!row) return;
    const vol = row.querySelector('[data-field="volumeDb"]');
    if (document.activeElement !== vol) vol.value = t.volumeDb;
    vol.nextElementSibling.value = formatDb(t.volumeDb);
    row.querySelector('[data-field="muted"]').setAttribute('aria-pressed', String(t.muted));
    const out = row.querySelector('[data-field="output"]');
    if (document.activeElement !== out) out.value = t.output;
    row.querySelector('.hdr-name').className = classes(t, 'hdr-name');
    row.classList.toggle('muted-track', t.muted);
    const items = row.querySelector('.items');
    if (t.type === 'cues') items.innerHTML = cueItems(t);
    else if (t.type === 'audio') items.innerHTML = clipItem(t);
    else items.innerHTML = '';
  }

  // Cue labels, stacked into rows so that ones close together don't cover each other.
  function cueItems(track) {
    refs.cue = track.clips;
    const placed = track.clips
      .map((c, i) => ({ c, i, x: cueX(c) }))
      .filter((p) => p.x !== null)
      .sort((a, b) => a.x - b.x);
    const rowEnds = Array(CUE_ROWS).fill(-Infinity);
    return placed.map(({ c, i, x }) => {
      const width = c.key.length * 6.5 + 14;
      let row = rowEnds.findIndex((end) => end <= x);
      if (row === -1) row = rowEnds.indexOf(Math.min(...rowEnds));
      rowEnds[row] = x + width;
      return `<button type="button" class="${classes(c, `cue cue-${c.type}`)}" data-kind="cue" data-i="${i}"
        style="left:${x}px;top:${4 + row * CUE_ROW_PX}px" title="${esc(c.key)} (${c.at.join('.')})">${esc(c.key)}</button>`;
    }).join('');
  }

  function cueX(clip) {
    try {
      return view.grid.secAt(clip.at) * pps;
    } catch {
      return null; // outside the song; the Detail panel explains
    }
  }

  function clipItem(track) {
    if (!track.clip) return '<span class="lane-hint muted small">No audio. Use Import audio.</span>';
    const info = handlers.getPeaks(track);
    const width = info ? info.duration * pps : 120;
    return `<div class="${classes(track.clip, 'clip')}" data-kind="track" data-track="${esc(track.id)}"
      style="left:${track.clip.startSec * pps}px;width:${width}px" title="${esc(track.clip.file)} at ${clock(track.clip.startSec, true)}">
      <span class="clip-title">${esc(track.name)}${info ? '' : ' · loading…'}</span></div>`;
  }

  function placePlayhead() {
    playhead.hidden = playheadSec === null;
    if (playheadSec !== null) playhead.style.transform = `translateX(${playheadSec * pps}px)`;
  }

  function redraw() {
    cancelAnimationFrame(drawFrame);
    drawFrame = requestAnimationFrame(drawAll);
  }

  function drawAll() {
    if (!view) return;
    const left = scroll.scrollLeft;
    const width = Math.max(0, scroll.clientWidth - HEADER_PX);
    const dpr = window.devicePixelRatio || 1;
    for (const canvas of el.querySelectorAll('canvas[data-draw]')) {
      const height = canvas.parentElement.clientHeight;
      canvas.style.left = `${left}px`;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, -left * dpr, 0);
      const kind = canvas.dataset.draw;
      if (kind === 'bars') drawBarRuler(g, left, width, height);
      else if (kind === 'time') drawTimeRuler(g, left, width, height);
      else {
        drawGrid(g, left, width, height, kind === 'strip');
        if (kind === 'lane') {
          const track = trackById(canvas.closest('[data-track]').dataset.track);
          if (track?.type === 'audio') drawWaveform(g, track, left, width, height);
        }
      }
    }
  }

  function visibleBars(left, width) {
    return view.grid.bars.filter((b) => (b.startSec + b.sec) * pps >= left && b.startSec * pps <= left + width);
  }

  function drawBarRuler(g, left, width, height) {
    const style = getComputedStyle(el);
    g.fillStyle = style.getPropertyValue('--ruler-fg');
    g.strokeStyle = style.getPropertyValue('--ruler-fg');
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'top';
    const bars = visibleBars(left, width);
    const minBarPx = Math.min(...bars.map((b) => b.sec * pps));
    const step = [1, 2, 4, 8, 16, 32, 64, 128].find((n) => n * minBarPx >= 36) ?? 256;
    for (const b of bars) {
      const x = Math.round(b.startSec * pps) + 0.5;
      const labelled = (b.bar - 1) % step === 0;
      g.globalAlpha = labelled ? 1 : 0.5;
      g.beginPath();
      g.moveTo(x, labelled ? 0 : height * 0.55);
      g.lineTo(x, height);
      g.stroke();
      if (labelled) g.fillText(String(b.bar), x + 3, 3);
      const beatPx = b.sec * pps / b.beats;
      if (beatPx >= 8) {
        g.globalAlpha = 0.35;
        for (let i = 1; i < b.beats; i++) {
          const bx = Math.round(b.startSec * pps + i * beatPx) + 0.5;
          g.beginPath();
          g.moveTo(bx, height * 0.75);
          g.lineTo(bx, height);
          g.stroke();
        }
      }
    }
    g.globalAlpha = 1;
  }

  function drawTimeRuler(g, left, width, height) {
    const style = getComputedStyle(el);
    g.fillStyle = style.getPropertyValue('--ruler-fg');
    g.strokeStyle = style.getPropertyValue('--ruler-fg');
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'top';
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * pps >= 50) ?? 600;
    for (let t = Math.floor(left / pps / step) * step; t * pps <= left + width; t += step) {
      const x = Math.round(t * pps) + 0.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, height * 0.4);
      g.stroke();
      g.fillText(clock(t) + (step < 1 && t % 1 ? '.5' : ''), x + 3, height * 0.35);
    }
  }

  function drawGrid(g, left, width, height, light) {
    const style = getComputedStyle(el);
    const line = style.getPropertyValue('--grid-line');
    const beatLine = style.getPropertyValue('--grid-beat');
    for (const b of visibleBars(left, width)) {
      const x0 = b.startSec * pps;
      g.fillStyle = line;
      g.fillRect(Math.round(x0), 0, 1, height);
      if (light) continue;
      const beatPx = b.sec * pps / b.beats;
      if (beatPx < 8) continue;
      const perBeat = 16 / b.unit;
      const sixteenthPx = beatPx / perBeat;
      const step = sixteenthPx >= 10 ? 1 : perBeat;
      g.fillStyle = beatLine;
      for (let s = step; s < b.beats * perBeat; s += step) {
        g.globalAlpha = s % perBeat === 0 ? 1 : 0.5;
        g.fillRect(Math.round(x0 + s * sixteenthPx), 0, 1, height);
      }
      g.globalAlpha = 1;
    }
  }

  function drawWaveform(g, track, left, width, height) {
    const info = track.clip && handlers.getPeaks(track);
    if (!info) return;
    const { peaks, sampleRate } = info;
    const x0 = track.clip.startSec * pps;
    const from = Math.max(Math.floor(x0), Math.floor(left));
    const to = Math.min(Math.ceil(x0 + info.duration * pps), Math.ceil(left + width));
    const top = CLIP_TITLE_PX + 2;
    const mid = top + (height - top) / 2;
    const half = (height - top) / 2 - 2;
    const perPx = sampleRate / peaks.bucketSize / pps; // buckets per pixel
    g.fillStyle = getComputedStyle(el).getPropertyValue('--wave');
    for (let x = from; x < to; x++) {
      const b0 = (x / pps - track.clip.startSec) * sampleRate / peaks.bucketSize;
      const p = peakRange(peaks, b0, b0 + Math.max(perPx, 1));
      if (!p) continue;
      const y0 = mid - p.max * half;
      const y1 = mid - p.min * half;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }
}

function clampPps(value) {
  return Math.min(PPS_RANGE[1], Math.max(PPS_RANGE[0], value));
}

function masterHeader(key, label, title) {
  return `<div class="hdr hdr-master" title="${title}">
    <span class="hdr-title">${label}</span>
    <input type="range" data-master="${key}" min="${LIMITS.volumeDb[0]}" max="${LIMITS.volumeDb[1]}" step="1" aria-label="${label} master volume">
    <output class="small"></output>
  </div>`;
}
