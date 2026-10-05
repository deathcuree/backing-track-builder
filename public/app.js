// App shell: loads the catalog and songs, owns the open song, the selection and the start bar,
// and connects the Control Bar, Browser, Arrangement, Detail panel, player and export.
import { newSong, validateSong, clipEnd, splitClip, uniqueId, sanitizeStemName, STEM_EXTENSIONS, LIMITS } from '/shared/song.js';
import { buildGrid } from '/shared/grid.js';
import { buildSchedule } from '/shared/schedule.js';
import { peaks } from '/shared/waveform.js';
import { createHistory } from '/shared/history.js';
import { createControlBar } from './controlbar.js';
import { createBrowser } from './browser.js';
import { createArrangement } from './arrangement.js';
import { createDetail } from './detail.js';
import { createSession } from './session.js';
import { createSetlists } from './setlists.js';
import { Player } from './player.js';
import { exportSong } from './export.js';
import { esc, clock } from './ui.js';

const $ = (id) => document.getElementById(id);
const PEAK_BUCKET = 256; // samples per waveform bucket (~170 per second at 44.1 kHz)
const AUDIO_TRACK_COLORS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const SPLIT_NOTES = {
  select: 'Select an audio clip to split it.',
  outside: 'Place the insert marker inside the clip to split it.',
  loading: 'The audio is still loading; try again in a moment.',
  unreadable: "This clip's audio could not be read.",
};

const catalogRes = await fetch('/samples/catalog.json').catch(() => null);
if (!catalogRes?.ok) {
  $('app').hidden = true;
  $('setup').hidden = false;
} else {
  await start(await catalogRes.json());
}

async function start(catalog) {
  let song = null;
  let savedJson = null; // JSON of the song as opened or last saved
  let isNew = false; // never saved
  let songs = [];
  let selection = null; // { kind: 'track'|'clip'|'cue'|'locator'|'tempo'|'meter', ref } or null (the song)
  let cursor = [1, 1, 1]; // insert marker [bar, beat, sixteenth]: where new things go and Play starts
  let view = 'arrangement'; // or 'session' (Tab switches)
  let position = null; // last playback position
  let fitPending = false; // zoom-to-fit the arrangement once it is visible
  let solo = new Set(); // soloed track ids; rehearsal only, never saved
  const history = createHistory();
  const clipSeconds = new Map(); // "songId/file" -> decoded audio length in seconds (see growToFitAudio)
  const measuring = new Set(); // keys of clipSeconds being decoded
  let loop = null; // loop brace { startBar, endBar } or null
  let loopOn = false;
  let grid = null; // last grid that could be built (kept while tempo/meter fields are being fixed)
  let errors = [];
  let warnings = [];
  let busy = ''; // 'uploading' | 'exporting' | 'duplicating' | ''
  let note = '';
  let settings = null;
  let extraMessages = []; // import/export/load problems shown until the next song is opened
  const waveforms = new Map(); // "<song id>/<file>" -> { peaks, sampleRate, duration } | 'loading' | 'failed'

  const player = new Player({
    onPosition: (pos) => {
      position = pos;
      arrangement.setPlayhead(pos ? pos.songSec : null, view === 'arrangement');
      session.setPosition(pos);
      showPosition(pos);
    },
    onStateChange: (playing) => {
      controlbar.setPlaying(playing);
      setlists.render(); // songs can only be switched while stopped
      if (!playing) setNote('');
    },
    onLoopReleased: () => {
      loopOn = false;
      controlbar.setLoop(false);
      render();
    },
  });
  const controlbar = createControlBar($('controlbar'), {
    onTempo: (bpm) => {
      song.tempo[0].bpm = bpm;
      changed({ structural: selection?.kind === 'tempo', mergeKey: 'tempo.0.bpm' });
    },
    onMeter: (beats, unit) => {
      Object.assign(song.meter[0], { beats, unit });
      changed({ structural: selection?.kind === 'meter' });
    },
    onPlay: togglePlay,
    onView: setView,
    onLoop: () => {
      loopOn = !loopOn;
      if (loopOn && !loop) loop = defaultLoop();
      applyLoop();
    },
    onGrid: (value) => arrangement.setGrid(value),
    onZoom: (factor) => arrangement.zoom(factor),
    onImport: () => $('import-files').click(),
    onExport: exportWav,
    onSave: save,
  });
  const browser = createBrowser($('browser'), {
    catalog,
    onOpenSong: (id) => {
      if (id !== song.id) whenSaved(async () => open(await api('GET', `/api/songs/${id}`), true));
    },
    onNewSong: () => whenSaved(() => open(newSong(), false)),
    onDuplicateSong: (id) => whenSaved(() => duplicate(id)),
    onDeleteSong: deleteSong,
    onAddCue: ({ type, key }) => {
      const clip = { at: [...cursor], type, key };
      cuesTrack().clips.push(clip);
      select({ kind: 'cue', ref: clip });
    },
  });
  const arrangement = createArrangement($('arrangement'), {
    onSelect: select,
    onCursor: (at) => {
      cursor = at;
      render();
    },
    onTrackChange: trackChanged,
    onSolo: toggleSolo,
    onDropFiles: (files, track) => importAudio(files, track),
    onMasterChange: (key, db) => {
      settings.mix[key] = db;
      player.setMix({ [key]: db });
      saveSettingsSoon();
    },
    onAdd: (kind) => addAt(kind, cursor[0]),
    onAddAt: (kind, bar) => {
      cursor = [bar, 1, 1];
      addAt(kind, bar);
    },
    onMove: moveItem,
    clipFits,
    onDropCue: (cue, at) => {
      const clip = { at, type: cue.type, key: cue.key };
      cuesTrack().clips.push(clip);
      select({ kind: 'cue', ref: clip });
    },
    onLoopRange: (range) => {
      loop = range;
      applyLoop();
    },
    getPeaks: waveformFor,
    unreadable,
  });
  const session = createSession($('session'), {
    onLaunch: launch,
    onTrackChange: trackChanged,
    onSolo: toggleSolo,
    onMasterChange: (key, db) => {
      settings.mix[key] = db;
      player.setMix({ [key]: db });
      saveSettingsSoon();
    },
    onSelect: select,
    getPeaks: waveformFor,
  });
  const setlists = createSetlists(browser.setlistsEl, {
    api,
    getSongs: () => songs,
    getOpenSong: () => ({ id: song.id, saved: !isNew }),
    isPlaying: () => player.playing,
    onOpenSong: (id) => {
      if (id !== song.id) whenSaved(async () => open(await api('GET', `/api/songs/${id}`), true));
    },
    showMessage: (text) => showStatusMessages([text]),
  });
  const detail = createDetail($('detail'), {
    catalog,
    onChange: (path, { structural }) => {
      const track = path.match(/^tracks\.(\d+)\.(volumeDb|muted|output)$/);
      if (track) player.setTrack(song.tracks[Number(track[1])]);
      // no growing while the end bar is being typed, or "5" on the way to "50" would jump
      changed({ structural, live: Boolean(track), mergeKey: structural ? undefined : path, fit: path !== 'endBar' });
    },
    onDelete: deleteSelection,
  });

  settings = await api('GET', '/api/settings');
  player.setMix(settings.mix);
  songs = await api('GET', '/api/songs');
  open(songs[0] ? await api('GET', `/api/songs/${songs[0].id}`) : newSong(), Boolean(songs[0]));
  await setlists.enter();

  $('import-files').accept = STEM_EXTENSIONS.map((e) => `.${e}`).join(',');
  $('import-files').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) importAudio(files);
  });
  $('statusbar').addEventListener('click', (e) => {
    const i = e.target.closest('[data-error]')?.dataset.error;
    if (i !== undefined) select(itemOfPath(errors[Number(i)].path));
    if (e.target.closest('[data-action="toggle-messages"]')) $('statusbar').classList.toggle('open');
  });
  // Cmd/Ctrl+S save · Cmd/Ctrl+Z undo · Cmd/Ctrl+Shift+Z (or Ctrl+Y) redo · Cmd/Ctrl+E split the
  // selected audio clip at the insert marker. In a text field the browser's own text undo applies.
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    const typing = e.target.closest?.('input[type="text"], input[type="number"], textarea');
    if (key === 's') {
      e.preventDefault();
      document.activeElement?.blur?.(); // apply a field that commits when you leave it
      save();
    } else if ((key === 'z' && e.shiftKey) || (key === 'y' && !e.shiftKey)) {
      if (typing) return;
      e.preventDefault();
      restore(history.redo());
    } else if (key === 'z') {
      if (typing) return;
      e.preventDefault();
      restore(history.undo());
    } else if (key === 'e') {
      if (typing) return;
      e.preventDefault();
      splitSelection();
    }
  });
  // Dropping a file anywhere else must not make the browser open it (and leave the app).
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (e) => {
      if (e.dataTransfer?.types.includes('Files') && !e.defaultPrevented) e.preventDefault();
    });
  }
  // Space play/stop · Tab Arrangement/Session · 1–9 launch section · L loop the section heard ·
  // ←/→ previous/next setlist song (stopped) · Delete removes the selection · Esc selects the song ·
  // +/− zoom · F full screen
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, select, textarea')) return;
    const digit = e.code.match(/^(?:Digit|Numpad)([1-9])$/);
    if (e.key === 'Tab' && !e.shiftKey) setView(view === 'arrangement' ? 'session' : 'arrangement');
    else if (digit) launch(Number(digit[1]) - 1);
    else if (e.code === 'KeyL') toggleSectionLoop();
    else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') setlists.step(e.code === 'ArrowLeft' ? -1 : 1);
    else if (e.code === 'Space' && !e.target.closest?.('button')) togglePlay();
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection();
    else if (e.key === 'Escape') select(null);
    else if (e.key === '+' || e.key === '=') arrangement.zoom(1.5);
    else if (e.key === '-') arrangement.zoom(1 / 1.5);
    else if (e.code === 'KeyF') controlbar.toggleFullscreen();
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
    selection = null;
    cursor = [1, 1, 1];
    loop = null;
    loopOn = false;
    player.setLoop(null);
    controlbar.setLoop(false);
    solo = new Set();
    player.setSolo(solo);
    history.reset(snapshotOf(song));
    grid = null;
    extraMessages = [];
    setNote('');
    changed({ structural: true });
    if (view === 'arrangement') arrangement.fit();
    else fitPending = true;
    browser.renderSongs(songs, song.id);
    setlists.render();
  }

  function setView(next) {
    view = next;
    $('arrangement').hidden = view !== 'arrangement';
    $('session').hidden = view !== 'session';
    controlbar.setView(view);
    render();
    if (view === 'arrangement' && fitPending) {
      fitPending = false;
      arrangement.fit();
    }
    session.setPosition(position);
  }

  // Locator sections of the song being edited, as the engine builds them.
  function sections() {
    const bars = [...song.locators].filter((l) => l.bar <= grid.bars.length).sort((a, b) => a.bar - b.bar);
    return bars.map((l, i) => ({ name: l.name, startBar: l.bar, endBar: (bars[i + 1]?.bar ?? grid.bars.length + 1) - 1 }));
  }

  // Launch section `index`: jump there at the next bar line while playing, else start there.
  function launch(index) {
    if (player.playing) return player.jump(index);
    const target = sections()[index];
    if (target) startPlayback([target.startBar, 1, 1]);
  }

  // L: loop the section being heard (or at the start bar when stopped); L again releases it.
  function toggleSectionLoop() {
    if (loopOn) {
      loopOn = false;
    } else {
      const bar = player.playing && position ? position.bar : cursor[0];
      loop = sectionOf(bar) ?? defaultLoop();
      loopOn = true;
    }
    applyLoop();
  }

  /**
   * Call after every edit. `structural` re-renders the Detail panel; `live` marks changes the
   * player applies at once (volume, mute, output), so no "press Play again" note is needed.
   */
  function changed({ structural = false, live = false, mergeKey, fit = true } = {}) {
    if (selection && !contains(selection)) selection = null;
    if (fit) growToFitAudio();
    history.push(snapshotOf(song), { mergeKey });
    errors = validateSong(song);
    try {
      grid = buildGrid(song);
    } catch {
      // keep drawing the last good grid while a tempo or meter field is being fixed
    }
    grid ??= buildGrid(newSong());
    cursor = clampCursor(cursor);
    if (loop && loop.endBar > grid.bars.length) {
      loop = null;
      if (loopOn) applyLoop();
    }
    warnings = errors.length ? [] : buildSchedule(song, catalog).warnings;
    if (structural) detail.show(song, selection);
    detail.showErrors(errors);
    browser.renderCues(cuesTrack()?.language ?? 'en');
    if (player.playing && !live) note = 'Changes apply the next time you press Play.';
    else if (!errors.length && note.startsWith('Fix the problems')) note = '';
    render();
  }

  function render() {
    arrangement.render({ song, grid, selection, invalid: invalidItems(), cursor, mix: settings.mix, loop, loopOn, solo });
    if (view === 'session') session.render({ song, grid, sections: sections(), selection, mix: settings.mix, solo });
    controlbar.render(song);
    if (!player.playing) showPosition(null);
    const dirty = isNew || isDirty();
    controlbar.setSaveState(isNew ? 'Not saved yet' : dirty ? 'Unsaved changes' : 'Saved', dirty);
    const exportBlocked = isNew || isDirty() || busy === 'uploading';
    controlbar.setButtons({
      save: busy !== 'uploading',
      import: !busy,
      importTitle: 'Add audio files as new tracks (WAV, MP3, M4A, FLAC or OGG)',
      exportEnabled: !busy && !exportBlocked,
      exportTitle: exportBlocked ? 'Save the song first; the export uses the saved version.'
        : 'Save a stereo WAV: left = in-ears, right = main',
    });
    renderStatus();
  }

  // Volume, mute or output from a mixer: heard at once; a fader drag is one undo step.
  function trackChanged(track, field) {
    player.setTrack(track);
    changed({ live: true, structural: selection?.ref === track, mergeKey: field === 'volumeDb' ? `${track.id}.volumeDb` : undefined });
  }

  // Plain click: solo just this track (again: no solo). Cmd/Ctrl-click: add or remove it.
  function toggleSolo(track, additive) {
    if (additive) {
      solo = new Set(solo);
      if (solo.has(track.id)) solo.delete(track.id);
      else solo.add(track.id);
    } else {
      solo = solo.size === 1 && solo.has(track.id) ? new Set() : new Set([track.id]);
    }
    player.setSolo(solo);
    render();
  }

  // Undo history holds the song without its id: saving a new song gives it an id, which is not an
  // edit, and undo must never take it away (the next save would create a second song).
  function snapshotOf(s) {
    return JSON.stringify({ ...s, id: '' });
  }

  // Undo/redo: put a snapshot back under the song's current id.
  function restore(snapshot) {
    if (snapshot === null) return;
    const { id } = song;
    song = { ...JSON.parse(snapshot), id };
    selection = null;
    for (const t of song.tracks) player.setTrack(t);
    solo = new Set([...solo].filter((tid) => song.tracks.some((t) => t.id === tid)));
    player.setSolo(solo);
    changed({ structural: true, fit: false }); // growing here would record a new step and drop the redos
  }

  function select(next) {
    selection = next;
    if (next?.kind === 'locator') loop = sectionOf(next.ref.bar) ?? loop; // the brace follows the locator
    if (loopOn) player.setLoop(loop);
    changed({ structural: true, live: true });
  }

  // The locator section containing `bar`, or null before the first locator.
  function sectionOf(bar) {
    const found = sections().findLast((sec) => sec.startBar <= bar);
    return found ? { startBar: found.startBar, endBar: found.endBar } : null;
  }

  // Loop brace when Loop is switched on without one: the section at the insert marker, else 4 bars.
  function defaultLoop() {
    const bar = cursor[0];
    return sectionOf(bar) ?? { startBar: bar, endBar: Math.min(bar + 3, grid.bars.length) };
  }

  function applyLoop() {
    controlbar.setLoop(loopOn);
    player.setLoop(loopOn ? loop : null);
    render();
  }

  // A finished drag in the arrangement: one edit. Refused when it would put two locators or two
  // markers of a kind on the same bar, or an audio clip over another clip on its track.
  function moveItem(kind, ref, value) {
    if (kind === 'cue') {
      ref.at = value;
    } else if (kind === 'clip') {
      if (!clipFits(ref, value)) {
        setNote('That would overlap another clip on the track.');
        return render();
      }
      // Only the last clip on a track may run to the end of its file (see validateSong).
      const fileSec = fileSeconds(ref.file);
      if (ref.lengthSec === null && fileSec !== null && trackOfClip(ref).clips.length > 1) {
        ref.lengthSec = fileSec - ref.offsetSec;
      }
      ref.startSec = value;
    } else {
      const list = kind === 'locator' ? song.locators : song[kind];
      if (list.some((m) => m !== ref && m.bar === value)) {
        setNote(`There is already a ${kind === 'locator' ? 'locator' : `${kind} marker`} at bar ${value}.`);
        return render();
      }
      ref.bar = value;
      if (kind !== 'locator') list.sort((a, b) => a.bar - b.bar);
    }
    select({ kind, ref });
  }

  // Cmd/Ctrl+E: cuts the selected audio clip in two at the insert marker (one undo step) and selects
  // the right-hand piece. When it can't, the song is unchanged and the status bar says why.
  function splitSelection() {
    if (selection?.kind !== 'clip') return setNote(SPLIT_NOTES.select);
    const clip = selection.ref;
    const result = splitClip(clip, grid.secAt(cursor), fileSeconds(clip.file));
    if (result.reason === 'outside') return setNote(SPLIT_NOTES.outside);
    if (result.reason === 'unknown-length') {
      return setNote(unreadable(clip.file) ? SPLIT_NOTES.unreadable : SPLIT_NOTES.loading);
    }
    const { clips } = trackOfClip(clip);
    clips.splice(clips.indexOf(clip), 1, result.left, result.right);
    if (Object.values(SPLIT_NOTES).includes(note)) note = '';
    select({ kind: 'clip', ref: result.right });
  }

  function contains({ kind, ref }) {
    if (kind === 'track') return song.tracks.includes(ref);
    if (kind === 'clip') return Boolean(trackOfClip(ref));
    if (kind === 'cue') return Boolean(cuesTrack()?.clips.includes(ref));
    if (kind === 'locator') return song.locators.includes(ref);
    return song[kind].includes(ref);
  }

  function cuesTrack() {
    return song.tracks.find((t) => t.type === 'cues');
  }

  function trackOfClip(clip) {
    return song.tracks.find((t) => t.type === 'audio' && t.clips.includes(clip));
  }

  // Decoded length of an uploaded file in seconds, null until known (or if it can't be read).
  function fileSeconds(file) {
    const sec = clipSeconds.get(`${song.id}/${file}`) ?? waveforms.get(`${song.id}/${file}`)?.duration;
    return sec > 0 ? sec : null;
  }

  // Whether audio clip `clip` placed at `startSec` stays clear of the other clips on its track
  // (ends may touch). A clip whose end is unknown is treated as running on forever.
  function clipFits(clip, startSec) {
    const track = trackOfClip(clip);
    if (!track) return false;
    const endOf = (c, start) => clipEnd({ ...c, startSec: start }, fileSeconds(c.file)) ?? Infinity;
    const end = endOf(clip, startSec);
    return track.clips.every((other) => other === clip
      || endOf(other, other.startSec) <= startSec + 1e-6 || end <= other.startSec + 1e-6);
  }

  // The insert marker kept inside the song after the end bar or a time signature changed.
  function clampCursor([bar, beat, sixteenth]) {
    if (bar > grid.bars.length) return [grid.bars.length, 1, 1];
    const b = grid.bars[bar - 1];
    return beat > b.beats || sixteenth > 16 / b.unit ? [bar, 1, 1] : [bar, beat, sixteenth];
  }

  // Adds a locator or marker at `barNumber`, or selects the one already there. A marker copies the
  // tempo or time signature in effect there.
  function addAt(kind, barNumber) {
    const list = kind === 'locator' ? song.locators : song[kind];
    let item = list.find((m) => m.bar === barNumber);
    if (!item) {
      const bar = grid.bars[barNumber - 1];
      item = kind === 'locator' ? { bar: barNumber, name: 'Section' }
        : kind === 'tempo' ? { bar: barNumber, bpm: bar.bpm }
          : { bar: barNumber, beats: bar.beats, unit: bar.unit };
      list.push(item);
      if (kind !== 'locator') list.sort((a, b) => a.bar - b.bar);
    }
    select({ kind, ref: item });
    if (kind === 'locator') detail.focus('name');
  }

  function deleteSelection() {
    if (!selection) return;
    const { kind, ref } = selection;
    if (kind === 'track') {
      if (ref.type !== 'audio') return;
      song.tracks.splice(song.tracks.indexOf(ref), 1);
    } else if (kind === 'clip') {
      const { clips } = trackOfClip(ref);
      clips.splice(clips.indexOf(ref), 1);
    } else if (kind === 'cue') {
      cuesTrack().clips.splice(cuesTrack().clips.indexOf(ref), 1);
    } else {
      const list = kind === 'locator' ? song.locators : song[kind];
      if (kind !== 'locator' && list.indexOf(ref) === 0) return; // bar-1 markers stay
      list.splice(list.indexOf(ref), 1);
    }
    selection = null;
    changed({ structural: true });
  }

  // Validation errors point at items by path; outline those items in the arrangement.
  function invalidItems() {
    return new Set(errors.map((e) => itemOfPath(e.path)?.ref).filter(Boolean));
  }

  function itemOfPath(path) {
    let m = path.match(/^tracks\[(\d+)\]\.clips\[(\d+)\]/);
    if (m) return { kind: song.tracks[m[1]]?.type === 'audio' ? 'clip' : 'cue', ref: song.tracks[m[1]]?.clips?.[m[2]] };
    m = path.match(/^tracks\[(\d+)\]/);
    if (m) return { kind: 'track', ref: song.tracks[m[1]] };
    m = path.match(/^(locators|tempo|meter)\[(\d+)\]/);
    if (m) return { kind: m[1] === 'locators' ? 'locator' : m[1], ref: song[m[1]][m[2]] };
    return null;
  }

  function waveformFor(file) {
    const key = `${song.id}/${file}`;
    const known = waveforms.get(key);
    if (known && typeof known === 'object') return known;
    if (!known && song.id) {
      waveforms.set(key, 'loading');
      player.audioBuffer(song.id, file).then((buffer) => {
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
        waveforms.set(key, { peaks: peaks(channels, PEAK_BUCKET), sampleRate: buffer.sampleRate, duration: buffer.duration });
        if (song.id && key.startsWith(`${song.id}/`)) render();
      }, () => {
        waveforms.set(key, 'failed');
        if (song.id && key.startsWith(`${song.id}/`)) render(); // the lane stops saying "loading…"
      });
    }
    return null;
  }

  // Whether an uploaded file turned out not to be decodable audio.
  function unreadable(file) {
    const key = `${song.id}/${file}`;
    return clipSeconds.get(key) === 0 || waveforms.get(key) === 'failed';
  }

  // Uploads the files one at a time and adds an audio track for each, clip at 0 s. The first file
  // goes into `target` instead when it is an audio track without clips. A song that was never
  // saved is saved first (its folder must exist to hold the files).
  async function importAudio(files, target = null) {
    if (isNew && !(await save())) {
      setNote('Fix the problems in the song before importing audio.');
      return;
    }
    busy = 'uploading';
    player.stop();
    render();
    const added = [];
    const failed = [];
    for (const [i, file] of files.entries()) {
      setNote(`Uploading ${file.name} (${i + 1} of ${files.length})…`);
      try {
        if (!sanitizeStemName(file.name)) throw new Error('unsupported file; use WAV, MP3, M4A, FLAC or OGG');
        const res = await fetch(`/api/songs/${song.id}/stems`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
          body: file,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        if (target && !target.clips.length && song.tracks.includes(target)) {
          target.clips.push(wholeFile(data.file));
          added.push(target);
          target = null;
        } else {
          added.push(addAudioTrack(data.file));
        }
      } catch (err) {
        failed.push(`Not added: ${file.name}: ${err.message}`);
      }
    }
    busy = '';
    setNote(added.length ? `Added ${added.length} audio track${added.length > 1 ? 's' : ''}. Press Save to keep ${added.length > 1 ? 'them' : 'it'}.` : '');
    if (added.length) selection = { kind: 'track', ref: added.at(-1) };
    changed({ structural: true });
    if (failed.length) showStatusMessages(failed);
  }

  function addAudioTrack(file) {
    const audio = song.tracks.filter((t) => t.type === 'audio');
    const n = Math.max(0, ...audio.map((t) => Number(t.id.slice(1)))) + 1;
    const track = {
      id: `a${n}`, type: 'audio', name: file.replace(/\.[^.]+$/, '').slice(0, LIMITS.nameLength).trim() || `Audio ${n}`,
      color: AUDIO_TRACK_COLORS[audio.length % AUDIO_TRACK_COLORS.length], volumeDb: 0, muted: false, output: 'both',
      clips: [wholeFile(file)],
    };
    song.tracks.push(track);
    return track;
  }

  function wholeFile(file) {
    return { file, startSec: 0, offsetSec: 0, lengthSec: null };
  }

  // Raises the song end so every audio clip ends inside the song (never lowers it). Runs on every
  // edit, so a faster tempo, a shorter meter or a clip moved later cannot cut the audio off. A clip
  // that runs to the end of its file needs the decoded audio; until then it is fitted when it arrives.
  function growToFitAudio() {
    if (validateSong(song).length) return; // e.g. a tempo being typed: fit once it is valid
    const g = buildGrid(song);
    let audioEnd = 0;
    for (const track of song.tracks) {
      if (track.type !== 'audio') continue;
      for (const clip of track.clips) {
        const end = clipEnd(clip, fileSeconds(clip.file));
        if (end !== null) audioEnd = Math.max(audioEnd, end);
        else if (!clipSeconds.has(`${song.id}/${clip.file}`)) measureClip(clip.file, track);
      }
    }
    if (g.endSec >= audioEnd) return;
    const last = g.bars.at(-1);
    song.endBar = Math.min(LIMITS.endBar[1], song.endBar + Math.ceil((audioEnd - g.endSec - 1e-9) / last.sec));
  }

  async function measureClip(file, track) {
    const key = `${song.id}/${file}`;
    if (measuring.has(key)) return;
    measuring.add(key);
    try {
      const buffer = await player.audioBuffer(song.id, file);
      clipSeconds.set(key, buffer.duration);
      const endBar = song.endBar;
      if (song.tracks.includes(track)) growToFitAudio();
      if (song.endBar !== endBar) changed({ structural: !selection });
    } catch (err) {
      clipSeconds.set(key, 0); // do not retry (and repeat the message) on every edit
      if (song.tracks.includes(track)) {
        showStatusMessages([`Audio "${track.name}" could not be read (${err.message || 'unsupported audio'}).`]);
      }
    } finally {
      measuring.delete(key);
    }
  }

  function togglePlay() {
    if (player.playing) return player.stop();
    return startPlayback(cursor);
  }

  /** @param {[number, number, number]} at where to start: the insert marker or a locator */
  async function startPlayback(at) {
    if (errors.length) {
      setNote('Fix the problems in the song before playing.');
      return;
    }
    setNote('Loading…');
    try {
      const loadWarnings = await player.load(song, catalog);
      warnings = loadWarnings;
      setNote('');
      renderStatus();
      const bar = grid.bars[at[0] - 1];
      await player.play({ fromBar: at[0], offsetSec: grid.secAt(at) - bar.startSec });
    } catch (err) {
      setNote(`Could not start playback: ${err.message}`);
    }
  }

  // Renders the saved song to exports/<title>.wav and also downloads it.
  async function exportWav() {
    player.stop();
    busy = 'exporting';
    render();
    setNote('Rendering WAV…');
    try {
      const result = await exportSong(song, catalog);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([result.bytes], { type: 'audio/wav' }));
      link.download = result.file;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
      setNote(`Exported ${result.file} (${clock(result.seconds)}) to ${result.folder}.`);
      if (result.warnings.length) showStatusMessages(result.warnings);
    } catch (err) {
      setNote(`Export failed: ${err.message}`);
    } finally {
      busy = '';
      render();
    }
  }

  async function save() {
    if (errors.length) {
      setNote('Fix the problems in the song before saving.');
      return false;
    }
    if (!song.id) song.id = uniqueId(song.title, songs.map((s) => s.id));
    try {
      await api('PUT', `/api/songs/${song.id}`, song);
    } catch (err) {
      setNote(`Save failed: ${err.message}`);
      return false;
    }
    savedJson = JSON.stringify(song);
    isNew = false;
    note = '';
    songs = await api('GET', '/api/songs');
    browser.renderSongs(songs, song.id);
    setlists.render();
    render();
    return true;
  }

  // Copies a saved song, audio files included, as "<title> copy" and opens the copy.
  async function duplicate(id) {
    if (busy) return setNote('Wait for the import, export or copy in progress to finish.');
    busy = 'duplicating';
    render();
    setNote('Duplicating…');
    const shown = song;
    const shownJson = JSON.stringify(song);
    try {
      const copy = await api('POST', `/api/songs/${id}/copy`);
      songs = await api('GET', '/api/songs');
      if (song !== shown || JSON.stringify(song) !== shownJson) {
        // edited (or another song opened) while the audio was being copied: leave that on screen
        browser.renderSongs(songs, song.id);
        setNote(`Duplicated as “${copy.title}”; open it from the Songs list.`);
      } else {
        open(copy, true);
        setNote(`Duplicated as “${copy.title}”.`);
      }
    } catch (err) {
      setNote(`Duplicate failed: ${err.message}`);
    } finally {
      busy = '';
      render();
    }
  }

  // Deletes a saved song and its audio files for good (the Browser asks "Really delete?" first).
  // When it was the open song, the first song left opens (or a new one).
  async function deleteSong(id) {
    if (busy) return setNote('Wait for the import, export or copy in progress to finish.');
    const title = songs.find((s) => s.id === id)?.title ?? id;
    try {
      await api('DELETE', `/api/songs/${id}`);
      songs = await api('GET', '/api/songs');
      for (const cache of [waveforms, clipSeconds]) {
        for (const key of cache.keys()) if (key.startsWith(`${id}/`)) cache.delete(key);
      }
      if (id === song.id) open(songs[0] ? await api('GET', `/api/songs/${songs[0].id}`) : newSong(), Boolean(songs[0]));
      else {
        browser.renderSongs(songs, song.id);
        setlists.render();
      }
      setNote(`Deleted “${title}”.`);
    } catch (err) {
      setNote(`Delete failed: ${err.message}`);
    }
  }

  let settingsTimer;
  function saveSettingsSoon() {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => api('PUT', '/api/settings', settings).catch(() => {}), 400);
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

  function showPosition(pos) {
    if (pos) return controlbar.setPosition(pos, pos.songSec);
    const [bar, beat, sixteenth] = cursor;
    controlbar.setPosition({ bar, beat, sixteenth }, grid.secAt(cursor));
    arrangement.setPlayhead(null);
  }

  function setNote(text) {
    note = text;
    renderStatus();
  }

  function showStatusMessages(list) {
    extraMessages = list;
    renderStatus();
  }

  // Status bar: the latest note, then problems (click one to select its item) and heads-ups.
  function renderStatus() {
    const bar = $('statusbar');
    const heads = [...warnings, ...extraMessages];
    const count = errors.length + heads.length;
    bar.innerHTML = `
      <span class="status-note">${esc(note)}</span>
      ${errors.length ? `<button type="button" class="status-problem" data-error="0">⚠ ${esc(errors[0].message)}</button>` : ''}
      ${count ? `<button type="button" class="status-count" data-action="toggle-messages">${errors.length ? `${errors.length} problem${errors.length > 1 ? 's' : ''}` : ''}${errors.length && heads.length ? ' · ' : ''}${heads.length ? `${heads.length} heads-up` : ''}</button>` : ''}
      <div class="status-messages">
        ${errors.length ? `<h2>Problems</h2><ul>${errors.map((e, i) => `<li><button type="button" data-error="${i}">${esc(e.message)}</button></li>`).join('')}</ul>` : ''}
        ${heads.length ? `<h2>Heads up</h2><ul>${heads.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      </div>`;
    if (!count) bar.classList.remove('open');
  }
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
