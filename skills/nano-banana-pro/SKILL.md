---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image (Nano Banana Pro).
homepage: https://ai.google.dev/
metadata: {"moltbot":{"emoji":"🍌","requires":{"bins":["uv"],"env":["GEMINI_API_KEY"]},"primaryEnv":"GEMINI_API_KEY","install":[{"id":"uv-brew","kind":"brew","formula":"uv","bins":["uv"],"label":"Install uv (brew)"}]}}
---

# Nano Banana Pro (Gemini 3 Pro Image)

Use the bundled script to generate or edit images.

Generate
```bash
uv run {baseDir}/scripts/generate_image.py --prompt "your image description" --filename "output.png" --resolution 1K
```

Edit (single image)
```bash
uv run {baseDir}/scripts/generate_image.py --prompt "edit instructions" --filename "output.png" -i "/path/in.png" --resolution 2K
```

Multi-image composition (up to 14 images)
```bash
uv run {baseDir}/scripts/generate_image.py --prompt "combine these into one scene" --filename "output.png" -i img1.png -i img2.png -i img3.png
```

API key
- `GEMINI_API_KEY` env var
- Or set `skills."nano-banana-pro".apiKey` / `skills."nano-banana-pro".env.GEMINI_API_KEY` in `~/.clawdbot/moltbot.json`

Notes
- Resolutions: `1K` (default), `2K`, `4K`.
- Use timestamps in filenames: `yyyy-mm-dd-hh-mm-ss-name.png`.
- The script prints a `MEDIA:` line for Moltbot to auto-attach on supported chat providers.
- Do not read the image back; report the saved path only.
