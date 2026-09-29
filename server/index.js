// Local server: serves the app page, shared modules, imported samples and the JSON API.
// Binds to 127.0.0.1 only; nothing is reachable from other machines. The code (and the imported
// samples) come from the project folder; your songs, setlists, settings and exports live in the
// data folder (see data-dir.js).
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.js';
import { defaultDataDir, prepareDataDir } from './data-dir.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_PORT = 4747;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// URL prefix -> folder under the project root. Everything else comes from public/.
const MOUNTS = [
  ['/shared/', 'shared'],
  ['/samples/', 'samples'],
  ['/', 'public'],
];

/** @param {{ root?: string, dataDir?: string, port?: number, maxStemBytes?: number }} options dataDir defaults to root */
export function startServer({ root = PROJECT_ROOT, dataDir = root, port = DEFAULT_PORT, maxStemBytes } = {}) {
  const server = createServer((req, res) => handle(root, dataDir, req, res, { maxStemBytes }).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'Server error');
  }));
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok(server));
  });
}

async function handle(root, dataDir, req, res, apiOptions) {
  if (req.url.startsWith('/api/')) return handleApi(dataDir, req, res, apiOptions);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

  let path;
  try {
    path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (path.includes('\0')) return send(res, 400, 'Bad request');
  if (path === '/') path = '/index.html';

  const file = resolveInside(root, path);
  if (!file) return send(res, 404, 'Not found');
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return send(res, 404, 'Not found');

  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

// Maps a decoded URL path to a file inside its mount folder, or null if it would escape it.
function resolveInside(root, path) {
  const [prefix, folder] = MOUNTS.find(([p]) => path.startsWith(p));
  const base = resolve(root, folder);
  const file = resolve(base, '.' + path.slice(prefix.length - 1));
  return file.startsWith(base + sep) ? file : null;
}

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const dataDir = defaultDataDir();
  prepareDataDir(dataDir, { legacyRoot: PROJECT_ROOT })
    .then(({ created, copied }) => {
      if (created) console.log(`Created your data folder: ${dataDir}`);
      if (copied.length) console.log(`Copied ${copied.join(', ')} from the project folder into it (the originals are untouched).`);
      return startServer({ port, dataDir });
    })
    .then(
    () => {
      console.log(`Backing Track Builder running at http://localhost:${port}`);
      console.log(`Songs, setlists and exports: ${dataDir}`);
      console.log('Open it in Chrome. Press Ctrl+C to stop.');
    },
    (err) => {
      console.error(err.code === 'EADDRINUSE'
        ? `Port ${port} is already in use. Is the app already running? Or start with PORT=4748 npm start`
        : err.message);
      process.exit(1);
    },
  );
}
