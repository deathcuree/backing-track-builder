const LANGUAGE_NAMES = { en: 'English', fr: 'French', pt: 'Portuguese', es: 'Spanish' };

const status = document.getElementById('status');

try {
  const res = await fetch('/samples/catalog.json');
  if (!res.ok) throw new Error('missing');
  renderCatalog(await res.json());
} catch {
  status.innerHTML = `
    <p class="warn">No samples imported yet.</p>
    <p>Run this in the project folder, then reload:</p>
    <pre>npm run import-samples -- "/path/to/Click and Guide Samples"</pre>`;
}

function renderCatalog(catalog) {
  const sounds = Object.entries(catalog.clicks)
    .map(([sound, roles]) => `<li><strong>${sound}</strong> <span class="muted">${Object.keys(roles).join(', ')}</span></li>`)
    .join('');
  const languages = Object.entries(catalog.guides)
    .map(([lang, g]) => `<li><strong>${LANGUAGE_NAMES[lang] ?? lang}</strong>
      <span class="muted">${Object.keys(g.section).length} sections, ${Object.keys(g.cue).length} cues,
      count 1–${Object.keys(g.count).length}</span></li>`)
    .join('');
  status.innerHTML = `
    <h2>Click sounds</h2><ul>${sounds}</ul>
    <h2>Guide languages</h2><ul>${languages}</ul>`;
}
