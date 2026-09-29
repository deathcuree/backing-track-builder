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

const song = (overrides = {}) => ({ ...newSong(), id: 'way-maker', title: 'Way Maker', bpm: 68, ...overrides });

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
});

test('saved files are readable, hand-editable JSON', async () => {
  await call('PUT', '/api/songs/way-maker', song({ bpm: 70 }));
  const onDisk = readFileSync(join(root, 'songs/way-maker/song.json'), 'utf8');
  assert.match(onDisk, /\n {2}"bpm": 70,\n/);
});

test('invalid songs are refused with the validation errors', async () => {
  const r = await call('PUT', '/api/songs/way-maker', song({ bpm: 500 }));
  assert.equal(r.status, 400);
  assert.deepEqual(r.json.errors.map((e) => e.path), ['bpm']);
  assert.equal((await call('GET', '/api/songs/way-maker')).json.bpm, 70);
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

test('settings default to split routing and persist', async () => {
  const first = await call('GET', '/api/settings');
  assert.deepEqual(first.json, { version: 1, routing: { mode: 'split' }, mix: { inEarStemsDb: 0, mainStemsDb: 0 } });
  const put = await call('PUT', '/api/settings', { version: 1, routing: { mode: 'interface' }, mix: { inEarStemsDb: -6, mainStemsDb: 0 } });
  assert.equal(put.status, 200);
  server.close();
  await start();
  assert.equal((await call('GET', '/api/settings')).json.routing.mode, 'interface');
  assert.equal((await call('GET', '/api/settings')).json.mix.inEarStemsDb, -6);
  assert.equal((await call('PUT', '/api/settings', { version: 1, routing: { mode: 'split' }, mix: { inEarStemsDb: 9, mainStemsDb: 0 } })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { version: 1, routing: { mode: 'loud' } })).status, 400);
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

test('saving a song removes uploaded stem files it no longer uses', async () => {
  const keep = await upload('way-maker', 'Keep.wav', Buffer.from('k'));
  const drop = await upload('way-maker', 'Drop.wav', Buffer.from('d'));
  const stem = (file) => ({ file, name: file.replace(/\.wav$/, ''), volumeDb: 0, muted: false });
  const saved = await call('PUT', '/api/songs/way-maker', song({ stems: [stem(keep.json.file), stem('Missing.wav')] }));
  assert.equal(saved.status, 200);
  const files = readdirSync(join(root, 'songs/way-maker/stems'));
  assert.ok(files.includes('Keep.wav'));
  assert.ok(!files.includes(drop.json.file));
});

test('overlapping saves all succeed', async () => {
  const puts = Array.from({ length: 8 }, (_, i) =>
    call('PUT', '/api/settings', { version: 1, routing: { mode: 'split' }, mix: { inEarStemsDb: -i, mainStemsDb: 0 } }));
  const results = await Promise.all(puts);
  assert.deepEqual(results.map((r) => r.status), Array(8).fill(200));
  const songs = await Promise.all(Array.from({ length: 5 }, () => call('PUT', '/api/songs/way-maker', song())));
  assert.deepEqual(songs.map((r) => r.status), Array(5).fill(200));
});
