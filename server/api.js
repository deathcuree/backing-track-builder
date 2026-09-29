// JSON API for songs, stems, setlists and settings. Data lives under the project root:
// songs/<id>/song.json, songs/<id>/stems/<file>, setlists/<id>.json and settings.json, so it can
// be backed up or edited by hand.
import { readFile, writeFile, rename, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, extname } from 'node:path';
import { validateSong, sanitizeStemName, LIMITS, ID_RE } from '../shared/song.js';
import { validateSetlist } from '../shared/setlist.js';

const MAX_BODY = 1024 * 1024;
const DEFAULT_MAX_STEM_BYTES = 1024 * 1024 * 1024; // 1 GB; long 24-bit/96 kHz stems are big
const DEFAULT_SETTINGS = { version: 1, routing: { mode: 'split' }, mix: { inEarStemsDb: 0, mainStemsDb: 0 } };
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
    allow(req, ['GET', 'PUT']);
    if (req.method === 'GET') return readJson(file, () => { throw new HttpError(404, 'Song not found'); });
    const song = await readBody(req);
    if (song?.id !== id) throw new HttpError(400, 'Song id does not match the URL');
    const errors = validateSong(song);
    if (errors.length) throw new HttpError(400, 'Song is not valid', { errors });
    await writeJson(file, song);
    await pruneStems(join(root, 'songs', id, 'stems'), song.stems);
    return song;
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
    for (const key of ['inEarStemsDb', 'mainStemsDb']) {
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
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.upload-${process.pid}-${Date.now()}.part`);
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
          reject(new HttpError(413, `Stem is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
        }
      });
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
    const file = await freeName(dir, name);
    await rename(tmp, join(dir, file));
    return { file, size };
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// Uploaded stems the saved song no longer lists are deleted (they are copies; originals stay
// wherever the user uploaded them from). In-progress uploads (.part files) are left alone.
async function pruneStems(dir, stems) {
  const used = new Set(stems.map((s) => s.file));
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

function withDefaults(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    routing: { ...DEFAULT_SETTINGS.routing, ...s.routing },
    mix: { ...DEFAULT_SETTINGS.mix, ...s.mix },
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
    if (song) songs.push({ id: song.id, title: song.title, bpm: song.bpm, meter: song.meter });
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
