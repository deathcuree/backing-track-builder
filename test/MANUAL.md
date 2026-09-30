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
2. **Line it up.** Click the audio clip and change **Clip start (s)** until the song's first
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
9. **Insert marker.** Click anywhere in the arrangement (an empty lane, inside a waveform, or the bar
   ruler): a steady line and the orange triangle mark the spot, snapped to the grid for the zoom
   (Cmd/Ctrl-click for sixteenths), and the position box shows it. Click a Browser cue: it lands on the
   marker. **+** on Locators/Tempo/Time sig. adds at the marker's bar. Press Play: playback starts at
   the marker, even in the middle of a bar; Stop returns to it.

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
  - Step 9 (added after review, 2026-09-29): click inside the waveform at 9.3 s → marker 5.4.1 (1/4
    grid at that zoom) and the audio track selected; Cmd-click in the Click lane → 5.3.3; Browser
    "Build" added at 5.3.3; + Locator → bar 5. Play from 5.3.3 (9.25 s): position 5. 3. 4 right after
    Play; recorded output: the Build cue at the start, then the next beats at +0.25 s, +0.75 s, … on both
    the click and the song (in step); Stop → back at 5. 3. 3.
  - Not yet done: steps 1–9 by ear with a real song on the user's laptop.

## BTB-10: Direct editing in the Arrangement

1. **Drag cues.** Drag a cue left/right: it snaps to the grid (Control Bar → Grid: Auto follows the
   zoom; or 1 Bar, 1/4, 1/8, 1/16) and a small readout shows the position. Hold Cmd (Ctrl on Windows)
   for sixteenths. Letting go outside the song puts it back.
2. **Drag locators and markers.** They snap to bars. Dropping a locator on another locator's bar (or a
   marker on another marker's bar) is refused with a message. The bar-1 tempo and time signature
   markers don't move.
3. **Drag an audio clip.** It moves freely; the readout shows the start time to the millisecond. Zoom
   in and line the first downbeat up with a bar line. It can't be dropped over another clip on its
   track (it turns red and goes back).
4. **Drag from the Browser.** Drag "Build" from Cues → Dynamic cues onto the Cues track: a line shows
   where it will land, and it is added there and selected.
5. **Double-click** the Locators, Tempo or Time sig. strip to add one at that bar.
6. **Loop.** Shift-drag across the bar ruler to set the loop brace (or select a locator: the brace
   follows its section). Press **Loop** and Play: after the brace's last bar playback jumps back to
   its first bar with no gap or double click. Press Loop again: playback carries on past the brace.

### Results
- 2026-09-29 (automated, headless Brave via DevTools protocol, real mouse events; isolated data folder
  and the BTB-09 test song):
  - Steps 1–3 and 5: cue at 2.4.1 dragged +1.1 s → 3.2.1 (Auto = 1/4 at that zoom); Cmd-drag +0.3 s →
    3.2.3; Grid 1 Bar → 4.1.1. Locator Verse 1 → bar 10; onto Intro's bar → refused ("There is already
    a locator at bar 3."). 3/4 marker → bar 8; bar-1 tempo marker doesn't drag. Clip → 2.500 s.
    Double-click on the locator strip → "Section" locator added.
  - Step 4: headless Brave does not start native drags from synthetic mouse input, so the drop was
    checked with DragEvents carrying a real DataTransfer: dragstart puts the cue in the
    `application/x-btb-cue` payload; dragover on the Cues lane is accepted, shows the drop line and
    "5.3.1"; the drop adds "Build" at 5.3.1 and selects it. Over the Click lane and past the song end:
    not accepted.
  - Step 6 (player output recorded with a test-only tap on the audio destination): brace bars 3–4,
    Loop on, play from bar 3 → position 3→4→3→4→3; in-ear click intervals exactly 0.500 s through
    every seam; song (main) intervals 0.4989–0.5011 s. Selecting the Intro locator set the brace to bars
    3–6; Loop off during bar 5 → playback continued 6→7→…→10.
  - Not yet done: a real mouse drag from the Browser in Chrome (step 4), and all steps by ear.

## BTB-11: Session View and setlists

1. **Switch views.** Press Tab (or the Arrangement / Session buttons): the Session View shows one
   column per track (fader, M, output) with In-ears and Main master strips, and one row per locator
   on the right. Tab again while playing: playback continues; the arrangement is where you left it.
2. **Launch.** Stopped: click a section row (or press its number, 1–9): playback starts at that
   locator. Playing: press another section: the row blinks and playback jumps there at the next bar
   line; press it again before then to cancel.
3. **Loop.** Press L: the section you hear loops (row outlined orange, Loop button on). L again
   releases it. Jumping to another section also releases it.
4. **Setlists.** Browser → Setlists → **+ New**, name it, open songs and **+ Add open song**. Reorder
   with ↑/↓ (hover a song), remove with ✕. While stopped, ← / → open the previous / next song (with
   the Save / Discard / Cancel prompt if there are unsaved changes); while playing they do nothing.
   Reload: the same setlist is selected. **Delete setlist** asks "Really delete?" first.

### Results
- 2026-09-29 (automated, headless Brave via DevTools protocol, real key events; player output
  recorded with a test-only tap on the audio destination):
  - Step 1: Tab → Session with 3 columns and 2 rows (Intro 3–6, Verse 1 7–16); cells show "4/4 · 120",
    "3/4 · 120" for the Click and ▶ where the song plays. Tab back while playing: still playing,
    arrangement scrollLeft unchanged (120).
  - Step 2: row 2 launched while stopped → 7. 3. 1 after 1.2 s; key 1 → Intro rows marked pending and
    "Jumping to Intro at the next bar (press again to cancel)" → position 7→3; keys 2, 2 → cancelled
    (3→4, "Playing Intro").
  - Step 3: L → Loop on, "Looping Intro (press L to release)", bars 4→5→6→3→4→5; key 2 → 5→7 and the
    Loop button turned off.
  - Seams over the whole run: in-ear click intervals exactly 0.500 s (n 33); song (main) 0.4989–0.5011 s.
  - Step 4: setlist "Sunday AM" with both songs; ← with unsaved changes → prompt → Discard → previous
    song opened; → next song; ↑/↓ reorder saved; while playing → ignored and songs disabled; after a
    reload the setlist is still selected; delete needed two clicks.
  - Not yet done: a full rehearsal by ear on the user's laptop.

## BTB-12: Undo/redo, Cmd+S, drag-and-drop import, solo

1. **Undo/redo.** Drag a cue, type a new title, drag a track's volume fader, delete a cue. Cmd/Ctrl+Z
   undoes them one at a time (a whole drag, a burst of typing or a fader move is one step);
   Cmd/Ctrl+Shift+Z (or Ctrl+Y) redoes. Undoing everything shows "Saved" again. In a text field,
   Cmd+Z undoes the typing as usual. Opening another song starts a fresh history.
2. **Save.** Cmd/Ctrl+S saves (no browser "Save page" dialog).
3. **Drop audio.** Drag audio files from Finder onto the arrangement: one new track per file, clip at
   0 s. Drop on an audio lane that has no clips: the file goes into that lane. Other files are listed
   as "Not added". Dropping a file anywhere else does nothing (the page stays open).
4. **Solo.** Click S on a track: only that track is heard (the click too, as in Ableton). Click it
   again: everything is heard. Cmd/Ctrl-click S adds or removes tracks from the solo. Works in both
   views; never saved with the song and never in the export.

### Results
- 2026-09-29 (automated, headless Brave via DevTools protocol, real mouse and Cmd key events; player
  output recorded with a test-only tap on the audio destination):
  - Step 1: drag of cue "4" (2.4.1 → 3.3.1), title typed in 3 bursts, fader −3/−6/−9/−12, cue "1"
    deleted → 4 × Cmd+Z undid exactly those four steps in reverse (cue back, fader back to 0, title
    back, cue at 2.4.1) and the state read "Saved"; a 5th Cmd+Z did nothing; Cmd+Shift+Z redid the drag.
  - Step 2: Cmd+S → "Saved".
  - Step 3 (DragEvents with real File objects; headless can't drag from Finder): Pad.wav + notes.txt
    dropped → a "Pad" track with its clip and 1 heads-up for the .txt; dropped on an empty audio lane →
    that lane got the clip; a drop on the Browser was prevented and added nothing.
  - Step 4, peaks per channel (bars 1–2 = click + counts; bars 3+ = song enters):
    no solo L −4.5/−2.2 dB, R silent/−4.4; solo song → bars 1–2 silent on both sides, song on both after;
    + Cmd-click Click → click back in bars 1–2; solo Cues only → only the cues (R silent throughout);
    solo off → as with no solo. The saved song has no solo field.
  - Not yet done: dragging real files from Finder, and all steps by ear.

## BTB-13: Data folder outside the project

1. **First start.** `npm start`: the terminal says "Created your data folder: …/Music/Backing Tracks",
   and, if the project folder still had songs/setlists/settings from older versions, "Copied … into
   it (the originals are untouched)". Every start prints "Songs, setlists and exports: <folder>".
2. **Where things go.** Create and save a song, a setlist and an export: they appear in
   `~/Music/Backing Tracks/songs`, `setlists`, `settings.json` and `exports`. The export note in the app
   shows that folder. Nothing new appears in the project folder, and `git status` stays clean.
3. **Git can't touch it.** `git pull`, switching branches, even deleting the project and cloning it
   again: your songs are still in the Music folder.
4. **Another folder.** `BTB_DATA_DIR=~/Dropbox/Backing\ Tracks npm start` uses that folder instead
   (it is created on first use). An existing folder is never filled from the project or overwritten.

### Results
- 2026-09-29: `npm test` 133 passing (new: data folder choice and preparation, and a server with separate
  code and data folders). The real start path with `BTB_DATA_DIR` set to a temporary folder: created it,
  copied the project's old `songs/` in (project copy untouched), a saved song landed there, a second start
  copied nothing. Not run against the user's real ~/Music folder, so their first start does that.

## Full screen

1. **Enter.** Click ⛶ at the right of the Arrangement / Session buttons (or press F outside a text
   field): the browser's tabs, address bar and bookmarks disappear and the app fills the screen;
   the ⛶ button turns orange.
2. **Leave.** Press F or click ⛶ again, or press Esc: the browser comes back and ⛶ is grey again.
   Playback is not interrupted either way.

## BTB-14a: Audio clips on a track (song format 3)

Setup: a song saved before this change, with an audio track. For steps 4–6, a song with two clips on
one track (until BTB-14b adds Split, edit song.json by hand: give the track `"clips"` with two entries
such as `{ "file": "Band.wav", "startSec": 0, "offsetSec": 0, "lengthSec": 5 }` and
`{ "file": "Band.wav", "startSec": 10, "offsetSec": 10, "lengthSec": 10 }`).

1. **Older songs.** The song saved before this change is in the song list, opens, looks and plays as
   before. After Save, its song.json has `"version": 3` and `"clips"` in place of `"clip"`.
2. **Select a clip.** Click the clip: it is outlined and the Detail panel shows **Audio clip** (File,
   Clip start, Starts in file, Length: "to end of file" for a whole file) with the track's name,
   volume, mute, output and color below. Click the track's name in its header: **Audio track** with
   "Click a clip in the lane to edit it."
3. **Delete.** With a clip selected, Delete (or **Remove clip**) removes only that clip; the track and
   its mixer stay, and an empty lane says "No audio. Drop a file here or use Import audio." Cmd+Z
   brings the clip back. With the track's name selected, Delete removes the whole track.
4. **Two clips.** Each shows only its part of the waveform. Drag the second clip onto the first: red,
   and it goes back. Drag it into free space: it moves.
5. **Play and export.** Play from bar 1: the first 5 s play, then silence until 10 s, then the file
   from 10 s on. Start from a later bar, launch or loop a section across the gap: the same. Export WAV
   and listen: the same.
6. **Session view.** A section is ▶ on the audio column when any clip of it plays in the section.

### Results
- 2026-09-30: `npm test` 147 passing (new: format 3 validation, upgrading version-2 songs, clip ends,
  the schedule's clip windows, the server upgrading on load, refusing overlaps and keeping shared files).
  App run against a temporary data folder with a version-2 song and a 20 s test WAV (four loudness
  steps), driven in headless Chrome for Testing via the DevTools protocol with real mouse and key events:
  - Step 1: the v2 song was listed and opened as one clip (offset 0, to end of file); song.json stayed v2
    until saved.
  - Step 2: clicking the clip selected it and showed the Audio clip panel (Band.wav, 0, 0.000, to end of
    file, then the Band track fields); the header name showed the Audio track panel with the hint.
  - Step 3: Delete on a clip left the Band track with 1 clip; Cmd+Z restored 2; deleting both left the
    empty-lane hint and the track; Delete on the header name removed the track.
  - Step 4: dragged to ~6 s and ~5.1 s: moved (0:06.000, 0:05.100); to ~4.8 s (over the first clip):
    refused and back at 0:05.100. Waveforms showed each clip's own part of the file. Dragging to *exactly*
    5.000 s by mouse lands a millisecond short and is refused; typing 5 in Clip start gives an exact fit.
  - Step 5 (audio source starts recorded in the page): from bar 1 → clip 1 at +0 s, file 0 s for 5 s;
    clip 2 at +10 s, file 10 s for 10 s. From bar 4 (6 s) → only clip 2, at +4 s, file 10 s for 10 s.
    Export: same two starts; the exported main channel's loudness per second was
    0.14 ×5, silence ×5, 0.28 ×5, 0.51 ×5, silence (the file's 10–20 s part at 10–20 s).
  - Step 6: ▶ ▶ for Intro and Verse. No console errors.
  - Not checked by ear.


## BTB-14b: Split audio clips (Cmd/Ctrl+E)

Setup: a song with an audio track (a stem or a full mix).

1. **Split.** Click inside the clip where you want to cut (the insert marker moves there, snapped to the
   grid; hold Cmd/Ctrl for sixteenths) and press Cmd/Ctrl+E. There are now two clips meeting at the
   marker, the right one selected: its panel shows the new Clip start, Starts in file and Length. Play
   across the cut: it sounds exactly as before.
2. **Undo/redo.** Cmd/Ctrl+Z puts the single clip back; Cmd/Ctrl+Shift+Z splits it again.
3. **Cut out a part.** Split at the start and end of a part and Delete the middle clip: that stretch is
   silent when you play from bar 1, launch or loop a section across it, and in Export WAV.
4. **Can't split.** Cmd/Ctrl+E with nothing or a track name selected → "Select an audio clip to split it.";
   with the marker outside the selected clip → "Place the insert marker inside the clip to split it.";
   right after opening a song, before the audio has loaded → "The audio is still loading; try again in a
   moment."; on a clip whose file can't be decoded → "This clip's audio could not be read." The song
   doesn't change.
5. **Keys.** Cmd/Ctrl+E while typing in a field does nothing; Cmd/Ctrl+S still saves.

### Results
- 2026-09-30: `npm test` 154 passing (new: splitClip, including the spec example, clips with a window,
  clips before bar 1, the pieces meeting exactly and validating, refusals within 1 ms of the edges, past
  the audio, and when the file length is unknown). App run against a temporary data folder (20 s test WAV,
  plus an undecodable "Bad.wav"), driven in headless Chrome for Testing via the DevTools protocol with
  real mouse and key events:
  - Step 1: click at ~5.2 s snapped to 5 s (3.3.1); Cmd+E → clips 0–5 s and 5–20 s, right one
    selected (Clip start 5, Starts in file 5.000, Length 15.000). A second split at 8 s → 5–8 s and 8–20 s.
  - Step 2: Cmd+Z → 1 clip, Cmd+Shift+Z → 2.
  - Step 3 (audio source starts recorded in the page): with the 0–5 s clip deleted, Play from bar 1 →
    file 5 s for 3 s at +5 s, then file 8 s for 12 s at +8 s. Launch Verse (6 s) → file 6 s for 2 s at once,
    then file 8 s at +2 s. Split at 6 s while playing, saved, exported: 3 starts (5 s/1 s, 6 s/2 s,
    8 s/12 s) exactly as saved.
  - Step 4: all four notes as listed, the clip count unchanged each time (the "still loading" case with
    decoding slowed down on purpose).
  - Step 5: Cmd+E with the Clip start field focused → no split; Cmd+S → saved with the clips as shown.
  - No console errors. Not checked by ear.
