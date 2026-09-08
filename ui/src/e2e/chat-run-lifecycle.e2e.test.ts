// Control UI E2E tests cover chat run lifecycle behavior through the Gateway WebSocket.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { afterEach, expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat run lifecycle",
});
const CHAT_RUN_STATUS_TOAST_DURATION_MS = 5_000;
const rosterMatch = { includeGlobal: true };

// Browser contexts preserve test isolation; keep one process warm for this file.
let page: Page | undefined;
suite.define(() => {
  afterEach(async () => {
    if (page) {
      await suite.closeBrowserContext(page.context());
    }
    page = undefined;
  });

  it("retires failed history released after clicking Send", async () => {
    const context = await suite.newBrowserContext({});
    const currentPage = await context.newPage();
    page = currentPage;
    const sessionKey = "agent:main:main";
    const diagnostic = "⚠️ ✉️ Message failed: delivery unavailable near 🧭";
    const renderedDiagnostic = "Message failed: delivery unavailable near 🧭";
    const gateway = await installMockGateway(currentPage, {
      sessionKey,
      // Account recovery can replace startup with a scoped history request.
      heldMethods: ["chat.startup", "chat.history", "chat.send"],
      sessions: [
        {
          key: sessionKey,
          status: "failed",
          hasActiveRun: false,
          lastRunId: "failed-run",
          lastRunError: diagnostic,
        },
      ],
    });
    await currentPage.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await gateway.waitForRequest("sessions.list", { match: rosterMatch });
    const startup = await gateway.waitForRequest("chat.startup");
    expect(startup.params).toMatchObject({ sessionKey });
    await currentPage.locator(".agent-chat__input textarea").fill("Try again");
    await currentPage.getByRole("button", { name: "Send message" }).click();
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);

    // Fault injection controls only WebSocket delivery, never application state.
    await gateway.resolveDeferred("chat.startup");
    await expect
      .poll(async () =>
        (await gateway.getRequests()).some(
          ({ method }) => method === "chat.history" || method === "chat.send",
        ),
      )
      .toBe(true);
    if ((await gateway.getRequests("chat.history")).length > 0) {
      await gateway.resolveDeferred("chat.history");
    }
    const send = await gateway.waitForRequest("chat.send");
    const { idempotencyKey: runId } = send.params as { idempotencyKey: string };
    expect(runId).toEqual(expect.any(String));
    const alert = currentPage.getByRole("alert").filter({ hasText: renderedDiagnostic });
    await alert.waitFor();
    await alert.locator(".chat-error__content > strong").getByText(renderedDiagnostic).waitFor();
    expect(await alert.locator("details").count()).toBe(0);
    await gateway.resolveDeferred("chat.send", { runId, status: "started" });
    await currentPage.getByRole("button", { name: "Stop generating" }).waitFor();
    await gateway.emitChatFinal({ sessionKey, runId, text: "Recovery completed." });
    await currentPage
      .locator(".chat-group.assistant")
      .getByText("Recovery completed.", { exact: true })
      .waitFor();
    await expect.poll(() => alert.count()).toBe(0);
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
  });

  it("excludes a reply-less failed turn's idle time from the next successful turn", async () => {
    const context = await suite.newBrowserContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const sessionKey = "agent:main:dashboard:failed-turn-elapsed";
    const gateway = await installMockGateway(currentPage, { sessionKey });
    await currentPage.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    const composer = currentPage.locator(".agent-chat__input textarea");
    await composer.fill("First attempt");
    // Freeze wall time without pausing the animation frames that publish sends.
    const firstStartedAt = Date.now();
    await currentPage.clock.setFixedTime(firstStartedAt);
    const messages: Record<string, unknown>[] = [];
    const persistUser = async (text: string, timestamp: number, after: number) => {
      const send = await gateway.waitForRequest("chat.send", { after });
      expect(send.params).toMatchObject({ sessionKey, idempotencyKey: expect.any(String) });
      const { idempotencyKey: runId } = send.params as { idempotencyKey: string };
      const message = {
        role: "user",
        content: text,
        timestamp,
        __openclaw: {
          id: `user-${after}`,
          idempotencyKey: `${runId}:user`,
          senderId: "operator",
        },
      };
      messages.push(message);
      await gateway.setHistoryMessages(messages);
      await gateway.emitGatewayEvent("session.message", {
        sessionKey,
        clientRunId: runId,
        message,
        messageId: message["__openclaw"].id,
        messageSeq: messages.length,
        activeRunIds: [runId],
        hasActiveRun: true,
      });
      await currentPage.getByRole("button", { name: "Stop generating" }).waitFor();
      return runId;
    };
    await currentPage.getByRole("button", { name: "Send message" }).click();
    const failedRunId = await persistUser("First attempt", firstStartedAt, 0);
    const diagnostic = "⚠️ 🛠️ Exec failed (exit 1): command failed near 🧭.";
    const renderedDiagnostic = "Exec failed (exit 1): command failed near 🧭.";
    await gateway.emitGatewayEvent("chat", {
      sessionKey,
      runId: failedRunId,
      state: "error",
      errorMessage: diagnostic,
    });
    const failedAlert = currentPage.getByRole("alert").filter({ hasText: renderedDiagnostic });
    await failedAlert.waitFor();
    await failedAlert
      .locator(".chat-error__content > strong")
      .getByText(renderedDiagnostic)
      .waitFor();
    expect(await failedAlert.locator("details").count()).toBe(0);
    expect(await currentPage.locator(".chat-group.assistant").count()).toBe(0);
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);

    await currentPage.clock.setFixedTime(firstStartedAt + 981_000);
    await composer.fill("Try again independently");
    await currentPage.getByRole("button", { name: "Send message" }).click();
    const runId = await persistUser("Try again independently", firstStartedAt + 981_000, 1);
    expect(runId).not.toBe(failedRunId);
    await currentPage.clock.setFixedTime(firstStartedAt + 982_000);
    const tool = {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "successful-tool",
      content: "ok",
      timestamp: firstStartedAt + 982_000,
      __openclaw: { id: "successful-tool-result", runId },
    };
    messages.push(tool);
    await gateway.setHistoryMessages(messages);
    await gateway.emitGatewayEvent("session.message", {
      sessionKey,
      runId,
      message: tool,
      messageId: tool["__openclaw"].id,
      messageSeq: messages.length,
      activeRunIds: [runId],
      hasActiveRun: true,
    });
    await currentPage.clock.setFixedTime(firstStartedAt + 994_000);
    const reply = {
      role: "assistant",
      content: "Success after the earlier failure.",
      timestamp: firstStartedAt + 994_000,
      __openclaw: { id: "successful-reply", runId },
    };
    messages.push(reply);
    // The same canonical history must survive a full page reload, not just
    // the live terminal projection or its retained local timestamps.
    await gateway.setMethodResponse("chat.history", {
      messages,
      sessionId: `session:${sessionKey}`,
      sessionInfo: { key: sessionKey, hasActiveRun: false, activeRunIds: [], status: "done" },
    });
    await gateway.emitGatewayEvent("chat", { sessionKey, runId, state: "final", message: reply });
    const replyBody = currentPage
      .locator(".chat-group.assistant")
      .getByText(reply.content, { exact: true });
    await replyBody.waitFor();
    const elapsedLabel = currentPage.locator(".chat-work-group .chat-activity-group__label");
    await elapsedLabel.waitFor();
    expect.soft(await elapsedLabel.textContent()).toBe("Worked for 13s");
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);

    await currentPage.reload();
    await gateway.waitForRequest("chat.startup");
    await replyBody.waitFor();
    await elapsedLabel.waitFor();
    expect(await elapsedLabel.textContent()).toBe("Worked for 13s");
    expect(await currentPage.locator(".chat-group.user").count()).toBe(2);
  });

  it("keeps a continuing run inside its latest assistant reply", async () => {
    const context = await suite.newBrowserContext({ viewport: { height: 800, width: 1200 } });
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
        key: "agent:main:main",
      },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    const assistantGroup = currentPage.locator(".chat-group.assistant");
    await assistantGroup.getByText("First result is ready.", { exact: true }).waitFor();
    await assistantGroup.locator(".chat-working-indicator--continuation").waitFor();

    expect(await assistantGroup.count()).toBe(1);
    expect(await currentPage.locator(".chat-reading-indicator").count()).toBe(0);
    expect(await assistantGroup.getByText("Working…", { exact: true }).count()).toBe(1);

    const artifactDir = path.join(suite.artifactDir, "chat-single-turn-status");
    await currentPage.screenshot({
      path: path.join(artifactDir, "continuing-reply.png"),
      fullPage: true,
    });
  });

  it("keeps a different active run in its own status row", async () => {
    const context = await suite.newBrowserContext({ viewport: { height: 800, width: 1200 } });
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
        key: "agent:main:main",
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
    const artifactDir =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? path.join(suite.artifactDir, "chat-inflight-reconnect")
        : "";
    const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
    const context = await suite.newBrowserContext({
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
        key: "agent:main:main",
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
      await writeFile(
        path.join(artifactDir, "restored-inflight-tail.png"),
        await takeControlUiViewportScreenshot(currentPage, currentPage.locator(".shell"), [stream]),
      );
    }
  });

  it("queues an exact-run Stop while offline and replays it after reconnecting", async () => {
    const context = await suite.newBrowserContext({});
    const currentPage = await context.newPage();
    page = currentPage;
    const sessionKey = "agent:main:main";
    const gateway = await installMockGateway(currentPage, { sessionKey });

    await currentPage.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await currentPage.locator(".agent-chat__input textarea").fill("keep this run stoppable");
    await currentPage.getByRole("button", { name: "Send message" }).click();
    const send = await gateway.waitForRequest("chat.send");
    const runId = (send.params as { idempotencyKey?: unknown }).idempotencyKey;
    expect(typeof runId).toBe("string");
    const stop = currentPage.getByRole("button", { name: "Stop generating" });
    await stop.waitFor({ state: "visible" });
    const composer = currentPage.locator(".agent-chat__input textarea");

    await gateway.setOnline(false);
    await expect
      .poll(() =>
        currentPage.evaluate(() => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime?: { context: { gateway: { snapshot: { phase: string } } } };
          };
          return app.runtime?.context.gateway.snapshot.phase;
        }),
      )
      .toBe("reconnecting");
    await stop.waitFor({ state: "visible" });
    expect(await stop.isEnabled()).toBe(true);
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
      await currentPage.screenshot({
        path: path.join(suite.artifactDir, "offline-stop-visible.png"),
        fullPage: true,
      });
    }

    await stop.click();
    expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
    await composer.fill("keep this draft");
    expect(await composer.inputValue()).toBe("keep this draft");

    await gateway.setOnline(true);
    const abort = await gateway.waitForRequest("chat.abort");
    expect(abort.params).toEqual({ runId, sessionKey });
    await stop.waitFor({ state: "detached" });
    expect(await gateway.getRequests("chat.abort")).toHaveLength(1);
    expect(await composer.inputValue()).toBe("keep this draft");
  });

  it("shows compaction savings and live working time", async () => {
    const context = await suite.newBrowserContext({ viewport: { height: 800, width: 1200 } });
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

  it.each(["final", "error"] as const)(
    "clears shared session activity when chat %s arrives first",
    async (terminalState) => {
      const context = await suite.newBrowserContext({ viewport: { height: 800, width: 1200 } });
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
      await gateway.waitForRequest("sessions.list", { match: rosterMatch });
      await currentPage.locator(".agent-chat__input textarea").fill("finish this run");
      await currentPage.getByRole("button", { name: "Send message" }).click();
      const send = await gateway.waitForRequest("chat.send");
      const params = send.params as { idempotencyKey?: unknown };
      expect(typeof params.idempotencyKey).toBe("string");
      const runId = params.idempotencyKey as string;

      await currentPage.getByRole("button", { name: "Stop generating" }).waitFor();
      const mainSession = currentPage.locator(".nav-item--home");
      // Home mirrors session rows: active-run state rings the leading glyph.
      const mainSessionRunIndicator = mainSession
        .locator(".session-glyph")
        .getByRole("img", { name: "Active run" });
      await mainSession.waitFor({ state: "visible" });
      const sessionListsBeforeActive = (await gateway.getRequests("sessions.list", rosterMatch))
        .length;
      await gateway.deferNext("sessions.list", rosterMatch);
      const activeUpdatedAt = Date.now();
      const activeStartedAt = activeUpdatedAt - 1_000;
      await gateway.emitGatewayEvent("sessions.changed", {
        activeRunIds: [runId],
        hasActiveRun: true,
        key: "agent:main:main",
        kind: "direct",
        reason: "lifecycle",
        startedAt: activeStartedAt,
        status: "running",
        updatedAt: activeUpdatedAt,
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length)
        .toBeGreaterThan(sessionListsBeforeActive);
      await mainSessionRunIndicator.waitFor();

      const diagnostic =
        "Provider request failed: session store unavailable. Retry after recovery.";
      if (terminalState === "error") {
        await gateway.emitGatewayEvent("chat", {
          runId,
          sessionKey: "agent:main:main",
          state: "error",
          errorMessage: diagnostic,
        });
        try {
          await currentPage.getByRole("alert").filter({ hasText: diagnostic }).waitFor();
          await mainSession.locator('[data-session-attention="error"]').waitFor();
          expect(await mainSession.getAttribute("aria-label")).toContain(diagnostic);
          expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(
            0,
          );
          await expect.poll(() => mainSessionRunIndicator.count()).toBe(0);
        } finally {
          await gateway.resolveDeferred("sessions.list");
        }
        return;
      }
      await gateway.emitChatFinal({ runId, text: "Run complete." });
      await currentPage
        .locator(".chat-bubble")
        .getByText("Run complete.", { exact: true })
        .waitFor();
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
            key: "agent:main:main",
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
      await currentPage
        .locator(".chat-pane__session-title", { hasText: staleActiveLabel })
        .waitFor();
      expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
      await expect.poll(() => mainSessionRunIndicator.count()).toBe(0);

      const sessionListsBeforeStaleActive = (
        await gateway.getRequests("sessions.list", rosterMatch)
      ).length;
      await gateway.deferNext("sessions.list", rosterMatch);
      await gateway.emitGatewayEvent("sessions.changed", {
        activeRunIds: [runId],
        hasActiveRun: true,
        key: "agent:main:main",
        kind: "direct",
        reason: "lifecycle",
        startedAt: Date.now() - 1_000,
        status: "running",
        updatedAt: Date.now(),
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length)
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
      const sessionListsBeforeOtherSession = (
        await gateway.getRequests("sessions.list", rosterMatch)
      ).length;
      await gateway.deferNext("sessions.list", rosterMatch);
      await gateway.emitGatewayEvent("sessions.changed", {
        key: "agent:main:another-session",
        kind: "direct",
        label: "Another session",
        reason: "lifecycle",
        updatedAt: otherSessionUpdatedAt,
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length)
        .toBeGreaterThan(sessionListsBeforeOtherSession);
      expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
      await expect.poll(() => mainSessionRunIndicator.count()).toBe(0);
      await gateway.resolveDeferred("sessions.list");

      // Re-publish after the former 10-second suppression window. The completed
      // run identity stays terminal until the Gateway publishes different state.
      await currentPage.clock.fastForward(CHAT_RUN_STATUS_TOAST_DURATION_MS + 250);
      const lateStaleActiveUpdatedAt = await currentPage.evaluate(() => Date.now());
      const sessionListsBeforeLateStaleActive = (
        await gateway.getRequests("sessions.list", rosterMatch)
      ).length;
      await gateway.deferNext("sessions.list", rosterMatch);
      await gateway.emitGatewayEvent("sessions.changed", {
        activeRunIds: [runId],
        hasActiveRun: true,
        key: "agent:main:main",
        kind: "direct",
        reason: "lifecycle",
        startedAt: lateStaleActiveUpdatedAt - 11_000,
        status: "running",
        updatedAt: lateStaleActiveUpdatedAt,
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length)
        .toBeGreaterThan(sessionListsBeforeLateStaleActive);
      expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
      await expect.poll(() => mainSessionRunIndicator.count()).toBe(0);
      await gateway.resolveDeferred("sessions.list");
    },
  );

  it("does not announce Done when a yielded parent is waiting for continuation", async () => {
    const context = await suite.newBrowserContext({ viewport: { height: 800, width: 1200 } });
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
    await gateway.waitForRequest("sessions.list", { match: rosterMatch });
    await currentPage.locator(".agent-chat__input textarea").fill("restart and continue");
    await currentPage.getByRole("button", { name: "Send message" }).click();
    const send = await gateway.waitForRequest("chat.send");
    const params = send.params as { idempotencyKey?: unknown };
    expect(typeof params.idempotencyKey).toBe("string");
    const runId = params.idempotencyKey as string;

    await currentPage.getByRole("button", { name: "Stop generating" }).waitFor();
    const mainSession = currentPage.locator(".nav-item--home");
    // Home mirrors session rows: active-run state rings the leading glyph.
    const mainSessionRunIndicator = mainSession
      .locator(".session-glyph")
      .getByRole("img", { name: "Active run" });
    await mainSession.waitFor({ state: "visible" });
    const sessionListsBeforeActive = (await gateway.getRequests("sessions.list", rosterMatch))
      .length;
    await gateway.deferNext("sessions.list", rosterMatch);
    await gateway.emitGatewayEvent("sessions.changed", {
      activeRunIds: [runId],
      hasActiveRun: true,
      key: "agent:main:main",
      kind: "direct",
      reason: "lifecycle",
      startedAt: Date.now() - 1_000,
      status: "running",
      updatedAt: Date.now(),
    });
    await expect
      .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length)
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
      sessionKey: "agent:main:main",
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
    const artifactDir =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? path.join(suite.artifactDir, "chat-abort-diagnostic")
        : "";
    const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
    const context = await suite.newBrowserContext({ viewport: { height: 800, width: 1200 } });
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
      sessionKey: "agent:main:main",
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
