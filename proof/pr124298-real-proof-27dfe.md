# PR #124298 exact-head real behavior proof

Captured 2026-08-16 from the pushed source head `27dfe3138bd5119e9b429f48dbafc5d6d4cb7cf7`.

## Runtime identity

```text
$ git rev-parse HEAD
27dfe3138bd5119e9b429f48dbafc5d6d4cb7cf7

$ pnpm ui:build
✓ built in 2.85s
verified 816 finalized Control UI sidecars

$ curl -fsS http://127.0.0.1:19892/health
{"ok":true,"status":"live"}
```

The bundled Control UI was opened at `http://127.0.0.1:19892/chat/main`. Its account footer identified the running build as `codex/pr-12429…@27dfe31`. The Gateway used a real WebSocket connection and a local OpenAI-compatible streaming endpoint that held the active run open; the queued rows were produced through the live Gateway path.

## Inline stop fence

The browser created a genuine queued row while the first run was active. I opened `Edit queued message`, replaced the row text with plain `stop`, and pressed `Send message`. The exact UI result was:

```text
Queued-row edits cannot run commands or stop aliases. Cancel this edit and send the command from the composer.
```

The source row remained queued, the inline editor remained open with `stop`, and no replacement or abort was dispatched. Screenshot: [stop-fence.png](pr124298-27dfe-stop-fence.png).

The annotation-specific ordering case is covered by the exact-head regression in `ui/src/pages/chat/queued-message-edit.test.ts`: an attached browser annotation cannot hide a raw `/stop` from the fence.

## Peer edit conflict

I opened the same live session in split panes, started editing the queued row in pane one, then pressed `Edit queued message` for that row in pane two. Pane two surfaced:

```text
A queued message is being edited in another pane. Finish or cancel that edit before removing it.
```

The peer action did not silently no-op and the owning pane retained the edit. Screenshot: [peer-edit-conflict.png](pr124298-27dfe-peer-edit-conflict.png).

## Validation

```text
4 focused test files, 411 tests passed
oxfmt --check: passed
oxlint: passed
git diff --check: passed
```
