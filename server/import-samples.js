// Copies the MultiTracks click & guide pack into samples/ and writes samples/catalog.json.
// Usage: npm run import-samples -- "/path/to/Click and Guide Samples"
import { readdir, mkdir, copyFile, rm, writeFile, stat } from 'node:fs/promises';
import { join, dirname, relative, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog } from '../shared/catalog.js';

const DEFAULT_DEST = fileURLToPath(new URL('../samples', import.meta.url));

export async function importSamples(srcDir, destDir = DEFAULT_DEST) {
  const exists = await stat(srcDir).then((s) => s.isDirectory(), () => false);
  if (!exists) throw new Error(`Sample folder not found: ${srcDir}`);

  const relPaths = (await listFiles(srcDir)).map((p) => relative(srcDir, p).split(sep).join('/'));
  const { catalog, files, report } = buildCatalog(relPaths);

  // Replace only what the importer owns, so re-imports never leave stale samples behind.
  await rm(join(destDir, 'clicks'), { recursive: true, force: true });
  await rm(join(destDir, 'guides'), { recursive: true, force: true });
  for (const { from, to } of files) {
    const target = join(destDir, to);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(srcDir, from), target);
  }
  await writeFile(join(destDir, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');

  return {
    copied: files.length,
    skipped: report.skipped,
    duplicates: report.duplicates,
    languageOnly: Object.fromEntries(
      Object.entries(catalog.guides).map(([lang, g]) => [lang, g.languageOnly]),
    ),
  };
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? listFiles(p) : e.isFile() ? [p] : [];
  }));
  return nested.flat();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const src = process.argv[2];
  if (!src) {
    console.error('Usage: npm run import-samples -- "/path/to/Click and Guide Samples"');
    process.exit(1);
  }
  try {
    const r = await importSamples(src);
    const skippedWavs = r.skipped.filter((f) => f.endsWith('.wav'));
    console.log(`Copied ${r.copied} samples to samples/ and wrote samples/catalog.json`);
    console.log(`Skipped ${r.skipped.length} files (${skippedWavs.length} .wav outside the click/guide folders)`);
    for (const d of r.duplicates) {
      console.log(`Duplicate ${d.language} "${d.key}": kept ${d.kept}, ignored ${d.dropped}`);
    }
    for (const [lang, keys] of Object.entries(r.languageOnly)) {
      if (keys.length) console.log(`Only in ${lang} (no English equivalent): ${keys.join(', ')}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
