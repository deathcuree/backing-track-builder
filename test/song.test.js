import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newSong, validateSong, LIMITS, OUTPUTS, slugify, uniqueId, sanitizeStemName } from '../shared/song.js';

function valid() {
  const s = newSong();
  s.id = 'el-shaddai';
  s.title = 'El Shaddai';
  s.endBar = 64;
  s.tempo = [{ bar: 1, bpm: 68 }, { bar: 41, bpm: 64 }];
  s.meter = [{ bar: 1, beats: 6, unit: 4 }, { bar: 31, beats: 4, unit: 4 }];
  s.locators = [{ bar: 3, name: 'Intro' }, { bar: 7, name: 'Verse 1' }];
  s.tracks[1].clips = [
    { at: [2, 1, 1], type: 'count', key: '1' },
    { at: [6, 4, 1], type: 'section', key: 'Verse 1' },
  ];
  s.tracks.push({
    id: 'a1', type: 'audio', name: 'El Shaddai', color: 2, volumeDb: 0, muted: false,
    output: 'both', clip: { file: 'El Shaddai.wav', startSec: 3.214 },
  });
  return s;
}

/** Applies `change` to a valid song and returns the error paths. */
function paths(change) {
  const s = valid();
  change(s);
  return validateSong(s).map((e) => e.path);
}

describe('newSong', () => {
  test('is valid and matches the spec defaults', () => {
    const s = newSong();
    assert.deepEqual(validateSong(s), []);
    assert.equal(s.version, 2);
    assert.equal(s.title, 'New song');
    assert.equal(s.endBar, 16);
    assert.deepEqual(s.tempo, [{ bar: 1, bpm: 120 }]);
    assert.deepEqual(s.meter, [{ bar: 1, beats: 4, unit: 4 }]);
    assert.deepEqual(s.locators, []);
    assert.deepEqual(s.tracks.map((t) => [t.id, t.type, t.output]), [['click', 'click', 'inEars'], ['cues', 'cues', 'inEars']]);
    assert.equal(s.tracks[0].sound, 'Classic');
    assert.equal(s.tracks[0].subdivision, 'quarter');
    assert.equal(s.tracks[1].language, 'en');
    assert.deepEqual(s.tracks[1].clips, []);
  });

  test('returns a fresh object each time', () => {
    const a = newSong();
    a.tracks[1].clips.push({ at: [1, 1, 1], type: 'count', key: '1' });
    assert.deepEqual(newSong().tracks[1].clips, []);
  });
});

describe('validateSong', () => {
  test('the spec example song is valid', () => {
    assert.deepEqual(validateSong(valid()), []);
  });

  test('errors have a path and a message', () => {
    const s = valid();
    s.title = '';
    const [e] = validateSong(s);
    assert.equal(e.path, 'title');
    assert.ok(e.message.length > 0);
  });

  test('not an object', () => {
    assert.deepEqual(validateSong(null).map((e) => e.path), ['']);
    assert.deepEqual(validateSong([]).map((e) => e.path), ['']);
  });

  test('version must be 2', () => {
    assert.deepEqual(paths((s) => { s.version = 1; }), ['version']);
  });

  test('title', () => {
    assert.deepEqual(paths((s) => { s.title = '   '; }), ['title']);
  });

  test('endBar is a whole number from 1 to 999', () => {
    assert.deepEqual(paths((s) => { s.endBar = 1000; s.locators = []; s.tracks[1].clips = []; s.tempo.length = 1; s.meter.length = 1; }), ['endBar']);
    assert.deepEqual(paths((s) => { s.endBar = 2.5; }), ['endBar']);
    assert.equal(LIMITS.endBar[1], 999);
  });

  test('tempo markers: bpm range, first at bar 1, sorted and unique, inside the song', () => {
    assert.deepEqual(paths((s) => { s.tempo[1].bpm = 241; }), ['tempo[1].bpm']);
    assert.deepEqual(paths((s) => { s.tempo[1].bpm = 39; }), ['tempo[1].bpm']);
    assert.deepEqual(paths((s) => { s.tempo[0].bar = 2; }), ['tempo[0].bar']);
    assert.deepEqual(paths((s) => { s.tempo[1].bar = 1; }), ['tempo[1].bar']);
    assert.deepEqual(paths((s) => { s.tempo.push({ bar: 20, bpm: 70 }); }), ['tempo[2].bar']);
    assert.deepEqual(paths((s) => { s.tempo[1].bar = 65; }), ['tempo[1].bar']);
    assert.deepEqual(paths((s) => { s.tempo = []; }), ['tempo']);
  });

  test('meter markers: 1–16 beats over 4 or 8, first at bar 1, sorted and unique', () => {
    assert.deepEqual(paths((s) => { s.meter[1].beats = 17; }), ['meter[1].beats']);
    assert.deepEqual(paths((s) => { s.meter[1].beats = 0; }), ['meter[1].beats']);
    assert.deepEqual(paths((s) => { s.meter[1].unit = 16; }), ['meter[1].unit']);
    assert.deepEqual(paths((s) => { s.meter[0].bar = 3; }), ['meter[0].bar']);
    assert.deepEqual(paths((s) => { s.meter.push({ bar: 31, beats: 2, unit: 4 }); }), ['meter[2].bar']);
    assert.deepEqual(paths((s) => { s.meter = 'x'; }), ['meter']);
  });

  test('12/8 and 1/4 are allowed', () => {
    assert.deepEqual(paths((s) => { s.meter[1] = { bar: 31, beats: 12, unit: 8 }; }), []);
    assert.deepEqual(paths((s) => { s.meter[1] = { bar: 31, beats: 1, unit: 4 }; }), []);
  });

  test('locators: bar inside the song, unique bars, a name of 1–40 characters, up to 99', () => {
    assert.deepEqual(paths((s) => { s.locators[1].bar = 65; }), ['locators[1].bar']);
    assert.deepEqual(paths((s) => { s.locators[1].bar = 3; }), ['locators[1].bar']);
    assert.deepEqual(paths((s) => { s.locators[1].name = ''; }), ['locators[1].name']);
    assert.deepEqual(paths((s) => { s.locators[1].name = 'x'.repeat(41); }), ['locators[1].name']);
    assert.deepEqual(paths((s) => { s.locators = Array.from({ length: 100 }, (_, i) => ({ bar: 1, name: `L${i}` })); s.endBar = 999; })
      .filter((p) => p === 'locators'), ['locators']);
  });

  test('locators need not be sorted', () => {
    assert.deepEqual(paths((s) => { s.locators.reverse(); }), []);
  });

  test('exactly one click and one cues track', () => {
    assert.deepEqual(paths((s) => { s.tracks.splice(0, 1); }), ['tracks']);
    assert.deepEqual(paths((s) => { s.tracks.push({ ...s.tracks[1], clips: [] }); }), ['tracks[3].id', 'tracks']);
  });

  test('up to 32 audio tracks', () => {
    assert.deepEqual(paths((s) => {
      for (let i = 2; i <= 33; i++) s.tracks.push({ ...s.tracks[2], id: `a${i}`, clip: null });
    }), ['tracks']);
  });

  test('track ids: click, cues and a<n>, unique', () => {
    assert.deepEqual(paths((s) => { s.tracks[2].id = 'song'; }), ['tracks[2].id']);
    assert.deepEqual(paths((s) => { s.tracks[0].id = 'metronome'; }), ['tracks[0].id']);
    assert.deepEqual(paths((s) => { s.tracks.push({ ...s.tracks[2], clip: null }); }), ['tracks[3].id']);
  });

  test('unknown track type', () => {
    assert.deepEqual(paths((s) => { s.tracks[2].type = 'midi'; }), ['tracks[2].type']);
  });

  test('common track fields: name, color, volume, mute, output', () => {
    assert.deepEqual(paths((s) => { s.tracks[2].name = ''; }), ['tracks[2].name']);
    assert.deepEqual(paths((s) => { s.tracks[2].name = 'x'.repeat(41); }), ['tracks[2].name']);
    assert.deepEqual(paths((s) => { s.tracks[2].color = 14; }), ['tracks[2].color']);
    assert.deepEqual(paths((s) => { s.tracks[0].volumeDb = 7; }), ['tracks[0].volumeDb']);
    assert.deepEqual(paths((s) => { s.tracks[1].volumeDb = -61; }), ['tracks[1].volumeDb']);
    assert.deepEqual(paths((s) => { s.tracks[2].muted = 'no'; }), ['tracks[2].muted']);
    assert.deepEqual(paths((s) => { s.tracks[2].output = 'left'; }), ['tracks[2].output']);
    assert.deepEqual(OUTPUTS, ['inEars', 'main', 'both']);
  });

  test('click track: sound and subdivision', () => {
    assert.deepEqual(paths((s) => { s.tracks[0].sound = ''; }), ['tracks[0].sound']);
    assert.deepEqual(paths((s) => { s.tracks[0].subdivision = 'triplet'; }), ['tracks[0].subdivision']);
  });

  test('cues track: language and clips', () => {
    assert.deepEqual(paths((s) => { s.tracks[1].language = 'de'; }), ['tracks[1].language']);
    assert.deepEqual(paths((s) => { s.tracks[1].clips = {}; }), ['tracks[1].clips']);
    assert.deepEqual(paths((s) => { s.tracks[1].clips[0].type = 'shout'; }), ['tracks[1].clips[0].type']);
    assert.deepEqual(paths((s) => { s.tracks[1].clips[0].key = ''; }), ['tracks[1].clips[0].key']);
    assert.deepEqual(paths((s) => {
      s.tracks[1].clips = Array.from({ length: 2001 }, () => ({ at: [1, 1, 1], type: 'count', key: '1' }));
    }), ['tracks[1].clips']);
  });

  test('two cue clips may share a position', () => {
    assert.deepEqual(paths((s) => { s.tracks[1].clips.push({ at: [2, 1, 1], type: 'section', key: 'Intro' }); }), []);
  });

  test('cue positions follow the meter of their bar', () => {
    const at = (s, a) => { s.tracks[1].clips[0].at = a; };
    // Bars 1–30 are 6/4: beat 6 exists. Bar 31 is 4/4: beat 5 does not.
    assert.deepEqual(paths((s) => at(s, [30, 6, 4])), []);
    assert.deepEqual(paths((s) => at(s, [31, 5, 1])), ['tracks[1].clips[0].at']);
    assert.deepEqual(paths((s) => at(s, [1, 1, 5])), ['tracks[1].clips[0].at']);
    assert.deepEqual(paths((s) => at(s, [0, 1, 1])), ['tracks[1].clips[0].at']);
    assert.deepEqual(paths((s) => at(s, [65, 1, 1])), ['tracks[1].clips[0].at']);
    assert.deepEqual(paths((s) => at(s, [1, 1])), ['tracks[1].clips[0].at']);
    assert.deepEqual(paths((s) => at(s, [1.5, 1, 1])), ['tracks[1].clips[0].at']);
  });

  test('in x/8 a beat has two sixteenths', () => {
    const s = valid();
    s.meter = [{ bar: 1, beats: 6, unit: 8 }];
    s.tracks[1].clips = [{ at: [1, 6, 2], type: 'count', key: '6' }];
    assert.deepEqual(validateSong(s), []);
    s.tracks[1].clips[0].at = [1, 6, 3];
    assert.deepEqual(validateSong(s).map((e) => e.path), ['tracks[1].clips[0].at']);
  });

  test('the message explains a missing beat', () => {
    const s = valid();
    s.tracks[1].clips[0].at = [31, 5, 1];
    assert.match(validateSong(s)[0].message, /4 beats/);
  });

  test('audio clip: null, or a valid file used once and a start time within an hour', () => {
    assert.deepEqual(paths((s) => { s.tracks[2].clip = null; }), []);
    assert.deepEqual(paths((s) => { s.tracks[2].clip.startSec = -2; }), []);
    assert.deepEqual(paths((s) => { s.tracks[2].clip.startSec = 3601; }), ['tracks[2].clip.startSec']);
    assert.deepEqual(paths((s) => { s.tracks[2].clip.startSec = NaN; }), ['tracks[2].clip.startSec']);
    assert.deepEqual(paths((s) => { s.tracks[2].clip.file = '../x.wav'; }), ['tracks[2].clip.file']);
    assert.deepEqual(paths((s) => { s.tracks[2].clip.file = 'notes.txt'; }), ['tracks[2].clip.file']);
    assert.deepEqual(paths((s) => {
      s.tracks.push({ ...s.tracks[2], id: 'a2', clip: { file: 'El Shaddai.wav', startSec: 0 } });
    }), ['tracks[3].clip.file']);
    assert.deepEqual(paths((s) => { s.tracks[2].clip = 'x.wav'; }), ['tracks[2].clip']);
  });
});

describe('helpers', () => {
  test('slugify makes URL-safe ids', () => {
    assert.equal(slugify('Way Maker'), 'way-maker');
    assert.equal(slugify('  Él Shaddai (Live) '), 'el-shaddai-live');
    assert.equal(slugify('!!!'), 'song');
    assert.match(slugify('x'.repeat(200)), /^x{60}$/);
  });
  
  test('uniqueId avoids existing ids', () => {
    assert.equal(uniqueId('Way Maker', []), 'way-maker');
    assert.equal(uniqueId('Way Maker', ['way-maker', 'way-maker-2']), 'way-maker-3');
  });
  
  test('sanitizeStemName keeps readable names and rejects unsupported files', () => {
    assert.equal(sanitizeStemName('Drums.wav'), 'Drums.wav');
    assert.equal(sanitizeStemName('Way Maker - Keys (Pad).WAV'), 'Way Maker - Keys (Pad).WAV');
    assert.equal(sanitizeStemName('C:\\Users\\me\\Bass.m4a'), 'Bass.m4a');
    assert.equal(sanitizeStemName('../../etc/Click Track.mp3'), 'Click Track.mp3');
    assert.equal(sanitizeStemName('Guitarra Eléctrica #1.flac'), 'Guitarra Electrica _1.flac');
    assert.equal(sanitizeStemName('..wav'), null);
    assert.equal(sanitizeStemName('notes.txt'), null);
    assert.equal(sanitizeStemName('x'.repeat(300) + '.wav'), 'x'.repeat(90) + '.wav');
  });
});
