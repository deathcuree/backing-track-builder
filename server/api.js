// JSON API for songs, audio files ("stems"), setlists, settings and exports. Data lives in the data folder:
// songs/<id>/song.json, songs/<id>/stems/<file>, setlists/<id>.json, settings.json and
// exports/<title>.wav, so it can be backed up or edited by hand.
import { readFile, writeFile, rename, mkdir, readdir, stat, unlink, open, copyFile, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { join, extname } from 'node:path';
import { validateSong, upgradeSong, uniqueId, sanitizeStemName, LIMITS, ID_RE } from '../shared/song.js';
import { validateSetlist } from '../shared/setlist.js';

const MAX_BODY = 1024 * 1024;
const DEFAULT_MAX_STEM_BYTES = 1024 * 1024 * 1024; // 1 GB; long 24-bit/96 kHz stems are big
const DEFAULT_SETTINGS = { version: 2, routing: { mode: 'split' }, mix: { inEarsDb: 0, mainDb: 0 } };
const MIX_KEYS = ['inEarsDb', 'mainDb']; // master levels of the in-ear (left) and main (right) outputs
const AUDIO_TYPES = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg' };
const ROUTING_MODES = ['split', 'interface'];

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Handles /api/* requests. A route returns JSON, or a function that writes the response itself. */
export async function handleApi(root, req, res, { maxStemBytes = DEFAULT_MAX_STEM_BYTES } = {}) {
  try {
    const result = await route(root, req, apiSegments(req.url), { maxStemBytes });
    if (typeof result === 'function') return await result(res);
    sendJson(res, 200, result);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    sendJson(res, err.status, { error: err.message, ...err.extra });
  }
}

// Split the raw path before decoding, so "%2f" or ".." inside an id stay part of that id
// (and fail the id check) instead of being resolved as path navigation.
function apiSegments(url) {
  const raw = url.split('?')[0].split('/').slice(2); // "/api/songs/x" -> ["songs", "x"]
  try {
    return raw.map(decodeURIComponent);
  } catch {
    throw new HttpError(400, 'Bad request');
  }
}

async function route(root, req, parts, options) {
  const [resource, id, ...rest] = parts;

  if (resource === 'songs' && parts.length === 1) {
    allow(req, ['GET']);
    return listSongs(root);
  }
  if (resource === 'songs' && parts.length === 2 && rest.length === 0) {
    checkId(id);
    const file = join(root, 'songs', id, 'song.json');
    allow(req, ['GET', 'PUT', 'DELETE']);
    if (req.method === 'GET') return upgradeSong(await readJson(file, () => { throw new HttpError(404, 'Song not found'); }));
    if (req.method === 'DELETE') {
      // The song and its audio files go for good; setlists keep the id and show it as missing.
      const dir = join(root, 'songs', id);
      if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new HttpError(404, 'Song not found');
      await rm(dir, { recursive: true });
      return { deleted: id };
    }
    const song = await readBody(req);
    if (song?.id !== id) throw new HttpError(400, 'Song id does not match the URL');
    const errors = validateSong(song);
    if (errors.length) throw new HttpError(400, 'Song is not valid', { errors });
    await writeJson(file, song);
    await pruneStems(join(root, 'songs', id, 'stems'), song.tracks);
    return song;
  }
  if (resource === 'songs' && rest[0] === 'copy' && parts.length === 3) {
    checkId(id);
    allow(req, ['POST']);
    return copySong(root, id);
  }
  if (resource === 'songs' && rest[0] === 'stems' && parts.length === 3) {
    checkId(id);
    allow(req, ['POST']);
    return uploadStem(root, id, req, options.maxStemBytes);
  }
  if (resource === 'songs' && rest[0] === 'stems' && parts.length === 4) {
    checkId(id);
    const name = rest[1];
    if (sanitizeStemName(name) !== name) throw new HttpError(400, 'Invalid stem name');
    const file = join(root, 'songs', id, 'stems', name);
    allow(req, ['GET', 'DELETE']);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new HttpError(404, 'Stem not found');
    if (req.method === 'DELETE') {
      await unlink(file);
      return { deleted: name };
    }
    return (res) => {
      res.writeHead(200, {
        'Content-Type': AUDIO_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'no-cache',
      });
      createReadStream(file).pipe(res);
    };
  }
  if (resource === 'exports' && parts.length === 2) {
    checkId(id);
    allow(req, ['POST']);
    return saveExport(root, id, req, options.maxStemBytes);
  }
  if (resource === 'setlists' && parts.length === 1) {
    allow(req, ['GET']);
    return listSetlists(root);
  }
  if (resource === 'setlists' && parts.length === 2) {
    checkId(id);
    const file = join(root, 'setlists', `${id}.json`);
    allow(req, ['GET', 'PUT', 'DELETE']);
    const notFound = () => { throw new HttpError(404, 'Setlist not found'); };
    if (req.method === 'GET') return readJson(file, notFound);
    if (req.method === 'DELETE') {
      await unlink(file).catch((err) => (err.code === 'ENOENT' ? notFound() : Promise.reject(err)));
      return { deleted: id };
    }
    const setlist = await readBody(req);
    if (setlist?.id !== id) throw new HttpError(400, 'Setlist id does not match the URL');
    const errors = validateSetlist(setlist);
    if (errors.length) throw new HttpError(400, 'Setlist is not valid', { errors });
    await writeJson(file, setlist);
    return setlist;
  }
  if (resource === 'settings' && parts.length === 1) {
    const file = join(root, 'settings.json');
    allow(req, ['GET', 'PUT']);
    if (req.method === 'GET') return withDefaults(await readJson(file, () => ({})));
    const settings = withDefaults(await readBody(req));
    if (!ROUTING_MODES.includes(settings.routing.mode)) {
      throw new HttpError(400, `routing.mode must be one of: ${ROUTING_MODES.join(', ')}`);
    }
    for (const key of MIX_KEYS) {
      const v = settings.mix[key];
      if (typeof v !== 'number' || v < LIMITS.volumeDb[0] || v > LIMITS.volumeDb[1]) {
        throw new HttpError(400, `mix.${key} must be between ${LIMITS.volumeDb[0]} and ${LIMITS.volumeDb[1]} dB`);
      }
    }
    await writeJson(file, settings);
    return settings;
  }
  throw new HttpError(404, 'Not found');
}

// Streams the request body into songs/<id>/stems/, never overwriting an existing stem.
async function uploadStem(root, id, req, maxBytes) {
  const name = sanitizeStemName(decodeHeader(req.headers['x-filename']));
  if (!name) throw new HttpError(400, 'Unsupported file. Use WAV, MP3, M4A, FLAC or OGG.');
  const songFile = join(root, 'songs', id, 'song.json');
  if (!(await stat(songFile).catch(() => null))) throw new HttpError(404, 'Song not found; save it first');

  const dir = join(root, 'songs', id, 'stems');
  const tmp = await receiveFile(dir, req, maxBytes, 'Stem');
  try {
    const file = await freeName(dir, name);
    await rename(tmp.path, join(dir, file));
    return { file, size: tmp.size };
  } catch (err) {
    await unlink(tmp.path).catch(() => {});
    throw err;
  }
}

// Duplicates a saved song as "<title> copy" ("copy 2", "copy 3"…) under a new id, with its own copies
// of the audio files. song.json is written last, so a copy that fails part-way is never listed.
async function copySong(root, id) {
  const source = upgradeSong(await readJson(join(root, 'songs', id, 'song.json'), () => { throw new HttpError(404, 'Song not found'); }));
  const titles = new Set((await listSongs(root)).map((s) => s.title));
  let title = `${source.title} copy`;
  for (let n = 2; titles.has(title); n++) title = `${source.title} copy ${n}`;

  const songsDir = join(root, 'songs');
  let copyId;
  let dir;
  for (;;) {
    copyId = uniqueId(title, await readdir(songsDir));
    dir = join(songsDir, copyId);
    // mkdir claims the folder, so two copies made at once never share one
    const claimed = await mkdir(dir).then(() => true, (err) => (err.code === 'EEXIST' ? false : Promise.reject(err)));
    if (claimed) break;
  }
  try {
    const stems = join(songsDir, id, 'stems');
    const files = (await readdir(stems).catch(() => [])).filter((f) => sanitizeStemName(f) === f);
    if (files.length) await mkdir(join(dir, 'stems'));
    // cloned where the disk supports it (instant, no extra space), copied otherwise
    for (const f of files) await copyFile(join(stems, f), join(dir, 'stems', f), constants.COPYFILE_FICLONE);
    const copy = { ...source, id: copyId, title };
    await writeJson(join(dir, 'song.json'), copy);
    return copy;
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// Saves a rendered WAV as exports/<song title>.wav, replacing that song's previous export.
async function saveExport(root, id, req, maxBytes) {
  const song = await readJson(join(root, 'songs', id, 'song.json'), () => { throw new HttpError(404, 'Song not found'); });
  const name = sanitizeStemName(`${song.title}.wav`) ?? `${id}.wav`;
  const dir = join(root, 'exports');
  const tmp = await receiveFile(dir, req, maxBytes, 'Export');
  try {
    const head = await readHead(tmp.path, 12);
    if (!head.startsWith('RIFF') || head.slice(8, 12) !== 'WAVE') throw new HttpError(400, 'Export must be a WAV file');
    await rename(tmp.path, join(dir, name));
    return { file: name, size: tmp.size, folder: dir };
  } catch (err) {
    await unlink(tmp.path).catch(() => {});
    throw err;
  }
}

async function readHead(file, bytes) {
  const handle = await open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(bytes), 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('latin1');
  } finally {
    await handle.close();
  }
}

// Streams the request body to a hidden temp file in `dir`; rejects with 413 above `maxBytes`.
async function receiveFile(dir, req, maxBytes, what) {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.upload-${process.pid}-${Date.now()}-${++tmpCounter}.part`);
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      const out = createWriteStream(tmp);
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.unpipe(out);
          out.destroy();
          req.resume();
          reject(new HttpError(413, `${what} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
        }
      });
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
    return { path: tmp, size };
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// Uploaded audio files no audio clip of the saved song uses are deleted (they are copies; originals
// stay wherever the user uploaded them from). In-progress uploads (.part files) are left alone.
async function pruneStems(dir, tracks) {
  const used = new Set(tracks.filter((t) => t.type === 'audio').flatMap((t) => t.clips.map((c) => c.file)));
  const files = await readdir(dir).catch(() => []);
  await Promise.all(files
    .filter((f) => sanitizeStemName(f) === f && !used.has(f))
    .map((f) => unlink(join(dir, f)).catch(() => {})));
}

// "Bass.m4a" -> "Bass (2).m4a" when "Bass.m4a" exists.
async function freeName(dir, name) {
  const ext = extname(name);
  const base = name.slice(0, -ext.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${base} (${n})${ext}`;
    if (!(await stat(join(dir, candidate)).catch(() => null))) return candidate;
  }
}

function decodeHeader(value) {
  try {
    return decodeURIComponent(value ?? '');
  } catch {
    return '';
  }
}

// Unknown mix keys (such as the version-1 stem levels) are dropped.
function withDefaults(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const mix = Object.fromEntries(MIX_KEYS.map((k) => [k, s.mix?.[k] ?? DEFAULT_SETTINGS.mix[k]]));
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    version: DEFAULT_SETTINGS.version,
    routing: { ...DEFAULT_SETTINGS.routing, ...s.routing },
    mix,
  };
}

async function listSetlists(root) {
  const dir = join(root, 'setlists');
  const files = await readdir(dir).catch(() => []);
  const setlists = [];
  for (const f of files) {
    const id = f.replace(/\.json$/, '');
    if (id === f || !ID_RE.test(id)) continue;
    const s = await readJson(join(dir, f), () => null).catch(() => null);
    if (s) setlists.push({ id: s.id, name: s.name, count: s.songs?.length ?? 0 });
  }
  return setlists.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function listSongs(root) {
  const dir = join(root, 'songs');
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const songs = [];
  for (const e of entries) {
    if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
    const song = await readJson(join(dir, e.name, 'song.json'), () => null).catch(() => null);
    if (song?.version !== 2 && song?.version !== 3) continue; // older formats can't be opened (2 is upgraded on GET)
    const meter = song.meter?.[0];
    songs.push({ id: song.id, title: song.title, bpm: song.tempo?.[0]?.bpm, meter: [meter?.beats, meter?.unit] });
  }
  return songs.sort((a, b) => String(a.title).localeCompare(String(b.title)));
}

function checkId(id) {
  if (!ID_RE.test(id ?? '')) throw new HttpError(400, 'Invalid id');
}

function allow(req, methods) {
  if (!methods.includes(req.method)) throw new HttpError(405, 'Method not allowed');
}

async function readJson(file, onMissing) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return onMissing();
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(500, `${file} is not valid JSON; fix or delete it`);
  }
}

let tmpCounter = 0;

// Write to a temp file then rename, so a crash mid-save never leaves a half-written song.
async function writeJson(file, value) {
  await mkdir(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`; // unique, so overlapping saves never collide
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, file);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
