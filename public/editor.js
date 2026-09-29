// Song editor form. Edits the song object in place and reports every change; the app validates,
// updates the timeline and tracks unsaved changes. Structural changes (adding, moving, removing
// rows) re-render the form; typing into a field does not, so focus is never lost.
import { LANGUAGES, SUBDIVISIONS, LIMITS, STEM_EXTENSIONS } from '/shared/song.js';

export const LANGUAGE_NAMES = { en: 'English', fr: 'French', pt: 'Portuguese', es: 'Spanish' };
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true });

/**
 * @param {HTMLFormElement} form
 * @param {{ catalog: object, onChange: (path?: string) => void, onAddStems: (files: File[]) => void }} options
 *   onChange receives the edited field's path (e.g. "stems.0.volumeDb") so live levels can follow.
 */
export function createEditor(form, { catalog, onChange, onAddStems }) {
  let song = null;
  let upload = { enabled: false, message: '' };

  form.addEventListener('submit', (e) => e.preventDefault());

  form.addEventListener('input', (event) => {
    const input = event.target.closest('[data-path]');
    if (!input) return;
    setPath(song, input.dataset.path, readValue(input));
    const out = form.querySelector(`output[for="${input.id}"]`);
    if (out) out.value = formatDb(Number(input.value));
    // Changing the language changes which section and cue names exist.
    if (input.dataset.path === 'guide.language') render();
    onChange(input.dataset.path);
  });

  form.addEventListener('change', (event) => {
    if (!event.target.matches('input[type="file"]')) return;
    const files = [...event.target.files];
    event.target.value = '';
    if (files.length) onAddStems(files);
  });

  form.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const i = Number(button.dataset.index);
    const { sections, cues } = song;
    switch (button.dataset.action) {
      case 'add-section': sections.push({ name: 'Chorus', bars: 8 }); break;
      case 'move-up': if (i > 0) [sections[i - 1], sections[i]] = [sections[i], sections[i - 1]]; break;
      case 'move-down': if (i < sections.length - 1) [sections[i + 1], sections[i]] = [sections[i], sections[i + 1]]; break;
      case 'remove-section': sections.splice(i, 1); break;
      case 'add-cue': cues.push({ name: defaultCue(), bar: 1 }); break;
      case 'remove-cue': cues.splice(i, 1); break;
      case 'remove-stem': song.stems.splice(i, 1); break;
      case 'add-stems': form.querySelector('#f-stem-files').click(); return;
      default: return;
    }
    render();
    onChange();
  });

  return {
    show(newSong) {
      song = newSong;
      render();
    },
    /** Adds a cue at `bar` (from a timeline click) and focuses its name. */
    addCue(bar) {
      song.cues.push({ name: defaultCue(), bar });
      song.cues.sort((a, b) => a.bar - b.bar);
      render();
      onChange();
      const index = song.cues.findLastIndex((c) => c.bar === bar);
      form.querySelector(`[data-path="cues.${index}.name"]`)?.focus();
    },
    /** Adds uploaded stems ({ file }) with default levels. */
    addStems(uploaded) {
      for (const { file } of uploaded) {
        song.stems.push({ file, name: file.replace(/\.[^.]+$/, ''), volumeDb: 0, muted: false });
      }
      render();
      onChange('stems');
    },
    /** @param {{ enabled: boolean, message: string }} state whether stems can be uploaded now, and why not */
    setUpload(state) {
      upload = state;
      const button = form.querySelector('[data-action="add-stems"]');
      if (button) button.disabled = !upload.enabled;
      const note = form.querySelector('#stem-upload-note');
      if (note) note.textContent = upload.message;
    },
    /** @param {{ path: string, message: string }[]} errors from validateSong */
    showErrors(errors) {
      for (const el of form.querySelectorAll('[data-error-for]')) el.textContent = '';
      for (const input of form.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
      for (const { path, message } of errors) {
        const key = path.replace(/\[(\d+)\]/g, '.$1');
        const slot = form.querySelector(`[data-error-for="${key}"]`) ?? form.querySelector('[data-error-for="form"]');
        slot.textContent = slot.textContent ? `${slot.textContent} ${message}` : message;
        form.querySelector(`[data-path="${key}"]`)?.setAttribute('aria-invalid', 'true');
      }
      updateBarRanges();
    },
  };

  function render() {
    const lang = song.guide.language;
    const names = (type) => {
      const set = new Set([
        ...Object.keys(catalog.guides.en?.[type] ?? {}),
        ...Object.keys(catalog.guides[lang]?.[type] ?? {}),
      ]);
      return [...set].sort(byName);
    };
    const sectionNames = names('section');
    const cueNames = names('cue');

    form.innerHTML = `
      <p class="form-error" data-error-for="form" role="alert"></p>
      <fieldset>
        <legend>Song</legend>
        <div class="grid">
          ${field('Title', `<input id="f-title" data-path="title" type="text" value="${esc(song.title)}" required>`, 'title', 'wide')}
          ${field('BPM', `<input id="f-bpm" data-path="bpm" data-type="number" type="number" min="${LIMITS.bpm[0]}" max="${LIMITS.bpm[1]}" step="0.1" value="${esc(song.bpm)}">`, 'bpm')}
          ${field('Time signature', `
            <span class="meter">
              <select id="f-beats" data-path="meter.0" data-type="number" aria-label="Beats per bar">
                ${options(range(LIMITS.beats[0], LIMITS.beats[1]), song.meter[0])}
              </select>
              <span aria-hidden="true">/</span>
              <select data-path="meter.1" data-type="number" aria-label="Beat unit">
                ${options(LIMITS.denominators, song.meter[1])}
              </select>
            </span>`, 'meter')}
          ${field('Count-in', `<select id="f-countin" data-path="countInBars" data-type="number">
              ${options(LIMITS.countInBars, song.countInBars, (n) => (n === 0 ? 'None' : `${n} bar${n > 1 ? 's' : ''}`))}
            </select>`, 'countInBars')}
        </div>
      </fieldset>

      <fieldset>
        <legend>Click</legend>
        <div class="grid">
          ${field('Sound', `<select id="f-sound" data-path="click.sound">
              ${options(Object.keys(catalog.clicks).sort(byName), song.click.sound)}
            </select>`, 'click.sound')}
          ${field('Subdivision', `<select id="f-subdivision" data-path="click.subdivision">
              ${options(SUBDIVISIONS, song.click.subdivision, (s) => ({ quarter: 'Beats only', eighth: 'Eighths', sixteenth: 'Sixteenths' })[s])}
            </select>`, 'click.subdivision')}
          ${volume('f-click-vol', 'click.volumeDb', song.click.volumeDb)}
        </div>
      </fieldset>

      <fieldset>
        <legend>Guide</legend>
        <div class="grid">
          ${field('Language', `<select id="f-language" data-path="guide.language">
              ${options(LANGUAGES, lang, (l) => LANGUAGE_NAMES[l])}
            </select>`, 'guide.language')}
          ${volume('f-guide-vol', 'guide.volumeDb', song.guide.volumeDb)}
        </div>
      </fieldset>

      <fieldset>
        <legend>Sections</legend>
        <p class="error" data-error-for="sections"></p>
        <ol class="rows">
          ${song.sections.map((s, i) => `
            <li class="row">
              <select data-path="sections.${i}.name" aria-label="Section ${i + 1} name">
                ${options(withCurrent(sectionNames, s.name), s.name)}
              </select>
              <label class="inline">
                <input data-path="sections.${i}.bars" data-type="number" type="number" min="1" max="${LIMITS.maxBars}" step="1" value="${esc(s.bars)}" aria-label="Section ${i + 1} bars">
                bars
              </label>
              <span class="muted bar-range" data-range="${i}"></span>
              <span class="row-actions">
                <button type="button" data-action="move-up" data-index="${i}" aria-label="Move ${esc(s.name)} up" ${i === 0 ? 'disabled' : ''}>↑</button>
                <button type="button" data-action="move-down" data-index="${i}" aria-label="Move ${esc(s.name)} down" ${i === song.sections.length - 1 ? 'disabled' : ''}>↓</button>
                <button type="button" data-action="remove-section" data-index="${i}" aria-label="Remove ${esc(s.name)}">✕</button>
              </span>
              <span class="error" data-error-for="sections.${i}.name"></span>
              <span class="error" data-error-for="sections.${i}.bars"></span>
            </li>`).join('')}
        </ol>
        <button type="button" data-action="add-section">+ Add section</button>
      </fieldset>

      <fieldset>
        <legend>Cues</legend>
        <p class="muted hint">Spoken on beat 1 of their bar (mid-bar if a section name is spoken there). Tip: click a bar on the timeline to add one.</p>
        <p class="error" data-error-for="cues"></p>
        <ul class="rows">
          ${song.cues.map((c, i) => `
            <li class="row">
              <select data-path="cues.${i}.name" aria-label="Cue ${i + 1}">
                ${options(withCurrent(cueNames, c.name), c.name)}
              </select>
              <label class="inline">bar
                <input data-path="cues.${i}.bar" data-type="number" type="number" min="1" step="1" value="${esc(c.bar)}" aria-label="Cue ${i + 1} bar">
              </label>
              <span class="row-actions">
                <button type="button" data-action="remove-cue" data-index="${i}" aria-label="Remove cue ${esc(c.name)} at bar ${esc(c.bar)}">✕</button>
              </span>
              <span class="error" data-error-for="cues.${i}.name"></span>
              <span class="error" data-error-for="cues.${i}.bar"></span>
            </li>`).join('')}
        </ul>
        <button type="button" data-action="add-cue">+ Add cue</button>
      </fieldset>

      <fieldset>
        <legend>Stems</legend>
        <p class="muted hint">Band tracks from MultiTracks. They start with bar 1 and play to both the in-ears and the main output. Volume and mute change live while playing.</p>
        <p class="error" data-error-for="stems"></p>
        <ul class="rows">
          ${song.stems.map((st, i) => `
            <li class="row stem-row">
              <input data-path="stems.${i}.name" type="text" value="${esc(st.name)}" aria-label="Stem ${i + 1} name" class="stem-name">
              <span class="volume">
                <input id="f-stem-vol-${i}" data-path="stems.${i}.volumeDb" data-type="number" type="range" min="${LIMITS.volumeDb[0]}" max="${LIMITS.volumeDb[1]}" step="1" value="${esc(st.volumeDb)}" aria-label="${esc(st.name)} volume">
                <output for="f-stem-vol-${i}">${formatDb(st.volumeDb)}</output>
              </span>
              <label class="inline mute"><input data-path="stems.${i}.muted" data-type="checkbox" type="checkbox" ${st.muted ? 'checked' : ''}> Mute</label>
              <span class="row-actions">
                <button type="button" data-action="remove-stem" data-index="${i}" aria-label="Remove stem ${esc(st.name)}">✕</button>
              </span>
              <span class="muted small stem-file">${esc(st.file)}</span>
              <span class="error" data-error-for="stems.${i}.name"></span>
              <span class="error" data-error-for="stems.${i}.volumeDb"></span>
              <span class="error" data-error-for="stems.${i}.file"></span>
            </li>`).join('')}
        </ul>
        <div class="stem-actions">
          <button type="button" data-action="add-stems" ${upload.enabled ? '' : 'disabled'}>+ Add stems…</button>
          <input id="f-stem-files" type="file" multiple hidden accept="${STEM_EXTENSIONS.map((e) => `.${e}`).join(',')}">
          <span id="stem-upload-note" class="muted small" aria-live="polite">${esc(upload.message)}</span>
        </div>
        <div class="grid offset-grid">
          ${field('Stem offset (ms)', `<input id="f-offset" data-path="stemOffsetMs" data-type="number" type="number" min="${LIMITS.stemOffsetMs[0]}" max="${LIMITS.stemOffsetMs[1]}" step="1" value="${esc(song.stemOffsetMs)}">`, 'stemOffsetMs')}
          <p class="muted hint offset-hint">Nudges stems against the click. Positive = stems later. Applies the next time you press Play.</p>
        </div>
      </fieldset>`;
    updateBarRanges();
  }

  function updateBarRanges() {
    let bar = 1;
    song.sections.forEach((s, i) => {
      const el = form.querySelector(`[data-range="${i}"]`);
      if (!el) return;
      const ok = Number.isInteger(s.bars) && s.bars >= 1;
      el.textContent = ok ? `(${bar}–${bar + s.bars - 1})` : '';
      if (ok) bar += s.bars;
    });
  }

  function defaultCue() {
    return catalog.guides.en?.cue?.Build ? 'Build' : Object.keys(catalog.guides.en?.cue ?? {})[0] ?? '';
  }
}

function field(label, control, path, extraClass = '') {
  const id = control.match(/id="([^"]+)"/)?.[1];
  return `<div class="field ${extraClass}">
    <label${id ? ` for="${id}"` : ''}>${label}</label>
    ${control}
    <span class="error" data-error-for="${path}"></span>
  </div>`;
}

function volume(id, path, value) {
  return field('Volume', `<span class="volume">
    <input id="${id}" data-path="${path}" data-type="number" type="range" min="${LIMITS.volumeDb[0]}" max="${LIMITS.volumeDb[1]}" step="1" value="${esc(value)}">
    <output for="${id}">${formatDb(value)}</output>
  </span>`, path);
}

function options(values, selected, label = (v) => v) {
  return values.map((v) => `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(label(v))}</option>`).join('');
}

function withCurrent(list, current) {
  return current && !list.includes(current) ? [current, ...list] : list;
}

function range(from, to) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
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

export function formatDb(db) {
  return db > 0 ? `+${db} dB` : `${db} dB`;
}

export function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
