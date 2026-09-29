// Timeline: section blocks (width ∝ bars, colored by family), cue markers, bar numbers and the
// playhead. Clicking a bar asks to add a cue there.

const BAR_WIDTH = 28; // px; must match --bar-width in style.css

const FAMILIES = {
  Intro: 'edge', Outro: 'edge', Ending: 'edge',
  Verse: 'verse',
  'Pre Chorus': 'pre',
  Chorus: 'chorus', 'Post Chorus': 'chorus', Refrain: 'chorus',
  Bridge: 'bridge',
  Tag: 'tag', Vamp: 'tag', Turnaround: 'tag',
};

export function sectionFamily(name) {
  return FAMILIES[name.replace(/\s*\d+$/, '')] ?? 'other';
}

/** @param {HTMLElement} el @param {{ onBarClick: (bar: number) => void }} handlers */
export function createTimeline(el, { onBarClick }) {
  el.classList.add('timeline');
  const track = document.createElement('div');
  track.className = 'timeline-track';
  el.replaceChildren(track);
  let playhead;

  track.addEventListener('click', (event) => {
    const bar = Number(event.target.closest('[data-bar]')?.dataset.bar);
    if (bar) onBarClick(bar);
  });

  return {
    /** @param song the song being edited @param totalBars bars in the song (0 if it cannot be timed) */
    render(song, totalBars) {
      track.style.width = `${Math.max(totalBars, 1) * BAR_WIDTH}px`;
      track.replaceChildren();
      if (!totalBars) {
        track.append(Object.assign(document.createElement('p'), {
          className: 'muted timeline-empty', textContent: 'Fix the errors below to see the timeline.',
        }));
        return;
      }

      const cues = row('timeline-cues');
      for (const cue of song.cues) {
        if (cue.bar < 1 || cue.bar > totalBars) continue;
        const marker = document.createElement('div');
        marker.className = 'cue-marker';
        marker.style.left = `${(cue.bar - 1) * BAR_WIDTH}px`;
        marker.textContent = cue.name;
        marker.title = `${cue.name} (bar ${cue.bar})`;
        cues.append(marker);
      }

      const sections = row('timeline-sections');
      let bar = 1;
      for (const s of song.sections) {
        const block = document.createElement('div');
        block.className = `section-block family-${sectionFamily(s.name)}`;
        block.style.left = `${(bar - 1) * BAR_WIDTH}px`;
        block.style.width = `${s.bars * BAR_WIDTH}px`;
        block.textContent = s.name;
        block.title = `${s.name}: bars ${bar}–${bar + s.bars - 1}`;
        sections.append(block);
        bar += s.bars;
      }

      const bars = row('timeline-bars');
      for (let b = 1; b <= totalBars; b++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'bar-cell';
        cell.dataset.bar = b;
        cell.title = `Add a cue at bar ${b}`;
        cell.setAttribute('aria-label', `Add a cue at bar ${b}`);
        if (b === 1 || (b - 1) % 4 === 0) cell.textContent = b;
        bars.append(cell);
      }

      playhead = document.createElement('div');
      playhead.className = 'playhead';
      playhead.hidden = true;
      track.append(cues, sections, bars, playhead);
    },

    /** @param pos { bar, fraction } from the player, or null when stopped */
    setPosition(pos) {
      if (!playhead) return;
      if (!pos || pos.bar < 1) {
        playhead.hidden = true;
        return;
      }
      playhead.hidden = false;
      const x = (pos.bar - 1 + pos.fraction) * BAR_WIDTH;
      playhead.style.transform = `translateX(${x}px)`;
      const view = el;
      if (x < view.scrollLeft || x > view.scrollLeft + view.clientWidth - 40) view.scrollLeft = x - 40;
    },
  };

  function row(className) {
    const div = document.createElement('div');
    div.className = `timeline-row ${className}`;
    return div;
  }
}
