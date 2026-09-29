import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startServer } from '../server/index.js';

let server;
let port;

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'btb-root-'));
  for (const d of ['public', 'shared', 'samples/guides/es/Song Sections']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'public/index.html'), '<!doctype html><title>BTB</title>');
  writeFileSync(join(root, 'public/app.js'), 'export {}');
  writeFileSync(join(root, 'shared/catalog.js'), 'export {}');
  writeFileSync(join(root, 'samples/catalog.json'), '{"clicks":{}}');
  writeFileSync(join(root, 'samples/guides/es/Song Sections/Spanish - Coro 1 (Chorus 1).wav'), 'RIFF');
  writeFileSync(join(root, 'secret.txt'), 'nope');
  server = await startServer({ root, port: 0 });
  port = server.address().port;
});

after(() => server.close());

// Raw request so the path is sent exactly as written (fetch would normalize "..").
function get(path) {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    }).on('error', reject).end();
  });
}

test('listens on localhost only', () => {
  assert.equal(server.address().address, '127.0.0.1');
});

test('serves the page at /', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.match(r.body, /BTB/);
});

test('serves public, shared and samples with correct types', async () => {
  assert.match((await get('/app.js')).type, /javascript/);
  assert.match((await get('/shared/catalog.js')).type, /javascript/);
  const cat = await get('/samples/catalog.json');
  assert.equal(cat.status, 200);
  assert.match(cat.type, /application\/json/);
});

test('serves sample files whose names contain spaces and parentheses', async () => {
  const r = await get('/samples/guides/es/Song%20Sections/Spanish%20-%20Coro%201%20(Chorus%201).wav');
  assert.equal(r.status, 200);
  assert.match(r.type, /audio\/wav/);
});

test('missing files are 404', async () => {
  assert.equal((await get('/nope.js')).status, 404);
});

test('paths cannot escape their folders', async () => {
  for (const p of ['/../secret.txt', '/samples/../secret.txt', '/samples/%2e%2e/secret.txt',
    '/samples/..%2fsecret.txt', '/shared/%2e%2e%2fsecret.txt', '/%00']) {
    const r = await get(p);
    assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
    assert.doesNotMatch(r.body, /nope/);
  }
});
