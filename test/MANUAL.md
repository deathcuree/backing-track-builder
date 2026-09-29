# Manual checks

Things that need ears, real hardware or a real browser. Record the date and result under each ticket.

## BTB-04: Song editor and click/guide playback

Setup: `npm start`, open http://localhost:4747 in Chrome (or Brave), wear headphones.

1. **Create and save.** New song → title "Test", 120 BPM, 4/4, count-in 1 bar, sections Intro 4 and
   Verse 1 8 (remove Chorus). Save. Stop the server (Ctrl+C), `npm start` again, reload: the song is
   still in the list with the same settings.
2. **Sounds on the grid.** Press Play (or Space). You should hear: "Intro" then "3, 4" over four
   clicks, an accented click on every bar's beat 1, and "Verse 1" spoken during bar 4.
   The playhead moves across the timeline; the top bar shows "Count-in · beat n" then "Bar n · beat n · Intro".
3. **Left ear only.** Click and guide are only in the **left** ear. The right ear is silent (it is the
   main/audience feed, reserved for stems).
4. **Fallbacks.** Set the click sound to Digital and subdivision to Eighths, and the guide language to
   French with a "Build" cue. The yellow "Heads up" box lists the substitutions; playback still works.
5. **Stop.** Press Stop or Space: sound stops at once and the position returns to "Stopped".
6. **Unsaved changes.** Change the BPM, then click another song: a bar asks Save / Discard / Cancel.

### Results
- 2026-09-29 (automated, headless Brave via DevTools protocol, isolated data folder):
  - Offline render of the AC 2 song through the split routing: right channel peak exactly 0, left
    −1.8 dBFS; 52/52 click onsets found, max 0.998 ms off a 0.5 s grid (explained by the beat sample's
    attack starting 1.04 ms later in its file than the accent's; scheduling itself is exact).
  - Guide events: Intro 0 s, "3" 1.0 s, "4" 1.5 s, Verse 1 8.0 s (bar 4), Build 12.0 s (bar 6).
  - UI: create/edit/save, song survives server restart, inline BPM error, French fallback warning,
    unsaved-changes prompt, Play → count-in → bar 1 with moving playhead, Space stops, no console errors.
  - Not yet done by ear on the user's laptop: steps 2–3 above.
