// Setlists (in the Browser): the songs for a service or gig, in order. Pick a setlist, open its
// songs (through the unsaved-changes prompt), and step through them with ← / → while stopped.
// Create, rename, reorder, remove and delete work as in the old Live view. The last setlist used
// is remembered in this browser.
import { newSetlist } from '/shared/setlist.js';
import { uniqueId } from '/shared/song.js';
import { esc } from './ui.js';

const LAST_SETLIST_KEY = 'btb.lastSetlist';

/**
 * @param {HTMLElement} el
 * @param {{ api: Function, getSongs: () => { id: string, title: string }[],
 *           getOpenSong: () => { id: string, saved: boolean }, isPlaying: () => boolean,
 *           onOpenSong: (id: string) => void, showMessage: (text: string) => void }} options
 */
export function createSetlists(el, { api, getSongs, getOpenSong, isPlaying, onOpenSong, showMessage }) {
  let setlists = [];
  let setlist = null;
  let deleteArmed = null;
  let renameTimer;

  el.addEventListener('click', onClick);
  el.addEventListener('change', async (e) => {
    if (e.target.id === 'sl-select' && e.target.value !== setlist?.id) await openSetlist(e.target.value);
  });
  el.addEventListener('input', (e) => {
    if (e.target.id === 'sl-name') renameSoon(e.target.value);
  });

  return {
    /** Loads the setlists and opens the last used one (or the first). */
    async enter() {
      setlists = await api('GET', '/api/setlists');
      const remembered = storage('get');
      const id = setlists.find((s) => s.id === remembered)?.id ?? setlists[0]?.id;
      if (id) await openSetlist(id);
      else render();
    },
    /** Opens the previous/next song of the setlist; only while stopped. @param {-1|1} by */
    step(by) {
      if (!setlist || isPlaying()) return;
      const current = setlist.songs.indexOf(getOpenSong().id);
      const to = current === -1 ? (by > 0 ? 0 : setlist.songs.length - 1) : current + by;
      if (to >= 0 && to < setlist.songs.length) openAt(to);
    },
    /** Re-renders (after the song list, the open song or playback changed). */
    render,
  };

  async function openSetlist(id) {
    setlist = await api('GET', `/api/setlists/${id}`);
    storage('set', id);
    render();
  }

  function openAt(i) {
    const id = setlist.songs[i];
    if (!getSongs().some((s) => s.id === id)) {
      showMessage(`Song "${id}" is not in the library. It may have been deleted.`);
      return;
    }
    onOpenSong(id);
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
      renderPicker();
    }, 400);
  }

  async function onClick(e) {
    const button = e.target.closest('button[data-sl]');
    if (!button) return;
    const i = Number(button.dataset.index);
    switch (button.dataset.sl) {
      case 'new': {
        const created = { ...newSetlist('New setlist'), id: uniqueId('New setlist', setlists.map((s) => s.id)) };
        await api('PUT', `/api/setlists/${created.id}`, created);
        setlists = await api('GET', '/api/setlists');
        await openSetlist(created.id);
        el.querySelector('#sl-name')?.select();
        return;
      }
      case 'delete': {
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
        await api('DELETE', `/api/setlists/${setlist.id}`);
        storage('set', '');
        setlist = null;
        setlists = await api('GET', '/api/setlists');
        if (setlists[0]) await openSetlist(setlists[0].id);
        else render();
        return;
      }
      case 'add': {
        const open = getOpenSong();
        if (!open.saved) return showMessage('Save the song before adding it to a setlist.');
        setlist.songs.push(open.id);
        await saveSetlist();
        return render();
      }
      case 'song':
        if (!isPlaying()) openAt(i);
        return;
      case 'up':
      case 'down': {
        const j = button.dataset.sl === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= setlist.songs.length) return;
        [setlist.songs[i], setlist.songs[j]] = [setlist.songs[j], setlist.songs[i]];
        await saveSetlist();
        return render();
      }
      case 'remove':
        setlist.songs.splice(i, 1);
        await saveSetlist();
        return render();
      default:
    }
  }

  function render() {
    el.innerHTML = `
      <div class="br-head"><h2>Setlists</h2><button type="button" data-sl="new" title="New setlist">+ New</button></div>
      <div id="sl-picker"></div>
      <div id="sl-list"></div>`;
    renderPicker();
    renderList();
  }

  function renderPicker() {
    const picker = el.querySelector('#sl-picker');
    if (!picker) return;
    picker.innerHTML = setlists.length ? `
      <select id="sl-select" aria-label="Setlist">
        ${setlists.map((s) => `<option value="${esc(s.id)}" ${s.id === setlist?.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
      </select>
      ${setlist ? `<input id="sl-name" type="text" aria-label="Setlist name" value="${esc(setlist.name)}">` : ''}`
      : '<p class="muted small br-empty">No setlists yet.</p>';
  }

  function renderList() {
    const list = el.querySelector('#sl-list');
    if (!setlist) {
      list.innerHTML = '';
      return;
    }
    const songs = getSongs();
    const open = getOpenSong();
    const stopped = !isPlaying();
    const titleOf = (id) => songs.find((s) => s.id === id)?.title;
    list.innerHTML = `
      <ol class="br-list sl-songs">
        ${setlist.songs.map((id, i) => `
          <li>
            <button type="button" data-sl="song" data-index="${i}" ${stopped ? '' : 'disabled'} ${id === open.id ? 'aria-current="true"' : ''}
              title="${stopped ? 'Open this song' : 'Stop to change songs'}">
              <span><span class="muted">${i + 1}.</span> ${titleOf(id) ? esc(titleOf(id)) : `<span class="warn">Missing: ${esc(id)}</span>`}</span>
            </button>
            <span class="sl-actions">
              <button type="button" data-sl="up" data-index="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button type="button" data-sl="down" data-index="${i}" aria-label="Move down" ${i === setlist.songs.length - 1 ? 'disabled' : ''}>↓</button>
              <button type="button" data-sl="remove" data-index="${i}" aria-label="Remove from setlist">✕</button>
            </span>
          </li>`).join('') || '<li class="muted small br-empty">No songs in this setlist yet.</li>'}
      </ol>
      <div class="sl-foot">
        <button type="button" data-sl="add" title="Add the open song to the end of this setlist">+ Add open song</button>
        <button type="button" data-sl="delete" class="sl-delete">${deleteArmed === setlist.id ? 'Really delete?' : 'Delete setlist'}</button>
      </div>
      <p class="muted small br-hint">← / → open the previous / next song while stopped.</p>`;
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
