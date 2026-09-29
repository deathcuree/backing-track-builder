import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { importSamples } from '../server/import-samples.js';

function makePack() {
  const root = mkdtempSync(join(tmpdir(), 'btb-pack-'));
  const files = [
    'Click Tracks/New Click -  Classic-accents.wav',
    'Click Tracks/New Click -  Classic-accents.wav.asd',
    'English Guides/Song Sections/English Female - Chorus 1.wav',
    'English Guides/Song Sections/English Female - 1.wav',
    'Spanish Guides/Song Sections/Spanish - Coro 1 (Chorus 1).wav',
    'Click Guide - Drum Racks Project/Click Guide Drum Racks.als',
    '.DS_Store',
  ];
  for (const f of files) {
    mkdirSync(join(root, dirname(f)), { recursive: true });
    writeFileSync(join(root, f), `data:${f}`);
  }
  return root;
}

test('copies wavs, writes catalog.json, skips everything else', async () => {
  const src = makePack();
  const dest = mkdtempSync(join(tmpdir(), 'btb-samples-'));

  const report = await importSamples(src, dest);

  const catalog = JSON.parse(readFileSync(join(dest, 'catalog.json'), 'utf8'));
  assert.equal(catalog.clicks.Classic.accents, 'clicks/Classic-accents.wav');
  assert.equal(
    readFileSync(join(dest, catalog.guides.es.section['Chorus 1']), 'utf8'),
    'data:Spanish Guides/Song Sections/Spanish - Coro 1 (Chorus 1).wav',
  );
  assert.equal(report.copied, 4);
  assert.ok(report.skipped.includes('.DS_Store'));
  assert.ok(!readdirSync(join(dest, 'clicks')).some((f) => f.endsWith('.asd')));
});

test('re-import replaces previous samples but keeps unrelated files', async () => {
  const src = makePack();
  const dest = mkdtempSync(join(tmpdir(), 'btb-samples-'));
  mkdirSync(join(dest, 'clicks'));
  writeFileSync(join(dest, 'clicks', 'stale.wav'), 'old');
  writeFileSync(join(dest, '.gitkeep'), '');

  await importSamples(src, dest);

  assert.ok(!existsSync(join(dest, 'clicks', 'stale.wav')));
  assert.ok(existsSync(join(dest, '.gitkeep')));
});

test('missing source folder rejects with a clear message', async () => {
  const dest = mkdtempSync(join(tmpdir(), 'btb-samples-'));
  await assert.rejects(importSamples(join(tmpdir(), 'no-such-pack-xyz'), dest), /not found/);
});
