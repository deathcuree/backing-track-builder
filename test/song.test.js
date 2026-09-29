import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSong, validateSong, slugify, uniqueId } from '../shared/song.js';

const paths = (song) => validateSong(song).map((e) => e.path);

test('a new song is valid and uses the spec defaults', () => {
  const s = newSong();
  assert.deepEqual(validateSong(s), []);
  assert.equal(s.version, 1);
  assert.equal(s.countInBars, 1);
  assert.deepEqual(s.meter, [4, 4]);
  assert.deepEqual(s.stems, []);
});

test('BPM 40-240, decimals allowed', () => {
  assert.deepEqual(paths({ ...newSong(), bpm: 72.5 }), []);
  assert.deepEqual(paths({ ...newSong(), bpm: 240 }), []);
  assert.deepEqual(paths({ ...newSong(), bpm: 39.9 }), ['bpm']);
  assert.deepEqual(paths({ ...newSong(), bpm: '120' }), ['bpm']);
});

test('time signature 2-7 over 4 or 8', () => {
  assert.deepEqual(paths({ ...newSong(), meter: [6, 8] }), []);
  assert.deepEqual(paths({ ...newSong(), meter: [8, 8] }), ['meter']);
  assert.deepEqual(paths({ ...newSong(), meter: [4, 2] }), ['meter']);
});

test('title required, count-in 0-2', () => {
  assert.deepEqual(paths({ ...newSong(), title: '  ' }), ['title']);
  assert.deepEqual(paths({ ...newSong(), countInBars: 3 }), ['countInBars']);
});

test('sections need a name and at least one whole bar', () => {
  const s = { ...newSong(), sections: [{ name: 'Intro', bars: 4 }, { name: '', bars: 0 }, { name: 'Verse', bars: 1.5 }] };
  assert.deepEqual(paths(s), ['sections[1].name', 'sections[1].bars', 'sections[2].bars']);
  assert.deepEqual(paths({ ...newSong(), sections: [] }), ['sections']);
});

test('cues must land inside the song', () => {
  const s = { ...newSong(), sections: [{ name: 'Intro', bars: 4 }, { name: 'Verse 1', bars: 8 }] };
  assert.deepEqual(paths({ ...s, cues: [{ name: 'Build', bar: 12 }] }), []);
  const errors = validateSong({ ...s, cues: [{ name: 'Build', bar: 13 }, { name: 'Hits', bar: 0 }] });
  assert.deepEqual(errors.map((e) => e.path), ['cues[0].bar', 'cues[1].bar']);
  assert.match(errors[0].message, /12 bars/);
});

test('click, guide and volume settings', () => {
  const s = newSong();
  assert.deepEqual(paths({ ...s, click: { ...s.click, subdivision: 'triplet' } }), ['click.subdivision']);
  assert.deepEqual(paths({ ...s, click: { ...s.click, volumeDb: 7 } }), ['click.volumeDb']);
  assert.deepEqual(paths({ ...s, guide: { ...s.guide, language: 'de' } }), ['guide.language']);
  assert.deepEqual(paths({ ...s, guide: { ...s.guide, volumeDb: -61 } }), ['guide.volumeDb']);
});

test('non-objects are rejected without throwing', () => {
  assert.deepEqual(paths(null), ['']);
  assert.deepEqual(paths([]), ['']);
});

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
