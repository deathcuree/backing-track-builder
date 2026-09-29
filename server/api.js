// JSON API for songs and settings. Data lives as pretty-printed JSON under the project root:
// songs/<id>/song.json and settings.json, so it can be backed up or edited by hand.
import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateSong } from '../shared/song.js';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BODY = 1024 * 1024;
const DEFAULT_SETTINGS = { version: 1, routing: { mode: 'split' } };
const ROUTING_MODES = ['split', 'interface'];

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Handles /api/* requests. */
export async function handleApi(root, req, res) {
  try {
    const result = await route(root, req, apiSegments(req.url));
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

async function route(root, req, parts) {
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
    return song;
  }
  if (resource === 'settings' && parts.length === 1) {
    const file = join(root, 'settings.json');
    allow(req, ['GET', 'PUT']);
    if (req.method === 'GET') return readJson(file, () => DEFAULT_SETTINGS);
    const settings = await readBody(req);
    if (!ROUTING_MODES.includes(settings?.routing?.mode)) {
      throw new HttpError(400, `routing.mode must be one of: ${ROUTING_MODES.join(', ')}`);
    }
    await writeJson(file, settings);
    return settings;
  }
  throw new HttpError(404, 'Not found');
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

// Write to a temp file then rename, so a crash mid-save never leaves a half-written song.
async function writeJson(file, value) {
  await mkdir(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
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
