---
name: control-ui-e2e
description: Use when testing, fixing, or extending the OpenClaw Control UI GUI with Vitest + Playwright end-to-end checks, mocked Gateway WebSocket flows, mocked dashboard runs, screenshots/videos, or agent-verifiable browser proof.
---

# Control UI E2E

Use this for Control UI changes that need a real browser flow with deterministic Gateway data.

## Test Shape

- Use `ui/src/**/*.e2e.test.ts` for full GUI flows.
- Use `ui/src/test-helpers/control-ui-e2e.ts` to start the Vite Control UI and install a mocked Gateway WebSocket.
- Keep scenarios deterministic. Do not use live provider keys, real channel credentials, or a real Gateway unless the user explicitly asks for live proof.
- Prefer existing `.browser.test.ts` or unit tests for narrow rendering logic; use this E2E lane when the proof should cover routing, app boot, Gateway handshake, requests, and visible UI behavior together.

## Commands

- Target one E2E test in a Codex worktree:

```bash
node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/e2e/chat-flow.messaging.e2e.test.ts
```

- Run the whole local lane in a normal checkout:

```bash
pnpm test:ui:e2e
```

Do not install dependencies into a linked/sparse worktree. For broad GUI proof
or dependency-heavy checks, use a prepared normal checkout on the current
dedicated Linux worker when it has browser support; otherwise use
Testbox/Crabbox instead of running a wide lane on a workstation.

## Visual Proof Default

When running mocked Control UI/dashboard validation for a user-facing feature, produce visual proof by default unless the user explicitly opts out.

- Keep the Vitest E2E assertions deterministic; do not commit generated screenshots or videos.
- After or alongside the focused E2E test, run the mocked Control UI app when available, for example `pnpm dev:ui:mock -- --port <port>`.
- Drive Chromium with Playwright against the local mock URL and capture a video plus screenshots for each meaningful state: initial view, interaction input, result state, and final/paginated/selected state.
- Use `browser.newContext({ recordVideo: { dir, size }, viewport })`, `page.screenshot({ path })`, and close the context before reporting the video path.
- Allocate retained proof with `createControlUiE2eArtifactDir(scope, parentDir?)` from `ui/src/test-helpers/control-ui-e2e-artifacts.ts`. Each call atomically creates a fresh directory and logs its actual path. An explicit parent wins, then the trimmed existing `OPENCLAW_UI_E2E_ARTIFACT_DIR`, then the repository's `.artifacts/control-ui-e2e` parent. Existing custom output controls select parents; do not add or rewrite env vars to enable capture.
- Allocate during the test/scenario or `beforeEach`, once per attempt; standalone scripts allocate once per invocation. Pass the owner explicitly to shared capture helpers. Keep the original gates, feature/stage names, viewports, waits, and recording options. Use distinct filenames for distinct stages and keep screenshots, reports, and video together.
- Retain successful and failed evidence. Report actual allocated paths, including relocated filename overrides. Manually delete only exact owned directories after review; never clear shared parents before a replay. Disposable build/media fixtures and owned temporary raw video may keep their cleanup. New synthetic captures do not recover overwritten evidence.
- Timeout diagnostics use fresh children beneath their existing diagnostic parent. Mantis retains every capture attempt under an invocation-owned directory and refuses to overwrite reports. Real-Gateway suites, `chat-outbox-*`, and `chat-attachment-read-lifecycle` remain separate owners; coordinate before claiming replay-safe retention there.
- Treat recording as validation, not only demo capture. If the recorder fails or shows surprising behavior, stop, fix the behavior, add or update a regression test, then rerecord.
- If visual proof is blocked, state the exact blocker and still report the textual E2E evidence.

## Mock Pattern

Start the app server, install the mock before `page.goto`, then assert both Gateway traffic and visible UI:

```ts
const server = await startControlUiE2eServer();
const page = await context.newPage();
const gateway = await installMockGateway(page, {
  historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
});

await page.goto(`${server.baseUrl}chat`);
await page.locator(".agent-chat__composer-combobox textarea").fill("hello");
await page.getByRole("button", { name: "Send message" }).click();

const request = await gateway.waitForRequest("chat.send");
await gateway.emitChatFinal({ runId: String(request.params.idempotencyKey), text: "Done." });
await page.getByText("Done.").waitFor();
```

Extend `installMockGateway` with typed scenario options or method responses when a new flow needs more Gateway surface.

## Standalone Recording

When recording an already-running mocked Control UI URL, use a temporary Playwright script or `playwright test` spec and keep the recording flow focused:

- Open the mock URL, interact through stable `data-*` selectors or user-facing role selectors, and wait on asserted states instead of relying on fixed sleeps.
- Assert both visible UI state and mocked Gateway traffic for request-driven flows. For example, verify the expected count/row is visible and that `sessions.list` was called with the expected `search`, `offset`, and `limit`.
- Use short sleeps only after assertions to make the captured video readable.
- Store the generated video in the invocation's fresh allocated directory; do not commit it or remove older captures.
