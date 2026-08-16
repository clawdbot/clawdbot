# Real Gateway queue-edit proof

This is the reviewable terminal transcript for the exact-head real behavior run recorded in the pull request body. The run uses the bundled Control UI, a real isolated Gateway, a real WebSocket connection, and a local OpenAI-compatible streaming endpoint that holds the active run open so queued rows are created through the live delivery path.

## Observed behavior

- `GET /health` returned `{"ok":true,"status":"live"}`.
- The Gateway identified the bundled Control UI build from the PR checkout.
- The browser created real `Waiting for current run` queue rows through the live Gateway.
- Inline submit changed `[queue row alpha, queue row beta]` to `[queue row alpha, queue row beta edited]` while the independent composer draft remained `composer draft must survive`.
- A second live run edited a queued row, entered `abandoned live edit`, pressed Escape, and restored the original queue text with zero editing rows.
- Gateway logs recorded the live WebSocket connections, chat startup, model transport, and config/session activity.

The raw screenshots and logs are retained locally by the operator under `/tmp/openclaw-pr124298-real-606/`; this tracked transcript contains the inspectable behavior summary without committing generated media.
