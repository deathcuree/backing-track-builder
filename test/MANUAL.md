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

## BTB-05: Stems

Setup: a saved song with the right BPM and sections for a MultiTracks song, headphones on.

1. **Upload.** Stems → "+ Add stems…" → pick the song's stem files (WAV/MP3/M4A/FLAC/OGG).
   Each appears as a row; press Save.
2. **In sync.** Play: count-in, then the stems start exactly on bar 1 with the click. If they drift
   or start early/late, adjust "Stem offset (ms)" (positive = stems later) and press Play again.
3. **Left vs right.** Left ear: click + guide + stems. Right ear: stems only, never click or guide.
4. **Live mix.** While playing, move a stem's volume and tick Mute: the change is heard within a
   moment. Switch songs without saving → the Save/Discard prompt appears.
5. **Output mix.** Sidebar sliders: "Stems in the in-ears" changes only the left side, "Stems to
   main" only the right. Reload the page: the sliders keep their values.
6. **Missing file.** Delete a stem file from `songs/<id>/stems/` by hand and press Play: a "Heads up"
   message names the stem and the click still plays.
7. **Memory (Chrome Task Manager, Shift+Esc).** Play a song with many stems, switch to another song
   and play it: the tab's memory drops back instead of adding up.

### Results
- 2026-09-29 (automated, headless Brave via DevTools protocol, isolated data folder; generated test stem
  with a 1 kHz burst every 0.5 s; the player's real output recorded with an AudioWorklet tap):
  - AC 8: right channel (click+guide+stems) minus right channel (stems only) = −∞ dB (identical).
  - Stems silent during the count-in; first stem hit 1999.93 ms after the first click (expected 2000);
    +100 ms offset → 2099.93 ms.
  - Live mute: right channel −92 dB 50 ms after muting; left keeps the click.
  - Broken, missing and too-short stems give warnings; click keeps playing.
  - AC 13: after switching songs the player holds only the new song's decoded stems.
  - UI: stem button disabled until the song is saved; upload via the button; unsupported file named in
    a message; volume/mute saved; unused uploaded copies removed on Save; output mix persists.
  - Not yet done: steps 2–5 and 7 by ear / Task Manager on the user's laptop with real MultiTracks stems.

## BTB-06: Live player (setlist, jump, loop)

Setup: three saved songs (at least one with stems), headphones on. Click **Live** in the top bar.

1. **Setlist.** "+ New", rename it, add the three songs, reorder with ↑/↓. Stop and restart the
   server (`npm start`), reload, click Live: the setlist is still there and selected.
2. **Songs.** ◀ Prev / Next ▶ (or ←/→) change the song only while stopped; the song and its stems
   load right away ("loading stems…").
3. **Jump.** Play. In the middle of a verse press **3** (or click a section button): the button gets
   a dashed outline, the status says "Jumping to …", and at the next bar line the band tracks and
   click continue from that section with no gap or double click. Pressed early in a bar you also
   hear the section's name on the next beat. Press the same number again before the bar ends to cancel.
4. **Loop.** Press **L** during a section: it repeats (tracks too) until you press L again, then the
   song carries on. Leave it looping for a few minutes and listen for drift between click and tracks.
5. **Live mute.** Mute a stem and move a fader while playing: heard immediately, "Live changes not
   saved" appears. "Save mix" keeps it; switching songs without saving throws it away.
6. **Rehearsal.** Run the whole setlist top to bottom with count-in, one jump, one loop, one mute.

### Results
- 2026-09-29 (automated, headless Brave via DevTools protocol, isolated data folder; test stems whose
  burst pitch encodes the bar number; the player's real output recorded with an AudioWorklet tap):
  - AC 6: jump requested mid-bar 2 → at the next downbeat (6.000 s) the stem plays bar 13 (1600 Hz);
    click intervals 499.2–500.7 ms throughout (no gap/double hit); stem vs click at the seam 1.0 ms.
  - Announce: jump at ¼ of the bar → "Chorus" spoken at 5.009 s (next beat).
  - AC 7: Intro looped for 20 s at 240 BPM: stem bars 1,2,3,4 ×4, then 5,6,7,8 after release; click grid
    drift −0.1 ms over 81 clicks; stem vs click −0.02 to 1.45 ms at every seam.
  - UI: setlist create/rename/add, ←/→ only while stopped, key 3 → pending → Chorus at bar 13, L → looping,
    live mute → "Save mix" saved to the song, setlist survives server restart, no console/server errors.
  - Not yet done: minutes-long loop by ear and the full rehearsal (steps 4 and 6) on the user's laptop.

## BTB-07: WAV export

1. Open a saved song with stems in the Edit view and press **Export WAV** (it is disabled while there
   are unsaved changes). The note says "Exported <title>.wav (m:ss) to the exports folder" and the
   browser downloads the same file.
2. Play the file in QuickTime or on a phone: it starts right on bar 1 (no count-in), click and guide
   in the **left** ear only, band tracks in the **right** ear only, same length as the song.
3. Mute a stem, Save, export again: that stem is missing from the file, which replaces the old one.
4. As a backup rig: phone → 3.5 mm-to-dual-¼″ Y-cable → left to the in-ear mixer, right to front of house.

### Results
- 2026-09-29 (automated, headless Brave, isolated data folder; bar-pitch test stem + a muted 3 kHz tone):
  - AC 10: first click on the left at 0.091 ms (the sample's own attack); 40.000 s = 20 bars at 120 BPM;
    right channel = stems (bar 1 at 400 Hz, bar 13 at 1600 Hz at 24 s); muted stem absent; left identical to a
    render without stems; +100 ms offset → stems at 100.045 ms.
  - Export button → exports/Way Maker (Live).wav; `afinfo`: WAVE, 2 ch, 44100 Hz, Int16, 40.000000 s;
    read back independently with Python: click at 0.045 ms left, stem at 0.045 ms right, silence between.
  - Not yet done: playing the file in QuickTime / on a phone by ear (steps 2–4).

> From BTB-09 on, the Edit/Live views and the old song format are gone. The BTB-04 to BTB-07 steps
> above describe that older UI; the timing, routing and export checks they record still apply to
> the new engine through the sections below.

## BTB-09: Arrangement View, playback and export

Setup: `npm start`, open http://localhost:4747 in Chrome (or Brave), wear headphones. Have a song
recorded to a click at a steady tempo (e.g. a MultiTracks stem or full mix).

1. **Build a song.** Browser → **+ New**. In the Detail panel type the title; in the Control Bar
   type or **Tap** the BPM and pick the time signature. **Import audio** → pick the song: it is
   saved first, an audio track with its waveform appears, and the end bar grows to fit it.
2. **Line it up.** Select the audio track and change **Clip start (s)** until the song's first
   downbeat sits on bar 3 (zoom with −/+ or Cmd/Ctrl + scroll to check the waveform against the grid).
3. **Count-in and cues.** Click the bar ruler at bar 2 (the orange start marker moves there). Click
   Counts → 1, 2, 3, 4 in the Browser; set each one's beat in the Detail panel. Add a section cue
   ("Intro") and a dynamic cue ("Build") the same way.
4. **Locators and markers.** With the start marker on bar 3, **+** on the Locators strip → name it
   "Intro". Add a time signature marker where the song changes meter (e.g. 3/4) and a tempo marker if it
   changes tempo. Bars after a meter marker get narrower or wider.
5. **Problems.** Put a cue on a beat that doesn't exist (beat 4 in a 3/4 bar): it is outlined in red,
   the status bar names the problem (click it to select the cue), and Play and Save are refused.
   Delete it (Delete key or the Detail panel's Delete).
6. **Play.** Click the bar ruler at bar 1, press Space: you hear the click from bar 1, the counts
   on bar 2, and the song from bar 3 exactly on the click. The playhead follows. Stop with Space.
7. **Live levels.** While playing: the track volume sliders and M buttons change what you hear within
   a moment; set the song's output to **In-ears** and the right ear goes silent; set the Click to **Main**
   and it moves to the right ear. The **In-ears** and **Main** master sliders survive a reload.
8. **Export.** Save, then **Export WAV**: left = everything routed to In-ears or Both, right =
   everything routed to Main or Both, from bar 1 to the end bar.

### Results
- 2026-09-29 (automated, headless Brave via DevTools protocol, isolated data folder; a generated
  21 s test "song": 1.0 s of silence, then a 1 kHz burst every 0.5 s):
  - Steps 1–5 driven through the real UI: save → import (upload, waveform, 3 tracks) → clip start 3.0 s →
    counts 1–4 on bar 2 and "Intro" at 2.3.3 → locators Intro (bar 3) and Verse 1 (bar 7) → 3/4 marker
    at bar 7 → "Build" on beat 4 of bar 7 outlined in red, status "Bar 7 has 3 beats; beat 4 doesn't
    exist.", Play refused, deleted → saved. The song.json on disk matches.
  - Step 6: Play from bar 1 → after 2.6 s the position reads 2. 2. 1 and the playhead is at 0:02; no
    console errors.
  - Step 7 (offline render of the real routing, −12 dB track): −24.0 dB on both sides before; muted →
    −60 dB 50 ms later; output In-ears → right −61.5 dB 50 ms later; In-ears master −6 → left −29.9 dB.
  - Step 8: exported Test Song.wav is 27.000 s (6 bars × 2 s in 4/4 + 10 bars × 1.5 s in 3/4). Right
    channel: 40 bursts from exactly 4.000 s (bar 3), no click. Left: click onsets every 0.500 s from
    0.000 s, continuing through the 3/4 change at 12.000 s.
  - Zoom: Cmd/Ctrl + wheel and −/+ change the width around the pointer; deep zoom shows sixteenth
    lines with the test bursts on the beat lines.
  - Not yet done: steps 1–8 by ear with a real song on the user's laptop.
