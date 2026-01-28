---
name: oracle
description: Best practices for using the oracle CLI (prompt + file bundling, engines, sessions, and file attachment patterns).
homepage: https://askoracle.dev
metadata: {"moltbot":{"emoji":"🧿","requires":{"bins":["oracle"]},"install":[{"id":"node","kind":"node","package":"@steipete/oracle","bins":["oracle"],"label":"Install oracle (node)"}]}}
---

# oracle — best use

Oracle bundles your prompt + selected files into one “one-shot” request so another model can answer with real repo context (API or browser automation). Treat output as advisory: verify against code + tests.

## Main use case (browser, GPT‑5.2 Pro)

Default workflow here: `--engine browser` with GPT‑5.2 Pro in ChatGPT. This is the common “long think” path: ~10 minutes to ~1 hour is normal; expect a stored session you can reattach to.

Recommended defaults:
- Engine: browser (`--engine browser`)
- Model: GPT‑5.2 Pro (`--model gpt-5.2-pro` or `--model "5.2 Pro"`)

## Golden path

1. Pick a tight file set (fewest files that still contain the truth).
2. Preview payload + token spend (`--dry-run` + `--files-report`).
3. Use browser mode for the usual GPT‑5.2 Pro workflow; use API only when you explicitly want it.
4. If the run detaches/timeouts: reattach to the stored session (don’t re-run).

## Commands (preferred)

- Help:
  - `oracle --help`
  - If the binary isn’t installed: `npx -y @steipete/oracle --help` (avoid `pnpx` here; sqlite bindings).

- Preview (no tokens):
  - `oracle --dry-run summary -p "<task>" --file "src/**" --file "!**/*.test.*"`
  - `oracle --dry-run full -p "<task>" --file "src/**"`

- Token sanity:
  - `oracle --dry-run summary --files-report -p "<task>" --file "src/**"`

- Browser run (main path; long-running is normal):
  - `oracle --engine browser --model gpt-5.2-pro -p "<task>" --file "src/**"`

- Manual paste fallback:
  - `oracle --render --copy -p "<task>" --file "src/**"`
  - Note: `--copy` is a hidden alias for `--copy-markdown`.

## Attaching files (`--file`)

`--file` accepts files, directories, and globs. You can pass it multiple times; entries can be comma-separated.

- Include:
  - `--file "src/**"`
  - `--file src/index.ts`
  - `--file docs --file README.md`

- Exclude:
  - `--file "src/**" --file "!src/**/*.test.ts" --file "!**/*.snap"`

- Defaults (implementation behavior):
  - Default-ignored dirs: `node_modules`, `dist`, `coverage`, `.git`, `.turbo`, `.next`, `build`, `tmp` (skipped unless explicitly passed as literal dirs/files).
  - Honors `.gitignore` when expanding globs.
  - Does not follow symlinks.
  - Dotfiles filtered unless opted in via pattern (e.g. `--file ".github/**"`).
  - Files > 1 MB rejected.

## Engines (API vs browser)

- Auto-pick: `api` when `OPENAI_API_KEY` is set; otherwise `browser`.
- Browser supports GPT + Gemini only; use `--engine api` for Claude/Grok/Codex or multi-model runs.
- Browser attachments:
  - `--browser-attachments auto|never|always` (auto pastes inline up to ~60k chars then uploads).
- Remote browser host:
  - Host: `oracle serve --host 0.0.0.0 --port 9473 --token <secret>`
  - Client: `oracle --engine browser --remote-host <host:port> --remote-token <secret> -p "<task>" --file "src/**"`

## Sessions + slugs

- Stored under `~/.oracle/sessions` (override with `ORACLE_HOME_DIR`).
- Runs may detach or take a long time (browser + GPT‑5.2 Pro often does). If the CLI times out: don’t re-run; reattach.
  - List: `oracle status --hours 72`
  - Attach: `oracle session <id> --render`
- Use `--slug "<3-5 words>"` to keep session IDs readable.
- Duplicate prompt guard exists; use `--force` only when you truly want a fresh run.

## Prompt template (high signal)

Oracle starts with **zero** project knowledge. Assume the model cannot infer your stack, build tooling, conventions, or “obvious” paths. Include:
- Project briefing (stack + build/test commands + platform constraints).
- “Where things live” (key directories, entrypoints, config files, boundaries).
- Exact question + what you tried + the error text (verbatim).
- Constraints (“don’t change X”, “must keep public API”, etc).
- Desired output (“return patch plan + tests”, “give 3 options with tradeoffs”).

## Safety

- Don’t attach secrets by default (`.env`, key files, auth tokens). Redact aggressively; share only what’s required.

## “Exhaustive prompt” restoration pattern

For long investigations, write a standalone prompt + file set so you can rerun days later:
- 6–30 sentence project briefing + the goal.
- Repro steps + exact errors + what you tried.
- Attach all context files needed (entrypoints, configs, key modules, docs).

Oracle runs are one-shot; the model doesn’t remember prior runs. “Restoring context” means re-running with the same prompt + `--file …` set (or reattaching a still-running stored session).
