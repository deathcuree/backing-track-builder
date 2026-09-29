// Arrangement View (center), laid out like Ableton's: rulers and the locator/tempo/meter strips on
// top, one lane per track with its header and mixer strip on the right, the time ruler and the
// In-ears/Main masters at the bottom, and a playhead.
//
// Time runs left to right at `pps` pixels per second. Bars are placed from the grid, so tempo and
// meter changes show as wider or narrower bars. Rulers, grid lines and waveforms are drawn on
// canvases that cover only the visible part (a song can be thousands of screens wide when zoomed
// in); clips, cues, locators and markers are elements so they can be clicked and dragged.
//
// Clicking anywhere in the lanes or the bar ruler places the insert marker (snapped to the grid;
// Cmd/Ctrl for sixteenths): new cues, locators and markers go there and Play starts there.
// Dragging only moves the element on screen; the song changes once, when you let go (onMove), so a
// drag is one edit. Cues snap to the grid (hold Cmd/Ctrl for sixteenths), locators and markers to
// bars, audio clips move freely.
import { OUTPUTS, LIMITS } from '/shared/song.js';
import { autoStep } from '/shared/grid.js';
import { peakRange } from '/shared/waveform.js';
import { esc, options, formatDb, clock, TRACK_COLORS, OUTPUT_NAMES } from './ui.js';

const HEADER_PX = 260;
const PPS_RANGE = [2, 1000];
const END_MARGIN_PX = 400;
const CUE_ROWS = 3;
const CUE_ROW_PX = 18;
const CLIP_TITLE_PX = 14;
const STRIPS = [['locator', 'Locators'], ['tempo', 'Tempo'], ['meter', 'Time sig.']];
const DRAG_THRESHOLD_PX = 3;
export const CUE_MIME = 'application/x-btb-cue'; // Browser cue being dragged: JSON { type, key }

/**
 * @param {HTMLElement} el
 * @param {{ onSelect: (sel: { kind: string, ref: object } | null) => void,
 *           onCursor: (at: [number, number, number]) => void, onTrackChange: (track: object) => void,
 *           onMasterChange: (key: 'inEarsDb'|'mainDb', db: number) => void,
 *           onAdd: (kind: 'locator'|'tempo'|'meter') => void,
 *           onAddAt: (kind: 'locator'|'tempo'|'meter', bar: number) => void,
 *           onMove: (kind: string, ref: object, value: number[]|number) => void,
 *           onDropCue: (cue: { type: string, key: string }, at: number[]) => void,
 *           onLoopRange: (range: { startBar: number, endBar: number }) => void,
 *           getPeaks: (track: object) => { peaks: object, sampleRate: number, duration: number } | null }} handlers
 */
export function createArrangement(el, handlers) {
  el.innerHTML = `
    <div class="arr-scroll">
      <div class="arr-inner">
        <div class="arr-head">
          <div class="arr-row ruler-row">
            <div class="lane" data-ruler="bars"><canvas data-draw="bars"></canvas><div class="loop-brace" hidden></div><div class="start-marker" title="Insert marker"></div></div>
            <div class="hdr hdr-strip"><span class="hdr-title">Bar</span><span class="muted small">Click: insert marker · Shift-drag: loop</span></div>
          </div>
          ${STRIPS.map(([kind, label]) => `
            <div class="arr-row strip-row" data-strip="${kind}">
              <div class="lane" data-lane="${kind}"><canvas data-draw="strip"></canvas><div class="items"></div></div>
              <div class="hdr hdr-strip">
                <span class="hdr-title">${label}</span>
                <button type="button" data-add="${kind}" title="Add a ${label.toLowerCase().replace('.', '')} ${kind === 'locator' ? '' : 'marker '}at the insert marker's bar">+</button>
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
        <div class="insert-marker"></div>
        <div class="playhead" hidden></div>
        <div class="drop-line" hidden></div>
      </div>
    </div>
    <div class="drag-readout" hidden></div>`;

  const scroll = el.querySelector('.arr-scroll');
  const inner = el.querySelector('.arr-inner');
  const tracksEl = el.querySelector('.arr-tracks');
  const playhead = el.querySelector('.playhead');
  const startMarker = el.querySelector('.start-marker');
  const insertMarker = el.querySelector('.insert-marker');
  const loopBrace = el.querySelector('.loop-brace');
  const dropLine = el.querySelector('.drop-line');
  const readout = el.querySelector('.drag-readout');
  let pps = 40;
  let gridSetting = 'auto'; // 'auto', 'bar' or sixteenths per step (1, 2, 4)
  let drag = null; // item or loop brace being dragged
  let suppressClick = false; // the click that ends a drag is not a selection
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
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const add = e.target.closest('[data-add]');
    if (add) return handlers.onAdd(add.dataset.add);
    const ruler = e.target.closest('[data-ruler="bars"]');
    if (ruler && view) return handlers.onCursor(cursorAt(e, ruler));
    // A click on a lane (not on a cue, locator or marker) also places the insert marker.
    const lane = e.target.closest('.lane');
    if (lane && view && !e.target.closest('.cue, .loc, .mk')) {
      const at = cursorAt(e, lane);
      if (at) handlers.onCursor(at);
    }
    const item = e.target.closest('[data-kind]');
    if (item) {
      const ref = item.dataset.kind === 'track' ? trackById(item.dataset.track) : refs[item.dataset.kind]?.[item.dataset.i];
      return handlers.onSelect(ref ? { kind: item.dataset.kind, ref } : null);
    }
    if (e.target.closest('.hdr-mixer, .hdr-master, .hdr-strip')) return;
    if (e.target.closest('.lane')) handlers.onSelect(null);
  });

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !view) return;
    const ruler = e.target.closest('[data-ruler="bars"]');
    if (ruler && e.shiftKey) {
      const bar = view.grid.positionAt(laneX(e, ruler) / pps).bar;
      drag = { kind: 'loop', anchor: bar, range: { startBar: bar, endBar: bar }, moved: true };
      ruler.setPointerCapture(e.pointerId);
      showBrace(drag.range, false);
      return;
    }
    const item = e.target.closest('.cue, .loc, .mk, .clip');
    if (!item) return;
    const kind = item.dataset.kind;
    const ref = kind === 'track' ? trackById(item.dataset.track) : refs[kind]?.[item.dataset.i];
    if (!ref || ((kind === 'tempo' || kind === 'meter') && view.song[kind][0] === ref)) return; // bar-1 markers stay
    drag = { kind, ref, item, startX: e.clientX, left: parseFloat(item.style.left), moved: false, value: null };
    item.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.kind === 'loop') {
      const ruler = el.querySelector('[data-ruler="bars"]');
      const bar = view.grid.positionAt(laneX(e, ruler) / pps).bar;
      drag.range = { startBar: Math.min(bar, drag.anchor), endBar: Math.max(bar, drag.anchor) };
      showBrace(drag.range, false);
      return;
    }
    const dx = e.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    const sec = (drag.left + dx) / pps;
    const { grid } = view;
    let x;
    let label;
    if (drag.kind === 'cue') {
      drag.value = sec < 0 || sec >= grid.endSec ? null : grid.snap(sec, e.metaKey || e.ctrlKey ? 1 : stepAt(sec));
      x = drag.value ? grid.secAt(drag.value) * pps : drag.left + dx;
      label = drag.value ? drag.value.join('.') : 'outside the song';
    } else if (drag.kind === 'track') {
      const [min, max] = LIMITS.clipStartSec;
      drag.value = Math.round(Math.min(max, Math.max(min, sec)) * 1000) / 1000;
      x = drag.value * pps;
      label = `starts at ${clock(drag.value, true)}`;
    } else {
      drag.value = sec < 0 || sec >= grid.endSec ? null : grid.nearestBar(sec);
      x = drag.value ? barX(drag.value) : drag.left + dx;
      label = drag.value ? `bar ${drag.value}` : 'outside the song';
    }
    drag.item.style.left = `${x}px`;
    drag.item.classList.toggle('refused', drag.value === null);
    showReadout(label, e);
  });

  const endDrag = (e) => {
    if (!drag) return;
    const done = drag;
    drag = null;
    readout.hidden = true;
    if (done.moved) {
      // The browser follows pointerup with a click; that one is part of the drag, not a selection.
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    }
    if (done.kind === 'loop') return handlers.onLoopRange(done.range);
    if (!done.moved) return;
    if (done.value === null || e.type === 'pointercancel') return layout(); // put it back
    handlers.onMove(done.kind, done.ref, done.value);
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);

  // Double-click a strip to add a locator or marker at that bar.
  el.addEventListener('dblclick', (e) => {
    const lane = e.target.closest('[data-lane]');
    if (!lane || !view || e.target.closest('[data-kind]')) return;
    const sec = laneX(e, lane) / pps;
    if (sec >= view.grid.endSec) return;
    handlers.onAddAt(lane.dataset.lane, view.grid.positionAt(sec).bar);
  });

  // Browser cues dropped on the Cues lane.
  el.addEventListener('dragover', (e) => {
    const at = cueDropAt(e);
    dropLine.hidden = !at;
    if (!at) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dropLine.style.transform = `translateX(${view.grid.secAt(at) * pps}px)`;
    showReadout(at.join('.'), e);
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) {
      dropLine.hidden = true;
      readout.hidden = true;
    }
  });
  el.addEventListener('drop', (e) => {
    const at = cueDropAt(e);
    dropLine.hidden = true;
    readout.hidden = true;
    if (!at) return;
    e.preventDefault();
    try {
      handlers.onDropCue(JSON.parse(e.dataTransfer.getData(CUE_MIME)), at);
    } catch {
      // not a cue from the Browser
    }
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
     *           invalid: Set<object>, cursor: [number, number, number], mix: { inEarsDb: number, mainDb: number },
     *           loop: { startBar: number, endBar: number } | null, loopOn: boolean }} next
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
    /** @param {'auto'|'bar'|1|2|4} value grid resolution for drawing and snapping */
    setGrid(value) {
      gridSetting = value;
      redraw();
    },
  };

  // Grid step for the bar at `sec`: the chosen one, or (Auto) the finest that fits the zoom.
  function stepAt(sec) {
    return stepFor(view.grid.bars[view.grid.positionAt(sec).bar - 1]);
  }

  function stepFor(b) {
    return gridSetting === 'auto' ? autoStep((b.sec * pps) / (b.beats * (16 / b.unit))) : gridSetting;
  }

  function cueDropAt(e) {
    if (!view || !e.dataTransfer?.types.includes(CUE_MIME)) return null;
    const lane = e.target.closest('.track-cues .lane');
    if (!lane) return null;
    const sec = laneX(e, lane) / pps;
    if (sec < 0 || sec >= view.grid.endSec) return null;
    return view.grid.snap(sec, e.metaKey || e.ctrlKey ? 1 : stepAt(sec));
  }

  function showReadout(text, e) {
    readout.textContent = text;
    readout.hidden = false;
    const box = el.getBoundingClientRect();
    readout.style.transform = `translate(${e.clientX - box.left + 12}px, ${e.clientY - box.top - 26}px)`;
  }

  function showBrace(range, on) {
    loopBrace.hidden = !range;
    if (!range) return;
    const start = barX(range.startBar);
    const last = view.grid.bars[range.endBar - 1];
    loopBrace.style.left = `${start}px`;
    loopBrace.style.width = `${(last.startSec + last.sec) * pps - start}px`;
    loopBrace.classList.toggle('on', on);
    loopBrace.title = `Loop bars ${range.startBar}–${range.endBar}`;
  }

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
    const cursorX = `${grid.secAt(view.cursor) * pps}px`;
    startMarker.style.left = cursorX;
    insertMarker.style.left = cursorX;
    insertMarker.title = `Insert marker ${view.cursor.join('.')}`;
    const loop = view.loop && view.loop.endBar <= grid.bars.length ? view.loop : null;
    showBrace(loop, view.loopOn);
    placePlayhead();
    redraw();
  }

  // Snapped grid position under the pointer (null past the song end).
  function cursorAt(event, lane) {
    const sec = laneX(event, lane) / pps;
    if (sec >= view.grid.endSec) return null;
    return view.grid.snap(sec, event.metaKey || event.ctrlKey ? 1 : stepAt(sec));
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
      const step = stepFor(b);
      if (step === 'bar') continue;
      const perBeat = 16 / b.unit;
      const sixteenthPx = (b.sec * pps) / (b.beats * perBeat);
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
