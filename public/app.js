import { newSong, validateSong, uniqueId } from '/shared/song.js';
import { buildSchedule } from '/shared/schedule.js';
import { createEditor, esc, formatDb } from './editor.js';
import { createTimeline } from './timeline.js';
import { Player } from './player.js';
import { createLiveView } from './live.js';

const $ = (id) => document.getElementById(id);

let catalog;
let songs = [];
let song = null;
let savedJson = null; // JSON of the song as opened or last saved
let isNew = false; // never saved
let sectionStarts = [];
let uploading = false;
let view = 'edit';

const catalogRes = await fetch('/samples/catalog.json').catch(() => null);
if (!catalogRes?.ok) {
  $('app').hidden = true;
  $('setup').hidden = false;
} else {
  catalog = await catalogRes.json();
  await start();
}

async function start() {
  const editor = createEditor($('editor'), { catalog, onChange: changed, onAddStems: uploadStems });
  const timeline = createTimeline($('timeline'), { onBarClick: (bar) => editor.addCue(bar) });
  const player = new Player({
    onPosition: (pos) => {
      if (view === 'live') {
        $('position').textContent = !pos ? 'Stopped' : pos.countIn ? `Count-in · beat ${pos.beat}` : `Bar ${pos.bar} · beat ${pos.beat}`;
        return live.setPosition(pos);
      }
      timeline.setPosition(pos);
      showPosition(pos);
    },
    onStateChange: (playing) => {
      $('play').textContent = playing ? '■ Stop' : '▶ Play';
      $('play').setAttribute('aria-pressed', String(playing));
      if (!playing) $('play-note').textContent = '';
      if (view === 'live') live.setPlaying(playing);
    },
  });
  const live = createLiveView({
    side: $('live-side'), main: $('live-show'), player, catalog, api,
    getSongs: () => songs, showMessages,
  });

  const settings = await api('GET', '/api/settings');
  player.setMix(settings.mix);
  setupMix(settings);

  songs = await api('GET', '/api/songs');
  renderSongList();
  open(songs[0] ? await api('GET', `/api/songs/${songs[0].id}`) : newSong(), songs[0] ? true : false);

  $('play').addEventListener('click', togglePlay);
  $('view-edit').addEventListener('click', () => setView('edit'));
  $('view-live').addEventListener('click', () => whenSaved(() => setView('live')));
  $('save').addEventListener('click', save);
  $('new-song').addEventListener('click', () => whenSaved(() => open(newSong(), false)));
  $('song-list').addEventListener('click', (e) => {
    const id = e.target.closest('[data-id]')?.dataset.id;
    if (id && id !== song.id) whenSaved(async () => open(await api('GET', `/api/songs/${id}`), true));
  });
  // Space play/stop · 1–9 jump to section · L loop · ←/→ previous/next song (live view, stopped)
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, select, textarea')) return;
    const digit = e.code.match(/^(?:Digit|Numpad)([1-9])$/);
    if (e.code === 'Space' && !e.target.closest('button')) togglePlay();
    else if (digit) player.jump(Number(digit[1]) - 1);
    else if (e.code === 'KeyL') player.toggleLoop();
    else if (view === 'live' && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) live.step(e.code === 'ArrowLeft' ? -1 : 1);
    else return;
    e.preventDefault();
  });
  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) e.preventDefault();
  });

  function open(next, saved) {
    player.stop();
    song = next;
    savedJson = JSON.stringify(song);
    isNew = !saved;
    editor.show(song);
    changed();
    renderSongList();
  }

  function changed(path) {
    const live = path?.match(/^stems\.(\d+)\.(volumeDb|muted)$/);
    if (live) player.setStemGain(song.stems[Number(live[1])]);
    const errors = validateSong(song);
    editor.showErrors(errors);
    let warnings = [];
    let totalBars = 0;
    if (!errors.length) {
      const schedule = buildSchedule(song, catalog);
      warnings = schedule.warnings;
      totalBars = schedule.totalBars;
      sectionStarts = schedule.sections.map((s) => ({ name: s.name, startBar: s.startBar }));
    }
    timeline.render(song, totalBars);
    showMessages(warnings);
    $('song-title').textContent = song.title || 'Untitled';
    $('save-state').textContent = isNew ? 'Not saved yet' : isDirty() ? 'Unsaved changes' : 'Saved';
    $('save-state').classList.toggle('dirty', isNew || isDirty());
    if (player.playing && !live) $('play-note').textContent = 'Changes apply the next time you press Play.';
    updateUploadState();
  }

  function updateUploadState() {
    editor.setUpload({
      enabled: !isNew && !uploading,
      message: isNew ? 'Save the song first, then add stems.' : uploading ? '' : 'WAV, MP3, M4A, FLAC or OGG.',
    });
    $('save').disabled = uploading;
  }

  // Uploads one file at a time, then adds the stems to the song (saved with the next Save).
  async function uploadStems(files) {
    uploading = true;
    player.stop();
    const added = [];
    const failed = [];
    try {
      for (const [i, file] of files.entries()) {
        editor.setUpload({ enabled: false, message: `Uploading ${file.name} (${i + 1} of ${files.length})…` });
        try {
          const res = await fetch(`/api/songs/${song.id}/stems`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
            body: file,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error ?? res.statusText);
          added.push(data);
        } catch (err) {
          failed.push(`${file.name}: ${err.message}`);
        }
      }
    } finally {
      uploading = false;
    }
    player.forgetStems();
    if (added.length) editor.addStems(added);
    else changed();
    if (failed.length) showMessages(failed.map((f) => `Not added: ${f}`));
    if (added.length) $('play-note').textContent = `Added ${added.length} stem${added.length > 1 ? 's' : ''}. Press Save to keep ${added.length > 1 ? 'them' : 'it'}.`;
  }

  function setupMix(current) {
    let saveTimer;
    for (const input of document.querySelectorAll('#mix input')) {
      const key = input.dataset.mix;
      input.value = current.mix[key];
      input.nextElementSibling.value = formatDb(current.mix[key]);
      input.addEventListener('input', () => {
        const db = Number(input.value);
        current.mix[key] = db;
        input.nextElementSibling.value = formatDb(db);
        player.setMix({ [key]: db });
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => api('PUT', '/api/settings', current).catch(() => {}), 400);
      });
    }
  }

  async function setView(next) {
    if (next === view) return;
    player.stop();
    view = next;
    $('view-edit').setAttribute('aria-pressed', String(view === 'edit'));
    $('view-live').setAttribute('aria-pressed', String(view === 'live'));
    for (const id of ['edit-side', 'edit-main']) $(id).hidden = view !== 'edit';
    for (const id of ['live-side', 'live-main']) $(id).hidden = view !== 'live';
    $('position').textContent = 'Stopped';
    if (view === 'live') {
      songs = await api('GET', '/api/songs');
      showMessages([]);
      await live.enter();
    } else {
      changed();
    }
  }

  async function togglePlay() {
    if (view === 'live') return live.togglePlay();
    if (player.playing) return player.stop();
    const errors = validateSong(song);
    if (errors.length) {
      editor.showErrors(errors);
      $('play-note').textContent = 'Fix the errors in the song before playing.';
      return;
    }
    $('play').disabled = true;
    $('play-note').textContent = 'Loading samples…';
    try {
      showMessages(await player.load(song, catalog));
      $('play-note').textContent = '';
      await player.play();
    } catch (err) {
      $('play-note').textContent = `Could not start playback: ${err.message}`;
    } finally {
      $('play').disabled = false;
    }
  }

  async function save() {
    const errors = validateSong(song);
    editor.showErrors(errors);
    if (errors.length) return false;
    if (!song.id) song.id = uniqueId(song.title, songs.map((s) => s.id));
    try {
      await api('PUT', `/api/songs/${song.id}`, song);
    } catch (err) {
      editor.showErrors(err.errors ?? [{ path: '', message: `Save failed: ${err.message}` }]);
      return false;
    }
    savedJson = JSON.stringify(song);
    isNew = false;
    const settings = await api('GET', '/api/settings');
  player.setMix(settings.mix);
  setupMix(settings);

  songs = await api('GET', '/api/songs');
    renderSongList();
    changed();
    return true;
  }

  // Runs `action` (switch song / new song) once unsaved changes are saved or discarded.
  function whenSaved(action) {
    if (!isDirty()) return action();
    const notice = $('notice');
    notice.hidden = false;
    notice.innerHTML = `
      <span><strong>${esc(song.title || 'This song')}</strong> has unsaved changes.</span>
      <button type="button" data-choice="save" class="primary">Save</button>
      <button type="button" data-choice="discard">Discard</button>
      <button type="button" data-choice="cancel">Cancel</button>`;
    notice.onclick = async (e) => {
      const choice = e.target.closest('[data-choice]')?.dataset.choice;
      if (!choice) return;
      notice.hidden = true;
      if (choice === 'save' && !(await save())) return;
      if (choice !== 'cancel') action();
    };
    notice.querySelector('button').focus();
  }

  function isDirty() {
    return JSON.stringify(song) !== savedJson;
  }

  function renderSongList() {
    $('song-list').innerHTML = songs.map((s) => `
      <li><button type="button" data-id="${esc(s.id)}" ${s.id === song?.id ? 'aria-current="true"' : ''}>
        <span>${esc(s.title)}</span>
        <span class="muted">${esc(s.bpm)} BPM · ${esc(s.meter.join('/'))}</span>
      </button></li>`).join('') || '<li class="muted empty">No songs yet.</li>';
  }

  function showPosition(pos) {
    const el = $('position');
    if (!pos) {
      el.textContent = 'Stopped';
      return;
    }
    if (pos.countIn) {
      el.textContent = `Count-in · beat ${pos.beat}`;
      return;
    }
    const section = sectionStarts.findLast((s) => s.startBar <= pos.bar);
    el.textContent = `Bar ${pos.bar} · beat ${pos.beat}${section ? ` · ${section.name}` : ''}`;
  }
}

function showMessages(warnings) {
  const el = $(view === 'live' ? 'live-messages' : 'messages');
  el.hidden = warnings.length === 0;
  el.innerHTML = `<h2>Heads up</h2><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { errors: data.errors });
  return data;
}
