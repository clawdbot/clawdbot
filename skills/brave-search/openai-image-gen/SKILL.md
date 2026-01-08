---
name: openai-image-gen
description: High-performance batch image generation via OpenAI Images API. Features parallel async generation, random prompt sampling, and an automated HTML gallery.
homepage: https://platform.openai.com/docs/guides/image-generation
metadata: {"clawdbot":{"emoji":"🖼️","requires":{"bins":["uv","python3"],"env":["OPENAI_API_KEY"]},"primaryEnv":"OPENAI_API_KEY","install":[{"id":"python-brew","kind":"brew","formula":"python","bins":["python3"],"label":"Install Python (brew)"},{"id":"uv-brew","kind":"brew","formula":"uv","bins":["uv"],"label":"Install uv (brew)"}]}}
---

# OpenAI Image Gen

Batch-generate images via OpenAI Images API (GPT Image/Dall-E). Now optimized with **parallel async generation** for maximum speed.

## Run

This skill uses `uv` for dependency management and parallel execution.

```bash
# Run with default settings (random prompts, parallel generation, gpt-image-1-mini)
uv run scripts/gen.py

# Run as a one-off tool via uvx (if outside the directory)
uvx --from /Users/cortex-mini/Developer/clawdis/skills/openai-image-gen openai-image-gen

# Open the gallery
open ~/Projects/tmp/openai-image-gen-*/index.html
```

Useful flags:

```bash
# Generate 4 images in parallel with a specific model
uv run scripts/gen.py --count 4 --model gpt-image-1

# Generate from a specific prompt (default is gpt-image-1-mini)
uv run scripts/gen.py --prompt "ultra-detailed studio photo of a lobster astronaut" --count 1

# Custom size and quality
uv run scripts/gen.py --size 1024x1792 --quality hd --out-dir ./out/images
```

## Output

- `*.png` images
- `prompts.json` (prompt → file mapping)
- `index.html` (thumbnail gallery)
