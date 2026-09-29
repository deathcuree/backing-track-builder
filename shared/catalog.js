// Maps the MultiTracks "Click and Guide Samples" folder to a language-independent catalog.
// Songs reference guides by English key ("Chorus 1"); each language maps keys to its own file.
// Pure: takes relative paths, returns the catalog plus the copy plan. No filesystem access.

const LANGUAGES = {
  'English Guides': 'en',
  'French Guides': 'fr',
  'Portugese Guides': 'pt', // sic, as named in the pack
  'Spanish Guides': 'es',
};

const FOLDER_TYPES = {
  'Song Sections': 'section',
  'Dynamic Cues': 'cue',
  'Guide Cues': 'cue', // Spanish name for Dynamic Cues
};

const ALIASES = { 'A Capella': 'Acapella' };

const CLICK_RE = /^New Click -\s+(.+)-(accents|quarter|eighth|sixteenth)\.wav$/;
const PAREN_RE = /^(.*?)\s*\((.+)\)$/;

/**
 * @param {string[]} relPaths paths relative to the sample pack root, "/"-separated
 * @returns {{
 *   catalog: { clicks: Record<string, Record<string, string>>,
 *              guides: Record<string, { section: Record<string,string>, cue: Record<string,string>,
 *                                       count: Record<string,string>, languageOnly: string[] }> },
 *   files: { from: string, to: string }[],
 *   report: { skipped: string[], duplicates: { language: string, key: string, kept: string, dropped: string }[] }
 * }}
 */
export function buildCatalog(relPaths) {
  const catalog = { clicks: {}, guides: {} };
  const files = [];
  const report = { skipped: [], duplicates: [] };
  const guideEntries = [];

  for (const path of relPaths) {
    const parts = path.split('/');
    if (!path.endsWith('.wav')) {
      report.skipped.push(path);
      continue;
    }
    if (parts.length === 2 && parts[0] === 'Click Tracks') {
      const m = parts[1].match(CLICK_RE);
      if (!m) {
        report.skipped.push(path);
        continue;
      }
      const [, sound, role] = m;
      const to = `clicks/${sound}-${role}.wav`;
      (catalog.clicks[sound] ??= {})[role] = to;
      files.push({ from: path, to });
      continue;
    }
    const language = LANGUAGES[parts[0]];
    const folderType = FOLDER_TYPES[parts[1]];
    if (parts.length !== 3 || !language || !folderType) {
      report.skipped.push(path);
      continue;
    }
    guideEntries.push({
      language,
      folderType,
      names: candidateNames(parts[2]),
      from: path,
      to: `guides/${language}/${parts[1]}/${parts[2]}`,
    });
  }

  // English defines the canonical keys and whether each key is a section or a cue.
  const englishTypes = new Map();
  for (const e of guideEntries) {
    if (e.language === 'en') englishTypes.set(e.names[0], typeOf(e.names[0], e.folderType));
  }

  const kept = new Map(); // "lang|type|key" -> entry
  for (const e of guideEntries) {
    const englishKey = e.names.find((n) => englishTypes.has(n));
    e.key = englishKey ?? e.names[0];
    e.languageOnly = englishKey === undefined && !/^\d+$/.test(e.key);
    e.type = englishTypes.get(e.key) ?? typeOf(e.key, e.folderType);

    const slot = `${e.language}|${e.type}|${e.key}`;
    const existing = kept.get(slot);
    if (!existing) {
      kept.set(slot, e);
      continue;
    }
    // Same key twice in one language (e.g. Portuguese Breakdown in both folders):
    // keep the file from the folder matching its type.
    const [keep, drop] = existing.folderType !== e.type && e.folderType === e.type
      ? [e, existing] : [existing, e];
    kept.set(slot, keep);
    report.duplicates.push({ language: e.language, key: e.key, kept: keep.from, dropped: drop.from });
  }

  for (const language of Object.values(LANGUAGES)) {
    catalog.guides[language] = { section: {}, cue: {}, count: {}, languageOnly: [] };
  }
  for (const e of kept.values()) {
    const guide = catalog.guides[e.language];
    guide[e.type][e.key] = e.to;
    if (e.languageOnly) guide.languageOnly.push(e.key);
    files.push({ from: e.from, to: e.to });
  }
  for (const guide of Object.values(catalog.guides)) guide.languageOnly.sort();

  return { catalog, files, report };
}

// "Spanish - Coro 1 (Chorus 1).wav" -> ["Coro 1", "Chorus 1"]; "French Guide -  Bass.wav" -> ["Bass"]
function candidateNames(fileName) {
  const base = fileName.replace(/\.wav$/, '');
  const name = base.slice(base.indexOf('-') + 1).trim();
  const m = name.match(PAREN_RE);
  const names = m ? [m[1].trim(), m[2].trim()] : [name];
  return names.map((n) => ALIASES[n] ?? n);
}

function typeOf(key, folderType) {
  return /^\d+$/.test(key) ? 'count' : folderType;
}
