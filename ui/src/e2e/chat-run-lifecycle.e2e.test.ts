// Control UI E2E tests cover chat run lifecycle behavior through the Gateway WebSocket.
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CHAT_RUN_STATUS_TOAST_DURATION_MS } from "../pages/chat/run-lifecycle.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser | undefined;
let page: Page | undefined;
let server: ControlUiE2eServer | undefined;

describeControlUiE2e("Control UI chat run lifecycle", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
  });

  afterEach(async () => {
    await page
      ?.context()
      .close()
      .catch(() => {});
    await browser?.close().catch(() => {});
    page = undefined;
    browser = undefined;
  });

  afterAll(async () => {
    await server?.close();
  });

  it("clears shared session activity when chat final arrives first", async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    await currentPage.clock.install();
    const gateway = await installMockGateway(currentPage, {
      historyMessages: [
        {
          content: [{ text: "Ready for run lifecycle verification.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    await currentPage.goto(`${server?.baseUrl ?? ""}chat`);
    await currentPage
      .getByText("Ready for run lifecycle verification.")
      .waitFor({ timeout: 10_000 });
    await gateway.waitForRequest("sessions.list");
    await currentPage.locator(".agent-chat__input textarea").fill("finish this run");
    await currentPage.getByRole("button", { name: "Send message" }).click();
    const send = await gateway.waitForRequest("chat.send");
    const params = send.params as { idempotencyKey?: unknown };
    expect(typeof params.idempotencyKey).toBe("string");
    const runId = params.idempotencyKey as string;

    await currentPage.getByRole("button", { name: "Stop generating" }).waitFor();
    const mainSession = currentPage.locator(".sidebar-recent-session").filter({ hasText: "Main" });
    await mainSession.waitFor({ state: "visible" });
    const sessionListsBeforeActive = (await gateway.getRequests("sessions.list")).length;
    await gateway.deferNext("sessions.list");
    const activeUpdatedAt = Date.now();
    const activeStartedAt = activeUpdatedAt - 1_000;
    await gateway.emitGatewayEvent("sessions.changed", {
      activeRunIds: [runId],
      hasActiveRun: true,
      key: "main",
      kind: "direct",
      reason: "lifecycle",
      startedAt: activeStartedAt,
      status: "running",
      updatedAt: activeUpdatedAt,
    });
    await expect
      .poll(async () => (await gateway.getRequests("sessions.list")).length)
      .toBeGreaterThan(sessionListsBeforeActive);
    await mainSession.locator(".session-run-spinner").waitFor();

    await gateway.emitChatFinal({ runId, text: "Run complete." });
    await currentPage.getByText("Run complete.", { exact: true }).waitFor();
    await expect.poll(() => mainSession.locator(".session-run-spinner").count()).toBe(0);
    const staleActiveLabel = "Main stale active snapshot";
    await gateway.resolveDeferred("sessions.list", {
      count: 1,
      defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
      path: "",
      sessions: [
        {
          activeRunIds: [runId],
          displayName: staleActiveLabel,
          hasActiveRun: true,
          key: "main",
          kind: "direct",
          label: staleActiveLabel,
          model: "gpt-5.5",
          modelProvider: "openai",
          startedAt: activeStartedAt,
          status: "running",
          updatedAt: activeUpdatedAt,
        },
      ],
      ts: activeUpdatedAt,
    });
    await currentPage.getByText(staleActiveLabel, { exact: true }).waitFor();
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
    await expect.poll(() => mainSession.locator(".session-run-spinner").count()).toBe(0);

    const sessionListsBeforeStaleActive = (await gateway.getRequests("sessions.list")).length;
    await gateway.deferNext("sessions.list");
    await gateway.emitGatewayEvent("sessions.changed", {
      activeRunIds: [runId],
      hasActiveRun: true,
      key: "main",
      kind: "direct",
      reason: "lifecycle",
      startedAt: Date.now() - 1_000,
      status: "running",
      updatedAt: Date.now(),
    });
    await expect
      .poll(async () => (await gateway.getRequests("sessions.list")).length)
      .toBeGreaterThan(sessionListsBeforeStaleActive);
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
    await expect.poll(() => mainSession.locator(".session-run-spinner").count()).toBe(0);
    await gateway.resolveDeferred("sessions.list");

    await currentPage.clock.runFor(CHAT_RUN_STATUS_TOAST_DURATION_MS + 250);
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
    expect(await mainSession.locator(".session-run-spinner").count()).toBe(0);

    // Event timestamps must follow the page's virtual clock so freshness checks
    // see the same elapsed suppression window that the UI just observed.
    const otherSessionUpdatedAt = await currentPage.evaluate(() => Date.now());
    const sessionListsBeforeOtherSession = (await gateway.getRequests("sessions.list")).length;
    await gateway.deferNext("sessions.list");
    await gateway.emitGatewayEvent("sessions.changed", {
      key: "agent:main:another-session",
      kind: "direct",
      label: "Another session",
      reason: "lifecycle",
      updatedAt: otherSessionUpdatedAt,
    });
    await expect
      .poll(async () => (await gateway.getRequests("sessions.list")).length)
      .toBeGreaterThan(sessionListsBeforeOtherSession);
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
    await expect.poll(() => mainSession.locator(".session-run-spinner").count()).toBe(0);
    await gateway.resolveDeferred("sessions.list");

    // Re-publish after the former 10-second suppression window. The completed
    // run identity stays terminal until the Gateway publishes different state.
    await currentPage.clock.runFor(CHAT_RUN_STATUS_TOAST_DURATION_MS + 250);
    const lateStaleActiveUpdatedAt = await currentPage.evaluate(() => Date.now());
    const sessionListsBeforeLateStaleActive = (await gateway.getRequests("sessions.list")).length;
    await gateway.deferNext("sessions.list");
    await gateway.emitGatewayEvent("sessions.changed", {
      activeRunIds: [runId],
      hasActiveRun: true,
      key: "main",
      kind: "direct",
      reason: "lifecycle",
      startedAt: lateStaleActiveUpdatedAt - 11_000,
      status: "running",
      updatedAt: lateStaleActiveUpdatedAt,
    });
    await expect
      .poll(async () => (await gateway.getRequests("sessions.list")).length)
      .toBeGreaterThan(sessionListsBeforeLateStaleActive);
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
    await expect.poll(() => mainSession.locator(".session-run-spinner").count()).toBe(0);
    await gateway.resolveDeferred("sessions.list");
  });
});
