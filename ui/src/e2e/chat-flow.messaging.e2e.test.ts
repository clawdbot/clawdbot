import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
  waitForRequests,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

async function withChatPage(run: (page: Page) => Promise<void>): Promise<void> {
  const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
  try {
    await run(await context.newPage());
  } finally {
    await suite.closeBrowserContext(context);
  }
}

suite.define(() => {
  it.each([
    { draft: "Draft from a shared link", name: "a one-shot chat draft" },
    { draft: undefined, name: "an existing session URL" },
  ])("preserves remaining URL state while resolving $name", async ({ draft }) => {
    await withChatPage(async (page) => {
      await installMockGateway(page, { historyMessages: [] });
      const sessionUrl = new URL(controlUiSessionUrl(suite.server.baseUrl, "main"));
      if (draft !== undefined) {
        sessionUrl.searchParams.set("draft", draft);
      }
      sessionUrl.searchParams.set("panel", "details");
      sessionUrl.hash = "#pane";

      await page.goto(sessionUrl.href);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await expect.poll(() => composer.inputValue()).toBe(draft ?? "");
      await expect.poll(() => new URL(page.url()).search).toBe("?panel=details");
      await expect.poll(() => new URL(page.url()).hash).toBe("#pane");
    });
  });

  it("sends a chat turn through the GUI and renders the final Gateway event", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            content: [{ text: "Ready for an end-to-end GUI check.", type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Ready for an end-to-end GUI check.").waitFor({ timeout: 10_000 });

      const prompt = "verify the control UI e2e harness";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      expect(params.sessionKey).toBe("agent:main:main");
      expect(params.message).toBe(prompt);
      expect(params.deliver).toBe(false);

      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      await gateway.emitChatFinal({ runId, text: "Harness verified." });

      await page
        .locator(".chat-thread-inner")
        .getByText("Harness verified.")
        .waitFor({ timeout: 10_000 });

      const spacedPairCommand = "/ pair qr";
      await page.locator(".agent-chat__composer-combobox textarea").fill(spacedPairCommand);
      await page.getByRole("button", { name: "Send message" }).click();

      const commandRequests = await waitForRequests(gateway, "chat.send", 2);
      const commandParams = requireRecord(commandRequests[1]?.params);
      expect(commandParams.message).toBe(spacedPairCommand);
    });
  });

  it("adopts a browser-local prompt from a metadata-free gateway event without duplication", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page, {
        historyMessages: [],
        deferredMethods: ["chat.send"],
      });
      const prompt = "Keep my browser-local prompt synchronized.";
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const request = await gateway.waitForRequest("chat.send");
      const runId = requireString(requireRecord(request.params).idempotencyKey, "chat run id");
      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      const userRow = page.locator(".chat-group.user", { hasText: prompt });
      await userRow.waitFor({ timeout: 10_000 });

      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [runId],
        clientRunId: runId,
        hasActiveRun: true,
        message: {
          content: [{ text: prompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
        messageId: "browser-local-authoritative-user",
        messageSeq: 1,
        session: {
          activeRunIds: [runId],
          hasActiveRun: true,
          key: "agent:main:main",
          kind: "direct",
          status: "running",
          updatedAt: Date.now(),
        },
        sessionKey: "agent:main:main",
      });

      await expect.poll(() => userRow.count()).toBe(1);
      const finalText = "Browser prompt stayed synchronized.";
      await gateway.setHistoryMessages([
        {
          __openclaw: {
            id: "browser-local-authoritative-user",
            idempotencyKey: `${runId}:user`,
            seq: 1,
          },
          content: [{ text: prompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
        {
          __openclaw: { id: "browser-local-authoritative-assistant", seq: 2, runId },
          content: [{ text: finalText, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ]);
      await gateway.emitChatFinal({ runId, text: finalText });
      await page.locator(".chat-group.assistant .chat-text", { hasText: finalText }).waitFor({
        timeout: 10_000,
      });
      await expect.poll(() => userRow.count()).toBe(1);
    });
  });

  it("keeps a previous final above a newer active turn when events arrive late", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page, {
        historyMessages: [],
        deferredMethods: ["chat.send"],
      });
      const previousRunId = "previous-run";
      const previousPrompt = "What are groups?";
      const previousFinal = "Groups organize conversations.";
      const currentPrompt = "Why were my sessions missing?";
      const currentPartial = "Checking external sessions...";

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [],
        clientRunId: previousRunId,
        hasActiveRun: false,
        message: {
          content: [{ text: previousPrompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
        messageId: "previous-user",
        messageSeq: 1,
        session: {
          activeRunIds: [],
          hasActiveRun: false,
          key: "agent:main:main",
          kind: "direct",
          status: "done",
          updatedAt: Date.now(),
        },
        sessionKey: "agent:main:main",
      });

      await page.locator(".agent-chat__composer-combobox textarea").fill(currentPrompt);
      await page.getByRole("button", { name: "Send message" }).click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      const currentRunId = requireString(
        requireRecord(sendRequest.params).idempotencyKey,
        "current chat run id",
      );
      // This scenario owns the exact transcript sequence, including a prior
      // final that arrives late. Keep its ACK distinct from those source events.
      await gateway.resolveDeferred("chat.send", { runId: currentRunId, status: "started" });
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [currentRunId],
        clientRunId: currentRunId,
        hasActiveRun: true,
        message: {
          content: [{ text: currentPrompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
        messageId: "current-user",
        messageSeq: 3,
        session: {
          activeRunIds: [currentRunId],
          hasActiveRun: true,
          key: "agent:main:main",
          kind: "direct",
          status: "running",
          updatedAt: Date.now(),
        },
        sessionKey: "agent:main:main",
      });
      await gateway.emitGatewayEvent("chat", {
        deltaText: currentPartial,
        message: {
          content: [{ text: currentPartial, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId: currentRunId,
        seq: 1,
        sessionKey: "agent:main:main",
        state: "delta",
      });
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [currentRunId],
        clientRunId: previousRunId,
        hasActiveRun: true,
        message: {
          content: [{ text: previousFinal, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        messageId: "previous-final",
        messageSeq: 2,
        session: {
          activeRunIds: [currentRunId],
          hasActiveRun: true,
          key: "agent:main:main",
          kind: "direct",
          status: "running",
          updatedAt: Date.now(),
        },
        sessionKey: "agent:main:main",
      });

      const visibleTexts = [previousPrompt, previousFinal, currentPrompt, currentPartial];
      const expectVisibleOrder = async () => {
        await expect
          .poll(() =>
            page.locator(".chat-thread-inner").evaluate((thread, texts) => {
              const rows = Array.from(thread.querySelectorAll(".chat-bubble"));
              return texts.map((text) => rows.findIndex((row) => row.textContent?.includes(text)));
            }, visibleTexts),
          )
          .toEqual([0, 1, 2, 3]);
      };
      await expectVisibleOrder();

      await gateway.emitChatFinal({ runId: previousRunId, text: previousFinal });
      await expectVisibleOrder();
      await expect
        .poll(() => page.locator(".chat-group.assistant", { hasText: previousFinal }).count())
        .toBe(1);
    });
  });

  it("preserves distinct same-text peer messages through conflicting envelopes and stale history", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page, { historyMessages: [] });
      const prompt = "Both clients independently sent the same prompt.";
      const persistedMessages = ["web", "tui"].map((client, index) => ({
        __openclaw: {
          id: `canonical-${client}-same-text`,
          idempotencyKey: `${client}-same-text-run:user`,
          seq: index + 1,
        },
        content: [{ text: prompt, type: "text" }],
        role: "user",
        timestamp: 1_700_000_000_000 + index,
      }));
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const historyCount = (await gateway.getRequests("chat.history")).length;
      await gateway.deferNext("chat.history");

      const emitPersistedMessage = async (index: number) => {
        const message = persistedMessages[index];
        await gateway.emitGatewayEvent("session.message", {
          activeRunIds: [],
          hasActiveRun: false,
          message,
          // Persisted metadata is authoritative when a transport envelope disagrees.
          messageId: `conflicting-envelope-${index + 1}`,
          messageSeq: 100 + index,
          session: {
            activeRunIds: [],
            hasActiveRun: false,
            key: "agent:main:main",
            kind: "direct",
            status: "done",
            updatedAt: Date.now(),
          },
          sessionKey: "agent:main:main",
        });
      };

      await emitPersistedMessage(0);
      await waitForRequests(gateway, "chat.history", historyCount + 1);
      await emitPersistedMessage(1);

      // Consecutive users intentionally share one sender group; identity belongs to each bubble.
      const peerBubbles = page.locator(".chat-group.user .chat-bubble", { hasText: prompt });
      const expectedBubbleIds = ["web", "tui"].map(
        (client) => `msg:send:${client}-same-text-run:0`,
      );
      const expectDistinctPeerBubbles = async () => {
        await expect.poll(() => peerBubbles.count()).toBe(2);
        await expect
          .poll(() =>
            peerBubbles.evaluateAll((bubbles) =>
              bubbles.map((bubble) => bubble.getAttribute("data-message-id")),
            ),
          )
          .toEqual(expectedBubbleIds);
      };
      await expectDistinctPeerBubbles();
      await gateway.setHistoryMessages(persistedMessages);
      await gateway.resolveDeferred("chat.history", {
        messages: [],
        sessionId: "session:agent:main:main",
        thinkingLevel: null,
      });
      await expectDistinctPeerBubbles();

      await emitPersistedMessage(0);
      await expectDistinctPeerBubbles();
    });
  });

  it.each([
    { identity: "transcript metadata", includeMessageMetadata: true },
    { identity: "gateway event envelope", includeMessageMetadata: false },
  ])(
    "keeps another client's $identity user turn ahead of its already-streaming reply",
    async ({ includeMessageMetadata }) => {
      await withChatPage(async (page) => {
        const gateway = await installMockGateway(page, { historyMessages: [] });
        const runId = "shared-session-tui-run";
        const prompt = "Sent from the other client.";
        const secondPrompt = "A distinct turn in the same shared run.";
        const partial = "Streaming into both clients.";
        const userMessage = {
          content: [{ text: prompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        };
        const persistedUserMessage = {
          ...userMessage,
          __openclaw: { id: "shared-session-user", idempotencyKey: `${runId}:user`, seq: 1 },
        };
        const secondUserMessage = {
          content: [{ text: secondPrompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        };
        const persistedSecondUserMessage = {
          ...secondUserMessage,
          __openclaw: { id: "shared-session-second-user", idempotencyKey: `${runId}:user`, seq: 2 },
        };
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        // Even an envelope-only event reads back with its canonical transcript identity.
        await gateway.setHistoryMessages([persistedUserMessage]);
        await gateway.emitGatewayEvent("chat", {
          deltaText: partial,
          message: {
            content: [{ text: partial, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
          runId,
          seq: 1,
          sessionKey: "agent:main:main",
          state: "delta",
        });
        await page.locator(".chat-bubble.streaming", { hasText: partial }).waitFor({
          timeout: 10_000,
        });

        const sharedUserEvent = {
          activeRunIds: [runId],
          clientRunId: includeMessageMetadata ? "conflicting-envelope-run" : runId,
          hasActiveRun: true,
          message: includeMessageMetadata ? persistedUserMessage : userMessage,
          messageId: "shared-session-user",
          messageSeq: 1,
          session: {
            activeRunIds: [runId],
            hasActiveRun: true,
            key: "agent:main:main",
            kind: "direct",
            status: "running",
            updatedAt: Date.now(),
          },
          sessionKey: "agent:main:main",
        };
        await gateway.emitGatewayEvent("session.message", sharedUserEvent);

        const userRow = page.locator(".chat-group.user", { hasText: prompt });
        await userRow.waitFor({ timeout: 10_000 });
        expect(await userRow.count()).toBe(1);
        await gateway.emitGatewayEvent("session.message", sharedUserEvent);
        await expect.poll(() => userRow.count()).toBe(1);
        await gateway.emitGatewayEvent("session.message", {
          ...sharedUserEvent,
          message: includeMessageMetadata ? persistedSecondUserMessage : secondUserMessage,
          messageId: "shared-session-second-user",
          messageSeq: 2,
        });
        const secondUserRow = page.locator(".chat-group.user", { hasText: secondPrompt });
        await secondUserRow.waitFor({ timeout: 10_000 });
        await expect.poll(() => userRow.count()).toBe(1);
        await expect.poll(() => secondUserRow.count()).toBe(1);
        await expect
          .poll(() =>
            page.locator(".chat-thread-inner").evaluate(
              (thread, texts) => {
                const user = Array.from(thread.querySelectorAll(".chat-group.user")).find((row) =>
                  row.textContent?.includes(texts.prompt),
                );
                const assistant = Array.from(
                  thread.querySelectorAll(".chat-bubble.streaming"),
                ).find((row) => row.textContent?.includes(texts.partial));
                return Boolean(
                  user &&
                  assistant &&
                  user.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING,
                );
              },
              { partial, prompt },
            ),
          )
          .toBe(true);

        const finalText = "Both clients stayed synchronized.";
        await gateway.setHistoryMessages([
          persistedUserMessage,
          persistedSecondUserMessage,
          {
            __openclaw: { id: "shared-session-assistant", seq: 3, runId },
            content: [{ text: finalText, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
        ]);
        await gateway.emitChatFinal({ runId, text: finalText });
        await page.locator(".chat-group.assistant .chat-text", { hasText: finalText }).waitFor({
          timeout: 10_000,
        });
        await expect.poll(() => userRow.count()).toBe(1);
        await expect.poll(() => secondUserRow.count()).toBe(1);
      });
    },
  );

  it.each([
    { history: "up-to-date", includesPrompt: true },
    { history: "stale", includesPrompt: false },
  ])(
    "preserves a delayed persisted prompt ahead of a finalized reply with $history history",
    async ({ includesPrompt }) => {
      await withChatPage(async (page) => {
        const gateway = await installMockGateway(page, { historyMessages: [] });
        const runId = "shared-session-finalized-run";
        const prompt = "The persisted prompt arrived after the final.";
        const finalText = "The reply was already finished.";
        const userMessage = {
          __openclaw: { id: "finalized-run-user", idempotencyKey: `${runId}:user`, seq: 1 },
          content: [{ text: prompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        };
        const assistantMessage = {
          __openclaw: { id: "finalized-run-assistant", seq: 2 },
          content: [{ text: finalText, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        };
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        await gateway.emitGatewayEvent("chat", {
          deltaText: finalText,
          message: {
            content: [{ text: finalText, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
          runId,
          seq: 1,
          sessionKey: "agent:main:main",
          state: "delta",
        });
        await page.locator(".chat-bubble.streaming", { hasText: finalText }).waitFor({
          timeout: 10_000,
        });
        await gateway.emitChatFinal({ runId, text: finalText });
        await page.locator(".chat-group.assistant .chat-text", { hasText: finalText }).waitFor({
          timeout: 10_000,
        });
        await gateway.setHistoryMessages([userMessage, assistantMessage]);
        await gateway.deferNext("chat.history");
        await gateway.emitGatewayEvent("session.message", {
          activeRunIds: [],
          clientRunId: runId,
          hasActiveRun: false,
          message: userMessage,
          messageId: "finalized-run-user",
          messageSeq: 1,
          session: {
            activeRunIds: [],
            hasActiveRun: false,
            key: "agent:main:main",
            kind: "direct",
            status: "done",
            updatedAt: Date.now(),
          },
          sessionKey: "agent:main:main",
        });

        await expect
          .poll(() =>
            page.locator(".chat-thread-inner").evaluate(
              (thread, texts) => {
                const user = Array.from(thread.querySelectorAll(".chat-group.user")).find((row) =>
                  row.textContent?.includes(texts.prompt),
                );
                const assistant = Array.from(thread.querySelectorAll(".chat-group.assistant")).find(
                  (row) => row.textContent?.includes(texts.finalText),
                );
                return Boolean(
                  user &&
                  assistant &&
                  user.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING,
                );
              },
              { finalText, prompt },
            ),
          )
          .toBe(true);
        await gateway.resolveDeferred("chat.history", {
          messages: includesPrompt ? [userMessage, assistantMessage] : [assistantMessage],
          sessionId: "session:agent:main:main",
          thinkingLevel: null,
        });
        await expect
          .poll(() => page.locator(".chat-group.user", { hasText: prompt }).count())
          .toBe(1);
      });
    },
  );

  it("keeps a browser-local prompt before a clock-skewed Gateway reply", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page, { historyMessages: [] });
      const prompt = "verify clock-skewed chat order";
      const partial = "The Gateway is replying from an earlier clock.";
      const reply = "The Gateway reply stayed below its prompt.";
      const appearsBefore = (lowerSelector: string, lowerText: string) =>
        page.locator(".chat-thread-inner").evaluate(
          (
            thread: Element,
            texts: { lowerSelector: string; lowerText: string; prompt: string },
          ) => {
            const findByText = (selector: string, text: string) =>
              Array.from(thread.querySelectorAll(selector)).find((row) =>
                (row.textContent ?? "").includes(text),
              );
            const promptRow = findByText(".chat-group.user", texts.prompt);
            const lowerRow = findByText(texts.lowerSelector, texts.lowerText);
            if (!promptRow || !lowerRow) {
              return false;
            }
            return promptRow.getBoundingClientRect().top < lowerRow.getBoundingClientRect().top;
          },
          { lowerSelector, lowerText, prompt },
        );
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.deferNext("chat.send");
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const runId = requireString(
        requireRecord(sendRequest.params).idempotencyKey,
        "chat send idempotency key",
      );
      const browserTimestamp = await page.evaluate(() => Date.now());
      const gatewayTimestamp = browserTimestamp - 60_000;
      await gateway.emitGatewayEvent("chat", {
        deltaText: partial,
        message: {
          content: [{ text: partial, type: "text" }],
          role: "assistant",
          timestamp: gatewayTimestamp,
        },
        runId,
        sessionKey: "agent:main:main",
        state: "delta",
      });
      await page.locator(".chat-bubble.streaming", { hasText: partial }).waitFor({
        timeout: 10_000,
      });
      expect(await appearsBefore(".chat-bubble.streaming", partial)).toBe(true);

      await gateway.emitGatewayEvent("chat", {
        message: {
          content: [{ text: reply, type: "text" }],
          role: "assistant",
          timestamp: gatewayTimestamp,
        },
        runId,
        sessionKey: "agent:main:main",
        state: "final",
      });
      await page.locator(".chat-group.assistant .chat-text", { hasText: reply }).waitFor({
        timeout: 10_000,
      });
      expect(await appearsBefore(".chat-group.assistant", reply)).toBe(true);
      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      expect(await appearsBefore(".chat-group.assistant", reply)).toBe(true);
    });
  });

  it("reconciles authoritative history before a trailing final by run identity", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page, { historyMessages: [] });
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("reconcile the terminal event ordering");
      await page.getByRole("button", { name: "Send message" }).click();
      const send = await gateway.waitForRequest("chat.send");
      const runId = requireString(
        requireRecord(send.params).idempotencyKey,
        "chat send idempotency key",
      );
      const finalText = "One authoritative final response.";
      const messageId = "assistant-authoritative-final";
      const authoritative = {
        __openclaw: { id: messageId, seq: 2 },
        content: [{ text: finalText, type: "text" }],
        role: "assistant",
        timestamp: Date.now(),
      };
      await gateway.emitGatewayEvent("chat", {
        deltaText: finalText,
        message: {
          content: [{ text: finalText, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "agent:main:main",
        state: "delta",
      });
      await page.locator(".chat-bubble.streaming", { hasText: finalText }).waitFor();
      await gateway.setHistoryMessages([
        {
          __openclaw: { id: `mock-user:${runId}`, idempotencyKey: `${runId}:user`, seq: 1 },
          content: "reconcile the terminal event ordering",
          role: "user",
          timestamp: Date.now() - 1,
        },
        authoritative,
      ]);
      const historyRequestsBefore = (await gateway.getRequests("chat.history")).length;
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [],
        clientRunId: runId,
        hasActiveRun: false,
        message: authoritative,
        messageId,
        messageSeq: 2,
        session: {
          activeRunIds: [],
          hasActiveRun: false,
          key: "agent:main:main",
          kind: "direct",
          status: "done",
          updatedAt: Date.now(),
        },
        sessionKey: "agent:main:main",
      });
      await expect
        .poll(async () => (await gateway.getRequests("chat.history")).length)
        .toBeGreaterThan(historyRequestsBefore);
      await page.locator(".chat-thread-inner").getByText(finalText, { exact: true }).waitFor();
      await expect
        .poll(() =>
          page.locator(".chat-group.assistant .chat-text", { hasText: finalText }).count(),
        )
        .toBe(1);

      await gateway.emitChatFinal({ runId, text: finalText });
      await expect
        .poll(() => page.locator(".chat-group.assistant .chat-duplicate-count").count())
        .toBe(0);
      await expect
        .poll(() =>
          page.locator(".chat-group.assistant .chat-text", { hasText: finalText }).count(),
        )
        .toBe(1);

      await gateway.emitChatFinal({ runId: "a-different-legitimate-run", text: finalText });
      await expect
        .poll(() =>
          page.locator(".chat-group.assistant .chat-text", { hasText: finalText }).count(),
        )
        .toBe(2);
    });
  });

  it("restores the selected session transcript after a hard reload", async () => {
    await withChatPage(async (page) => {
      const historyText = "Transcript survives a hard reload.";
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            content: [{ text: historyText, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
        ],
        sessionKey: "agent:main:main",
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "main"));
      await page.getByText(historyText).waitFor({ timeout: 10_000 });
      await gateway.waitForRequest("chat.startup");

      await page.reload();

      await page.getByText(historyText).waitFor({ timeout: 10_000 });
      // The mock request journal belongs to the current document and restarts
      // on reload, so the restored page records its own startup request once.
      await gateway.waitForRequest("chat.startup");
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
    });
  });

  it("sends idle stop aliases as ordinary chat messages", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await composer.fill("wait");
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      expect(requireRecord(sendRequest.params).message).toBe("wait");
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
    });
  });

  it("sends annotated /stop to the exact selected channel session and clears its working indicator", async () => {
    await withChatPage(async (page) => {
      const channelSessionKey = "agent:main:openclaw-weixin:direct:wechat-user";
      const gateway = await installMockGateway(page, {
        sessionKey: channelSessionKey,
        methodResponses: {
          "sessions.abort": { abortedRunId: null, ok: true, status: "aborted" },
          "sessions.list": chatSessionListResponse([
            {
              hasActiveRun: true,
              key: channelSessionKey,
              kind: "direct",
              label: "WeChat user",
              status: "running",
              updatedAt: Date.now(),
            },
          ]),
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, channelSessionKey));
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await gateway.waitForRequest("sessions.list");
      const workingIndicator = page.locator(".chat-working-indicator");
      await workingIndicator.waitFor({ state: "visible", timeout: 10_000 });

      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("openclaw:browser-annotation", {
            cancelable: true,
            detail: {
              modelContext: "Review the annotated page",
              dataUrl:
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
              fileName: "annotated-page.png",
              card: {
                title: "Annotated page",
                displayUrl: "example.com",
                markedRegionCount: 1,
                inspectedElement: false,
              },
            },
          }),
        );
      });
      await page.locator(".chat-attachment-thumb--browser-annotation").waitFor();

      await composer.fill("/stop");
      await page.getByRole("option", { name: /\/stop/ }).waitFor();
      await composer.press("Enter");

      const abortRequest = await gateway.waitForRequest("sessions.abort");
      expect(requireRecord(abortRequest.params)).toEqual({
        key: channelSessionKey,
        clearQueued: true,
      });
      await gateway.setSessionsListResponse(
        chatSessionListResponse([
          {
            activeRunIds: [],
            hasActiveRun: false,
            key: channelSessionKey,
            kind: "direct",
            label: "WeChat user",
            status: "running",
            updatedAt: Date.now(),
          },
        ]),
      );
      await gateway.emitGatewayEvent("sessions.changed", {
        activeRunIds: [],
        hasActiveRun: false,
        reason: "abort",
        sessionKey: channelSessionKey,
        status: "running",
        updatedAt: Date.now(),
      });
      await workingIndicator.waitFor({ state: "detached", timeout: 10_000 });
      await page.locator(".chat-attachment-thumb--browser-annotation").waitFor();
      await expectRequestCountStable(gateway, "chat.abort", 0);
      await expectRequestCountStable(gateway, "chat.send", 0);
      await expect.poll(() => page.getByRole("listbox").count()).toBe(0);
      expect(await composer.inputValue()).toBe("");
      if (captureUiProofEnabled) {
        const channelStopProofDir = path.join(suite.artifactDir, "channel-stop");
        await page.screenshot({
          path: path.join(channelStopProofDir, "stopped.png"),
          fullPage: true,
        });
      }
    });
  });

  it("persists the chat send shortcut and keeps multiline and IME input safe", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 10_000 });

      await composer.fill("default enter send");
      await composer.press("Enter");
      const defaultRequest = await gateway.waitForRequest("chat.send");
      const defaultParams = requireRecord(defaultRequest.params);
      expect(defaultParams.message).toBe("default enter send");
      await gateway.emitChatFinal({
        runId: requireString(defaultParams.idempotencyKey, "default send idempotency key"),
        text: "Default shortcut received.",
      });
      await page
        .locator(".chat-thread-inner")
        .getByText("Default shortcut received.")
        .waitFor({ timeout: 10_000 });

      // The send shortcut moved to the Settings appearance page; picking it
      // there must apply to the chat composer after navigating back.
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      const shortcutSelect = page.locator("[data-settings-send-shortcut]");
      await shortcutSelect.selectOption("modifier-enter");
      expect(await shortcutSelect.inputValue()).toBe("modifier-enter");

      await page.goto(`${suite.server.baseUrl}chat`);
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      expect(await composer.getAttribute("aria-keyshortcuts")).toBe("Control+Enter Meta+Enter");

      await composer.fill("plain enter stays in the draft");
      await composer.press("Enter");
      expect(await composer.inputValue()).toContain("\n");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await composer.fill("composition must not send");
      await composer.dispatchEvent("compositionstart");
      await composer.press("Control+Enter");
      await composer.dispatchEvent("compositionend");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await composer.fill("modifier send");
      await composer.press("Meta+Enter");
      const modifierRequest = await gateway.waitForRequest("chat.send");
      expect(requireRecord(modifierRequest.params).message).toBe("modifier send");
    });
  });

  it("sends /steer for the selected session without resolving a run or leaf", async () => {
    await withChatPage(async (page) => {
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            content: [{ text: "Active run is waiting for steering.", type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
        ],
        methodResponses: {
          "sessions.list": chatSessionListResponse([
            {
              hasActiveRun: true,
              activeRunIds: ["active-run"],
              activeLeafEntryId: "leaf-before-steer",
              key: "agent:main:main",
              kind: "direct",
              label: "Main",
              updatedAt: Date.now(),
            },
          ]),
        },
        sessionKey,
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Active run is waiting for steering.").waitFor({ timeout: 10_000 });
      await gateway.waitForRequest("sessions.list");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill("/steer use the smaller fix");
      await page.getByRole("button", { name: "Send message" }).click();

      const steerRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(steerRequest.params);
      expect(params.sessionKey).toBe(sessionKey);
      expect(params.message).toBe("use the smaller fix");
      expect(params.deliver).toBe(false);
      expect(params.queueMode).toBe("steer");
      expect(params).not.toHaveProperty("expectedRunId");
      expect(params).not.toHaveProperty("expectedLeafEntryId");

      await page.getByText("Steered.", { exact: true }).waitFor({ timeout: 10_000 });
      expect(await page.getByText("No active run").count()).toBe(0);
    });
  });

  it("keeps a targetless message-tool source reply beside the automatic final reply", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);

      const prompt = "send progress through the message tool and then finish";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      expect(params).toMatchObject({
        sessionKey: "agent:main:main",
        message: prompt,
        deliver: false,
      });
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");

      await gateway.emitChatFinal({
        runId,
        text: "Visible progress from the targetless message tool.",
      });
      await page
        .locator(".chat-thread-inner")
        .getByText("Visible progress from the targetless message tool.")
        .waitFor({ timeout: 10_000 });

      await gateway.emitChatFinal({ runId, text: "Visible automatic final reply." });
      await page
        .locator(".chat-thread-inner")
        .getByText("Visible automatic final reply.")
        .waitFor({ timeout: 10_000 });
      const bubbleTexts = await page.locator(".chat-thread .chat-bubble").allTextContents();
      for (const expectedText of [
        prompt,
        "Visible progress from the targetless message tool.",
        "Visible automatic final reply.",
      ]) {
        expect(bubbleTexts.some((text) => text.includes(expectedText))).toBe(true);
      }
    });
  });

  it("keeps the composer clear when a stale native input replay arrives after send", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            content: [{ text: "Ready for stale replay check.", type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Ready for stale replay check.").waitFor({ timeout: 10_000 });

      const prompt = "submitted message";
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await gateway.waitForRequest("chat.send");
      expect(await composer.inputValue()).toBe("");

      const afterReplay = await composer.evaluate((element, submitted) => {
        const textarea = element as HTMLTextAreaElement;
        textarea.value = submitted;
        textarea.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: submitted,
            inputType: "insertText",
          }),
        );
        return textarea.value;
      }, prompt);

      expect(afterReplay).toBe("");
      expect(await composer.inputValue()).toBe("");

      await composer.pressSequentially(prompt);
      expect(await composer.inputValue()).toBe(prompt);
    });
  });
});
