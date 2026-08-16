# Real Gateway queue-edit proof

This is the reviewable terminal transcript for the exact-head real behavior run recorded in the pull request body. The run uses commit `b68739a2b7421d30e482c522ae90e1538d98a750`, the bundled Control UI, a real isolated Gateway, a real WebSocket connection, and a local OpenAI-compatible streaming endpoint that holds the active run open so queued rows are created through the live delivery path.

## Observed behavior

- `GET /health` returned `{"ok":true,"status":"live"}`.
- The Gateway identified the bundled Control UI build from the PR checkout.
- The browser created real `Waiting for current run` queue rows through the live Gateway.
- Inline submit changed `[queue row alpha, queue row beta]` to `[queue row alpha, queue row beta edited]` while the independent composer draft remained `composer draft must survive`.
- A second live run edited a queued row, pressed Escape, and restored the original queue text with zero editing rows.
- Gateway logs recorded the live WebSocket connections, chat startup, model transport, and config/session activity.

## Exact-head run record

```text
GET http://127.0.0.1:19892/health
{"ok":true,"status":"live"}

Control UI footer
2026.8.1 · codex/pr-12429…@b68739a*

Queue edit
before: [queue row alpha, queue row beta]
after:  [queue row alpha, queue row beta edited]
composer: composer draft must survive

Escape cancellation
before: [cancel source one, cancel source two]
action: edit second row, press Escape
after:  [cancel source one, cancel source two]
editing rows after Escape: 0
```

The isolated Gateway log records build `2026.8.1-b68739a2b742-2026-08-16T21-14-25.619Z`, live WebSocket connections, `chat.startup`, and the local streaming model transport. Raw run state is retained locally under `/tmp/openclaw-pr124298-real-b687/`; the browser screenshot is retained in `.playwright-cli/` in the PR worktree. This tracked transcript keeps the exact-head evidence inspectable without committing generated media.
