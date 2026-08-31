---
name: model-usage
description: "Summarize CodexBar local cost logs by model for Codex or Claude, including current or full breakdowns."
metadata:
  {
    "openclaw":
      {
        "emoji": "📊",
        "os": ["darwin", "linux"],
        "requires": { "bins": ["codexbar"] },
        "install":
          [
            {
              "id": "brew-cask",
              "kind": "brew",
              "formula": "steipete/tap/codexbar",
              "bins": ["codexbar"],
              "label": "Install CodexBar CLI (Homebrew)",
            },
          ],
      },
  }
---

# Model usage

## Overview

Get per-model usage cost from CodexBar's local cost logs. Supports "current model" (most recent daily entry) or "all models" summaries for Codex or Claude.

CodexBar ships CLI builds for macOS and Linux. When `codexbar` is on `PATH`, the skill reads local usage directly; the bundled Python summarizer also accepts exported CodexBar JSON through `--input` anywhere Python is available.

## Quick start

1. Fetch cost JSON via CodexBar CLI or pass a JSON file.
2. Use the bundled script to summarize by model.

```bash
python {baseDir}/scripts/model_usage.py --provider codex --mode current
python {baseDir}/scripts/model_usage.py --provider codex --mode all
python {baseDir}/scripts/model_usage.py --provider claude --mode all --format json --pretty
```

## Current model logic

- Uses the most recent daily row with `modelBreakdowns`.
- Picks the model with the highest cost in that row.
- Falls back to the last entry in `modelsUsed` when breakdowns are missing.
- Override with `--model <name>` when you need a specific model.

## Inputs

- Default: runs `codexbar cost --format json --provider <codex|claude>`.
- macOS and Linux: use the bundled Homebrew formula installer above for live local usage reads. Linux users can also use CodexBar's [AUR package](https://aur.archlinux.org/packages/codexbar-cli) or [official release tarballs](https://github.com/steipete/CodexBar/releases).
- Other platforms: use `--input` with exported CodexBar JSON.
- File or stdin:

```bash
codexbar cost --provider codex --format json > /tmp/cost.json
python {baseDir}/scripts/model_usage.py --input /tmp/cost.json --mode all
cat /tmp/cost.json | python {baseDir}/scripts/model_usage.py --input - --mode current
```

## Output

- Text (default) or JSON (`--format json --pretty`).
- Values are cost-only per model; tokens are not split by model in CodexBar output.

## References

- Read `references/codexbar-cli.md` for CLI flags and cost JSON fields.
