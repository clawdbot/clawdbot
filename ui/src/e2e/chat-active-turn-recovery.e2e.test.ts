import path from "node:path";
import { expect, type Page } from "playwright/test";
import { beforeEach, it } from "vitest";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  installMockGateway,
  type MockGatewayControls,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "active turn recovery",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is required for active-turn recovery proof at ${executablePath}`,
});

let proofDir: string;
beforeEach(() => {
  if (captureProof) {
    proofDir = createControlUiE2eArtifactDir("active-turn-recovery");
  }
});
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
type ActiveRunSnapshotOptions = {
  events?: unknown[];
  messages?: unknown[];
  persistedToolCall?: boolean;
  sessionAbortable?: boolean;
  startedAt?: number;
};

async function capture(page: Page, name: string): Promise<void> {
  if (!captureProof) {
    return;
  }
  await page.screenshot({ path: path.join(proofDir, `${name}.png`), fullPage: true });
}

function activeRunSnapshot(
  runId: string,
  prompt: string,
  streamText: string,
  opts?: ActiveRunSnapshotOptions,
) {
  return {
    inFlightRun: {
      runId,
      text: streamText,
      startedAt: opts?.startedAt,
      ...(opts?.sessionAbortable ? { sessionAbortable: true } : {}),
      events: opts?.events ?? [
        {
          runId,
          seq: 1,
          stream: "tool",
          ts: 1_000,
          sessionKey: "agent:main:main",
          data: {
            toolCallId: "tool-active-turn-recovery",
            name: "read",
            phase: "start",
            args: { path: "README.md" },
          },
        },
      ],
    },
    messages: opts?.messages ?? [
      {
        __openclaw: { idempotencyKey: `${runId}:user` },
        content: [{ text: prompt, type: "text" }],
        role: "user",
        timestamp: 900,
      },
      ...(opts?.persistedToolCall
        ? [
            {
              content: [
                {
                  type: "toolCall",
                  id: "tool-active-turn-recovery",
                  name: "read",
                  arguments: { path: "README.md" },
                },
              ],
              role: "assistant",
              timestamp: 950,
            },
          ]
        : []),
    ],
    sessionId: "active-turn-recovery-session",
    sessionInfo: {
      ...(opts?.sessionAbortable ? {} : { activeRunIds: [runId] }),
      hasActiveRun: true,
      key: "agent:main:main",
      kind: "direct",
      sessionId: "active-turn-recovery-session",
      status: "running",
      updatedAt: 1_000,
    },
    thinkingLevel: null,
  };
}

async function startActiveTurn(
  page: Page,
  gateway: MockGatewayControls,
  prompt: string,
  streamText: string,
): Promise<string> {
  await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  const send = await gateway.waitForRequest("chat.send");
  const runId = (send.params as { idempotencyKey?: unknown }).idempotencyKey;
  expect(typeof runId).toBe("string");

  await gateway.emitGatewayEvent("agent", {
    runId,
    seq: 1,
    stream: "tool",
    ts: 1_000,
    sessionKey: "agent:main:main",
    data: {
      toolCallId: "tool-active-turn-recovery",
      name: "read",
      phase: "start",
      args: { path: "README.md" },
    },
  });
  await page.waitForTimeout(200);
  await gateway.emitGatewayEvent("chat", {
    deltaText: streamText,
    message: {
      content: [{ text: streamText, type: "text" }],
      role: "assistant",
      timestamp: 1_100,
    },
    runId,
    sessionKey: "agent:main:main",
    state: "delta",
  });
  await assertActiveTurnVisible(page, streamText);
  return runId as string;
}

async function installActiveRunSnapshot(
  gateway: MockGatewayControls,
  runId: string,
  prompt: string,
  streamText: string,
  opts?: ActiveRunSnapshotOptions,
): Promise<void> {
  const snapshot = activeRunSnapshot(runId, prompt, streamText, opts);
  await gateway.setMethodResponse("chat.startup", snapshot);
  await gateway.setMethodResponse("chat.history", snapshot);
  await gateway.setSessionsListResponse({
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [snapshot.sessionInfo],
    ts: 1_000,
  });
}

async function assertActiveTurnVisible(page: Page, streamText: string): Promise<void> {
  await expect(
    page.locator(".chat-thread-inner").getByText(streamText, { exact: true }),
  ).toHaveCount(1, { timeout: 10_000 });
  await page.locator(".chat-tool-row--running").waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });
  await expect
    .poll(() =>
      page
        .getByText(
          "Delivery could not be confirmed after reconnect. Check the conversation before retrying.",
          { exact: true },
        )
        .count(),
    )
    .toBe(0);
}

async function readWorkingStartedAts(page: Page): Promise<number[]> {
  return page.locator(".chat-working-indicator openclaw-elapsed-time").evaluateAll((elements) =>
    elements.flatMap((element) => {
      const value = (element as HTMLElement & { startMs?: unknown }).startMs;
      return typeof value === "number" ? [value] : [];
    }),
  );
}

async function waitForGatewayConnected(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime?: { context: { gateway: { snapshot: { phase: string } } } };
          };
          return app.runtime?.context.gateway.snapshot.phase;
        }),
      { timeout: 15_000 },
    )
    .toBe("connected");
}

async function finishRecoveredTurn(
  page: Page,
  gateway: MockGatewayControls,
  runId: string,
  finalText: string,
): Promise<void> {
  await gateway.emitGatewayEvent("agent", {
    runId,
    seq: 2,
    stream: "tool",
    ts: 1_200,
    sessionKey: "agent:main:main",
    data: {
      toolCallId: "tool-active-turn-recovery",
      name: "read",
      phase: "result",
      result: { content: [{ type: "text", text: "README recovered" }] },
    },
  });
  await expect.poll(() => page.locator(".chat-tool-row--running").count()).toBe(0);
  await expect.poll(() => page.locator(".chat-tool-row").count()).toBe(1);
  await gateway.emitChatFinal({ runId, text: finalText });
  const visibleFinal = page.getByRole("paragraph").filter({ hasText: finalText });
  await visibleFinal.waitFor({ timeout: 10_000 });
  await expect.poll(() => page.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
  expect(await visibleFinal.count()).toBe(1);
}

async function openActiveTurn(scenario: Parameters<typeof installMockGateway>[1] = {}) {
  const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
  const page = await context.newPage();
  const gateway = await installMockGateway(page, scenario);
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.locator(".agent-chat__composer-combobox textarea").waitFor({ timeout: 10_000 });
  return { context, page, gateway };
}

async function assertSteeredRecoveryOrder(
  page: Page,
  texts: { original: string; beforeSteer: string; steer: string; afterSteer: string },
): Promise<void> {
  const thread = page.locator(".chat-thread");
  await assertActiveTurnVisible(page, texts.afterSteer);
  for (const text of [texts.original, texts.beforeSteer, texts.steer]) {
    await expect(thread.getByText(text, { exact: true })).toHaveCount(1, { timeout: 10_000 });
  }
  await expect(page.locator(".chat-working-indicator")).toHaveCount(1, { timeout: 10_000 });

  const order = await thread.evaluate((element, expected) => {
    const visibleText = Array.from(element.querySelectorAll<HTMLElement>(".chat-bubble"));
    const bubbleWithText = (text: string) =>
      visibleText.find((bubble) => (bubble.textContent ?? "").includes(text));
    const original = bubbleWithText(expected.original);
    const beforeSteer = bubbleWithText(expected.beforeSteer);
    const steer = bubbleWithText(expected.steer);
    const tool = element.querySelector<HTMLElement>(".chat-tool-row--running");
    const afterSteer = bubbleWithText(expected.afterSteer);
    const precedes = (upper: Element | undefined | null, lower: Element | undefined | null) =>
      Boolean(
        upper && lower && upper.compareDocumentPosition(lower) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    return {
      originalBeforeCommentary: precedes(original, beforeSteer),
      commentaryBeforeSteer: precedes(beforeSteer, steer),
      steerBeforeTool: precedes(steer, tool),
      toolBeforeLaterCommentary: precedes(tool, afterSteer),
    };
  }, texts);
  expect(order).toEqual({
    originalBeforeCommentary: true,
    commentaryBeforeSteer: true,
    steerBeforeTool: true,
    toolBeforeLaterCommentary: true,
  });
}

suite.define(() => {
  it("restores the active assistant and tool across SPA navigation", async () => {
    const { context, page, gateway } = await openActiveTurn();
    try {
      const prompt = "navigation active turn";
      const streamText = "Navigation progress is still running.";
      const runId = await startActiveTurn(page, gateway, prompt, streamText);
      const startedAt = Date.now() - 10 * 60_000;
      await installActiveRunSnapshot(gateway, runId, prompt, streamText, { startedAt });
      await capture(page, "01-navigation-before");

      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-identity-card").click();
      await sidebar
        .locator('wa-dropdown.sidebar-identity-menu wa-dropdown-item[value="command:usage"]')
        .click();
      await waitForControlUiRoute(page, { pathname: "/usage", routeId: "usage" });
      await sidebar.getByRole("link", { name: "Home" }).click();
      await waitForControlUiRoute(page, { pathname: "/chat/main", routeId: "chat" });
      await assertActiveTurnVisible(page, streamText);
      await expect.poll(() => readWorkingStartedAts(page)).toContain(startedAt);
      await expect(
        page.locator(".chat-working-indicator openclaw-elapsed-time").filter({ hasText: "10m" }),
      ).not.toHaveCount(0);
      await capture(page, "02-navigation-after");
      await finishRecoveredTurn(page, gateway, runId, "Navigation delivery complete.");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("restores the active assistant and tool after socket reconnect", async () => {
    const { context, page, gateway } = await openActiveTurn();
    try {
      const prompt = "reconnect active turn";
      const streamText = "Reconnect progress is still running.";
      const runId = await startActiveTurn(page, gateway, prompt, streamText);
      const startedAt = Date.now() - 10 * 60_000;
      await installActiveRunSnapshot(gateway, runId, prompt, streamText, { startedAt });
      await capture(page, "03-reconnect-before");

      const startupCount = (await gateway.getRequests("chat.startup")).length;
      await gateway.closeLatest(1001, "active-turn recovery reconnect");
      await expect.poll(() => gateway.getSocketCount(), { timeout: 15_000 }).toBe(2);
      await expect
        .poll(async () => (await gateway.getRequests("chat.startup")).length, { timeout: 15_000 })
        .toBeGreaterThan(startupCount);
      await waitForGatewayConnected(page);
      await assertActiveTurnVisible(page, streamText);
      expect(await readWorkingStartedAts(page)).toContain(startedAt);
      await expect(
        page.locator(".chat-working-indicator openclaw-elapsed-time").filter({ hasText: "10m" }),
      ).not.toHaveCount(0);
      await capture(page, "04-reconnect-after");
      await finishRecoveredTurn(page, gateway, runId, "Reconnect delivery complete.");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each([true, false])(
    "keeps an owned reconnect prompt before a durable reply while history recovery is pending (active=%s)",
    async (active) => {
      const { context, page, gateway } = await openActiveTurn({ deferredMethods: ["chat.send"] });
      const readPane = () =>
        page.locator("openclaw-chat-pane").evaluate((element) => {
          const state = (element as HTMLElement & { state: ChatPageHost }).state;
          return {
            connected: state.connected,
            loading: state.chatLoading,
            runId: state.chatRunId,
            sending: state.chatSending,
            sessionId: state.currentSessionId,
            sessionKey: state.sessionKey,
            subscriptionKey: state.chatSessionMessageSubscription?.key ?? null,
            queue: state.chatQueue.map(({ sendRunId, sendState }) => ({ sendRunId, sendState })),
            messageCount: state.chatMessages.length,
          };
        });
      try {
        await expect.poll(readPane).toMatchObject({ connected: true, loading: false });
        const initial = await readPane();
        const sessionKey = initial.sessionKey;
        const prompt = "Keep my reconnect prompt before its answer.";
        const reply = "This durable answer arrived before history recovery.";
        await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
        await page.getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        const runId = (send.params as { idempotencyKey?: unknown }).idempotencyKey;
        if (typeof runId !== "string") {
          throw new Error("chat.send did not carry its generated run ID");
        }
        // This scenario commits the user below while disconnected, after acceptance.
        await gateway.resolveDeferred("chat.send", { runId, status: "started" });
        await expect.poll(readPane).toMatchObject({
          runId,
          sending: false,
          queue: [{ sendRunId: runId, sendState: "sending" }],
        });
        const oldSubscription = await page
          .locator("openclaw-chat-pane")
          .evaluateHandle(
            (element) =>
              (element as HTMLElement & { state: ChatPageHost }).state
                .chatSessionMessageSubscription,
          );
        await gateway.setOnline(false);
        await expect.poll(readPane).toMatchObject({
          connected: false,
          runId,
          queue: [{ sendRunId: runId, sendState: "waiting-reconnect" }],
        });
        const userIdentity = { id: "reconnect-user", seq: 1, idempotencyKey: `${runId}:user` };
        const user = {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
          __openclaw: userIdentity,
        };
        const sessionInfo = {
          key: sessionKey,
          sessionId: initial.sessionId,
          kind: "direct",
          hasActiveRun: true,
          activeRunIds: [runId],
          status: "running",
          updatedAt: user.timestamp,
        };
        const history = {
          sessionId: initial.sessionId,
          sessionInfo,
          messages: [user],
          pendingInputs: { items: [], total: 0 },
          inFlightRun: { runId, text: "", events: [] },
        };
        // Contract fixture: the user is saved and published while disconnected.
        // Reconnect subscriptions do not replay it; both real recovery RPCs still run.
        await gateway.setHistoryMessages([user]);
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          hasActiveRun: true,
          messageId: userIdentity.id,
          messageSeq: userIdentity.seq,
          message: user,
        });
        await gateway.setMethodResponse("chat.startup", history);
        await gateway.setMethodResponse("chat.history", history);
        await gateway.setSessionsListResponse({
          count: 1,
          sessions: [sessionInfo],
          defaults: {},
          ts: user.timestamp,
        });
        const startupCount = (await gateway.getRequests("chat.startup")).length;
        const historyCount = (await gateway.getRequests("chat.history")).length;
        const subscriptionCount = (await gateway.getRequests("sessions.messages.subscribe")).length;
        await gateway.deferNext("chat.startup", { sessionKey });
        await gateway.deferNext("chat.history", { sessionKey, limit: 1000 });
        await gateway.setOnline(true);
        await waitForGatewayConnected(page);
        await gateway.waitForRequest("sessions.messages.subscribe", { after: subscriptionCount });
        await expect
          .poll(() =>
            page.locator("openclaw-chat-pane").evaluate((element, previous) => {
              const subscription = (element as HTMLElement & { state: ChatPageHost }).state
                .chatSessionMessageSubscription;
              return subscription != null && subscription !== previous;
            }, oldSubscription),
          )
          .toBe(true);
        await oldSubscription.dispose();
        await gateway.waitForRequest("chat.startup", { after: startupCount });
        const recovery = await gateway.waitForRequest("chat.history", { after: historyCount });
        expect(recovery.params).toMatchObject({ sessionKey, limit: 1000, inputRunIds: [runId] });
        await expect.poll(readPane).toMatchObject({
          connected: true,
          loading: true,
          subscriptionKey: sessionKey,
          runId,
          queue: [{ sendRunId: runId, sendState: "waiting-reconnect" }],
          messageCount: initial.messageCount,
        });

        const assistantIdentity = { id: "reconnect-assistant", seq: 2, runId };
        const assistant = {
          role: "assistant",
          content: [{ type: "text", text: reply }],
          timestamp: Date.now(),
          __openclaw: assistantIdentity,
        };
        const replySessionInfo = {
          ...sessionInfo,
          hasActiveRun: active,
          activeRunIds: active ? [runId] : [],
          status: active ? "running" : "done",
          ...(!active ? { lastRunId: runId } : {}),
        };
        const completeHistory = {
          ...history,
          sessionInfo: replySessionInfo,
          messages: [user, assistant],
          inFlightRun: active ? history.inFlightRun : undefined,
        };
        await gateway.setHistoryMessages(completeHistory.messages);
        await gateway.setMethodResponse("chat.startup", completeHistory);
        await gateway.setMethodResponse("chat.history", completeHistory);
        await gateway.setSessionsListResponse({
          count: 1,
          sessions: [replySessionInfo],
          defaults: {},
          ts: user.timestamp,
        });
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          runId,
          hasActiveRun: active,
          session: replySessionInfo,
          messageId: assistantIdentity.id,
          messageSeq: assistantIdentity.seq,
          message: assistant,
        });
        await expect.poll(readPane).toMatchObject({
          loading: true,
          runId: active ? runId : null,
          queue: [{ sendRunId: runId, sendState: "waiting-reconnect" }],
          messageCount: initial.messageCount + 1,
        });
        const thread = page.locator(".chat-thread-inner");
        const assertOrder = async () => {
          await expect(thread.getByText(prompt, { exact: true })).toHaveCount(1);
          await expect(thread.getByText(reply, { exact: true })).toHaveCount(1);
          const promptBounds = await thread.getByText(prompt, { exact: true }).boundingBox();
          const replyBounds = await thread.getByText(reply, { exact: true }).boundingBox();
          if (!promptBounds || !replyBounds) {
            throw new Error("The reconnect prompt and reply must both be visible");
          }
          expect(promptBounds.y).toBeLessThan(replyBounds.y);
        };
        await expect(page.locator('[data-entry-id="reconnect-assistant"]')).toHaveCount(1);
        await capture(page, "09-reconnect-early-durable");
        await assertOrder();

        await gateway.resolveDeferred("chat.startup", completeHistory);
        await gateway.resolveDeferred("chat.history", completeHistory);
        await expect.poll(readPane).toMatchObject({ loading: false, queue: [] });
        await gateway.emitChatFinal({ runId, sessionKey, text: reply });
        await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
        await assertOrder();
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        await capture(page, "10-reconnect-recovered");
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("restores the active assistant and tool after a full reload", async () => {
    const { context, page, gateway } = await openActiveTurn();
    try {
      const prompt = "reload active turn";
      const streamText = "Reload progress is still running.";
      const runId = await startActiveTurn(page, gateway, prompt, streamText);
      const startedAt = Date.now() - 10 * 60_000;
      await installActiveRunSnapshot(gateway, runId, prompt, streamText, {
        persistedToolCall: true,
        startedAt,
      });
      await capture(page, "05-reload-before");

      await page.reload();
      await assertActiveTurnVisible(page, streamText);
      expect(await readWorkingStartedAts(page)).toContain(startedAt);
      await expect(
        page.locator(".chat-working-indicator openclaw-elapsed-time").filter({ hasText: "10m" }),
      ).not.toHaveCount(0);
      await capture(page, "06-reload-after");
      await finishRecoveredTurn(page, gateway, runId, "Reload delivery complete.");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("routes recovered embedded-run Stop through the session owner", async () => {
    const { context, page, gateway } = await openActiveTurn();
    try {
      const runId = "run-embedded-reload";
      const startedAt = Date.now() - 10 * 60_000;
      await installActiveRunSnapshot(gateway, runId, "channel turn", "", {
        sessionAbortable: true,
        startedAt,
      });

      await page.reload();
      await page.getByRole("button", { name: "Stop generating" }).click();

      const abortRequest = await gateway.waitForRequest("sessions.abort");
      expect(abortRequest.params).toMatchObject({ key: "agent:main:main", runId });
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("preserves pre-steer commentary order through a full reload", async () => {
    const runId = "run-steer-refresh";
    const texts = {
      original: "Review the fixture.",
      beforeSteer: "The first recovery note is visible.",
      steer: "Please include the verification pass.",
      afterSteer: "The second recovery note is visible.",
    };
    const fixtureNow = Date.now();
    const snapshot = activeRunSnapshot(runId, texts.original, "", {
      startedAt: fixtureNow,
      messages: [
        {
          __openclaw: {
            id: "fixture-original-user",
            idempotencyKey: `${runId}:user`,
            seq: 1,
          },
          content: [{ text: texts.original, type: "text" }],
          role: "user",
          timestamp: fixtureNow,
        },
        {
          __openclaw: {
            id: "fixture-steering-user",
            idempotencyKey: "fixture-steer:user",
            seq: 2,
          },
          content: [{ text: texts.steer, type: "text" }],
          role: "user",
          timestamp: fixtureNow + 2_000,
        },
      ],
      events: [
        {
          runId,
          seq: 1,
          stream: "item",
          ts: fixtureNow + 1_000,
          sessionKey: "agent:main:main",
          data: {
            kind: "preamble",
            itemId: "fixture-preamble-before-steer",
            progressText: texts.beforeSteer,
          },
        },
        {
          runId,
          seq: 2,
          stream: "tool",
          ts: fixtureNow + 3_000,
          sessionKey: "agent:main:main",
          data: {
            toolCallId: "fixture-active-tool",
            name: "read",
            phase: "start",
            args: { path: "fixture.txt" },
          },
        },
        {
          runId,
          seq: 3,
          stream: "item",
          ts: fixtureNow + 4_000,
          sessionKey: "agent:main:main",
          data: {
            kind: "preamble",
            itemId: "fixture-preamble-after-steer",
            progressText: texts.afterSteer,
          },
        },
      ],
    });
    const { context, page } = await openActiveTurn({
      historyMessages: snapshot.messages,
      inFlightRun: snapshot.inFlightRun,
      sessionInfo: snapshot.sessionInfo,
    });
    try {
      await assertSteeredRecoveryOrder(page, texts);
      await capture(page, "07-steer-refresh-before");

      await page.reload();
      await assertSteeredRecoveryOrder(page, texts);
      await capture(page, "08-steer-refresh-after");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
