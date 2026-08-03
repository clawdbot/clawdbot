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
  opts?: { persistedToolCall?: boolean },
) {
  return {
    inFlightRun: {
      runId,
      text: streamText,
      events: [
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
    messages: [
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
  opts?: { persistedToolCall?: boolean },
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
  await page.getByText(streamText, { exact: true }).waitFor({ timeout: 10_000 });
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

async function openActiveTurn() {
  const context = await suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  const page = await context.newPage();
  const gateway = await installMockGateway(page);
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.locator(".agent-chat__composer-combobox textarea").waitFor({ timeout: 10_000 });
  return { context, page, gateway };
}

suite.define(() => {
  it("restores the active assistant and tool across SPA navigation", async () => {
    const { context, page, gateway } = await openActiveTurn();
    try {
      const prompt = "navigation active turn";
      const streamText = "Navigation progress is still running.";
      const runId = await startActiveTurn(page, gateway, prompt, streamText);
      await installActiveRunSnapshot(gateway, runId, prompt, streamText);
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
      await installActiveRunSnapshot(gateway, runId, prompt, streamText);
      await capture(page, "03-reconnect-before");

      const startupCount = (await gateway.getRequests("chat.startup")).length;
      await gateway.closeLatest(1001, "active-turn recovery reconnect");
      await expect.poll(() => gateway.getSocketCount(), { timeout: 15_000 }).toBe(2);
      await expect
        .poll(async () => (await gateway.getRequests("chat.startup")).length, { timeout: 15_000 })
        .toBeGreaterThan(startupCount);
      await waitForGatewayConnected(page);
      await assertActiveTurnVisible(page, streamText);
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
      await installActiveRunSnapshot(gateway, runId, prompt, streamText, {
        persistedToolCall: true,
      });
      await capture(page, "05-reload-before");

      await page.reload();
      await assertActiveTurnVisible(page, streamText);
      await capture(page, "06-reload-after");
      await finishRecoveredTurn(page, gateway, runId, "Reload delivery complete.");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
