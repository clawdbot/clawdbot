import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { controlUiSessionPath, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI dashboard final reply recovery",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const proofDir = path.resolve(".artifacts/control-ui-e2e/dashboard-final-reply-recovery");

function dashboardPath(): string {
  return controlUiSessionPath(sessionKey).replace(/^\/chat\//u, "/dashboard/");
}

suite.define(() => {
  it("projects a distinct durable reply after interim text and a message-less terminal", async () => {
    const recordProof = process.env.OPENCLAW_UI_E2E_RECORD === "1";
    if (recordProof) {
      await mkdir(proofDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      locale: "en-US",
      viewport: { height: 900, width: 1280 },
      ...(recordProof
        ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey,
      featureMethods: ["board.get", "chat.metadata", "chat.startup"],
      historyMessages: [],
      methodResponses: {
        "board.get": {
          revision: 1,
          sessionKey,
          tabs: [{ tabId: "main", title: "Nightly Disk Cleanup", position: 0, chatDock: "right" }],
          widgets: [],
        },
        "sessions.resolve": { ok: true, key: sessionKey, boardFace: "dashboard" },
        "sessions.list": {
          count: 1,
          defaults: { contextTokens: null, model: "gpt-5.6-sol", modelProvider: "openai" },
          path: "",
          sessions: [
            {
              boardFace: "dashboard",
              key: sessionKey,
              kind: "direct",
              label: "Nightly Disk Cleanup",
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        },
      },
    });

    try {
      await page.goto(new URL(dashboardPath(), suite.server.baseUrl).href);
      const prompt = "Why did Done appear without my reply?";
      const interimText = "Checking the dashboard state.";
      const updatedInterimText = "Still checking the dashboard state.";
      const partialFinalText = "Drafting the durable dashboard reply.";
      const stalePartialFinalText = "Drafting more of the durable dashboard reply.";
      const finalText = "The durable dashboard reply is visible after Done.";
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      const send = await gateway.waitForRequest("chat.send");
      const params = send.params as Record<string, unknown>;
      const runId = typeof params.idempotencyKey === "string" ? params.idempotencyKey : "";
      expect(runId).not.toBe("");

      await gateway.emitGatewayEvent("chat", {
        runId,
        sessionKey,
        seq: 1,
        state: "delta",
        deltaText: interimText,
        message: {
          role: "assistant",
          phase: "commentary",
          content: [{ type: "text", text: interimText }],
          timestamp: 1,
        },
      });
      await page.locator(".chat-thread-inner", { hasText: interimText }).waitFor();
      await gateway.emitGatewayEvent("chat", {
        runId,
        sessionKey,
        seq: 2,
        state: "delta",
        deltaText: partialFinalText,
        message: {
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "text", text: partialFinalText }],
          timestamp: 2,
        },
      });
      await page.locator(".chat-thread-inner", { hasText: partialFinalText }).waitFor();

      const persistedInterimHistory = [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: 1,
          __openclaw: { id: "dashboard-prompt", idempotencyKey: `${runId}:user`, seq: 1 },
        },
        {
          role: "assistant",
          phase: "commentary",
          // A stale snapshot can contain newer commentary with producer key
          // order and metadata changes; it is still not the terminal reply.
          content: [
            { text: updatedInterimText, type: "text", cache_control: { type: "ephemeral" } },
          ],
          timestamp: 2,
          __openclaw: { id: "dashboard-interim", runId, seq: 2 },
        },
        {
          role: "assistant",
          phase: "final_answer",
          content: [
            {
              text: stalePartialFinalText,
              type: "text",
              cache_control: { type: "ephemeral" },
            },
          ],
          timestamp: 3,
          __openclaw: { id: "dashboard-partial-final", runId, seq: 3 },
        },
      ];
      const persistedHistory = [
        ...persistedInterimHistory,
        {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          stopReason: "stop",
          timestamp: 4,
          __openclaw: { id: "dashboard-final", runId, seq: 4 },
        },
      ];
      const historyCount = (await gateway.getRequests("chat.history")).length;
      await gateway.deferNext("chat.history");
      await gateway.emitGatewayEvent("chat", {
        runId,
        sessionKey,
        state: "final",
      });

      const staleRequest = await gateway.waitForRequest("chat.history", { after: historyCount });
      expect(staleRequest.params).toMatchObject({ sessionKey, limit: 100 });
      // The first authoritative snapshot can promote the same interim text to
      // a durable row before the distinct terminal reply is committed. That
      // identity change is not a recovered final; retry until new content lands.
      await gateway.setHistoryMessages(persistedHistory);
      await gateway.resolveDeferred("chat.history", {
        messages: persistedInterimHistory,
        sessionId: `session:${sessionKey}`,
        thinkingLevel: null,
      });
      await gateway.waitForRequest("chat.history", { after: historyCount + 1 });
      const visibleFinal = page.locator(".chat-thread-inner .chat-text", { hasText: finalText });
      await visibleFinal.waitFor({ timeout: 10_000 });
      await expect.poll(() => visibleFinal.count()).toBe(1);
      await expect
        .poll(async () => (await gateway.getRequests("chat.history")).length)
        .toBe(historyCount + 2);
      if (recordProof) {
        await page.screenshot({
          fullPage: true,
          path: path.join(proofDir, "dashboard-final-reply-recovered.png"),
        });
      }
    } finally {
      const video = page.video();
      await context.close();
      if (recordProof && video) {
        await video.saveAs(path.join(proofDir, "dashboard-final-reply-recovered.webm"));
      }
    }
  });
});
