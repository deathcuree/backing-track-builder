import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startServer } from '../server/index.js';
import { newSong } from '../shared/song.js';

let root;
let server;

async function start() {
  server = await startServer({ root, port: 0 });
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
  assert.deepEqual(first.json, { version: 1, routing: { mode: 'split' } });
  const put = await call('PUT', '/api/settings', { version: 1, routing: { mode: 'interface' } });
  assert.equal(put.status, 200);
  server.close();
  await start();
  assert.equal((await call('GET', '/api/settings')).json.routing.mode, 'interface');
  assert.equal((await call('PUT', '/api/settings', { version: 1, routing: { mode: 'loud' } })).status, 400);
});

test('unsupported methods and unknown API routes', async () => {
  assert.equal((await call('DELETE', '/api/songs/way-maker')).status, 405);
  assert.equal((await call('GET', '/api/nope')).status, 404);
});
