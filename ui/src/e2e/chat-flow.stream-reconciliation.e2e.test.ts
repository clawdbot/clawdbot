import path from "node:path";
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
    { order: "before hydration", tool: false, steer: false },
    { order: "after hydration", tool: false, steer: false },
    { order: "replayed after hydration", tool: false, steer: false },
    { order: "before hydration", tool: true, steer: false },
    { order: "before hydration", tool: false, steer: true },
  ])(
    "reconciles persistence $order (tool: $tool, steer: $steer)",
    async ({ order, tool, steer }) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
        async ({ page }) => {
          const runId = "hydrated-answer-run";
          const text = "The workspace check is complete.";
          const tailText = "The follow-up check is complete.";
          const toolEvent = {
            sessionKey: "agent:main:main",
            runId,
            seq: 1,
            ts: 1_001,
            stream: "tool",
            data: {
              phase: "result",
              toolCallId: "workspace-check",
              name: "read",
              result: { content: [{ type: "text", text: "Workspace ready." }] },
            },
          };
          const message = {
            role: "assistant",
            content: [{ type: "text", text }],
            __openclaw: { id: "hydrated-answer", seq: 2, runId },
          };
          const historyMessages = [
            message,
            ...(steer
              ? [
                  {
                    role: "user",
                    content: [{ type: "text", text: "Check the follow-up." }],
                    __openclaw: {
                      id: "follow-up",
                      seq: 3,
                      idempotencyKey: "follow-up:user",
                      steerTargetRunId: runId,
                    },
                  },
                ]
              : []),
          ];
          const sessionInfo = {
            key: "agent:main:main",
            hasActiveRun: true,
            activeRunIds: [runId],
          };
          const inFlightRun = {
            runId,
            startedAt: 1_000,
            text: steer ? `${text} Checking the follow-up.` : text,
            ...(tool ? { events: [toolEvent] } : {}),
          };
          const gateway = await installMockGateway(page, {
            historyMessages: [],
            inFlightRun: { ...inFlightRun, text: "" },
            sessionInfo,
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.getByRole("button", { name: "Stop generating" }).waitFor();
          await gateway.emitGatewayEvent("chat", {
            sessionKey: "agent:main:main",
            runId,
            state: "delta",
            deltaText: text,
            message: { role: "assistant", content: [{ type: "text", text }] },
          });
          if (tool) {
            await gateway.emitGatewayEvent("agent", toolEvent);
          }
          const persist = () =>
            gateway.emitGatewayEvent("session.message", {
              sessionKey: "agent:main:main",
              runId,
              hasActiveRun: true,
              activeRunIds: [runId],
              messageId: "hydrated-answer",
              messageSeq: 2,
              message,
            });
          const startupCount = (await gateway.getRequests("chat.startup")).length;
          await gateway.deferNext("chat.startup");
          await gateway.setOnline(false);
          await gateway.setOnline(true);
          await gateway.waitForRequest("chat.startup", { after: startupCount });
          if (order !== "after hydration") {
            await persist();
          }
          await gateway.resolveDeferred("chat.startup", {
            messages: historyMessages,
            inFlightRun,
            sessionInfo,
            thinkingLevel: null,
          });
          await page.waitForFunction(() => {
            const pane = document.querySelector<HTMLElement & { state?: { chatLoading: boolean } }>(
              "openclaw-chat-pane",
            );
            return pane?.state?.chatLoading === false;
          });
          await page.locator(".chat-group.assistant .chat-text", { hasText: text }).waitFor();
          if (order !== "before hydration") {
            await persist();
          }
          await gateway.deferNext("chat.history");
          await gateway.emitGatewayEvent("chat", {
            sessionKey: "agent:main:main",
            runId,
            state: "final",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: steer
                    ? `${text} ${tailText}`
                    : tool
                      ? `Checking the workspace.\n\n${text}`
                      : text,
                },
              ],
            },
          });
          await page.getByRole("button", { name: "Stop generating" }).waitFor({ state: "hidden" });
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await page.screenshot({
              fullPage: true,
              path: path.join(
                suite.artifactDir,
                steer ? "hydrated-continuation.png" : "hydrated-answer.png",
              ),
            });
          }
          expect(
            (await page.locator(".chat-group.assistant .chat-text").allTextContents()).map(
              (value) => value.trim(),
            ),
          ).toEqual(steer ? [text, tailText] : [text]);
          expect(await page.locator(".chat-duplicate-count").count()).toBe(0);
          if (tool) {
            expect(await page.locator(".chat-tool-msg-summary").count()).toBe(1);
          }
        },
      );
    },
  );

  it("reconciles distinct commentary items once across reconnect", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const runId = "commentary-reconciliation-run";
        const items = [
          { itemId: "commentary-item-one", text: "Inspecting the workspace." },
          { itemId: "commentary-item-two", text: "Checking the result." },
        ];
        const events = items.map(({ itemId, text }, index) => ({
          data: { kind: "preamble", itemId, phase: "update", progressText: text },
          runId,
          seq: index + 1,
          sessionKey: "agent:main:main",
          stream: "item",
          ts: 2_000 + index,
        }));
        const historyMessages = items.map(({ itemId, text }, index) => ({
          role: "assistant",
          content: [{ type: "text", text }],
          timestamp: 1_000 + index,
          __openclaw: { id: `commentary-message-${index}`, runId, seq: index + 1 },
          openclawStreamFallback: { itemId, replacementText: text, source: "segment" },
        }));
        const sessionInfo = {
          activeRunIds: [runId],
          hasActiveRun: true,
          key: "agent:main:main",
        };
        const gateway = await installMockGateway(page, {
          historyMessages: [],
          inFlightRun: { runId, startedAt: 1_000, text: "" },
          sessionInfo,
        });
        const transcript = page.locator(".chat-thread-inner");
        const itemOccurrences = async () => {
          const bubbles = await transcript.locator(".chat-bubble").allTextContents();
          return items.map(({ text }) => bubbles.filter((bubble) => bubble.trim() === text).length);
        };

        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByRole("button", { name: "Stop generating" }).waitFor();
        for (const event of events) {
          await gateway.emitGatewayEvent("agent", event);
        }
        await expect.poll(itemOccurrences).toEqual([1, 1]);

        const startupCount = (await gateway.getRequests("chat.startup")).length;
        await gateway.setMethodResponse("chat.startup", {
          messages: historyMessages,
          inFlightRun: { runId, startedAt: 1_000, text: "", events },
          sessionInfo,
          thinkingLevel: null,
        });
        await gateway.setOnline(false);
        await gateway.setOnline(true);
        await gateway.waitForRequest("chat.startup", { after: startupCount });
        await expect.poll(itemOccurrences).toEqual([1, 1]);

        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            fullPage: true,
            path: path.join(suite.artifactDir, "commentary-reconciliation.png"),
          });
        }
      },
    );
  });

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
            .toBe("2.4k output tokens");
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
