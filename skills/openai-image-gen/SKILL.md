---
name: openai-image-gen
description: Batch-generate images via OpenAI Images API. Random prompt sampler + `index.html` gallery.
homepage: https://platform.openai.com/docs/api-reference/images
metadata: {"moltbot":{"emoji":"🖼️","requires":{"bins":["python3"],"env":["OPENAI_API_KEY"]},"primaryEnv":"OPENAI_API_KEY","install":[{"id":"python-brew","kind":"brew","formula":"python","bins":["python3"],"label":"Install Python (brew)"}]}}
---

# OpenAI Image Gen

Generate a handful of “random but structured” prompts and render them via the OpenAI Images API.

## Run

```bash
python3 {baseDir}/scripts/gen.py
open ~/Projects/tmp/openai-image-gen-*/index.html  # if ~/Projects/tmp exists; else ./tmp/...
```

Useful flags:

```bash
# GPT image models with various options
python3 {baseDir}/scripts/gen.py --count 16 --model gpt-image-1
python3 {baseDir}/scripts/gen.py --prompt "ultra-detailed studio photo of a lobster astronaut" --count 4
python3 {baseDir}/scripts/gen.py --size 1536x1024 --quality high --out-dir ./out/images
python3 {baseDir}/scripts/gen.py --model gpt-image-1.5 --background transparent --output-format webp

# DALL-E 3 (note: count is automatically limited to 1)
python3 {baseDir}/scripts/gen.py --model dall-e-3 --quality hd --size 1792x1024 --style vivid
python3 {baseDir}/scripts/gen.py --model dall-e-3 --style natural --prompt "serene mountain landscape"

# DALL-E 2
python3 {baseDir}/scripts/gen.py --model dall-e-2 --size 512x512 --count 4
```

## Model-Specific Parameters

Different models support different parameter values. The script automatically selects appropriate defaults based on the model.

### Size

- **GPT image models** (`gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`): `1024x1024`, `1536x1024` (landscape), `1024x1536` (portrait), or `auto`
  - Default: `1024x1024`
- **dall-e-3**: `1024x1024`, `1792x1024`, or `1024x1792`
  - Default: `1024x1024`
- **dall-e-2**: `256x256`, `512x512`, or `1024x1024`
  - Default: `1024x1024`

### Quality

- **GPT image models**: `auto`, `high`, `medium`, or `low`
  - Default: `high`
- **dall-e-3**: `hd` or `standard`
  - Default: `standard`
- **dall-e-2**: `standard` only
  - Default: `standard`

### Other Notable Differences

- **dall-e-3** only supports generating 1 image at a time (`n=1`). The script automatically limits count to 1 when using this model.
- **GPT image models** support additional parameters:
  - `--background`: `transparent`, `opaque`, or `auto` (default)
  - `--output-format`: `png` (default), `jpeg`, or `webp`
  - Note: `stream` and `moderation` are available via API but not yet implemented in this script
- **dall-e-3** has a `--style` parameter: `vivid` (hyper-real, dramatic) or `natural` (more natural looking)

## Output

- `*.png`, `*.jpeg`, or `*.webp` images (output format depends on model + `--output-format`)
- `prompts.json` (prompt → file mapping)
- `index.html` (thumbnail gallery)
