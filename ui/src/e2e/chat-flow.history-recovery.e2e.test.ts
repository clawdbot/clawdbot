import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectDefined,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
  scrollChatThreadToTop,
  visibleChatBubbleTexts,
  waitForChatScrollIdle,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
type ChatFlowTestApp = HTMLElement & { runtime?: { context: ApplicationContext } };

suite.define(() => {
  it("keeps an unrelated retained transcript after another tab deletes a session", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionA = "agent:main:session-a";
    const sessionB = "agent:main:session-b";
    const deletedSession = "agent:main:session-c";
    const sessionAText = "Session A survives the peer deletion.";
    const sessionBText = "Session B keeps the first pane retained.";
    const historyCases = {
      cases: [
        {
          match: { sessionKey: sessionA },
          response: {
            messages: [{ role: "assistant", content: [{ type: "text", text: sessionAText }] }],
            sessionId: "session-a",
          },
        },
        {
          match: { sessionKey: sessionB },
          response: {
            messages: [{ role: "assistant", content: [{ type: "text", text: sessionBText }] }],
            sessionId: "session-b",
          },
        },
      ],
    };
    const sessionListResponse = chatSessionListResponse([
      { key: sessionA, kind: "direct", label: "Session A", updatedAt: 3 },
      { key: sessionB, kind: "direct", label: "Session B", updatedAt: 2 },
      { key: deletedSession, kind: "direct", label: "Session C", updatedAt: 1 },
    ]);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": historyCases,
        "chat.startup": historyCases,
        "sessions.list": sessionListResponse,
      },
      sessionKey: sessionA,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
      await page.getByText(sessionAText, { exact: true }).waitFor({ timeout: 10_000 });

      const sessionLink = (sessionKey: string) =>
        page.locator(
          `.sidebar-recent-session[data-session-key="${sessionKey}"] a.sidebar-recent-session__link`,
        );
      await sessionLink(sessionB).click();
      await page.getByText(sessionBText, { exact: true }).waitFor({ timeout: 10_000 });
      const retainedHistoryRequests = async () =>
        (await gateway.getRequests("chat.history")).filter(({ params }) => {
          const { sessionKey } = requireRecord(params);
          return sessionKey === sessionA || sessionKey === sessionB;
        });
      const historyRequestsBeforePeerDelete = (await retainedHistoryRequests()).length;
      const startupRequestsBeforePeerDelete = (await gateway.getRequests("chat.startup")).length;
      await page.evaluate(() => {
        window.addEventListener("storage", (event) => {
          if (event.key === "openclaw.control.chatSnapshots.invalidate.v1") {
            document.documentElement.dataset.snapshotInvalidationReceived = "true";
          }
        });
      });

      const peer = await context.newPage();
      try {
        await installMockGateway(peer, {
          methodResponses: {
            "sessions.delete": { deleted: true, ok: true },
            "sessions.list": sessionListResponse,
          },
          sessionKey: deletedSession,
        });
        await peer.goto(`${suite.server.baseUrl}sessions`);
        await peer.waitForFunction(() =>
          Boolean((document.querySelector("openclaw-app") as ChatFlowTestApp).runtime),
        );
        await expect(
          peer.evaluate(async (sessionKey) => {
            const sessions = (document.querySelector("openclaw-app") as ChatFlowTestApp).runtime
              ?.context.sessions;
            if (!sessions) {
              throw new Error("session capability unavailable");
            }
            return sessions.delete(sessionKey, { agentId: "main" });
          }, deletedSession),
        ).resolves.toMatchObject({ deleted: true });
        await page.waitForFunction(
          () => document.documentElement.dataset.snapshotInvalidationReceived === "true",
        );
      } finally {
        await peer.close();
      }

      await sessionLink(sessionA).click();
      await page.getByText(sessionAText, { exact: true }).waitFor({ timeout: 10_000 });
      // Prefetch may warm C without reloading either retained pane. Request capture is
      // append-only, so checking history after the startup window covers the same interval.
      await expectRequestCountStable(gateway, "chat.startup", startupRequestsBeforePeerDelete);
      expect(await retainedHistoryRequests()).toHaveLength(historyRequestsBeforePeerDelete);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("restores reasoning and tool activity after navigating away from a session", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
    }
    const context = await suite.newBrowserContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionA = "agent:main:session-a";
    const sessionB = "agent:main:session-b";
    const visibleAnswer = "Trace preserved after navigation.";
    const reasoning = "Checked the persisted session trace.";
    const currentMessages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Current session placeholder." }],
        timestamp: 1,
      },
    ];
    const traceMessages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: reasoning },
          { type: "text", text: visibleAnswer },
          {
            type: "toolCall",
            id: "call-read",
            name: "read",
            arguments: { path: "AGENTS.md" },
          },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-read",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        timestamp: 3,
      },
    ];
    const responseCases = {
      cases: [
        {
          match: { sessionKey: sessionB },
          response: { messages: traceMessages, sessionId: "trace-session", thinkingLevel: "high" },
        },
        {
          match: { sessionKey: sessionA },
          response: {
            messages: currentMessages,
            sessionId: "current-session",
            thinkingLevel: "high",
          },
        },
      ],
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": responseCases,
        "chat.startup": responseCases,
        "sessions.list": chatSessionListResponse([
          {
            key: sessionA,
            kind: "direct",
            label: "Session A",
            reasoningLevel: "high",
            updatedAt: 2,
          },
          {
            key: sessionB,
            kind: "direct",
            label: "Session B",
            reasoningLevel: "high",
            updatedAt: 1,
          },
        ]),
      },
      sessionKey: sessionA,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Current session placeholder.").waitFor({ timeout: 10_000 });

      const sessionLink = (sessionKey: string) =>
        page.locator(
          `.sidebar-recent-session[data-session-key="${sessionKey}"] a.sidebar-recent-session__link`,
        );
      const expectTrace = async () => {
        await page.getByText(visibleAnswer, { exact: true }).waitFor({ timeout: 10_000 });
        await expect.poll(() => page.locator(".chat-thinking").textContent()).toContain(reasoning);
        await expect
          .poll(() => page.locator(".chat-tool-msg-summary").textContent())
          .toContain("Read");
      };

      await sessionLink(sessionB).click();
      await expectTrace();
      if (artifactDir) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "trace-after-first-navigation.png"),
        });
      }

      await sessionLink(sessionA).click();
      await page.getByText("Current session placeholder.").waitFor({ timeout: 10_000 });
      const historyRequestsBeforeReturn = (await gateway.getRequests("chat.history")).length;
      await sessionLink(sessionB).click();
      await expectTrace();
      expect(await gateway.getRequests("chat.history")).toHaveLength(historyRequestsBeforeReturn);
      if (artifactDir) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "trace-after-return.png"),
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps valid assistant history visible after a malformed transcript block", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const visibleAnswer = "The valid assistant answer remains visible.";
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [null, { type: "output_text", text: visibleAnswer }],
          timestamp: Date.parse("2026-07-12T14:30:00.000Z"),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".chat-thread").getByText(visibleAnswer, { exact: true }).waitFor({
        timeout: 10_000,
      });
      expect((await gateway.getRequests("chat.startup")).length).toBeGreaterThan(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("shows persisted user messages after opening History and scrolling mixed history", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const currentSessionMessages = [
      {
        content: [{ text: "Current session placeholder", type: "text" }],
        role: "assistant",
        timestamp: baseTs - 1,
      },
    ];
    const historyMessages = Array.from({ length: 70 }, (_, index) => ({
      content: [
        {
          text: `${index % 2 === 0 ? "User history question" : "Assistant history answer"} ${index}\n${"history detail line\n".repeat(4)}`,
          type: index % 2 === 0 ? "input_text" : "output_text",
        },
      ],
      role: index % 2 === 0 ? "user" : "assistant",
      timestamp: baseTs + index,
    }));
    const gateway = await installMockGateway(page, {
      historyMessages: currentSessionMessages,
      methodResponses: {
        "chat.startup": {
          cases: [
            {
              match: { sessionKey: "agent:main:session-b" },
              response: {
                messages: historyMessages,
                sessionId: "control-ui-e2e-history-session-b",
                thinkingLevel: null,
              },
            },
            {
              match: { sessionKey: "agent:main:session-a" },
              response: {
                messages: currentSessionMessages,
                sessionId: "control-ui-e2e-history-session-a",
                thinkingLevel: null,
              },
            },
          ],
        },
        "sessions.list": chatSessionListResponse(),
      },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Current session placeholder").waitFor({ timeout: 10_000 });

      const startupCountBeforeSwitch = (await gateway.getRequests("chat.startup")).length;
      await page
        .locator(
          '.sidebar-recent-session[data-session-key="agent:main:session-b"] a.sidebar-recent-session__link',
        )
        .click();
      const startupRequests = await waitForRequests(
        gateway,
        "chat.startup",
        startupCountBeforeSwitch + 1,
      );
      const historyRequest = expectDefined(startupRequests.at(-1), "session B startup request");
      expect(requireRecord(historyRequest.params)).toMatchObject({
        sessionKey: "agent:main:session-b",
      });
      const activeThread = page.locator(".chat-pane-cache__pane--active .chat-thread");
      await activeThread.getByText("User history question 68").waitFor({
        timeout: 10_000,
      });
      await activeThread.locator(".chat-bubble").getByText("Assistant history answer 69").waitFor({
        timeout: 10_000,
      });
      await expect
        .poll(
          async () => {
            const texts = await visibleChatBubbleTexts(page);
            return (
              texts.some((text) => text.includes("User history question 68")) &&
              texts.some((text) => text.includes("Assistant history answer 69"))
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);

      await waitForChatScrollIdle(page);
      await scrollChatThreadToTop(page);
      await activeThread.getByText("User history question 0").waitFor({
        timeout: 10_000,
      });
      await scrollChatThreadToTop(page);
      await expect
        .poll(
          async () => {
            const texts = await visibleChatBubbleTexts(page);
            return (
              texts.some((text) => text.includes("User history question 0")) &&
              texts.some((text) => text.includes("Assistant history answer 1"))
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps evicted paginated history stable when returning to a session", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.newBrowserContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const captureEvictionStep = async (name: string) => {
      if (!artifactDir) {
        return;
      }
      await page.screenshot({
        path: path.join(artifactDir, `${name}.png`),
        fullPage: true,
      });
      // Keep post-assertion route states legible in the optional proof recording.
      await page.waitForTimeout(300);
    };
    const historyMessage = (seq: number, label: string) => ({
      __openclaw: { id: `history-${seq}`, seq },
      content: [
        {
          text: `${label} ${seq}\n${"retained transcript detail\n".repeat(3)}`,
          type: seq % 2 === 0 ? "output_text" : "input_text",
        },
      ],
      role: seq % 2 === 0 ? "assistant" : "user",
      timestamp: 1_800_000_000_000 + seq,
    });
    const shortMessages = [historyMessage(1, "short session"), historyMessage(2, "short session")];
    const sessionCMessages = [historyMessage(201, "session c"), historyMessage(202, "session c")];
    const sessionDMessages = [historyMessage(301, "session d"), historyMessage(302, "session d")];
    const shortSessions = [
      {
        key: "agent:main:session-a",
        label: "Session A",
        messages: shortMessages,
        sessionId: "short-history-session",
        updatedAt: 4,
      },
      {
        key: "agent:main:session-c",
        label: "Session C",
        messages: sessionCMessages,
        sessionId: "short-history-session-c",
        updatedAt: 2,
      },
      {
        key: "agent:main:session-d",
        label: "Session D",
        messages: sessionDMessages,
        sessionId: "short-history-session-d",
        updatedAt: 1,
      },
    ];
    const shortSessionHistoryCases = shortSessions.map(({ key, messages, sessionId }) => ({
      match: { sessionKey: key },
      response: {
        hasMore: false,
        messages,
        sessionId,
        thinkingLevel: null,
        totalMessages: 2,
      },
    }));
    const recentMessages = Array.from({ length: 100 }, (_, index) =>
      historyMessage(index + 41, "recent retained message"),
    );
    const olderMessages = Array.from({ length: 40 }, (_, index) =>
      historyMessage(index + 1, "older retained message"),
    );
    const gateway = await installMockGateway(page, {
      historyMessages: shortMessages,
      methodResponses: {
        "chat.history": {
          cases: [
            {
              match: { offset: 100, sessionKey: "agent:main:session-b" },
              response: {
                hasMore: false,
                messages: olderMessages,
                sessionId: "retained-history-session",
                thinkingLevel: null,
                totalMessages: 140,
              },
            },
            {
              match: { sessionKey: "agent:main:session-b" },
              response: {
                hasMore: true,
                messages: recentMessages,
                nextOffset: 100,
                sessionId: "retained-history-session",
                thinkingLevel: null,
                totalMessages: 140,
              },
            },
            ...shortSessionHistoryCases,
          ],
        },
        "chat.startup": {
          cases: [
            {
              match: { sessionKey: "agent:main:session-b" },
              response: {
                hasMore: true,
                messages: recentMessages,
                nextOffset: 100,
                sessionId: "retained-history-session",
                thinkingLevel: null,
                totalMessages: 140,
              },
            },
            ...shortSessionHistoryCases,
          ],
        },
        "sessions.list": chatSessionListResponse([
          ...shortSessions.map(({ key, label, updatedAt }) => ({
            key,
            kind: "direct",
            label,
            updatedAt,
          })),
          {
            key: "agent:main:session-b",
            kind: "direct",
            label: "Session B",
            updatedAt: 3,
          },
        ]),
      },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText(/^short session 2\n/).waitFor({ timeout: 10_000 });

      const sessionB = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-b"] a.sidebar-recent-session__link',
      );
      const sessionA = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-a"] a.sidebar-recent-session__link',
      );
      const sessionC = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-c"] a.sidebar-recent-session__link',
      );
      const sessionD = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-d"] a.sidebar-recent-session__link',
      );
      await sessionB.click();
      await page.getByText(/^recent retained message 140\n/).waitFor({ timeout: 10_000 });
      const activePane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const thread = activePane.locator(".chat-thread");
      await thread.hover();
      await page.mouse.wheel(0, -1_000_000);
      await expect
        .poll(() =>
          activePane.evaluate(
            (element) =>
              (element as HTMLElement & { state: { chatMessages: unknown[] } }).state.chatMessages
                .length,
          ),
        )
        .toBe(140);
      // Prepending preserves the visible anchor. A renewed upward gesture
      // reaches the newly loaded start instead of teleporting the reader.
      await page.mouse.wheel(0, -1_000_000);
      await page.getByText(/^older retained message 1\n/).waitFor({ timeout: 10_000 });

      await sessionA.click();
      await page.getByText(/^short session 2\n/).waitFor({ timeout: 10_000 });
      await captureEvictionStep("eviction-session-a");
      await sessionC.click();
      await page.getByText(/^session c 202\n/).waitFor({ timeout: 10_000 });
      await captureEvictionStep("eviction-session-c");
      await sessionD.click();
      await page.getByText(/^session d 302\n/).waitFor({ timeout: 10_000 });
      await captureEvictionStep("eviction-session-d");
      const historyRequestsBeforeReturn = (await gateway.getRequests("chat.history")).length;
      await page.evaluate(() => {
        type FrameSample = {
          hiddenNotice: boolean;
          loading: boolean;
          messageCount: number;
          minOpacity: number;
          sessionKey: string;
        };
        const samples: FrameSample[] = [];
        (
          globalThis as typeof globalThis & {
            chatSessionReturnSamples: FrameSample[];
          }
        ).chatSessionReturnSamples = samples;
        const deadline = performance.now() + 750;
        const sample = () => {
          const pane = document.querySelector('openclaw-chat-pane[aria-hidden="false"]') as
            | (HTMLElement & {
                state?: { chatMessages?: unknown[]; sessionKey?: string };
              })
            | null;
          const rows = Array.from(pane?.querySelectorAll<HTMLElement>("[data-chat-row-key]") ?? []);
          samples.push({
            hiddenNotice: pane?.textContent?.includes("Showing last") ?? false,
            loading:
              pane?.querySelector(".chat-history-sentinel openclaw-panel-loading-skeleton") !==
              null,
            messageCount: pane?.state?.chatMessages?.length ?? 0,
            minOpacity: rows.reduce(
              (minimum, row) => Math.min(minimum, Number.parseFloat(getComputedStyle(row).opacity)),
              1,
            ),
            sessionKey: pane?.state?.sessionKey ?? "",
          });
          if (performance.now() < deadline) {
            requestAnimationFrame(sample);
          }
        };
        requestAnimationFrame(sample);
      });

      await sessionB.click();
      // Returning preserves the reading position at the loaded-history start;
      // the user can still use the normal jump-to-end control for message 140.
      await page.getByText(/^older retained message 1\n/).waitFor({ timeout: 10_000 });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 800);
      });
      const samples = await page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              chatSessionReturnSamples: Array<{
                hiddenNotice: boolean;
                loading: boolean;
                messageCount: number;
                minOpacity: number;
                sessionKey: string;
              }>;
            }
          ).chatSessionReturnSamples,
      );
      const returnedSamples = samples.filter(
        (sample) => sample.sessionKey === "agent:main:session-b",
      );
      const restoredIndex = returnedSamples.findIndex((sample) => sample.messageCount === 140);
      expect(restoredIndex).toBeGreaterThanOrEqual(0);
      expect(
        returnedSamples.slice(restoredIndex).every((sample) => sample.messageCount === 140),
      ).toBe(true);
      expect(returnedSamples.every((sample) => sample.minOpacity === 1)).toBe(true);
      expect(returnedSamples.every((sample) => !sample.hiddenNotice)).toBe(true);
      expect(returnedSamples.every((sample) => !sample.loading)).toBe(true);
      await expectRequestCountStable(gateway, "chat.history", historyRequestsBeforeReturn);
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/retained-history-return.png`,
          fullPage: true,
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("parks an ACK-lost send for review before a same-key manual retry", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": {
          messages: [],
          sessionId: "control-ui-e2e-session",
          sessionInfo: { hasActiveRun: false, status: "done" },
          thinkingLevel: null,
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.deferNext("chat.send");

      const prompt = "retry with the same key";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const firstRequest = await gateway.waitForRequest("chat.send");
      const firstParams = requireRecord(firstRequest.params);
      const runId = requireString(firstParams.idempotencyKey, "first idempotency key");

      await gateway.closeLatest(1006, "lost ack");

      const deliveryStatus = page.locator('.chat-send-status[data-send-state="unconfirmed"]');
      await deliveryStatus.getByText("Delivery unconfirmed").waitFor({ timeout: 10_000 });
      expect(await page.locator(".chat-queue").count()).toBe(0);
      await page.locator(".chat-group.user").getByText(prompt, { exact: true }).waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      await deliveryStatus.getByRole("button", { name: "Retry queued message" }).click();

      const sends = await waitForRequests(gateway, "chat.send", 2);
      const secondParams = requireRecord(sends[1]?.params);
      expect(secondParams.idempotencyKey).toBe(runId);
      expect(secondParams.message).toBe(prompt);
      await deliveryStatus.waitFor({ state: "detached", timeout: 10_000 });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("clears inline delivery uncertainty after exact authoritative history proof", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.newBrowserContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": {
          messages: [],
          sessionId: "control-ui-e2e-session",
          sessionInfo: { hasActiveRun: false, status: "done" },
          thinkingLevel: null,
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.deferNext("chat.send");

      const prompt = "already accepted after the reconnect";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const firstRequest = await gateway.waitForRequest("chat.send");
      const runId = requireString(
        requireRecord(firstRequest.params).idempotencyKey,
        "first idempotency key",
      );
      await gateway.closeLatest(1006, "lost ack");

      const deliveryStatus = page.locator('.chat-send-status[data-send-state="unconfirmed"]');
      await deliveryStatus.getByText("Delivery unconfirmed").waitFor({ timeout: 10_000 });
      expect(await page.locator(".chat-queue").count()).toBe(0);
      const userBubble = page.locator(".chat-group.user").getByText(prompt, { exact: true });
      await userBubble.waitFor();
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/01-delivery-uncertain.png`, fullPage: true });
      }

      await gateway.setHistoryMessages([
        {
          content: "different delivered turn",
          idempotencyKey: "different-run:user",
          role: "user",
          timestamp: Date.now(),
        },
      ]);
      await gateway.emitGatewayEvent("session.message", {
        hasActiveRun: false,
        messageId: "different-history-turn",
        messageSeq: 1,
        sessionKey: "main",
        status: "done",
      });
      await deliveryStatus.getByText("Delivery unconfirmed").waitFor({ timeout: 10_000 });
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/02-different-key-still-uncertain.png`,
          fullPage: true,
        });
      }

      await gateway.setHistoryMessages([
        {
          content: prompt,
          idempotencyKey: `${runId}:user`,
          role: "user",
          timestamp: Date.now(),
        },
      ]);
      await gateway.emitGatewayEvent("session.message", {
        clientRunId: runId,
        hasActiveRun: true,
        messageId: "accepted-history-turn",
        messageSeq: 2,
        sessionKey: "main",
        status: "running",
      });

      await deliveryStatus.waitFor({ state: "detached", timeout: 10_000 });
      await userBubble.waitFor({ timeout: 10_000 });
      expect(await userBubble.count()).toBe(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/03-delivery-proven.png`, fullPage: true });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("stores new input while offline and sends it after reconnect", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.newBrowserContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": {
          messages: [],
          sessionId: "control-ui-e2e-session",
          sessionInfo: { hasActiveRun: false, status: "done" },
          thinkingLevel: null,
        },
      },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "global"));
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 10_000 });

      await gateway.setOnline(false);
      await page
        .locator(
          '.agent-chat__composer-underlaps[data-tone="warn"] .agent-chat__composer-status-band',
        )
        .waitFor({ timeout: 10_000 });

      const prompt = "send this when the Gateway returns";
      const attachmentName = "offline-proof.txt";
      const attachmentMimeType = "text/plain";
      const attachmentText = "offline attachment proof";
      const attachmentBase64 = Buffer.from(attachmentText).toString("base64");
      const attachmentDataUrl = `data:${attachmentMimeType};base64,${attachmentBase64}`;
      const composerEnabled = await composer.isEnabled();
      expect(composerEnabled).toBe(true);
      await composer.fill(prompt);
      await page.locator(".agent-chat__file-input").setInputFiles({
        name: attachmentName,
        mimeType: attachmentMimeType,
        buffer: Buffer.from(attachmentText),
      });
      await page.locator(".chat-attachment-file__name", { hasText: attachmentName }).waitFor({
        timeout: 10_000,
      });
      const send = page.getByRole("button", { name: "Send message" });
      const sendEnabled = await send.isEnabled();
      expect(sendEnabled).toBe(true);
      await send.click();

      const queue = page.locator(".chat-group.user:has(.chat-queue__item)", { hasText: prompt });
      await queue.getByText("Waiting for reconnect").waitFor({ timeout: 10_000 });
      await queue.getByText(prompt).waitFor({ timeout: 10_000 });
      const requestsBeforeReconnect = await gateway.getRequests("chat.send");
      expect(requestsBeforeReconnect).toHaveLength(0);
      const readStoredProof = () =>
        page.evaluate(
          ({ expectedAttachmentName, expectedAttachmentDataUrl, expectedPrompt }) => {
            const storedValues = Object.entries(sessionStorage)
              .filter(([key]) => key.startsWith("openclaw.control.chatComposer.v2:"))
              .map(([, value]) => value);
            const stored = storedValues.join("\n");
            let runId: string | null = null;
            for (const value of storedValues) {
              try {
                const parsed = JSON.parse(value) as {
                  sessions?: Record<
                    string,
                    {
                      queue?: Array<{
                        attachments?: Array<{ dataUrl?: unknown; fileName?: unknown }>;
                        sendRunId?: unknown;
                        text?: unknown;
                      }>;
                    }
                  >;
                };
                const item = Object.values(parsed.sessions ?? {})
                  .flatMap((session) => session.queue ?? [])
                  .find((entry) => entry.text === expectedPrompt);
                if (typeof item?.sendRunId === "string") {
                  runId = item.sendRunId;
                  const attachment = item.attachments?.find(
                    (entry) => entry.fileName === expectedAttachmentName,
                  );
                  return {
                    attachment: attachment?.dataUrl === expectedAttachmentDataUrl,
                    prompt: true,
                    runId,
                    waitingReconnect: value.includes('"sendState":"waiting-reconnect"'),
                  };
                }
              } catch {
                // Ignore unrelated malformed session storage in this focused proof.
              }
            }
            return {
              attachment: false,
              prompt: stored.includes(expectedPrompt),
              runId,
              waitingReconnect: stored.includes('"sendState":"waiting-reconnect"'),
            };
          },
          {
            expectedAttachmentDataUrl: attachmentDataUrl,
            expectedAttachmentName: attachmentName,
            expectedPrompt: prompt,
          },
        );
      await expect.poll(readStoredProof).toEqual({
        attachment: true,
        prompt: true,
        runId: expect.any(String),
        waitingReconnect: true,
      });
      const storedProof = await readStoredProof();
      const storedRunId = requireString(storedProof.runId, "stored offline send idempotency key");
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/01-offline-queued.png`, fullPage: true });
      }

      await page.reload();
      await expect.poll(readStoredProof).toEqual({
        attachment: true,
        prompt: true,
        runId: storedRunId,
        waitingReconnect: true,
      });
      // A cold reload waits for initial Gateway bootstrap before rebuilding the
      // UI. Storage survival here plus replay below is the reload contract.
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await gateway.setOnline(true);
      await page.locator("openclaw-chat-pane").waitFor({ state: "attached", timeout: 10_000 });

      const request = await gateway.waitForRequest("chat.send");
      const params = requireRecord(request.params);
      const runId = requireString(params.idempotencyKey, "offline send idempotency key");
      expect(params.message).toBe(prompt);
      expect(runId).toBe(storedRunId);
      expect(params.attachments).toEqual([
        {
          content: attachmentBase64,
          fileName: attachmentName,
          mimeType: attachmentMimeType,
          type: "file",
        },
      ]);
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/02-reconnected-active.png`, fullPage: true });
      }
      await expectRequestCountStable(gateway, "chat.send", 1);
      const requestsAfterReconnect = await gateway.getRequests("chat.send");
      await gateway.setHistoryMessages([
        {
          role: "user",
          __openclaw: { idempotencyKey: `${runId}:user` },
        },
      ]);
      await gateway.emitChatFinal({ runId, text: "Delivered after reconnect." });
      await queue.waitFor({ state: "detached", timeout: 10_000 });
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      await expect
        .poll(async () => {
          const proof = await readStoredProof();
          return proof.attachment || proof.prompt || proof.runId === runId;
        })
        .toBe(false);
      await page
        .locator(
          '.agent-chat__composer-underlaps[data-tone="warn"] .agent-chat__composer-status-band',
        )
        .waitFor({ state: "detached" });
      await expectRequestCountStable(gateway, "chat.send", 1);
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/03-online-delivered.png`, fullPage: true });
      }
      if (process.env.OPENCLAW_BEHAVIOR_PROOF === "1") {
        process.stdout.write(
          `${JSON.stringify({
            proof: "offline-chat-reconnect",
            composerEnabled,
            sendEnabled,
            waitingStateVisible: true,
            storedPrompt: storedProof.prompt,
            storedWaitingState: storedProof.waitingReconnect,
            requestsBeforeReconnect: requestsBeforeReconnect.length,
            requestsAfterReconnect: requestsAfterReconnect.length,
            idempotencyKeyPresent: runId.length > 0,
            queueClearedAfterDelivery: true,
          })}\n`,
        );
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
