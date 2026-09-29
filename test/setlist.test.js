import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSetlist, validateSetlist } from '../shared/setlist.js';

const paths = (s) => validateSetlist(s).map((e) => e.path);

test('a new setlist is valid and empty', () => {
  const s = newSetlist('Sunday');
  assert.deepEqual(s, { version: 1, id: '', name: 'Sunday', songs: [] });
  assert.deepEqual(validateSetlist({ ...s, id: 'sunday' }), []);
});

test('needs a name and a list of song ids; the same song may appear twice', () => {
  const s = { version: 1, id: 'sunday', name: 'Sunday', songs: ['way-maker', 'amazing-grace', 'way-maker'] };
  assert.deepEqual(paths(s), []);
  assert.deepEqual(paths({ ...s, name: ' ' }), ['name']);
  assert.deepEqual(paths({ ...s, songs: 'way-maker' }), ['songs']);
  assert.deepEqual(paths({ ...s, songs: ['ok', '../x', 'Bad'] }), ['songs[1]', 'songs[2]']);
  assert.deepEqual(paths({ ...s, songs: Array(201).fill('a') }), ['songs']);
  assert.deepEqual(paths(null), ['']);
});
