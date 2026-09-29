// Small helpers shared by the UI modules.

/** Track colors by palette index (song.tracks[].color), Ableton-like. */
export const TRACK_COLORS = [
  '#5ec2b7', '#7ff0a1', '#98c3f7', '#f5a742', '#ff8fa3', '#f3e26b', '#b7e05a',
  '#c69cf4', '#6f8ff0', '#e86c5c', '#d59a5f', '#9fb3c8', '#e79ae0', '#cfcfcf',
];

export const LANGUAGE_NAMES = { en: 'English', fr: 'French', pt: 'Portuguese', es: 'Spanish' };
export const OUTPUT_NAMES = { inEars: 'In-ears', main: 'Main', both: 'Both' };
export const CUE_TYPE_NAMES = { section: 'Section', cue: 'Dynamic cue', count: 'Count' };

export const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true });

export function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function formatDb(db) {
  if (db <= -60) return '−∞ dB';
  return db > 0 ? `+${db} dB` : `${db} dB`;
}

/** "17.3.1" */
export function formatPosition({ bar, beat, sixteenth }) {
  return `${bar}. ${beat}. ${sixteenth}`;
}

/** 83.5 -> "1:23.500" (or "1:23" without millis) */
export function clock(sec, millis = false) {
  const neg = sec < 0 ? '-' : '';
  const abs = Math.abs(sec);
  const m = Math.floor(abs / 60);
  const s = millis ? (abs - m * 60).toFixed(3).padStart(6, '0') : String(Math.floor(abs - m * 60)).padStart(2, '0');
  return `${neg}${m}:${s}`;
}

export function options(values, selected, label = (v) => v) {
  return values.map((v) => `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(label(v))}</option>`).join('');
}

/**
 * Cue names that can be placed for `type` in `language`: the language's own recordings, plus
 * English ones for sections and cues (the engine falls back to English). Counts never fall back.
 * @returns {{ key: string, english: boolean }[]}
 */
export function cueChoices(catalog, language, type) {
  const own = Object.keys(catalog.guides[language]?.[type] ?? {});
  const english = type === 'count' || language === 'en' ? [] : Object.keys(catalog.guides.en?.[type] ?? {}).filter((k) => !own.includes(k));
  return [...own.map((key) => ({ key, english: false })), ...english.map((key) => ({ key, english: true }))]
    .sort((a, b) => byName(a.key, b.key));
}
