import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCatalog } from '../shared/catalog.js';

const realFiles = readFileSync(new URL('./fixtures/sample-files.txt', import.meta.url), 'utf8')
  .split('\n').filter(Boolean);

const { catalog, files, report } = buildCatalog(realFiles);

test('only .wav files from click and guide folders are copied', () => {
  for (const { from } of files) {
    assert.match(from, /\.wav$/);
    assert.doesNotMatch(from, /Drum Racks Project/);
  }
  assert.ok(report.skipped.some((f) => f.endsWith('.asd')));
  assert.ok(report.skipped.some((f) => f.endsWith('.als')));
  assert.ok(report.skipped.some((f) => f.includes('Blank Accent.wav')));
});

test('all 8 click sounds with their real roles', () => {
  assert.deepEqual(Object.keys(catalog.clicks).sort(),
    ['Blip', 'Classic', 'Cowbell', 'Digital', 'Gentle', 'Percussive', 'Saw', 'Woodblock']);
  assert.deepEqual(Object.keys(catalog.clicks.Classic).sort(), ['accents', 'eighth', 'quarter', 'sixteenth']);
  assert.deepEqual(Object.keys(catalog.clicks.Digital).sort(), ['accents', 'sixteenth']);
  assert.deepEqual(Object.keys(catalog.clicks.Saw).sort(), ['accents', 'eighth', 'quarter']);
  assert.equal(catalog.clicks.Classic.accents, 'clicks/Classic-accents.wav');
});

test('four languages', () => {
  assert.deepEqual(Object.keys(catalog.guides).sort(), ['en', 'es', 'fr', 'pt']);
});

test('common sections resolve in every language', () => {
  for (const lang of ['en', 'fr', 'pt', 'es']) {
    for (const key of ['Chorus 1', 'Verse 2', 'Bridge', 'Intro', 'Pre Chorus', 'Breakdown']) {
      assert.ok(catalog.guides[lang].section[key], `${lang} missing section ${key}`);
    }
  }
});

test('Spanish English-name in or outside parentheses', () => {
  const es = catalog.guides.es;
  assert.equal(es.section['Chorus 1'], 'guides/es/Song Sections/Spanish - Coro 1 (Chorus 1).wav');
  assert.equal(es.section['Tag'], 'guides/es/Song Sections/Spanish - Repetir (Tag).wav');
  assert.equal(es.section['Ending'], 'guides/es/Song Sections/Spanish - Ending (Final).wav');
  assert.equal(es.cue['All In'], 'guides/es/Guide Cues/Spanish - All In (Toda La Banda).wav');
  assert.equal(es.cue['Last Time'], 'guides/es/Guide Cues/Spanish - Last Time (Ultima Vez).wav');
});

test('Spanish A Capella maps to the English section Acapella', () => {
  assert.equal(catalog.guides.es.section['Acapella'], 'guides/es/Guide Cues/Spanish - A Capella.wav');
});

test('French uses two different prefixes', () => {
  assert.equal(catalog.guides.fr.section['Verse 1'], 'guides/fr/Song Sections/French - Verse 1.wav');
  assert.equal(catalog.guides.fr.cue['Drums In'], 'guides/fr/Dynamic Cues/French Guide -  Drums In.wav');
});

test('type follows English: Portuguese Breakdown is a section, the cue-folder copy is a reported duplicate', () => {
  const pt = catalog.guides.pt;
  assert.equal(pt.section['Breakdown'], 'guides/pt/Song Sections/Portugese - Breakdown.wav');
  assert.equal(pt.cue['Breakdown'], undefined);
  assert.ok(report.duplicates.some((d) => d.language === 'pt' && d.key === 'Breakdown'));
});

test('counts 1-7 in English and Spanish, 1-6 in French and Portuguese', () => {
  const nums = (lang) => Object.keys(catalog.guides[lang].count).sort();
  assert.deepEqual(nums('en'), ['1', '2', '3', '4', '5', '6', '7']);
  assert.deepEqual(nums('es'), ['1', '2', '3', '4', '5', '6', '7']);
  assert.deepEqual(nums('fr'), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(nums('pt'), ['1', '2', '3', '4', '5', '6']);
  assert.equal(catalog.guides.en.section['1'], undefined);
});

test('cues without an English equivalent are kept and flagged languageOnly', () => {
  assert.equal(catalog.guides.pt.cue['Pad'], 'guides/pt/Dynamic Cues/Portugese - Pad.wav');
  assert.deepEqual(catalog.guides.pt.languageOnly.sort(), ['Channel', 'Click', 'Guitar', 'Pad']);
  assert.deepEqual(catalog.guides.fr.languageOnly, ['Guitar']);
  assert.equal(catalog.guides.es.cue['Guitar'], 'guides/es/Guide Cues/Spanish - Guitar (Guitara).wav');
  assert.deepEqual(catalog.guides.es.languageOnly, ['Guitar']);
  assert.deepEqual(catalog.guides.en.languageOnly, []);
});

test('every catalog path is a copy destination', () => {
  const dests = new Set(files.map((f) => f.to));
  const paths = [
    ...Object.values(catalog.clicks).flatMap(Object.values),
    ...Object.values(catalog.guides).flatMap((g) =>
      [g.section, g.cue, g.count].flatMap(Object.values)),
  ];
  for (const p of paths) assert.ok(dests.has(p), p);
});

test('unknown folders are skipped, not crashed on', () => {
  const r = buildCatalog(['German Guides/Song Sections/German - Intro.wav', 'random.wav']);
  assert.equal(r.files.length, 0);
  assert.equal(r.report.skipped.length, 2);
});
