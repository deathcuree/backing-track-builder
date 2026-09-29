import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultDataDir, prepareDataDir } from '../server/data-dir.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'btb-data-'));

test('the data folder is ~/Music/Backing Tracks unless BTB_DATA_DIR says otherwise', () => {
  assert.equal(defaultDataDir({}, '/Users/me'), '/Users/me/Music/Backing Tracks');
  assert.equal(defaultDataDir({ BTB_DATA_DIR: '/Volumes/Gig/Tracks' }, '/Users/me'), '/Volumes/Gig/Tracks');
  assert.equal(defaultDataDir({ BTB_DATA_DIR: '~/Dropbox/Tracks' }, '/Users/me'), '/Users/me/Dropbox/Tracks');
  assert.equal(defaultDataDir({ BTB_DATA_DIR: '   ' }, '/Users/me'), '/Users/me/Music/Backing Tracks');
});

test('a new data folder gets its subfolders and a copy of the data kept in the project', async () => {
  const project = tmp();
  mkdirSync(join(project, 'songs/way-maker/stems'), { recursive: true });
  writeFileSync(join(project, 'songs/way-maker/song.json'), '{"title":"Way Maker"}');
  writeFileSync(join(project, 'songs/way-maker/stems/Keys.wav'), 'RIFF');
  writeFileSync(join(project, 'songs/.gitkeep'), '');
  mkdirSync(join(project, 'setlists'));
  writeFileSync(join(project, 'setlists/sunday.json'), '{"name":"Sunday"}');
  writeFileSync(join(project, 'settings.json'), '{"version":2}');
  const data = join(tmp(), 'Backing Tracks');

  const result = await prepareDataDir(data, { legacyRoot: project });
  assert.equal(result.created, true);
  assert.deepEqual(result.copied, ['settings.json', 'setlists', 'songs']);
  for (const d of ['songs', 'setlists', 'exports']) assert.ok(existsSync(join(data, d)), d);
  assert.equal(readFileSync(join(data, 'songs/way-maker/song.json'), 'utf8'), '{"title":"Way Maker"}');
  assert.equal(readFileSync(join(data, 'songs/way-maker/stems/Keys.wav'), 'utf8'), 'RIFF');
  assert.equal(readFileSync(join(data, 'setlists/sunday.json'), 'utf8'), '{"name":"Sunday"}');
  assert.equal(existsSync(join(data, 'songs/.gitkeep')), false);
  // the project copy is left alone
  assert.ok(existsSync(join(project, 'songs/way-maker/song.json')));
});

test('an existing data folder is never filled from the project or overwritten', async () => {
  const project = tmp();
  mkdirSync(join(project, 'songs/new'), { recursive: true });
  writeFileSync(join(project, 'songs/new/song.json'), '{"title":"From project"}');
  writeFileSync(join(project, 'settings.json'), '{"from":"project"}');
  const data = tmp();
  writeFileSync(join(data, 'settings.json'), '{"from":"data"}');

  const result = await prepareDataDir(data, { legacyRoot: project });
  assert.deepEqual(result, { created: false, copied: [] });
  assert.equal(readFileSync(join(data, 'settings.json'), 'utf8'), '{"from":"data"}');
  assert.equal(existsSync(join(data, 'songs/new')), false);
  assert.ok(existsSync(join(data, 'songs')));
});

test('nothing to copy from an empty project', async () => {
  const data = join(tmp(), 'Tracks');
  assert.deepEqual(await prepareDataDir(data, { legacyRoot: tmp() }), { created: true, copied: [] });
});
