---
title: "TUI - Terminal Rendering Primitives and Output Safety Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# TUI - Terminal Rendering Primitives and Output Safety Maturity Note

## Summary

OpenClaw has a broad shared terminal toolkit: ANSI stripping, safe single-line
text, safe stream writes for broken pipes, styled prompts, table wrapping, QR
terminal rendering, OSC progress, OSC8 links, decorative emoji fallbacks, and
TUI-specific themes. This is strong implementation infrastructure, but it is a
supporting layer rather than a fully documented user workflow. Coverage is beta
because most proof is unit-level and scattered across CLI features.

## Category Scope

This category covers shared terminal output helpers used by CLI/TUI surfaces:
safe stream writing, text sanitization, ANSI/OSC handling, table wrapping,
prompt styling, QR output, OSC progress, terminal links, decorative emoji
fallbacks, and terminal theme/readability controls.

## Features

- Terminal Rendering Primitives: Covers Terminal Rendering Primitives across shared terminal output helpers used by CLI/TUI surfaces: safe stream writing, text sanitization, ANSI/OSC handling, table wrapping, and related terminal rendering primitives and output safety behavior.
- Output Safety: Covers Output Safety across shared terminal output helpers used by CLI/TUI surfaces: safe stream writing, text sanitization, ANSI/OSC handling, table wrapping, and related terminal rendering primitives and output safety behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: terminal helpers have direct unit tests for ANSI/OSC handling, wide graphemes, table wrapping, stream writes, QR rendering, OSC progress, decorative emoji, and TUI formatting.
- Negative signals: there is little workflow-level proof that these primitives compose correctly across install/onboard/status/logs/QR/TUI on macOS, Linux, Windows Terminal, and dumb/non-TTY terminals.
- Integration gaps: add cross-platform terminal smoke coverage for table/log/status/QR output in TTY and non-TTY modes.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports: `gitcrawl search issues "terminal output" -R openclaw/openclaw --state all --json number,title,url,state --limit 10` returned TUI/output-adjacent reports including `#49763` for a loading spinner freeze while queuing, `#79859` for recording-friendly quiet status mode, and `#74385` for slow Hatch terminal mode.
- Discrawl reports: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "terminal output"` returned adjacent operator discussion about terminal completion and output handling, but no direct shared primitive failure.
- Good qualities: output helpers sanitize control sequences, handle broken pipes, preserve copy-safe tokens, adapt borders on Windows terminals, and support QR and OSC terminal capabilities.
- Bad qualities: the primitives are not presented as a cohesive operator contract, and some user-facing terminal output issues remain at higher layers.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/tui-and-terminal-ux.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Terminal Rendering Primitives, Output Safety.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Non-TTY and cross-platform terminal-mode behavior is not scored as one coherent workflow.
- Terminal capability detection is strong in helpers, but docs mostly expose the resulting command behavior rather than the capability model.

## Evidence

### Docs

- `docs/web/tui.md:192` documents terminal color controls and `OPENCLAW_THEME`.
- `docs/cli/qr.md:30` documents `--no-ascii` and `--json` for QR output.
- `docs/cli/logs.md:24` documents JSON/plain/no-color log output modes.
- `docs/cli/completion.md:11` documents shell completion generation and install.

### Source

- `src/terminal/stream-writer.ts:18` implements safe stream writes with broken-pipe handling.
- `src/terminal/safe-text.ts:6` strips ANSI and control characters for single-line terminal/log rendering.
- `src/terminal/table.ts:23` chooses Unicode or ASCII borders based on platform and terminal environment.
- `src/terminal/table.ts:67` wraps table cells without splitting ANSI SGR or OSC8 sequences.
- `src/media/qr-terminal.ts:47` renders terminal QR output, including compact QR mode.
- `src/terminal/osc-progress.ts:12` detects OSC progress support and sanitizes progress labels.

### Integration tests

- `src/tui/tui-pty-harness.e2e.test.ts:415` verifies provider error text is preserved in terminal output.
- `src/tui/tui-pty-local.e2e.test.ts:249` proves local TUI output through a PTY with `OPENCLAW_THEME=dark`.

### Unit tests

- `src/terminal/ansi.test.ts:4` strips ANSI and OSC8 sequences and measures wide graphemes.
- `src/terminal/table.test.ts:232` keeps Unicode borders on modern Windows terminals.
- `src/terminal/stream-writer.test.ts` covers broken-pipe-safe writes.
- `src/terminal/osc-progress.test.ts:4` covers terminal support detection and sanitized OSC progress sequences.
- `src/media/qr-terminal.test.ts:28` delegates terminal rendering to qrcode; `src/media/qr-terminal.render.test.ts:71` renders compact QR output.
- `src/tui/tui-formatters.test.ts:310` covers TUI renderable text sanitization.

### Gitcrawl queries

Query:

`gitcrawl search issues "terminal output" -R openclaw/openclaw --state all --json number,title,url,state --limit 10`

Results:

- Returned output-adjacent open reports including `#49763`, `#79859`, and `#74385`.

Query:

`gitcrawl search issues "terminal qr ansi table" -R openclaw/openclaw --state all --json number,title,url,state --limit 8`

Results:

- Returned 0 direct shared terminal primitive reports.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "terminal output"`

Results:

- Returned adjacent operator discussion about terminal completion and output handling, but no direct terminal primitive failure.
