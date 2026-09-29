import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import { newSong } from '../shared/song.js';

// The app's code and its data live in different folders.
const code = mkdtempSync(join(tmpdir(), 'btb-code-'));
mkdirSync(join(code, 'public'));
const data = mkdtempSync(join(tmpdir(), 'btb-data-'));
const server = await startServer({ root: code, dataDir: data, port: 0 });
after(() => server.close());
const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;

test('songs, setlists, settings and exports are stored in the data folder, not with the code', async () => {
  const song = { ...newSong(), id: 'way-maker', title: 'Way Maker' };
  assert.equal((await fetch(url('/api/songs/way-maker'), { method: 'PUT', body: JSON.stringify(song) })).status, 200);
  await fetch(url('/api/setlists/sunday'), { method: 'PUT', body: JSON.stringify({ version: 1, id: 'sunday', name: 'Sunday', songs: [] }) });
  await fetch(url('/api/settings'), { method: 'PUT', body: JSON.stringify({ version: 2, routing: { mode: 'split' }, mix: { inEarsDb: -3, mainDb: 0 } }) });
  const exported = await (await fetch(url('/api/exports/way-maker'), { method: 'POST', body: Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(8)]) })).json();

  for (const p of ['songs/way-maker/song.json', 'setlists/sunday.json', 'settings.json', 'exports/Way Maker.wav']) {
    assert.ok(existsSync(join(data, p)), `data/${p}`);
    assert.ok(!existsSync(join(code, p)), `code/${p}`);
  }
  assert.deepEqual(exported, { file: 'Way Maker.wav', size: 20, folder: join(data, 'exports') });
});
