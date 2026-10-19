# Agent workflow film

The settled 62.2-second introduction to agents sharing a Forgejo project record.
It illustrates a team policy; fgj does not dispatch agents or impose that policy.

- [workflow.mp4](workflow.mp4): silent 30 fps film, suitable for download or video playback.
- [poster.png](poster.png): the open PR and accumulated agent comments, used by the root README.
- [index.html](index.html): the editable, seekable film with its timeline, styling, and transcript inline. Download the repository and open this file in a browser, or serve the repository with a static HTTP server. Repository file viewers may show its source instead of running it.
- [DESIGN.md](DESIGN.md): the settled product story, art direction, motion rules, and future Impeccable brief.
- [commands.txt](commands.txt): the full command inventory shown in the credits at the time of this cut. Use `fgj help` for the installed version's current commands.

The HTML uses the existing [white wordmark](../brand/fgj-wordmark-white.svg).
The MP4 is captured from the HTML at 1440 × 810, 30 frames per second, with H.264,
YUV 4:2:0, and fast-start metadata. The poster is the frame at 49 seconds.

This directory owns documentation media, not runtime code or team workflow rules.

## Reproduce the media

Serve the repository with a static server, open this directory's HTML in Playwright,
and wait for `document.fonts.ready`. Use a 1440 × 810 viewport. Hide the outer header,
controls, inventory link, note and transcript; set the viewport border and main
padding to zero. Keep the film's internal logo and header visible.

Pause playback, call `resize()`, and for frame `i` evaluate `position = i / 30; render()`.
Capture the viewport as `film-00000.png` through `film-01865.png` in a temporary
folder. This samples the deterministic timeline, avoiding dropped real-time frames.
Capture `poster.png` separately at `position = 49; render()`.

Encode those 1,866 frames with FFmpeg (replace the temporary input path):

```sh
ffmpeg -framerate 30 -i /tmp/fgj-film/film-%05d.png -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart -an assets/demo/workflow.mp4
```

Use `ffprobe` to verify 1440 × 810, 30 fps and 62.2 seconds. The HTML is the source
of truth; the MP4 and poster are derived media. No build or runtime dependency is
added to fgj for this documentation export.
