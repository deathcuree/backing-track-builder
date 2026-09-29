// Song model, version 2: tracks, clips, locators and tempo/meter markers placed by hand, as in
// Ableton's Arrangement View. Defaults and validation are shared by the editor (inline errors) and
// the server (refuses to save invalid songs). Fallback problems such as missing samples are not
// errors here; buildSchedule reports those as warnings and the song still saves.
//
// Positions are [bar, beat, sixteenth] (see shared/grid.js). Audio clips are placed in song seconds
// (bar 1 = 0 s) and are never time-stretched.
import { LANGUAGES, SUBDIVISIONS, sanitizeStemName } from './song.js';

export { ID_RE, LANGUAGES, SUBDIVISIONS, STEM_EXTENSIONS, slugify, uniqueId, sanitizeStemName } from './song.js';

export const OUTPUTS = ['inEars', 'main', 'both'];
export const CUE_TYPES = ['section', 'cue', 'count'];
export const METER_UNITS = [4, 8];
export const LIMITS = {
  bpm: [40, 240],
  beats: [1, 16],
  endBar: [1, 999],
  volumeDb: [-60, 6],
  clipStartSec: [-3600, 3600],
  color: [0, 13],
  nameLength: 40,
  locators: 99,
  audioTracks: 32,
  cueClips: 2000,
};

export function newSong() {
  return {
    version: 2,
    id: '',
    title: 'New song',
    endBar: 16,
    tempo: [{ bar: 1, bpm: 120 }],
    meter: [{ bar: 1, beats: 4, unit: 4 }],
    locators: [],
    tracks: [
      { id: 'click', type: 'click', name: 'Click', color: 0, volumeDb: 0, muted: false,
        output: 'inEars', sound: 'Classic', subdivision: 'quarter' },
      { id: 'cues', type: 'cues', name: 'Cues', color: 1, volumeDb: 0, muted: false,
        output: 'inEars', language: 'en', clips: [] },
    ],
  };
}

/** @returns {{ path: string, message: string }[]} empty when the song can be saved and played */
export function validateSong(song) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (!isObject(song)) {
    fail('', 'Song must be an object.');
    return errors;
  }

  if (song.version !== 2) fail('version', 'This song was made with an older version of the app.');
  if (typeof song.title !== 'string' || !song.title.trim()) fail('title', 'Give the song a title.');
  const endBarOk = isInt(song.endBar, LIMITS.endBar);
  if (!endBarOk) fail('endBar', `The song end must be a bar from 1 to ${LIMITS.endBar[1]}.`);
  const lastBar = endBarOk ? song.endBar : LIMITS.endBar[1];
  const inSong = (bar) => isInt(bar, [1, lastBar]);
  const barMessage = `Pick a bar from 1 to ${lastBar}.`;

  checkMarkers(song.tempo, 'tempo', 'tempo', inSong, barMessage, fail, (m, path) => {
    if (!inRange(m.bpm, LIMITS.bpm)) fail(`${path}.bpm`, `BPM must be between ${LIMITS.bpm[0]} and ${LIMITS.bpm[1]}.`);
  });
  const meterOk = checkMarkers(song.meter, 'meter', 'time signature', inSong, barMessage, fail, (m, path) => {
    if (!isInt(m.beats, LIMITS.beats)) fail(`${path}.beats`, `Beats per bar must be ${LIMITS.beats[0]} to ${LIMITS.beats[1]}.`);
    if (!METER_UNITS.includes(m.unit)) fail(`${path}.unit`, 'The beat unit must be 4 or 8.');
  });

  if (!Array.isArray(song.locators)) {
    fail('locators', 'Locators must be a list.');
  } else {
    if (song.locators.length > LIMITS.locators) fail('locators', `A song can have up to ${LIMITS.locators} locators.`);
    const bars = new Set();
    song.locators.forEach((l, i) => {
      const path = `locators[${i}]`;
      if (!isObject(l)) return fail(path, 'Locator must be an object.');
      if (!inSong(l.bar)) fail(`${path}.bar`, barMessage);
      else if (bars.has(l.bar)) fail(`${path}.bar`, `There is already a locator at bar ${l.bar}.`);
      bars.add(l.bar);
      if (!isName(l.name)) fail(`${path}.name`, `Give the locator a name of up to ${LIMITS.nameLength} characters.`);
    });
  }

  const meterAt = meterOk ? meterLookup(song.meter) : null;
  const checkAt = (at, path) => {
    if (!Array.isArray(at) || at.length !== 3 || !at.every(Number.isInteger)) {
      return fail(path, 'Position must be bar, beat and sixteenth.');
    }
    const [bar, beat, sixteenth] = at;
    if (!inSong(bar)) return fail(path, `Bar ${bar} is outside the song (bars 1–${lastBar}).`);
    if (!meterAt) return;
    const { beats, unit } = meterAt(bar);
    if (beat < 1 || beat > beats) return fail(path, `Bar ${bar} has ${beats} beats; beat ${beat} doesn't exist.`);
    const perBeat = 16 / unit;
    if (sixteenth < 1 || sixteenth > perBeat) fail(path, `A beat in ${beats}/${unit} has ${perBeat} sixteenths.`);
  };

  if (!Array.isArray(song.tracks)) {
    fail('tracks', 'Tracks must be a list.');
    return errors;
  }
  const ids = new Set();
  const files = new Set();
  const count = { click: 0, cues: 0, audio: 0 };
  song.tracks.forEach((t, i) => {
    const path = `tracks[${i}]`;
    if (!isObject(t)) return fail(path, 'Track must be an object.');
    if (!(t.type in count)) return fail(`${path}.type`, 'Track type must be click, cues or audio.');
    count[t.type]++;
    const idOk = t.type === 'audio' ? /^a\d{1,6}$/.test(t.id) : t.id === t.type;
    if (!idOk || ids.has(t.id)) fail(`${path}.id`, 'Track id is not valid or is used twice.');
    ids.add(t.id);
    if (!isName(t.name)) fail(`${path}.name`, `Give the track a name of up to ${LIMITS.nameLength} characters.`);
    if (!isInt(t.color, LIMITS.color)) fail(`${path}.color`, 'Pick a track color.');
    if (!inRange(t.volumeDb, LIMITS.volumeDb)) {
      fail(`${path}.volumeDb`, `Volume must be between ${LIMITS.volumeDb[0]} and +${LIMITS.volumeDb[1]} dB.`);
    }
    if (typeof t.muted !== 'boolean') fail(`${path}.muted`, 'Mute must be on or off.');
    if (!OUTPUTS.includes(t.output)) fail(`${path}.output`, 'Output must be In-ears, Main or Both.');

    if (t.type === 'click') {
      if (typeof t.sound !== 'string' || !t.sound) fail(`${path}.sound`, 'Pick a click sound.');
      if (!SUBDIVISIONS.includes(t.subdivision)) fail(`${path}.subdivision`, 'Pick quarter, eighth or sixteenth.');
    } else if (t.type === 'cues') {
      if (!LANGUAGES.includes(t.language)) fail(`${path}.language`, 'Pick a guide language.');
      if (!Array.isArray(t.clips) || t.clips.length > LIMITS.cueClips) {
        fail(`${path}.clips`, `A cues track holds up to ${LIMITS.cueClips} cues.`);
      } else {
        t.clips.forEach((c, j) => {
          const cp = `${path}.clips[${j}]`;
          if (!isObject(c)) return fail(cp, 'Cue must be an object.');
          checkAt(c.at, `${cp}.at`);
          if (!CUE_TYPES.includes(c.type)) fail(`${cp}.type`, 'Cue type must be section, cue or count.');
          if (typeof c.key !== 'string' || !c.key) fail(`${cp}.key`, 'Pick a cue.');
        });
      }
    } else if (t.clip !== null) {
      if (!isObject(t.clip)) return fail(`${path}.clip`, 'Audio clip must be empty or an object.');
      const { file, startSec } = t.clip;
      if (typeof file !== 'string' || sanitizeStemName(file) !== file || files.has(file)) {
        fail(`${path}.clip.file`, 'Audio file name is not valid or is used twice.');
      }
      files.add(file);
      if (!inRange(startSec, LIMITS.clipStartSec)) {
        fail(`${path}.clip.startSec`, `Clip start must be within ${LIMITS.clipStartSec[1]} seconds of bar 1.`);
      }
    }
  });
  if (count.click !== 1 || count.cues !== 1) fail('tracks', 'A song needs exactly one Click track and one Cues track.');
  if (count.audio > LIMITS.audioTracks) fail('tracks', `A song can have up to ${LIMITS.audioTracks} audio tracks.`);
  return errors;
}

// Markers: a non-empty list, first at bar 1, strictly increasing bars inside the song.
// Returns whether the bars are usable for building a grid.
function checkMarkers(list, key, label, inSong, barMessage, fail, checkValues) {
  if (!Array.isArray(list) || list.length === 0) {
    fail(key, `Add a ${label} marker at bar 1.`);
    return false;
  }
  let ok = true;
  list.forEach((m, i) => {
    const path = `${key}[${i}]`;
    if (!isObject(m)) {
      ok = false;
      return fail(path, `${label} marker must be an object.`);
    }
    if (i === 0 && m.bar !== 1) {
      ok = false;
      fail(`${path}.bar`, `The first ${label} marker must be at bar 1.`);
    } else if (i > 0 && !inSong(m.bar)) {
      ok = false;
      fail(`${path}.bar`, barMessage);
    } else if (i > 0 && !(m.bar > list[i - 1]?.bar)) {
      ok = false;
      fail(`${path}.bar`, `Each ${label} marker must come after the previous one.`);
    }
    checkValues(m, path);
  });
  return ok;
}

function meterLookup(meter) {
  return (bar) => meter.findLast((m) => m.bar <= bar);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isName(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= LIMITS.nameLength;
}

function isInt(value, [min, max]) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function inRange(value, [min, max]) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
