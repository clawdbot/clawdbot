import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "playwright/test";
import { it } from "vitest";
import {
  installMockGateway,
  type MockGatewayControls,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "active turn recovery",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is required for active-turn recovery proof at ${executablePath}`,
});

const proofDir = path.resolve(".artifacts/control-ui-e2e/active-turn-recovery");
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
type ActiveRunSnapshotOptions = {
  events?: unknown[];
  messages?: unknown[];
  persistedToolCall?: boolean;
  startedAt?: number;
};

async function capture(page: Page, name: string): Promise<void> {
  if (!captureProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
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
      events: opts?.events ?? [
        {
          runId,
          seq: 1,
          stream: "tool",
          ts: 1_000,
          sessionKey: "main",
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
      activeRunIds: [runId],
      hasActiveRun: true,
      key: "main",
      kind: "direct",
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
    sessionKey: "main",
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
    sessionKey: "main",
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
  await gateway.setMethodResponse("sessions.list", {
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [snapshot.sessionInfo],
    ts: 1_000,
  });
}

async function assertActiveTurnVisible(page: Page, streamText: string): Promise<void> {
  await expect(page.getByText(streamText, { exact: true })).toHaveCount(1, { timeout: 10_000 });
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
    sessionKey: "main",
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
  const context = await suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
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
    const groups = Array.from(element.querySelectorAll<HTMLElement>(".chat-group"));
    const groupWithText = (text: string) =>
      groups.find((group) => (group.textContent ?? "").includes(text));
    const original = groupWithText(expected.original);
    const beforeSteer = groupWithText(expected.beforeSteer);
    const steer = groupWithText(expected.steer);
    const tool = element.querySelector<HTMLElement>(".chat-tool-row--running");
    const afterSteer = groupWithText(expected.afterSteer);
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
      expect(await readWorkingStartedAts(page)).toContain(startedAt);
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
          sessionKey: "main",
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
          sessionKey: "main",
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
          sessionKey: "main",
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
