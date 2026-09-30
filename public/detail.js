// Detail panel (bottom): the fields of the selected item — the song itself when nothing is
// selected, or a track, audio clip, cue, locator, tempo marker or meter marker. Edits the song object in place
// and reports every change; the app validates and redraws. Typing never re-renders the panel, so
// focus is kept; structural changes (sorting markers, changing a cue's type) do.
import { LIMITS, METER_UNITS, OUTPUTS, LANGUAGES, SUBDIVISIONS, CUE_TYPES } from '/shared/song.js';
import {
  esc, options, formatDb, cueChoices, byName, TRACK_COLORS, OUTPUT_NAMES, LANGUAGE_NAMES, CUE_TYPE_NAMES,
} from './ui.js';

/**
 * @param {HTMLElement} el
 * @param {{ catalog: object, onChange: (path: string, opts: { structural: boolean }) => void,
 *           onDelete: () => void }} handlers
 */
export function createDetail(el, { catalog, onChange, onDelete }) {
  let song = null;
  let selection = null;
  let base = ''; // path of the selected item, e.g. "tracks.1.clips.4"

  el.addEventListener('submit', (e) => e.preventDefault());

  el.addEventListener('input', (e) => {
    const input = e.target.closest('[data-path]');
    if (!input || input.dataset.commit !== undefined) return;
    setPath(song, input.dataset.path, readValue(input));
    const out = el.querySelector(`output[for="${input.id}"]`);
    if (out) out.value = formatDb(Number(input.value));
    onChange(input.dataset.path, { structural: false });
  });

  // Fields that reorder or reshape the song apply when you leave them (or pick an option).
  el.addEventListener('change', (e) => {
    const input = e.target.closest('[data-path][data-commit]');
    if (!input) return;
    const path = input.dataset.path;
    setPath(song, path, readValue(input));
    if (/^(tempo|meter)\.\d+\.bar$/.test(path)) song[path.split('.')[0]].sort((a, b) => a.bar - b.bar);
    if (/\.clips\.\d+\.type$/.test(path)) {
      const clip = selection.ref;
      clip.key = cueChoices(catalog, cuesLanguage(), clip.type)[0]?.key ?? '';
    }
    onChange(path, { structural: true });
  });

  el.addEventListener('click', (e) => {
    const color = e.target.closest('[data-color]');
    if (color) {
      const path = color.closest('[data-color-path]').dataset.colorPath;
      setPath(song, path, Number(color.dataset.color));
      return onChange(path, { structural: true });
    }
    if (e.target.closest('[data-action="delete"]')) onDelete();
  });

  return {
    /** @param {object} nextSong @param {{ kind: string, ref: object } | null} nextSelection */
    show(nextSong, nextSelection) {
      song = nextSong;
      selection = nextSelection;
      base = pathOf(song, selection);
      el.innerHTML = `<form class="detail-form" novalidate>${render()}<p class="error" data-error-for="${base}"></p></form>`;
    },
    /** Shows the errors that belong to the selected item next to its fields. */
    showErrors(errors) {
      for (const slot of el.querySelectorAll('[data-error-for]')) slot.textContent = '';
      for (const input of el.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
      for (const { path, message } of errors) {
        const key = path.replace(/\[(\d+)\]/g, '.$1');
        const mine = base === '' ? !/^(tracks|locators|tempo|meter)\./.test(key) : key === base || key.startsWith(`${base}.`);
        if (!mine) continue;
        const slot = el.querySelector(`[data-error-for="${key}"]`) ?? el.querySelector(`[data-error-for="${base}"]`);
        slot.textContent = slot.textContent ? `${slot.textContent} ${message}` : message;
        for (const input of el.querySelectorAll(`[data-path^="${key}"]`)) input.setAttribute('aria-invalid', 'true');
      }
    },
    /** Focuses a field of the panel by its path suffix, e.g. "name". */
    focus(suffix) {
      const input = el.querySelector(`[data-path="${base ? `${base}.` : ''}${suffix}"]`);
      input?.focus();
      input?.select?.();
    },
  };

  function render() {
    const p = (suffix) => (base ? `${base}.${suffix}` : suffix);
    if (!selection) {
      return heading('Song', '') + row(
        field('Title', `<input id="d-title" data-path="title" type="text" maxlength="100" value="${esc(song.title)}">`, 'title', 'wide'),
        field('End bar', `<input id="d-end" data-path="endBar" data-type="number" type="number" min="1" max="${LIMITS.endBar[1]}" step="1" value="${esc(song.endBar)}">`, 'endBar'),
      ) + '<p class="muted small">Select a track, clip, cue, locator or marker to edit it. Click anywhere in the arrangement to place the insert marker: new cues, locators and markers go there, and Play starts there.</p>';
    }
    const { kind, ref } = selection;
    if (kind === 'track') return trackPanel(ref, p);
    if (kind === 'clip') return clipPanel(ref, p);
    if (kind === 'cue') {
      const choices = cueChoices(catalog, cuesLanguage(), ref.type);
      const keys = choices.some((c) => c.key === ref.key) ? choices : [{ key: ref.key, english: false }, ...choices];
      return heading('Cue', deleteButton()) + row(
        field('Type', `<select id="d-cue-type" data-path="${p('type')}" data-commit>${options(CUE_TYPES, ref.type, (t) => CUE_TYPE_NAMES[t])}</select>`, p('type')),
        field('Cue', `<select id="d-cue-key" data-path="${p('key')}">${keys.map(({ key, english }) =>
          `<option value="${esc(key)}" ${key === ref.key ? 'selected' : ''}>${esc(key)}${english ? ' (EN)' : ''}</option>`).join('')}</select>`, p('key')),
        positionField(p('at'), ref.at),
      );
    }
    if (kind === 'locator') {
      const names = [...new Set([...Object.keys(catalog.guides[cuesLanguage()]?.section ?? {}), ...Object.keys(catalog.guides.en?.section ?? {})])].sort(byName);
      return heading('Locator', deleteButton()) + row(
        field('Name', `<input id="d-loc-name" data-path="${p('name')}" type="text" maxlength="${LIMITS.nameLength}" list="d-section-names" value="${esc(ref.name)}">
          <datalist id="d-section-names">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`, p('name'), 'wide'),
        field('Bar', `<input id="d-loc-bar" data-path="${p('bar')}" data-type="number" type="number" min="1" max="${song.endBar}" step="1" value="${esc(ref.bar)}">`, p('bar')),
      ) + '<p class="muted small">Locators mark sections for jumping and looping. They make no sound; place cues for what the band should hear.</p>';
    }
    const first = song[kind].indexOf(ref) === 0;
    const barField = field('Bar', `<input id="d-mk-bar" data-path="${p('bar')}" data-type="number" type="number" min="1" max="${song.endBar}" step="1" value="${esc(ref.bar)}" data-commit ${first ? 'disabled title="The first marker is always at bar 1"' : ''}>`, p('bar'));
    if (kind === 'tempo') {
      return heading('Tempo marker', first ? '' : deleteButton()) + row(
        barField,
        field('BPM', `<input id="d-bpm" data-path="${p('bpm')}" data-type="number" type="number" min="${LIMITS.bpm[0]}" max="${LIMITS.bpm[1]}" step="0.1" value="${esc(ref.bpm)}">`, p('bpm')),
      ) + '<p class="muted small">The grid and click change tempo from this bar. Audio is never stretched, so the recording must change tempo here too.</p>';
    }
    const beats = Array.from({ length: LIMITS.beats[1] - LIMITS.beats[0] + 1 }, (_, i) => LIMITS.beats[0] + i);
    return heading('Time signature marker', first ? '' : deleteButton()) + row(
      barField,
      field('Beats', `<select id="d-beats" data-path="${p('beats')}" data-type="number">${options(beats, ref.beats)}</select>`, p('beats')),
      field('Unit', `<select id="d-unit" data-path="${p('unit')}" data-type="number">${options(METER_UNITS, ref.unit)}</select>`, p('unit')),
    );
  }

  function trackPanel(t, p) {
    const common = trackFields(t, p);
    if (t.type === 'click') {
      return heading('Click track', '') + row(...common,
        field('Sound', `<select id="d-sound" data-path="${p('sound')}">${options(Object.keys(catalog.clicks).sort(byName), t.sound)}</select>`, p('sound')),
        field('Subdivision', `<select id="d-sub" data-path="${p('subdivision')}">${options(SUBDIVISIONS, t.subdivision, (s) => ({ quarter: 'Beats only', eighth: 'Eighths', sixteenth: 'Sixteenths' })[s])}</select>`, p('subdivision')),
      ) + '<p class="muted small">The click follows the tempo and time signature markers, with an accent on beat 1.</p>';
    }
    if (t.type === 'cues') {
      return heading('Cues track', '') + row(...common,
        field('Language', `<select id="d-lang" data-path="${p('language')}" data-commit>${options(LANGUAGES, t.language, (l) => LANGUAGE_NAMES[l])}</select>`, p('language')),
      ) + '<p class="muted small">Add cues from the Browser. Missing recordings in this language play in English.</p>';
    }
    return heading('Audio track', deleteButton('Remove track')) + row(...common)
      + '<p class="muted small">Click a clip in the lane to edit it.</p>';
  }

  // Name, volume, mute, output and color: every track has them.
  function trackFields(t, p) {
    return [
      field('Name', `<input id="d-name" data-path="${p('name')}" type="text" maxlength="${LIMITS.nameLength}" value="${esc(t.name)}" data-commit>`, p('name'), 'wide'),
      field('Volume', `<span class="volume"><input id="d-vol" data-path="${p('volumeDb')}" data-type="number" type="range" min="${LIMITS.volumeDb[0]}" max="${LIMITS.volumeDb[1]}" step="1" value="${esc(t.volumeDb)}"><output for="d-vol">${formatDb(t.volumeDb)}</output></span>`, p('volumeDb')),
      field('Mute', `<input id="d-mute" data-path="${p('muted')}" data-type="checkbox" type="checkbox" ${t.muted ? 'checked' : ''}>`, p('muted')),
      field('Output', `<select id="d-output" data-path="${p('output')}">${options(OUTPUTS, t.output, (o) => OUTPUT_NAMES[o])}</select>`, p('output')),
      field('Color', `<span class="swatches" data-color-path="${p('color')}">${TRACK_COLORS.map((c, i) => `<button type="button" class="swatch" data-color="${i}" style="background:${c}" aria-label="Color ${i + 1}" aria-pressed="${t.color === i}"></button>`).join('')}</span>`, p('color'), 'wide'),
    ];
  }

  // An audio clip, then the fields of its track.
  function clipPanel(clip, p) {
    const i = song.tracks.findIndex((t) => t.type === 'audio' && t.clips.includes(clip));
    const track = song.tracks[i];
    const seconds = (sec) => (sec === null ? 'to end of file' : sec.toFixed(3));
    return heading('Audio clip', deleteButton('Remove clip')) + row(
      field('File', `<input id="d-file" type="text" readonly value="${esc(clip.file)}">`, p('file'), 'wide'),
      field('Clip start (s)', `<input id="d-start" data-path="${p('startSec')}" data-type="number" type="number" min="${LIMITS.clipStartSec[0]}" max="${LIMITS.clipStartSec[1]}" step="0.001" value="${esc(clip.startSec)}">`, p('startSec')),
      field('Starts in file (s)', `<input id="d-offset" type="text" readonly value="${seconds(clip.offsetSec)}">`, p('offsetSec')),
      field('Length (s)', `<input id="d-length" type="text" readonly value="${seconds(clip.lengthSec)}">`, p('lengthSec')),
    ) + '<p class="muted small">Clip start is when the clip\'s first sample plays, in seconds from bar 1 (negative skips the beginning). Line the song\'s first downbeat up with a bar. To split the clip, click where to cut and press Cmd/Ctrl+E.</p>'
      + `<h3 class="detail-sub">Track: ${esc(track.name)}</h3>` + row(...trackFields(track, (suffix) => `tracks.${i}.${suffix}`));
  }

  function positionField(path, at) {
    const part = (i, label) => `<input id="d-at-${i}" data-path="${path}.${i}" data-type="number" type="number" min="1" step="1" value="${esc(at[i])}" aria-label="${label}">`;
    return field('Position (bar. beat. 16th)', `<span class="position-inputs">${part(0, 'Bar')}${part(1, 'Beat')}${part(2, 'Sixteenth')}</span>`, path);
  }

  function cuesLanguage() {
    return song.tracks.find((t) => t.type === 'cues')?.language ?? 'en';
  }
}

/** Path of the selected item in the song, e.g. "tracks.1.clips.4" ('' for the song itself). */
function pathOf(song, selection) {
  if (!selection) return '';
  const { kind, ref } = selection;
  if (kind === 'track') return `tracks.${song.tracks.indexOf(ref)}`;
  if (kind === 'clip') {
    const i = song.tracks.findIndex((t) => t.type === 'audio' && t.clips.includes(ref));
    return `tracks.${i}.clips.${song.tracks[i].clips.indexOf(ref)}`;
  }
  if (kind === 'cue') {
    const i = song.tracks.findIndex((t) => t.type === 'cues');
    return `tracks.${i}.clips.${song.tracks[i].clips.indexOf(ref)}`;
  }
  return `${kind === 'locator' ? 'locators' : kind}.${song[kind === 'locator' ? 'locators' : kind].indexOf(ref)}`;
}

function heading(title, actions) {
  return `<div class="detail-head"><h2>${title}</h2>${actions}</div>`;
}

function deleteButton(label = 'Delete') {
  return `<button type="button" data-action="delete" title="${label} (Delete key)">${label}</button>`;
}

function row(...fields) {
  return `<div class="detail-fields">${fields.join('')}</div>`;
}

function field(label, control, path, extraClass = '') {
  const id = control.match(/id="([^"]+)"/)?.[1];
  return `<div class="field ${extraClass}">
    <label${id ? ` for="${id}"` : ''}>${label}</label>
    ${control}
    <span class="error" data-error-for="${path}"></span>
  </div>`;
}

function readValue(input) {
  if (input.dataset.type === 'checkbox') return input.checked;
  if (input.dataset.type !== 'number') return input.value;
  return input.value === '' ? NaN : Number(input.value);
}

function setPath(target, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let obj = target;
  for (const k of keys) obj = obj[k];
  obj[last] = value;
}
