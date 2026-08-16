# PR #124298 exact-head Control UI proof

- Code under test: `5cb3e9c68d6fba41b1c12865c6d439a406182e36`
- Browser run: `ui/src/e2e/chat-flow.queue-edit.e2e.test.ts`
- Browser: Playwright Chromium, real Control UI served from this checkout
- Gateway boundary: the suite's deterministic Gateway transport fixture; no UI state was mocked

Command:

```text
OPENCLAW_UI_E2E_ARTIFACT_DIR=.artifacts/pr124298-tip.MtWpUZ \
node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.ui-e2e.config.ts \
  --configLoader runner \
  ui/src/e2e/chat-flow.queue-edit.e2e.test.ts
```

Result: 1 file passed, 4 tests passed in 14.88s. The run captured the current-head screenshots and video in this directory:

- `pr-124298-current-head-remove-rejected.png`
- `pr-124298-current-head-duplicate-noop.png`
- `pr-124298-current-head-exact-drain.png`
- `pr-124298-current-head.webm`

The focused queue/edit suite also passed 84 tests at this code tip. The new shared-pane regression exercises a peer moving a different row across an active edit and verifies that the durable order remains unchanged.
