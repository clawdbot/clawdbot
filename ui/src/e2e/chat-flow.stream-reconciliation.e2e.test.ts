import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    { persistence: "between deltas", terminal: "final" },
    { persistence: "before streaming", terminal: "error" },
  ])(
    "keeps one answer during workspace reconciliation with persistence $persistence and $terminal",
    async ({ persistence, terminal }) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1280 },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, { historyMessages: [] });
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.locator(".agent-chat__composer-combobox textarea").fill("Check the workspace");
          await page.getByRole("button", { name: "Send message" }).click();
          const send = await gateway.waitForRequest("chat.send");
          const runId = requireString(requireRecord(send.params).idempotencyKey, "chat run id");
          const text = "Workspace changes are ready.";
          const partial = "Workspace";
          const emitDelta = (snapshot: string, deltaText: string) =>
            gateway.emitGatewayEvent("chat", {
              sessionKey: "main",
              runId,
              state: "delta",
              deltaText,
              message: { role: "assistant", content: [{ type: "text", text: snapshot }] },
            });
          if (persistence === "between deltas") {
            await emitDelta(partial, partial);
            await page.locator(".chat-bubble.streaming", { hasText: partial }).waitFor();
          }
          // Hold background refreshes so only the live message/delta boundary can repair the view.
          await gateway.deferNext("chat.history");
          await gateway.emitGatewayEvent("session.message", {
            sessionKey: "main",
            runId,
            clientRunId: runId,
            hasActiveRun: true,
            activeRunIds: [runId],
            messageId: "workspace-answer",
            messageSeq: 2,
            session: {
              key: "main",
              kind: "direct",
              status: "running",
              updatedAt: Date.now(),
              hasActiveRun: true,
              activeRunIds: [runId],
            },
            message: {
              role: "assistant",
              content: [{ type: "text", text }],
              __openclaw: { id: "workspace-answer", seq: 2, runId },
            },
          });
          await page.locator(".chat-group.assistant .chat-text", { hasText: text }).waitFor();
          if (persistence === "before streaming") {
            await emitDelta(partial, partial);
          }
          await emitDelta(text, text.slice(partial.length));
          await gateway.emitGatewayEvent("agent", {
            sessionKey: "main",
            runId,
            seq: 3,
            ts: Date.now(),
            stream: "lifecycle",
            data: { phase: "finishing" },
          });
          // Positive telemetry proves a render after the deltas; absence alone can pass on the old frame.
          await gateway.emitGatewayEvent("agent", {
            sessionKey: "main",
            runId,
            seq: 4,
            ts: Date.now(),
            stream: "usage",
            data: { outputTokens: 2400 },
          });
          await expect
            .poll(async () =>
              (await page.locator(".chat-working-indicator__tokens").textContent())?.trim(),
            )
            .toBe("2.4k tokens");
          await expect.poll(() => page.locator(".chat-bubble.streaming").count()).toBe(0);
          expect(
            (await page.locator(".chat-group.assistant .chat-text").allTextContents()).map(
              (value) => value.trim(),
            ),
          ).toEqual([text]);
          expect(await page.locator(".chat-duplicate-count").count()).toBe(0);
          expect(await page.getByRole("button", { name: "Stop generating" }).isEnabled()).toBe(
            true,
          );
          await page.locator(".chat-working-indicator").waitFor();

          const errorMessage = "Workspace reconciliation failed: the destination is read-only.";
          await gateway.emitGatewayEvent("chat", {
            sessionKey: "main",
            runId,
            state: terminal,
            ...(terminal === "error" ? { errorMessage } : {}),
            message: { role: "assistant", content: [{ type: "text", text }] },
          });
          await page.getByRole("button", { name: "Stop generating" }).waitFor({ state: "hidden" });
          await page.locator(".chat-working-indicator").waitFor({ state: "hidden" });
          if (terminal === "error") {
            await page.locator(".chat-error strong", { hasText: errorMessage }).waitFor();
          }
          await emitDelta(text, text.slice(partial.length));
          await expect.poll(() => page.locator(".chat-bubble.streaming").count()).toBe(0);
          expect(
            (await page.locator(".chat-group.assistant .chat-text").allTextContents()).map(
              (value) => value.trim(),
            ),
          ).toEqual([text]);
          expect(await page.locator(".chat-duplicate-count").count()).toBe(0);
        },
      );
    },
  );
});
