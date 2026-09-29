// Session View (Tab), laid out like Ableton's: one column per track with a mixer strip at the
// bottom, the In-ears and Main master strips, and one launch row per locator on the right (like
// scenes). Launching a row while stopped starts playback at that locator; while playing it jumps
// there at the next bar line (again cancels). Cells show what each track has in that section.
import { OUTPUTS, LIMITS } from '/shared/song.js';
import { esc, options, formatDb, TRACK_COLORS, OUTPUT_NAMES } from './ui.js';

/**
 * @param {HTMLElement} el
 * @param {{ onLaunch: (section: number) => void, onTrackChange: (track: object) => void,
 *           onMasterChange: (key: 'inEarsDb'|'mainDb', db: number) => void,
 *           onSelect: (sel: { kind: string, ref: object } | null) => void,
 *           getPeaks: (track: object) => { duration: number } | null }} handlers
 */
export function createSession(el, handlers) {
  el.innerHTML = `
    <div class="ses-scroll"><div class="ses-grid"></div></div>
    <div class="ses-status" aria-live="polite"></div>`;
  const gridEl = el.querySelector('.ses-grid');
  const statusEl = el.querySelector('.ses-status');
  let view = null;
  let signature = '';

  el.addEventListener('click', (e) => {
    const launch = e.target.closest('[data-launch]');
    if (launch) return handlers.onLaunch(Number(launch.dataset.launch));
    const name = e.target.closest('[data-select-track]');
    if (name) return handlers.onSelect({ kind: 'track', ref: trackById(name.dataset.selectTrack) });
    const mute = e.target.closest('[data-field="muted"]');
    const track = mute && trackById(mute.closest('[data-track]').dataset.track);
    if (track) {
      track.muted = !track.muted;
      mute.setAttribute('aria-pressed', String(track.muted));
      handlers.onTrackChange(track);
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

  return {
    /**
     * @param {{ song: object, grid: object, sections: { name: string, startBar: number, endBar: number }[],
     *           selection: object|null, mix: { inEarsDb: number, mainDb: number } }} next
     */
    render(next) {
      view = next;
      const { song, sections } = next;
      // Rebuild only when the columns or rows change, so a fader being dragged is never replaced.
      const sig = JSON.stringify([song.tracks.map((t) => [t.id, t.name, t.color]), sections.map((s) => [s.name, s.startBar, s.endBar]),
        song.tracks.find((t) => t.type === 'cues')?.clips.map((c) => [c.at, c.key]), song.tracks.map((t) => t.clip && [t.clip.startSec, Boolean(handlers.getPeaks(t))]),
        song.tempo, song.meter]);
      if (sig !== signature) {
        signature = sig;
        gridEl.style.setProperty('--rows', String(Math.max(sections.length, 1)));
        gridEl.innerHTML = song.tracks.map(trackColumn).join('')
          + '<div class="ses-gap"></div>'
          + sceneColumn()
          + masterColumn('inEarsDb', 'In-ears', 'Left channel: what the band hears')
          + masterColumn('mainDb', 'Main', 'Right channel: the audience');
      }
      for (const t of song.tracks) syncTrack(t);
      for (const input of el.querySelectorAll('[data-master]')) {
        const db = next.mix[input.dataset.master] ?? 0;
        if (document.activeElement !== input) input.value = db;
        input.nextElementSibling.value = formatDb(db);
      }
      for (const name of el.querySelectorAll('[data-select-track]')) {
        name.classList.toggle('selected', next.selection?.ref === trackById(name.dataset.selectTrack));
      }
    },
    /** @param {{ bar: number, section: number, pendingJump: number|null, loop: object|null } | null} pos */
    setPosition(pos) {
      if (!view) return;
      for (const row of el.querySelectorAll('[data-row]')) row.classList.remove('current', 'pending', 'looping');
      const rows = (i) => el.querySelectorAll(`[data-row="${i}"]`);
      if (!pos) {
        statusEl.textContent = view.sections.length ? 'Click a section (or press 1–9) to start there. L loops the section you hear.'
          : 'Add locators in the Arrangement (Tab) to get sections to launch.';
        return;
      }
      for (const r of rows(pos.section)) r.classList.add('current');
      const status = [];
      const name = (i) => view.sections[i]?.name ?? '';
      if (pos.pendingJump !== null) {
        for (const r of rows(pos.pendingJump)) r.classList.add('pending');
        status.push(`Jumping to ${name(pos.pendingJump)} at the next bar (press again to cancel)`);
      }
      if (pos.loop) {
        const looped = view.sections.findIndex((s) => s.startBar === pos.loop.startBar && s.endBar === pos.loop.endBar);
        for (const r of rows(looped)) r.classList.add('looping');
        status.push(`Looping ${looped >= 0 ? name(looped) : `bars ${pos.loop.startBar}–${pos.loop.endBar}`} (press L to release)`);
      }
      statusEl.textContent = status.join(' · ') || `Playing ${name(pos.section) || `bar ${pos.bar}`}`;
    },
  };

  function trackById(id) {
    return view?.song.tracks.find((t) => t.id === id);
  }

  function trackColumn(t) {
    const color = TRACK_COLORS[t.color] ?? TRACK_COLORS[0];
    const cells = view.sections.map((s, i) => {
      const text = cellText(t, s);
      return `<button type="button" class="ses-cell ${text === null ? '' : 'filled'}" data-launch="${i}" data-row="${i}" title="Launch ${esc(s.name)}">${text ? esc(text) : ''}</button>`;
    }).join('') || '<div class="ses-cell empty"></div>';
    return `
      <div class="ses-col" data-track="${esc(t.id)}" style="--track-color:${color}">
        <button type="button" class="ses-name" data-select-track="${esc(t.id)}" title="Select ${esc(t.name)}">${esc(t.name)}</button>
        <div class="ses-cells">${cells}</div>
        <div class="ses-mixer">
          <select data-field="output" aria-label="${esc(t.name)} output" title="Output">${options(OUTPUTS, t.output, (o) => OUTPUT_NAMES[o])}</select>
          <div class="ses-fader">
            <input type="range" data-field="volumeDb" min="${LIMITS.volumeDb[0]}" max="${LIMITS.volumeDb[1]}" step="1" aria-label="${esc(t.name)} volume">
            <output class="small"></output>
          </div>
          <button type="button" class="mute" data-field="muted" aria-label="Mute ${esc(t.name)}" title="Mute">M</button>
        </div>
      </div>`;
  }

  // What a track has in a section: its time signature and tempo (click), its cues, or whether
  // its audio plays there. null = nothing.
  function cellText(t, s) {
    const { grid } = view;
    if (t.type === 'click') {
      const b = grid.bars[s.startBar - 1];
      return b ? `${b.beats}/${b.unit} · ${b.bpm}` : null;
    }
    if (t.type === 'cues') {
      const keys = t.clips.filter((c) => c.at[0] >= s.startBar && c.at[0] <= s.endBar)
        .sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.at[2] - b.at[2]).map((c) => c.key);
      return keys.length ? keys.join(', ') : null;
    }
    if (!t.clip) return null;
    const from = grid.bars[s.startBar - 1]?.startSec;
    const last = grid.bars[s.endBar - 1];
    if (from === undefined || !last) return null;
    const duration = handlers.getPeaks(t)?.duration ?? Infinity;
    const plays = t.clip.startSec < last.startSec + last.sec && t.clip.startSec + duration > from;
    return plays ? '▶' : null;
  }

  // Mixer values of one column (the elements are kept while you use them).
  function syncTrack(t) {
    const col = gridEl.querySelector(`.ses-col[data-track="${CSS.escape(t.id)}"]`);
    if (!col) return;
    const vol = col.querySelector('[data-field="volumeDb"]');
    if (document.activeElement !== vol) vol.value = t.volumeDb;
    vol.nextElementSibling.value = formatDb(t.volumeDb);
    col.querySelector('[data-field="muted"]').setAttribute('aria-pressed', String(t.muted));
    const out = col.querySelector('[data-field="output"]');
    if (document.activeElement !== out) out.value = t.output;
    col.classList.toggle('muted-track', t.muted);
  }

  function sceneColumn() {
    const rows = view.sections.map((s, i) => `
      <button type="button" class="ses-scene" data-launch="${i}" data-row="${i}" title="Launch ${esc(s.name)}${i < 9 ? ` (key ${i + 1})` : ''}">
        <span class="ses-play">▶</span>${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}<span class="ses-scene-name">${esc(s.name)}</span>
        <span class="muted small">${s.startBar}–${s.endBar}</span>
      </button>`).join('') || '<div class="ses-cell empty muted small">No locators</div>';
    return `<div class="ses-col ses-scenes"><div class="ses-name ses-name-plain">Sections</div><div class="ses-cells">${rows}</div><div class="ses-mixer"></div></div>`;
  }
}

function masterColumn(key, label, title) {
  return `
    <div class="ses-col ses-master" title="${title}">
      <div class="ses-name ses-name-plain">${label}</div>
      <div class="ses-cells"></div>
      <div class="ses-mixer">
        <div class="ses-fader">
          <input type="range" data-master="${key}" min="${LIMITS.volumeDb[0]}" max="${LIMITS.volumeDb[1]}" step="1" aria-label="${label} master volume">
          <output class="small"></output>
        </div>
      </div>
    </div>`;
}
