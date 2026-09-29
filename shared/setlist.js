// Setlist model: an ordered list of song ids for a service or gig. Shared by the live view and
// the server. A song may appear more than once; ids of deleted songs are kept and shown as missing.
import { ID_RE } from './song.js';

export const MAX_SETLIST_SONGS = 200;

export function newSetlist(name = 'New setlist') {
  return { version: 1, id: '', name, songs: [] };
}

/** @returns {{ path: string, message: string }[]} empty when the setlist can be saved */
export function validateSetlist(setlist) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (!setlist || typeof setlist !== 'object' || Array.isArray(setlist)) {
    fail('', 'Setlist must be an object.');
    return errors;
  }
  if (typeof setlist.name !== 'string' || !setlist.name.trim()) fail('name', 'Give the setlist a name.');
  if (!Array.isArray(setlist.songs) || setlist.songs.length > MAX_SETLIST_SONGS) {
    fail('songs', `A setlist holds up to ${MAX_SETLIST_SONGS} songs.`);
  } else {
    setlist.songs.forEach((id, i) => {
      if (typeof id !== 'string' || !ID_RE.test(id)) fail(`songs[${i}]`, 'Not a valid song id.');
    });
  }
  return errors;
}
