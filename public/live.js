// Live view: run a setlist during a service or gig. Pick a setlist, step through its songs
// (only while stopped), jump between sections, loop a section, and mute or level stems live.
// Stem changes here are heard at once but only saved with "Save mix".
import { newSetlist } from '/shared/setlist.js';
import { uniqueId } from '/shared/song.js';
import { esc, formatDb } from './editor.js';
import { sectionFamily } from './timeline.js';

const LAST_SETLIST_KEY = 'btb.lastSetlist';

/**
 * @param {{ side: HTMLElement, main: HTMLElement, player: import('./player.js').Player,
 *           catalog: object, api: Function, getSongs: () => { id: string, title: string }[],
 *           showMessages: (warnings: string[]) => void }} options
 */
export function createLiveView({ side, main, player, catalog, api, getSongs, showMessages }) {
  let setlists = [];
  let setlist = null;
  let index = 0; // position in the setlist
  let song = null; // loaded song (the mix may have unsaved live changes)
  let savedMix = '';
  let loading = false;
  let deleteArmed = null;
  let renameTimer;

  side.addEventListener('click', onSideClick);
  side.addEventListener('change', onSideChange);
  side.addEventListener('input', (e) => {
    if (e.target.id === 'live-setlist-name') renameSoon(e.target.value);
  });
  main.addEventListener('click', onMainClick);
  main.addEventListener('input', onMixInput);

  return {
    enter,
    togglePlay() {
      if (player.playing) return player.stop();
      if (song && !loading) player.play();
    },
    step,
    setPosition(pos) {
      renderShow(pos);
    },
    /** Called when playback starts/stops (prev/next and song picking only work while stopped). */
    setPlaying() {
      render();
    },
    hasUnsavedMix: () => Boolean(song) && mixJson(song) !== savedMix,
  };

  /** Opens the last used setlist (or the first one). */
  async function enter() {
    setlists = await api('GET', '/api/setlists');
    const remembered = storage('get');
    const id = setlists.find((s) => s.id === remembered)?.id ?? setlists[0]?.id;
    if (id) return openSetlist(id);
    setlist = null;
    song = null;
    render();
  }

  /** Previous/next song in the setlist; only while stopped. @param {-1|1} by */
  function step(by) {
    if (player.playing || !setlist) return;
    const to = index + by;
    if (to >= 0 && to < setlist.songs.length) selectSong(to);
  }

  async function openSetlist(id) {
    setlist = await api('GET', `/api/setlists/${id}`);
    storage('set', id);
    index = 0;
    await selectSong(0);
  }

  async function selectSong(i) {
    player.stop();
    index = i;
    song = null;
    render();
    const id = setlist?.songs[i];
    if (!id) return;
    loading = true;
    render();
    try {
      song = await api('GET', `/api/songs/${id}`);
      savedMix = mixJson(song);
      showMessages(await player.load(song, catalog));
    } catch {
      song = null;
      showMessages([`Song "${id}" could not be loaded. It may have been deleted.`]);
    } finally {
      loading = false;
      render();
    }
  }

  async function saveSetlist() {
    await api('PUT', `/api/setlists/${setlist.id}`, setlist);
    setlists = await api('GET', '/api/setlists');
  }

  function renameSoon(name) {
    setlist.name = name;
    clearTimeout(renameTimer);
    if (!name.trim()) return;
    renameTimer = setTimeout(async () => {
      await saveSetlist();
      renderSetlistPicker();
    }, 400);
  }

  async function onSideClick(e) {
    const button = e.target.closest('button[data-live]');
    if (!button) return;
    const i = Number(button.dataset.index);
    switch (button.dataset.live) {
      case 'new-setlist': {
        const created = { ...newSetlist('New setlist'), id: uniqueId('New setlist', setlists.map((s) => s.id)) };
        await api('PUT', `/api/setlists/${created.id}`, created);
        setlists = await api('GET', '/api/setlists');
        await openSetlist(created.id);
        side.querySelector('#live-setlist-name')?.select();
        return;
      }
      case 'delete-setlist': {
        if (deleteArmed !== setlist.id) {
          deleteArmed = setlist.id;
          button.textContent = 'Really delete?';
          setTimeout(() => {
            deleteArmed = null;
            render();
          }, 3000);
          return;
        }
        deleteArmed = null;
        player.stop();
        await api('DELETE', `/api/setlists/${setlist.id}`);
        storage('set', '');
        await enter();
        return;
      }
      case 'add-song': {
        const id = side.querySelector('#live-add-song').value;
        if (!id) return;
        setlist.songs.push(id);
        await saveSetlist();
        if (setlist.songs.length === 1) await selectSong(0);
        else render();
        return;
      }
      case 'song':
        if (!player.playing && i !== index) await selectSong(i);
        return;
      case 'up':
      case 'down': {
        const j = button.dataset.live === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= setlist.songs.length) return;
        [setlist.songs[i], setlist.songs[j]] = [setlist.songs[j], setlist.songs[i]];
        if (index === i) index = j;
        else if (index === j) index = i;
        await saveSetlist();
        render();
        return;
      }
      case 'remove': {
        setlist.songs.splice(i, 1);
        await saveSetlist();
        if (i === index) await selectSong(Math.min(index, setlist.songs.length - 1));
        else {
          if (i < index) index--;
          render();
        }
        return;
      }
      default:
    }
  }

  async function onSideChange(e) {
    if (e.target.id === 'live-setlist-select' && e.target.value !== setlist?.id) {
      await openSetlist(e.target.value);
    }
  }

  function onMainClick(e) {
    const button = e.target.closest('button[data-show]');
    if (!button) return;
    switch (button.dataset.show) {
      case 'prev': return step(-1);
      case 'next': return step(1);
      case 'jump': return player.jump(Number(button.dataset.index));
      case 'loop': return player.toggleLoop();
      case 'mute': {
        const stem = song.stems[Number(button.dataset.index)];
        stem.muted = !stem.muted;
        player.setStemGain(stem);
        return renderMixer();
      }
      case 'save-mix': return saveMix();
      default:
    }
  }

  function onMixInput(e) {
    const input = e.target.closest('[data-stem-volume]');
    if (!input) return;
    const stem = song.stems[Number(input.dataset.stemVolume)];
    stem.volumeDb = Number(input.value);
    input.nextElementSibling.value = formatDb(stem.volumeDb);
    player.setStemGain(stem);
    updateMixState();
  }

  // Saves only the stem levels onto the latest saved song, so edits made elsewhere are kept.
  async function saveMix() {
    const latest = await api('GET', `/api/songs/${song.id}`);
    for (const stem of latest.stems) {
      const live = song.stems.find((s) => s.file === stem.file);
      if (live) Object.assign(stem, { volumeDb: live.volumeDb, muted: live.muted });
    }
    await api('PUT', `/api/songs/${song.id}`, latest);
    savedMix = mixJson(song);
    updateMixState();
  }

  function render() {
    renderSetlistPicker();
    renderSetlist();
    renderShowFrame();
  }

  function renderSetlistPicker() {
    side.querySelector('#live-setlist-picker').innerHTML = `
      <div class="field">
        <label for="live-setlist-select">Setlist</label>
        <div class="picker-row">
          <select id="live-setlist-select" ${setlists.length ? '' : 'disabled'}>
            ${setlists.map((s) => `<option value="${esc(s.id)}" ${s.id === setlist?.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')
              || '<option>No setlists yet</option>'}
          </select>
          <button type="button" data-live="new-setlist">+ New</button>
        </div>
      </div>
      ${setlist ? `
        <div class="field">
          <label for="live-setlist-name">Name</label>
          <input id="live-setlist-name" type="text" value="${esc(setlist.name)}">
        </div>` : ''}`;
  }

  function renderSetlist() {
    const list = side.querySelector('#live-setlist');
    if (!setlist) {
      list.innerHTML = '<p class="muted">Create a setlist to start.</p>';
      return;
    }
    const songs = getSongs();
    const titleOf = (id) => songs.find((s) => s.id === id)?.title;
    const stopped = !player.playing;
    list.innerHTML = `
      <ol class="setlist">
        ${setlist.songs.map((id, i) => `
          <li class="${i === index ? 'current' : ''}">
            <button type="button" class="setlist-song" data-live="song" data-index="${i}" ${stopped ? '' : 'disabled'}
              ${i === index ? 'aria-current="true"' : ''}>
              <span class="num">${i + 1}</span>
              <span>${titleOf(id) ? esc(titleOf(id)) : `<span class="warn">Missing: ${esc(id)}</span>`}</span>
            </button>
            <span class="row-actions">
              <button type="button" data-live="up" data-index="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button type="button" data-live="down" data-index="${i}" aria-label="Move down" ${i === setlist.songs.length - 1 ? 'disabled' : ''}>↓</button>
              <button type="button" data-live="remove" data-index="${i}" aria-label="Remove from setlist">✕</button>
            </span>
          </li>`).join('') || '<li class="muted empty">No songs in this setlist yet.</li>'}
      </ol>
      <div class="field">
        <label for="live-add-song">Add a song</label>
        <div class="picker-row">
          <select id="live-add-song">
            ${songs.map((s) => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('') || '<option value="">No songs yet</option>'}
          </select>
          <button type="button" data-live="add-song" ${songs.length ? '' : 'disabled'}>Add</button>
        </div>
      </div>
      <button type="button" class="danger-link" data-live="delete-setlist">${deleteArmed === setlist.id ? 'Really delete?' : 'Delete setlist'}</button>`;
  }

  function renderShowFrame() {
    if (!setlist || !setlist.songs.length) {
      main.innerHTML = `<div class="show-empty"><h1>Live</h1><p class="muted">${
        setlist ? 'Add songs to this setlist on the left.' : 'Create a setlist on the left, then add songs to it.'}</p></div>`;
      return;
    }
    const stopped = !player.playing;
    const title = song?.title ?? (loading ? 'Loading…' : 'Song not available');
    main.innerHTML = `
      <div class="show-head">
        <button type="button" data-show="prev" aria-label="Previous song" ${stopped && index > 0 ? '' : 'disabled'}>◀ Prev</button>
        <div class="show-title">
          <div class="muted small">Song ${index + 1} of ${setlist.songs.length}${loading ? ' · loading stems…' : ''}</div>
          <h1>${esc(title)}</h1>
          ${song ? `<div class="muted small">${esc(song.bpm)} BPM · ${esc(song.meter.join('/'))}</div>` : ''}
        </div>
        <button type="button" data-show="next" aria-label="Next song" ${stopped && index < setlist.songs.length - 1 ? '' : 'disabled'}>Next ▶</button>
      </div>
      <div class="show-now">
        <div id="show-section" class="show-section">${song ? 'Ready' : ''}</div>
        <div id="show-position" class="show-position muted">${song ? 'Press Play or Space' : ''}</div>
        <div id="show-status" class="show-status" aria-live="polite"></div>
      </div>
      ${song ? `
        <div class="show-sections" role="group" aria-label="Jump to section">
          ${song.sections.map((s, i) => `
            <button type="button" class="section-button family-${sectionFamily(s.name)}" data-show="jump" data-index="${i}" ${stopped ? 'disabled' : ''}>
              ${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}<span>${esc(s.name)}</span>
            </button>`).join('')}
        </div>
        <div class="show-controls">
          <button type="button" id="show-loop" data-show="loop" aria-pressed="false" ${stopped ? 'disabled' : ''}><kbd>L</kbd> Loop section</button>
          <span class="muted small">Space play/stop · 1–9 jump · L loop · ←/→ song (while stopped)</span>
        </div>
        <section class="show-mixer" aria-label="Stem mixer"></section>` : ''}`;
    renderMixer();
  }

  function renderMixer() {
    const el = main.querySelector('.show-mixer');
    if (!el || !song) return;
    el.innerHTML = song.stems.length ? `
      <div class="mixer-head">
        <h2>Stems</h2>
        <span id="mix-state" class="muted small"></span>
        <button type="button" data-show="save-mix" id="save-mix">Save mix</button>
      </div>
      <ul class="mixer">
        ${song.stems.map((st, i) => `
          <li class="${st.muted ? 'muted-stem' : ''}">
            <button type="button" class="mute-button" data-show="mute" data-index="${i}" aria-pressed="${st.muted}">${st.muted ? 'Muted' : 'Mute'}</button>
            <span class="stem-label">${esc(st.name)}</span>
            <span class="volume">
              <input type="range" min="-60" max="6" step="1" value="${esc(st.volumeDb)}" data-stem-volume="${i}" aria-label="${esc(st.name)} volume">
              <output>${formatDb(st.volumeDb)}</output>
            </span>
          </li>`).join('')}
      </ul>` : '<p class="muted small">This song has no stems. Add them in the Edit view.</p>';
    updateMixState();
  }

  function updateMixState() {
    const dirty = song && mixJson(song) !== savedMix;
    const state = main.querySelector('#mix-state');
    if (state) state.textContent = dirty ? 'Live changes not saved' : '';
    const button = main.querySelector('#save-mix');
    if (button) button.disabled = !dirty;
  }

  function renderShow(pos) {
    const sectionEl = main.querySelector('#show-section');
    if (!sectionEl || !song) return;
    const positionEl = main.querySelector('#show-position');
    const statusEl = main.querySelector('#show-status');
    const loopButton = main.querySelector('#show-loop');
    for (const b of main.querySelectorAll('.section-button')) b.classList.remove('current', 'pending', 'looping');
    if (!pos) {
      sectionEl.textContent = 'Ready';
      positionEl.textContent = 'Press Play or Space';
      statusEl.textContent = '';
      loopButton?.setAttribute('aria-pressed', 'false');
      return;
    }
    const name = (i) => song.sections[i]?.name ?? '';
    sectionEl.textContent = pos.countIn ? 'Count-in' : name(pos.section);
    positionEl.textContent = pos.countIn ? `beat ${pos.beat}` : `Bar ${pos.bar} · beat ${pos.beat}`;
    const buttons = main.querySelectorAll('.section-button');
    if (!pos.countIn) buttons[pos.section]?.classList.add('current');
    const status = [];
    if (pos.pendingJump !== null) {
      buttons[pos.pendingJump]?.classList.add('pending');
      status.push(`Jumping to ${name(pos.pendingJump)} at the next bar (press again to cancel)`);
    }
    if (pos.loop !== null) {
      buttons[pos.loop]?.classList.add('looping');
      status.push(`Looping ${name(pos.loop)} (press L to release)`);
    }
    statusEl.textContent = status.join(' · ');
    loopButton?.setAttribute('aria-pressed', String(pos.loop !== null));
  }

  function storage(op, value) {
    try {
      if (op === 'get') return localStorage.getItem(LAST_SETLIST_KEY);
      localStorage.setItem(LAST_SETLIST_KEY, value);
    } catch {
      // private mode or blocked storage: just don't remember
    }
    return null;
  }
}

function mixJson(song) {
  return JSON.stringify(song.stems.map(({ file, volumeDb, muted }) => ({ file, volumeDb, muted })));
}
