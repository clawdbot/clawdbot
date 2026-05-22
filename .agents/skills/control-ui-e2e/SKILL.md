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
node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/ui/e2e/chat-flow.e2e.test.ts
```

- Run the whole local lane in a normal checkout:

```bash
pnpm test:ui:e2e
```

If dependencies are missing in a Codex worktree, install once with `pnpm install`; for broad GUI proof or dependency-heavy checks, use Testbox/Crabbox instead of running a wide local pnpm lane.

## Visual Proof Default

When running mocked Control UI/dashboard validation for a user-facing feature, produce visual proof by default unless the user explicitly opts out.

- Keep the Vitest E2E assertions deterministic; do not commit generated screenshots or videos.
- After or alongside the focused E2E test, run the mocked Control UI app when available, for example `pnpm dev:ui:mock -- --port <port>`.
- Drive Chromium with Playwright against the local mock URL and capture a video plus screenshots for each meaningful state: initial view, interaction input, result state, and final/paginated/selected state.
- Use `browser.newContext({ recordVideo: { dir, size }, viewport })`, `page.screenshot({ path })`, and close the context before reporting the video path.
- Put artifacts under `.artifacts/control-ui-e2e/<short-feature-name>/` or another clearly named local temp directory, and report the absolute paths in the final answer.
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
