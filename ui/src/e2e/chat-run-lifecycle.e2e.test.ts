// Control UI E2E tests cover chat run lifecycle behavior through the Gateway WebSocket.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { afterEach, expect, it } from "vitest";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat run lifecycle",
});
const CHAT_RUN_STATUS_TOAST_DURATION_MS = 5_000;

// Browser contexts preserve test isolation; keep one process warm for this file.
let page: Page | undefined;
suite.define(() => {
  afterEach(async () => {
    await page
      ?.context()
      .close()
      .catch(() => {});
    page = undefined;
  });

  it("keeps a continuing run inside its latest assistant reply", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    await installMockGateway(currentPage, {
      historyMessages: [
        {
          role: "assistant",
          content: "First result is ready.",
          timestamp: Date.now() - 1_000,
        },
      ],
      inFlightRun: { runId: "run-continuing", text: "" },
      sessionInfo: {
        activeRunIds: ["run-continuing"],
        hasActiveRun: true,
        key: "main",
      },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    const assistantGroup = currentPage.locator(".chat-group.assistant");
    await assistantGroup.getByText("First result is ready.", { exact: true }).waitFor();
    await assistantGroup.locator(".chat-working-indicator--continuation").waitFor();

    expect(await assistantGroup.count()).toBe(1);
    expect(await currentPage.locator(".chat-reading-indicator").count()).toBe(0);
    expect(await assistantGroup.getByText("Working…", { exact: true }).count()).toBe(1);

    const artifactDir = path.resolve(".artifacts/control-ui-e2e/chat-single-turn-status");
    await mkdir(artifactDir, { recursive: true });
    await currentPage.screenshot({
      path: path.join(artifactDir, "continuing-reply.png"),
      fullPage: true,
    });
  });

  it("keeps a different active run in its own status row", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    await installMockGateway(currentPage, {
      historyMessages: [
        {
          role: "assistant",
          content: "Older run result.",
          timestamp: Date.now() - 1_000,
          __openclaw: { id: "older-result", idempotencyKey: "older-run" },
        },
      ],
      inFlightRun: { runId: "newer-run", text: "" },
      sessionInfo: {
        activeRunIds: ["newer-run"],
        hasActiveRun: true,
        key: "main",
      },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await currentPage.getByText("Older run result.", { exact: true }).waitFor();
    await currentPage.locator(".chat-reading-indicator").waitFor();

    expect(await currentPage.locator(".chat-group.assistant").count()).toBe(2);
    expect(
      await currentPage
        .locator(".chat-group.assistant", { hasText: "Older run result." })
        .locator(".chat-working-indicator--continuation")
        .count(),
    ).toBe(0);
  });

  it("restores only the unpersisted assistant response after reconnecting", async () => {
    const artifactDir = path.resolve(".artifacts/control-ui-e2e/chat-inflight-reconnect");
    const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
    if (captureProof) {
      await mkdir(artifactDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      viewport: { height: 800, width: 1200 },
      ...(captureProof
        ? { recordVideo: { dir: artifactDir, size: { height: 800, width: 1200 } } }
        : {}),
    });
    const currentPage = await context.newPage();
    page = currentPage;
    await installMockGateway(currentPage, {
      historyMessages: [
        { role: "user", content: "Continue working.", timestamp: Date.now() - 2_000 },
        { role: "assistant", content: "Saved opening.", timestamp: Date.now() - 1_000 },
      ],
      inFlightRun: {
        runId: "run-reconnected",
        text: "Saved opening. Still working after reconnect.",
      },
      sessionInfo: {
        activeRunIds: ["run-reconnected"],
        hasActiveRun: true,
        key: "main",
      },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await currentPage.getByText("Saved opening.", { exact: true }).waitFor();
    const stream = currentPage.locator(".chat-bubble.streaming", {
      hasText: "Still working after reconnect.",
    });
    await stream.waitFor({ state: "visible" });

    expect(await currentPage.getByText("Saved opening.", { exact: true }).count()).toBe(1);
    expect(await stream.textContent()).not.toContain("Saved opening.");
    await currentPage.getByRole("button", { name: "Stop generating" }).waitFor();
    if (captureProof) {
      await currentPage.screenshot({
        path: path.join(artifactDir, "restored-inflight-tail.png"),
        fullPage: true,
      });
    }
  });

  it("shows compaction savings and live working time", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    await currentPage.clock.install();
    const gateway = await installMockGateway(currentPage, {
      historyMessages: [
        {
          role: "system",
          timestamp: Date.now() - 1_000,
          __openclaw: {
            kind: "compaction",
            id: "compact-entry-1",
            tokensBefore: 900_000,
            tokensAfter: 24_700,
          },
        },
      ],
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await currentPage.getByText("saved 875.3k tokens", { exact: true }).waitFor();
    await currentPage.locator(".agent-chat__input textarea").fill("keep working");
    // The working timer starts at the send click; pause first so the elapsed
    // reading is exactly the fastForward below, not inflated by real time.
    await pauseVirtualClock(currentPage);
    await currentPage.getByRole("button", { name: "Send message" }).click();
    await gateway.waitForRequest("chat.send");
    await currentPage.locator(".chat-working-indicator").waitFor();

    await currentPage.clock.fastForward(177_000);

    await expect
      .poll(() => currentPage.locator(".chat-working-indicator__elapsed").textContent())
      .toBe("2m 57s");
    const workingLabel = currentPage.locator(".chat-working-indicator__status > .sr-only");
    expect(await workingLabel.textContent()).toBe("Working…");
    expect(
      await currentPage.locator(".chat-working-indicator__status > span:not(.sr-only)").count(),
    ).toBe(0);
  });

  it("clears shared session activity when chat final arrives first", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
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

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
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
    const mainSession = currentPage.locator(".nav-item--home");
    // Home mirrors session rows: active-run state lives in the trailing metadata endcap.
    const mainSessionRunIndicator = mainSession
      .locator(".nav-item__state")
      .getByRole("img", { name: "Active run" });
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
    await mainSessionRunIndicator.waitFor();

    await gateway.emitChatFinal({ runId, text: "Run complete." });
    await currentPage.locator(".chat-bubble").getByText("Run complete.", { exact: true }).waitFor();
    await expect.poll(() => mainSessionRunIndicator.count()).toBe(0);
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
    await currentPage.locator(".chat-pane__session-title", { hasText: staleActiveLabel }).waitFor();
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
    await expect.poll(() => mainSessionRunIndicator.count()).toBe(0);

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
    await expect.poll(() => mainSessionRunIndicator.count()).toBe(0);
    await gateway.resolveDeferred("sessions.list");

    await currentPage.clock.fastForward(CHAT_RUN_STATUS_TOAST_DURATION_MS + 250);
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
    expect(await mainSessionRunIndicator.count()).toBe(0);

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
    await expect.poll(() => mainSessionRunIndicator.count()).toBe(0);
    await gateway.resolveDeferred("sessions.list");

    // Re-publish after the former 10-second suppression window. The completed
    // run identity stays terminal until the Gateway publishes different state.
    await currentPage.clock.fastForward(CHAT_RUN_STATUS_TOAST_DURATION_MS + 250);
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
    await expect.poll(() => mainSessionRunIndicator.count()).toBe(0);
    await gateway.resolveDeferred("sessions.list");
  });

  it("does not announce Done when a yielded parent is waiting for continuation", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, {
      historyMessages: [
        {
          content: [{ text: "Ready for yielded lifecycle verification.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await currentPage
      .getByText("Ready for yielded lifecycle verification.")
      .waitFor({ timeout: 10_000 });
    await gateway.waitForRequest("sessions.list");
    await currentPage.locator(".agent-chat__input textarea").fill("restart and continue");
    await currentPage.getByRole("button", { name: "Send message" }).click();
    const send = await gateway.waitForRequest("chat.send");
    const params = send.params as { idempotencyKey?: unknown };
    expect(typeof params.idempotencyKey).toBe("string");
    const runId = params.idempotencyKey as string;

    await currentPage.getByRole("button", { name: "Stop generating" }).waitFor();
    const mainSession = currentPage.locator(".nav-item--home");
    // Home mirrors session rows: active-run state lives in the trailing metadata endcap.
    const mainSessionRunIndicator = mainSession
      .locator(".nav-item__state")
      .getByRole("img", { name: "Active run" });
    await mainSession.waitFor({ state: "visible" });
    const sessionListsBeforeActive = (await gateway.getRequests("sessions.list")).length;
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
      .toBeGreaterThan(sessionListsBeforeActive);
    await mainSessionRunIndicator.waitFor();

    const finalText = "The gateway will restart; I will resume verification afterward.";
    await gateway.emitGatewayEvent("chat", {
      message: {
        content: [{ text: finalText, type: "text" }],
        role: "assistant",
        timestamp: Date.now(),
      },
      runId,
      sessionKey: "main",
      state: "final",
      stopReason: "end_turn",
      yielded: true,
    });

    await currentPage.locator(".chat-thread-inner").getByText(finalText, { exact: true }).waitFor();
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
    await expect.poll(() => mainSessionRunIndicator.count()).toBe(0);
    await expect
      .poll(() => currentPage.locator(".agent-chat__run-status-announcement").textContent())
      .toBe("");
    await gateway.resolveDeferred("sessions.list");
  });

  it("renders a safe self-abort diagnostic without leaving stale composer status", async () => {
    const artifactDir = path.resolve(".artifacts/control-ui-e2e/chat-abort-diagnostic");
    const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
    if (captureProof) {
      await mkdir(artifactDir, { recursive: true });
    }
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage);

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await currentPage.locator(".agent-chat__input textarea").fill("run the edit");
    await currentPage.getByRole("button", { name: "Send message" }).click();
    const send = await gateway.waitForRequest("chat.send");
    const params = send.params as { idempotencyKey?: unknown };
    expect(typeof params.idempotencyKey).toBe("string");
    const runId = params.idempotencyKey as string;
    const diagnostic = "edit tool validation failed: edits: must be an array";

    await gateway.emitGatewayEvent("chat", {
      errorMessage: diagnostic,
      runId,
      sessionKey: "main",
      state: "aborted",
    });

    const alert = currentPage.getByRole("alert").filter({ hasText: diagnostic });
    await alert.waitFor();
    expect((await alert.textContent())?.trim()).toContain(`Error: ${diagnostic}`);
    expect(await currentPage.getByLabel("Run status: Interrupted").count()).toBe(0);
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
    if (captureProof) {
      await currentPage.screenshot({
        path: path.join(artifactDir, "abort-diagnostic-alert.png"),
        fullPage: true,
      });
    }
  });
});
