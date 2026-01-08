# openai-image-gen

High-performance batch image generation via OpenAI Images API. Features parallel async generation, random prompt sampling, and an automated HTML gallery.

## Overview

`openai-image-gen` is a Python-based skill designed for rapid, bulk image generation. It leverages OpenAI's Images API (DALL-E 3, `gpt-image-1-mini`, etc.) with full asynchronous execution to generate multiple images in parallel.

### Key Features
- **Parallel Generation**: Uses `asyncio` and `httpx` to trigger multiple generation requests simultaneously.
- **Smart Defaults**: Automatically samples high-quality random prompts if none are provided.
- **HTML Gallery**: Generates a responsive, dark-mode friendly `index.html` to preview results immediately.
- **Modern Python Tooling**: Optimized for `uv` with PEP 723 inline metadata support.

## Requirements

- **[uv](https://github.com/astral-sh/uv)**: Ultra-fast Python package installer and runner.
- **Python 3.12+**
- **OPENAI_API_KEY**: Your OpenAI API key must be set in your environment or a `.env` file.

## Setup

Set your OpenAI API key:

```bash
export OPENAI_API_KEY="your_api_key_here"
```

Alternatively, create a `.env` file in the skill directory:

```env
OPENAI_API_KEY=sk-...
```

## Usage

### Local Execution (within the directory)

Run with default settings (8 random images, `gpt-image-1-mini`):

```bash
uv run scripts/gen.py
```

### Advanced Usage

```bash
# Generate 4 images in parallel with a specific model
uv run scripts/gen.py --count 4 --model gpt-image-1

# Generate from a specific prompt
uv run scripts/gen.py --prompt "ultra-detailed studio photo of a lobster astronaut" --count 1

# Custom size and quality
uv run scripts/gen.py --size 1024x1792 --quality hd --out-dir ./out/images
```

### Running via uvx (One-off execution)

Since the script includes PEP 723 inline metadata, you can run it directly as a tool:

```bash
# From the parent directory or any location
uvx --from /Users/cortex-mini/Developer/clawdis/skills/openai-image-gen openai-image-gen --count 2
```

## Configuration Options

| Flag | Description | Default |
|------|-------------|---------|
| `--prompt` | Single prompt to generate. If omitted, random prompts are used. | `None` |
| `--count` | Number of images to generate (1-50). | `8` |
| `--model` | OpenAI image model ID. | `gpt-image-1-mini` |
| `--size` | Image resolution (e.g., `1024x1024`, `1024x1792`). | `1024x1024` |
| `--quality` | Image quality (`low`, `medium`, `high`, `auto`, `hd`). | `high` |
| `--out-dir` | Custom output directory. | `./tmp/openai-image-gen-<timestamp>` |

## Output Structure

The tool creates a timestamped directory containing:

- `*.png`: The generated images.
- `prompts.json`: A JSON mapping of prompts to their respective filenames.
- `index.html`: A self-contained gallery for easy viewing.

To view the results:

```bash
open ./tmp/openai-image-gen-<timestamp>/index.html
```

## License

MIT
