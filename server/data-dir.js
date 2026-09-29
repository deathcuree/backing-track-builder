// Where your songs, setlists, settings and exports live: a folder outside the code, so nothing
// done with git (pulling, switching branches, cleaning) can touch them. Default
// ~/Music/Backing Tracks; set BTB_DATA_DIR to use another folder (e.g. on an external drive).
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const SUBFOLDERS = ['songs', 'setlists', 'exports'];
const LEGACY = ['exports', 'settings.json', 'setlists', 'songs']; // what older versions kept in the project

/** @param {Record<string, string|undefined>} env @param {string} home */
export function defaultDataDir(env = process.env, home = homedir()) {
  const custom = env.BTB_DATA_DIR?.trim();
  if (!custom) return join(home, 'Music', 'Backing Tracks');
  return resolve(custom.replace(/^~(?=$|\/)/, home));
}

/**
 * Makes sure the data folder and its subfolders exist. When the folder is new, the data older
 * versions kept in the project folder (`legacyRoot`) is copied in; nothing is moved or deleted,
 * and an existing data folder is never touched.
 * @returns {Promise<{ created: boolean, copied: string[] }>} copied: top-level names that had data
 */
export async function prepareDataDir(dataDir, { legacyRoot } = {}) {
  const created = !(await stat(dataDir).catch(() => null));
  const copied = [];
  if (created && legacyRoot) {
    for (const name of LEGACY) {
      const from = join(legacyRoot, name);
      const info = await stat(from).catch(() => null);
      if (!info) continue;
      const entries = info.isDirectory() ? (await readdir(from)).filter((f) => !f.startsWith('.')) : [name];
      if (!entries.length) continue;
      await cp(from, join(dataDir, name), {
        recursive: true, force: false, errorOnExist: false,
        filter: (src) => !/(^|\/)\.(gitkeep|DS_Store)$/.test(src),
      });
      copied.push(name);
    }
  }
  for (const d of SUBFOLDERS) await mkdir(join(dataDir, d), { recursive: true });
  return { created, copied };
}
