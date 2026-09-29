// Browser (left): the song library and the guide samples that can be placed on the Cues track,
// grouped like the sample pack (Sections, Dynamic cues, Counts) in the Cues track's language.
import { esc, cueChoices, LANGUAGE_NAMES } from './ui.js';

const GROUPS = [['section', 'Sections'], ['cue', 'Dynamic cues'], ['count', 'Counts']];

/**
 * @param {HTMLElement} el
 * @param {{ catalog: object, onOpenSong: (id: string) => void, onNewSong: () => void,
 *           onAddCue: (cue: { type: string, key: string }) => void }} handlers
 */
export function createBrowser(el, { catalog, onOpenSong, onNewSong, onAddCue }) {
  el.innerHTML = `
    <section class="br-section">
      <div class="br-head"><h2>Songs</h2><button type="button" data-action="new-song" title="New song">+ New</button></div>
      <ul class="br-list" id="br-songs"></ul>
    </section>
    <section class="br-section br-cues">
      <div class="br-head"><h2>Cues</h2><span class="muted small" id="br-language"></span></div>
      <p class="muted small br-hint">Click a cue to add it at the insert marker.</p>
      <div id="br-cue-groups"></div>
    </section>`;
  let language = null;

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="new-song"]')) return onNewSong();
    const song = e.target.closest('[data-song]');
    if (song) return onOpenSong(song.dataset.song);
    const cue = e.target.closest('[data-cue-type]');
    if (cue) onAddCue({ type: cue.dataset.cueType, key: cue.dataset.cueKey });
  });

  return {
    /** @param {{ id: string, title: string, bpm: number, meter: number[] }[]} songs */
    renderSongs(songs, currentId) {
      el.querySelector('#br-songs').innerHTML = songs.map((s) => `
        <li><button type="button" data-song="${esc(s.id)}" ${s.id === currentId ? 'aria-current="true"' : ''}>
          <span>${esc(s.title)}</span>
          <span class="muted small">${esc(s.bpm)} · ${esc(s.meter.join('/'))}</span>
        </button></li>`).join('') || '<li class="muted small br-empty">No songs yet.</li>';
    },
    /** Lists the cues for the Cues track's language (English stand-ins are marked EN). */
    renderCues(lang) {
      if (lang === language) return;
      language = lang;
      el.querySelector('#br-language').textContent = LANGUAGE_NAMES[lang] ?? lang;
      el.querySelector('#br-cue-groups').innerHTML = GROUPS.map(([type, label]) => `
        <details class="br-group" ${type === 'section' ? 'open' : ''}>
          <summary>${label}</summary>
          <ul class="br-list">
            ${cueChoices(catalog, lang, type).map(({ key, english }) => `
              <li><button type="button" class="br-cue" data-cue-type="${type}" data-cue-key="${esc(key)}"
                title="Add “${esc(key)}” at the insert marker${english ? ' (English recording)' : ''}">
                ${esc(key)}${english ? ' <span class="br-tag">EN</span>' : ''}
              </button></li>`).join('') || '<li class="muted small br-empty">None in this language.</li>'}
          </ul>
        </details>`).join('');
    },
  };
}
