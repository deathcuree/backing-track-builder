// Song model: defaults, validation and ids. Shared by the editor (inline errors) and the server
// (refuses to save invalid songs). Fallback problems such as missing samples are not errors here;
// buildSchedule reports those as warnings and the song still saves.

export const LANGUAGES = ['en', 'fr', 'pt', 'es'];
export const SUBDIVISIONS = ['quarter', 'eighth', 'sixteenth'];
export const LIMITS = {
  bpm: [40, 240],
  beats: [2, 7],
  denominators: [4, 8],
  countInBars: [0, 1, 2],
  volumeDb: [-60, 6],
  stemOffsetMs: [-2000, 2000],
  maxBars: 999,
};

export function newSong() {
  return {
    version: 1,
    id: '',
    title: 'New song',
    bpm: 120,
    meter: [4, 4],
    click: { sound: 'Classic', subdivision: 'quarter', volumeDb: 0 },
    guide: { language: 'en', volumeDb: 0 },
    countInBars: 1,
    sections: [{ name: 'Intro', bars: 4 }, { name: 'Verse 1', bars: 8 }, { name: 'Chorus', bars: 8 }],
    cues: [],
    stems: [],
    stemOffsetMs: 0,
  };
}

/** @returns {{ path: string, message: string }[]} empty when the song can be saved and played */
export function validateSong(song) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (!song || typeof song !== 'object' || Array.isArray(song)) {
    fail('', 'Song must be an object.');
    return errors;
  }

  if (typeof song.title !== 'string' || !song.title.trim()) fail('title', 'Give the song a title.');
  if (!inRange(song.bpm, LIMITS.bpm)) fail('bpm', `BPM must be between ${LIMITS.bpm[0]} and ${LIMITS.bpm[1]}.`);
  const [beats, unit] = Array.isArray(song.meter) ? song.meter : [];
  if (!Number.isInteger(beats) || !inRange(beats, LIMITS.beats) || !LIMITS.denominators.includes(unit)) {
    fail('meter', 'Time signature must be 2–7 beats over 4 or 8.');
  }
  if (!LIMITS.countInBars.includes(song.countInBars)) fail('countInBars', 'Count-in must be 0, 1 or 2 bars.');

  if (typeof song.click?.sound !== 'string' || !song.click.sound) fail('click.sound', 'Pick a click sound.');
  if (!SUBDIVISIONS.includes(song.click?.subdivision)) fail('click.subdivision', 'Pick quarter, eighth or sixteenth.');
  checkVolume(song.click?.volumeDb, 'click.volumeDb', fail);
  if (!LANGUAGES.includes(song.guide?.language)) fail('guide.language', 'Pick a guide language.');
  checkVolume(song.guide?.volumeDb, 'guide.volumeDb', fail);

  let totalBars = 0;
  if (!Array.isArray(song.sections) || song.sections.length === 0) {
    fail('sections', 'Add at least one section.');
  } else {
    song.sections.forEach((s, i) => {
      if (typeof s?.name !== 'string' || !s.name) fail(`sections[${i}].name`, 'Pick a section name.');
      if (!Number.isInteger(s?.bars) || !inRange(s.bars, [1, LIMITS.maxBars])) {
        fail(`sections[${i}].bars`, `Bars must be a whole number from 1 to ${LIMITS.maxBars}.`);
      } else {
        totalBars += s.bars;
      }
    });
  }

  if (!Array.isArray(song.cues)) {
    fail('cues', 'Cues must be a list.');
  } else {
    song.cues.forEach((c, i) => {
      if (typeof c?.name !== 'string' || !c.name) fail(`cues[${i}].name`, 'Pick a cue.');
      if (!Number.isInteger(c?.bar) || c.bar < 1 || c.bar > totalBars) {
        fail(`cues[${i}].bar`, `Cue bar must be between 1 and ${totalBars} (the song has ${totalBars} bars).`);
      }
    });
  }

  if (!Array.isArray(song.stems)) fail('stems', 'Stems must be a list.');
  if (!inRange(song.stemOffsetMs, LIMITS.stemOffsetMs)) {
    fail('stemOffsetMs', `Stem offset must be between ${LIMITS.stemOffsetMs[0]} and ${LIMITS.stemOffsetMs[1]} ms.`);
  }
  return errors;
}

/** "Él Shaddai (Live)" -> "el-shaddai-live"; always matches the server's id pattern. */
export function slugify(title) {
  const slug = String(title)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'song';
}

export function uniqueId(title, existingIds) {
  const base = slugify(title);
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function inRange(value, [min, max]) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function checkVolume(value, path, fail) {
  if (!inRange(value, LIMITS.volumeDb)) fail(path, `Volume must be between ${LIMITS.volumeDb[0]} and +${LIMITS.volumeDb[1]} dB.`);
}
