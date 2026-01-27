---
name: songsee
description: Generate spectrograms and feature-panel visualizations from audio with the songsee CLI.
homepage: https://github.com/steipete/songsee
metadata: {"moltbot":{"emoji":"🌊","requires":{"bins":["songsee"]},"install":[{"id":"brew","kind":"brew","formula":"steipete/tap/songsee","bins":["songsee"],"label":"Install songsee (brew)"}]}}
---

# songsee

Generate spectrograms + feature panels from audio.

Quick start
- Spectrogram: `songsee track.mp3`
- Multi-panel: `songsee track.mp3 --viz spectrogram,mel,chroma,hpss,selfsim,loudness,tempogram,mfcc,flux`
- Time slice: `songsee track.mp3 --start 12.5 --duration 8 -o slice.jpg`
- Stdin: `cat track.mp3 | songsee - --format png -o out.png`

Common flags
- `--viz` list (repeatable or comma-separated)
- `--style` palette (classic, magma, inferno, viridis, gray)
- `--width` / `--height` output size
- `--window` / `--hop` FFT settings
- `--min-freq` / `--max-freq` frequency range
- `--start` / `--duration` time slice
- `--format` jpg|png

Notes
- WAV/MP3 decode native; other formats use ffmpeg if available.
- Multiple `--viz` renders a grid.
