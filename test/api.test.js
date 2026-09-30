import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startServer } from '../server/index.js';
import { newSong } from '../shared/song.js';

let root;
let server;

async function start() {
  server = await startServer({ root, port: 0, maxStemBytes: 1024 });
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'btb-api-'));
  mkdirSync(join(root, 'public'));
  writeFileSync(join(root, 'secret.json'), '{"secret":true}');
  await start();
});

after(() => server.close());

function call(method, path, body, headers = {}) {
  const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: server.address().port, method, path,
      headers: data === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const song = (overrides = {}) => ({ ...newSong(), id: 'way-maker', title: 'Way Maker', tempo: [{ bar: 1, bpm: 68 }], ...overrides });

const audioTrack = (id, file) => ({
  id, type: 'audio', name: file.replace(/\.wav$/, ''), color: 2, volumeDb: 0, muted: false, output: 'both',
  clips: [{ file, startSec: 0, offsetSec: 0, lengthSec: null }],
});

test('an empty library lists no songs', async () => {
  const r = await call('GET', '/api/songs');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, []);
});

test('save, load and list a song; it survives a server restart', async () => {
  const saved = await call('PUT', '/api/songs/way-maker', song());
  assert.equal(saved.status, 200);
  assert.equal(saved.json.title, 'Way Maker');
  assert.ok(existsSync(join(root, 'songs/way-maker/song.json')));

  await call('PUT', '/api/songs/amazing-grace', song({ id: 'amazing-grace', title: 'Amazing Grace' }));

  server.close();
  await start();

  const loaded = await call('GET', '/api/songs/way-maker');
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.json, song());
  const list = await call('GET', '/api/songs');
  assert.deepEqual(list.json.map((s) => s.title), ['Amazing Grace', 'Way Maker']);
  assert.deepEqual(Object.keys(list.json[0]).sort(), ['bpm', 'id', 'meter', 'title']);
  assert.deepEqual(list.json[1], { id: 'way-maker', title: 'Way Maker', bpm: 68, meter: [4, 4] });
});

test('the song list shows bpm and meter from the bar-1 markers and hides old-format songs', async () => {
  await call('PUT', '/api/songs/odd-time', song({
    id: 'odd-time', title: 'Odd Time', tempo: [{ bar: 1, bpm: 72 }, { bar: 5, bpm: 90 }],
    meter: [{ bar: 1, beats: 6, unit: 8 }, { bar: 3, beats: 4, unit: 4 }],
  }));
  mkdirSync(join(root, 'songs/old-song'), { recursive: true });
  writeFileSync(join(root, 'songs/old-song/song.json'), JSON.stringify({ version: 1, id: 'old-song', title: 'Old', bpm: 120, meter: [4, 4] }));
  const list = (await call('GET', '/api/songs')).json;
  assert.deepEqual(list.find((s) => s.id === 'odd-time'), { id: 'odd-time', title: 'Odd Time', bpm: 72, meter: [6, 8] });
  assert.ok(!list.some((s) => s.id === 'old-song'));
});

test('songs saved by the previous version (v2) are listed and open as version 3', async () => {
  const v2 = {
    ...song({ id: 'old-v2', title: 'Older Save' }), version: 2,
    tracks: [...newSong().tracks,
      { id: 'a1', type: 'audio', name: 'Band', color: 2, volumeDb: 0, muted: false, output: 'both', clip: { file: 'Band.wav', startSec: 3.214 } },
      { id: 'a2', type: 'audio', name: 'Empty', color: 3, volumeDb: 0, muted: false, output: 'both', clip: null }],
  };
  mkdirSync(join(root, 'songs/old-v2'), { recursive: true });
  writeFileSync(join(root, 'songs/old-v2/song.json'), JSON.stringify(v2));
  const list = (await call('GET', '/api/songs')).json;
  assert.ok(list.some((s) => s.id === 'old-v2'));
  const loaded = (await call('GET', '/api/songs/old-v2')).json;
  assert.equal(loaded.version, 3);
  assert.deepEqual(loaded.tracks.slice(2).map((t) => [t.clip, t.clips]), [
    [undefined, [{ file: 'Band.wav', startSec: 3.214, offsetSec: 0, lengthSec: null }]],
    [undefined, []],
  ]);
  // the file stays as it was until the song is saved again
  assert.equal(JSON.parse(readFileSync(join(root, 'songs/old-v2/song.json'), 'utf8')).version, 2);
  assert.equal((await call('PUT', '/api/songs/old-v2', loaded)).status, 200);
  assert.equal(JSON.parse(readFileSync(join(root, 'songs/old-v2/song.json'), 'utf8')).version, 3);
});

test('audio clips that overlap on a track are refused', async () => {
  const base = song();
  const res = await call('PUT', '/api/songs/way-maker', song({
    tracks: [...base.tracks, { ...audioTrack('a1', 'Band.wav'), clips: [
      { file: 'Band.wav', startSec: 0, offsetSec: 0, lengthSec: 10 },
      { file: 'Band.wav', startSec: 9, offsetSec: 9, lengthSec: null },
    ] }],
  }));
  assert.equal(res.status, 400);
  assert.deepEqual(res.json.errors.map((e) => e.path), ['tracks[2].clips[1].startSec']);
});

test('saved files are readable, hand-editable JSON', async () => {
  await call('PUT', '/api/songs/way-maker', song({ endBar: 70 }));
  const onDisk = readFileSync(join(root, 'songs/way-maker/song.json'), 'utf8');
  assert.match(onDisk, /\n {2}"endBar": 70,\n/);
});

test('invalid songs are refused with the validation errors', async () => {
  const r = await call('PUT', '/api/songs/way-maker', song({ tempo: [{ bar: 1, bpm: 500 }] }));
  assert.equal(r.status, 400);
  assert.deepEqual(r.json.errors.map((e) => e.path), ['tempo[0].bpm']);
  assert.equal((await call('GET', '/api/songs/way-maker')).json.tempo[0].bpm, 68);
  const old = await call('PUT', '/api/songs/way-maker', { version: 1, id: 'way-maker', title: 'Old', bpm: 120 });
  assert.equal(old.status, 400);
});

test('the id in the body must match the URL', async () => {
  const r = await call('PUT', '/api/songs/other', song());
  assert.equal(r.status, 400);
});

test('bad JSON and oversized bodies are refused', async () => {
  assert.equal((await call('PUT', '/api/songs/way-maker', '{nope')).status, 400);
  const big = JSON.stringify(song({ title: 'x'.repeat(1_100_000) }));
  assert.equal((await call('PUT', '/api/songs/way-maker', big)).status, 413);
});

test('one broken song file does not hide the other songs', async () => {
  mkdirSync(join(root, 'songs/broken'), { recursive: true });
  writeFileSync(join(root, 'songs/broken/song.json'), '{ "title": "Broken", ');
  const list = await call('GET', '/api/songs');
  assert.equal(list.status, 200);
  assert.ok(list.json.some((s) => s.id === 'way-maker'));
  assert.ok(!list.json.some((s) => s.id === 'broken'));
  const one = await call('GET', '/api/songs/broken');
  assert.equal(one.status, 500);
  assert.match(one.json.error, /not valid JSON/);
});

test('unknown songs are 404', async () => {
  assert.equal((await call('GET', '/api/songs/nope')).status, 404);
});

test('ids that could escape the songs folder are rejected', async () => {
  for (const id of ['..', '..%2f..%2fsecret', '%2e%2e', 'Way-Maker', 'a%00b', 'a.json', '-x']) {
    const get = await call('GET', `/api/songs/${id}`);
    assert.equal(get.status, 400, `GET ${id} -> ${get.status}`);
    const put = await call('PUT', `/api/songs/${id}`, song({ id }));
    assert.equal(put.status, 400, `PUT ${id} -> ${put.status}`);
  }
  assert.equal(readFileSync(join(root, 'secret.json'), 'utf8'), '{"secret":true}');
});

test('settings default to split routing and master levels of 0 dB, and persist', async () => {
  const first = await call('GET', '/api/settings');
  assert.deepEqual(first.json, { version: 2, routing: { mode: 'split' }, mix: { inEarsDb: 0, mainDb: 0 } });
  const put = await call('PUT', '/api/settings', { version: 2, routing: { mode: 'interface' }, mix: { inEarsDb: -6, mainDb: 0 } });
  assert.equal(put.status, 200);
  server.close();
  await start();
  assert.equal((await call('GET', '/api/settings')).json.routing.mode, 'interface');
  assert.equal((await call('GET', '/api/settings')).json.mix.inEarsDb, -6);
  assert.equal((await call('PUT', '/api/settings', { version: 2, routing: { mode: 'split' }, mix: { inEarsDb: 0, mainDb: 9 } })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { version: 2, routing: { mode: 'loud' } })).status, 400);
});

test('old mix keys in settings are ignored', async () => {
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ version: 1, routing: { mode: 'split' }, mix: { inEarStemsDb: -12, mainStemsDb: -3 } }));
  assert.deepEqual((await call('GET', '/api/settings')).json.mix, { inEarsDb: 0, mainDb: 0 });
  const put = await call('PUT', '/api/settings', { version: 2, routing: { mode: 'split' }, mix: { inEarStemsDb: -12, mainDb: -1 } });
  assert.deepEqual(put.json.mix, { inEarsDb: 0, mainDb: -1 });
});

test('unsupported methods and unknown API routes', async () => {
  assert.equal((await call('DELETE', '/api/songs/way-maker')).status, 405);
  assert.equal((await call('GET', '/api/nope')).status, 404);
});

function upload(id, fileName, bytes) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: server.address().port, method: 'POST', path: `/api/songs/${id}/stems`,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(fileName) },
    }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text || '{}') }));
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

function download(path) {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}

test('upload a stem, stream it back, then delete it', async () => {
  const bytes = Buffer.from('RIFF....WAVEfake-audio');
  const up = await upload('way-maker', 'Way Maker - Keys (Pad).wav', bytes);
  assert.equal(up.status, 200);
  assert.deepEqual(up.json, { file: 'Way Maker - Keys (Pad).wav', size: bytes.length });
  assert.deepEqual(readFileSync(join(root, 'songs/way-maker/stems/Way Maker - Keys (Pad).wav')), bytes);

  const got = await download('/api/songs/way-maker/stems/Way%20Maker%20-%20Keys%20(Pad).wav');
  assert.equal(got.status, 200);
  assert.match(got.type, /audio\/wav/);
  assert.deepEqual(got.body, bytes);

  const del = await call('DELETE', '/api/songs/way-maker/stems/Way%20Maker%20-%20Keys%20(Pad).wav');
  assert.equal(del.status, 200);
  assert.ok(!existsSync(join(root, 'songs/way-maker/stems/Way Maker - Keys (Pad).wav')));
  assert.equal((await call('DELETE', '/api/songs/way-maker/stems/Way%20Maker%20-%20Keys%20(Pad).wav')).status, 404);
});

test('uploaded names are cleaned up and never overwrite an existing stem', async () => {
  const a = await upload('way-maker', '../../Bass Guitar.m4a', Buffer.from('one'));
  const b = await upload('way-maker', 'Bass Guitar.m4a', Buffer.from('two'));
  assert.equal(a.json.file, 'Bass Guitar.m4a');
  assert.equal(b.json.file, 'Bass Guitar (2).m4a');
  assert.equal(readFileSync(join(root, 'songs/way-maker/stems/Bass Guitar.m4a'), 'utf8'), 'one');
});

test('unsupported files, unknown songs and oversized stems are refused', async () => {
  assert.equal((await upload('way-maker', 'notes.txt', Buffer.from('x'))).status, 400);
  assert.equal((await upload('no-such-song', 'Drums.wav', Buffer.from('x'))).status, 404);
  const big = await upload('way-maker', 'Huge.wav', Buffer.alloc(2048));
  assert.equal(big.status, 413);
  assert.ok(!existsSync(join(root, 'songs/way-maker/stems/Huge.wav')));
  assert.ok(!readdirSync(join(root, 'songs/way-maker/stems')).some((f) => f.includes('.part')));
});

test('stem paths cannot escape the stems folder', async () => {
  for (const p of ['..%2Fsong.json', '..%2F..%2Fsong.json', '..', '%2e%2e', 'song.json', 'a%2Fb.wav']) {
    const got = await download(`/api/songs/way-maker/stems/${p}`);
    assert.ok([400, 404].includes(got.status), `GET ${p} -> ${got.status}`);
    const del = await call('DELETE', `/api/songs/way-maker/stems/${p}`);
    assert.ok([400, 404].includes(del.status), `DELETE ${p} -> ${del.status}`);
  }
  assert.ok(existsSync(join(root, 'songs/way-maker/song.json')));
});

test('saving a song removes uploaded audio files no audio clip uses', async () => {
  const keep = await upload('way-maker', 'Keep.wav', Buffer.from('k'));
  const drop = await upload('way-maker', 'Drop.wav', Buffer.from('d'));
  const base = song();
  const saved = await call('PUT', '/api/songs/way-maker', song({
    tracks: [...base.tracks, audioTrack('a1', keep.json.file), audioTrack('a2', 'Missing.wav')],
  }));
  assert.equal(saved.status, 200);
  const files = readdirSync(join(root, 'songs/way-maker/stems'));
  assert.ok(files.includes('Keep.wav'));
  assert.ok(!files.includes(drop.json.file));
});

test('an audio file stays while any clip uses it, on any track', async () => {
  const shared = await upload('way-maker', 'Shared.wav', Buffer.from('s'));
  const file = shared.json.file;
  const base = song();
  const stems = () => readdirSync(join(root, 'songs/way-maker/stems'));
  const piece = (startSec, lengthSec) => ({ file, startSec, offsetSec: startSec, lengthSec });
  const withClips = (a1, a2) => song({ tracks: [...base.tracks,
    { ...audioTrack('a1', file), clips: a1 }, { ...audioTrack('a2', file), clips: a2 }] });
  assert.equal((await call('PUT', '/api/songs/way-maker', withClips([piece(0, 5), piece(20, null)], []))).status, 200);
  assert.ok(stems().includes(file));
  assert.equal((await call('PUT', '/api/songs/way-maker', withClips([], [piece(20, null)]))).status, 200);
  assert.ok(stems().includes(file));
  assert.equal((await call('PUT', '/api/songs/way-maker', withClips([], []))).status, 200);
  assert.ok(!stems().includes(file));
});

test('overlapping saves all succeed', async () => {
  const puts = Array.from({ length: 8 }, (_, i) =>
    call('PUT', '/api/settings', { version: 2, routing: { mode: 'split' }, mix: { inEarsDb: -i, mainDb: 0 } }));
  const results = await Promise.all(puts);
  assert.deepEqual(results.map((r) => r.status), Array(8).fill(200));
  const songs = await Promise.all(Array.from({ length: 5 }, () => call('PUT', '/api/songs/way-maker', song())));
  assert.deepEqual(songs.map((r) => r.status), Array(5).fill(200));
});

test('setlists: save, list, load, survive a restart; invalid ones are refused', async () => {
  assert.deepEqual((await call('GET', '/api/setlists')).json, []);
  const set = { version: 1, id: 'sunday', name: 'Sunday AM', songs: ['way-maker', 'gone-song'] };
  const put = await call('PUT', '/api/setlists/sunday', set);
  assert.equal(put.status, 200);
  assert.ok(existsSync(join(root, 'setlists/sunday.json')));
  await call('PUT', '/api/setlists/aaa', { version: 1, id: 'aaa', name: 'Christmas', songs: [] });
  server.close();
  await start();
  assert.deepEqual((await call('GET', '/api/setlists/sunday')).json, set);
  assert.deepEqual((await call('GET', '/api/setlists')).json,
    [{ id: 'aaa', name: 'Christmas', count: 0 }, { id: 'sunday', name: 'Sunday AM', count: 2 }]);
  assert.equal((await call('PUT', '/api/setlists/sunday', { ...set, name: '' })).status, 400);
  assert.equal((await call('PUT', '/api/setlists/other', set)).status, 400);
  assert.equal((await call('GET', '/api/setlists/nope')).status, 404);
  assert.equal((await call('GET', '/api/setlists/..%2Fsettings')).status, 400);
});

test('setlists can be deleted', async () => {
  assert.equal((await call('DELETE', '/api/setlists/aaa')).status, 200);
  assert.equal((await call('GET', '/api/setlists/aaa')).status, 404);
  assert.equal((await call('DELETE', '/api/setlists/aaa')).status, 404);
});

function post(path, bytes) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path,
      headers: { 'Content-Type': 'audio/wav' } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text || '{}') }));
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

test('exports are saved as exports/<song title>.wav and replace the previous export', async () => {
  await call('PUT', '/api/songs/way-maker', song({ title: 'Way Maker (Live)' }));
  const wav = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(100)]);
  const first = await post('/api/exports/way-maker', wav);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { file: 'Way Maker (Live).wav', size: wav.length, folder: join(root, 'exports') });
  const second = await post('/api/exports/way-maker', Buffer.concat([wav, Buffer.alloc(10)]));
  assert.equal(second.json.size, wav.length + 10);
  assert.equal(readFileSync(join(root, 'exports/Way Maker (Live).wav')).length, wav.length + 10);
  assert.deepEqual(readdirSync(join(root, 'exports')).filter((f) => !f.startsWith('.')), ['Way Maker (Live).wav']);
});

test('exports must be WAV data for an existing song', async () => {
  assert.equal((await post('/api/exports/way-maker', Buffer.from('not a wav file at all'))).status, 400);
  assert.equal((await post('/api/exports/no-such-song', Buffer.from('RIFF\0\0\0\0WAVE'))).status, 404);
  assert.equal((await post('/api/exports/..%2Fsettings', Buffer.from('RIFF\0\0\0\0WAVE'))).status, 400);
  assert.equal((await call('GET', '/api/exports/way-maker')).status, 405);
});
