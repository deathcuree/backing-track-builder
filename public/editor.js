// Song editor form. Edits the song object in place and reports every change; the app validates,
// updates the timeline and tracks unsaved changes. Structural changes (adding, moving, removing
// rows) re-render the form; typing into a field does not, so focus is never lost.
import { LANGUAGES, SUBDIVISIONS, LIMITS } from '/shared/song.js';

export const LANGUAGE_NAMES = { en: 'English', fr: 'French', pt: 'Portuguese', es: 'Spanish' };
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true });

/**
 * @param {HTMLFormElement} form
 * @param {{ catalog: object, onChange: () => void }} options
 */
export function createEditor(form, { catalog, onChange }) {
  let song = null;

  form.addEventListener('submit', (e) => e.preventDefault());

  form.addEventListener('input', (event) => {
    const input = event.target.closest('[data-path]');
    if (!input) return;
    setPath(song, input.dataset.path, readValue(input));
    const out = form.querySelector(`output[for="${input.id}"]`);
    if (out) out.value = formatDb(Number(input.value));
    // Changing the language changes which section and cue names exist.
    if (input.dataset.path === 'guide.language') render();
    onChange();
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
