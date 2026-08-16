# PR #124298 exact-head real behavior proof

Head: `4879eab1d9de5a4c3f110fd6698c36a9145875fc`

## Environment

- Built the literal PR checkout and ran an isolated Gateway on loopback.
- The Control UI connected over the Gateway WebSocket.
- Gateway `/health` and `/readyz` returned success.
- The browser observed held queued rows and preserved an independent composer draft.

## Observed behavior

1. An inline `/stop` edit was rejected before command dispatch. The source row remained visible and the composer draft was preserved.
2. Cancel restored the original queued row.
3. A normal inline edit replaced the queued row while preserving the unrelated composer draft.
4. Split view showed both panes sharing the same queued row. Pane 1 owned the inline edit; pane 2 displayed the row and its removal control.

The final peer-removal click was not performed because the ephemeral headed-browser session became unavailable immediately before that action. No peer-removal outcome is claimed from the browser capture.

## Automated boundary proof

The focused queue-edit suite passed with 73 tests, including the two-pane ownership check:

```text
ui/src/pages/chat/queued-message-edit.test.ts
ui/src/pages/chat/chat-state.test.ts
Test Files  2 passed (2)
Tests       73 passed (73)
```

The new guard rejects removal while any subscribed pane owns the row edit and leaves the source row available for cancel or submit.

Local capture artifacts are retained outside the repository at `/tmp/openclaw-pr124298-rerun/artifacts/` (screenshots, exact-head record, Gateway health/readiness, and logs).
