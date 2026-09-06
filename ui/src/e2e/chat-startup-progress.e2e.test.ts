import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
let proofDir: string;
beforeEach(() => {
  if (capture) {
    proofDir = createControlUiE2eArtifactDir("duplicate-session-naming");
  }
});
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it("preserves tool and approval activity received before the send ACK", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
      ...(capture ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 900 } } } : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { historyMessages: [] });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.deferNext("chat.send");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Inspect this synthetic workspace");
      await composer.press("Enter");
      const send = await gateway.waitForRequest("chat.send");
      const { idempotencyKey: runId, sessionKey } = send.params as {
        idempotencyKey: string;
        sessionKey: string;
      };
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey,
        seq: 2,
        ts: Date.now(),
        stream: "tool",
        data: {
          phase: "start",
          toolCallId: "synthetic-exec",
          name: "exec",
          args: { command: "pwd" },
        },
      });
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey,
        seq: 3,
        ts: Date.now(),
        stream: "lifecycle",
        data: {
          phase: "waiting-approval",
          approvalId: "synthetic-approval",
          toolCallId: "synthetic-exec",
        },
      });
      const tool = page.locator(".chat-tool-msg-summary", { hasText: "pwd" });
      const working = page.locator('.chat-working-indicator[role="status"]');
      await expect.poll(() => tool.count()).toBe(1);
      await expect.poll(() => working.textContent()).toContain("Waiting for approval");
      if (capture) {
        await writeFile(
          path.join(proofDir, "preack-pending.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [tool, working]),
        );
      }
      await gateway.resolveDeferred("chat.send", { status: "started", runId });
      if (capture) {
        await writeFile(
          path.join(proofDir, "preack-adopted.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [tool, working]),
        );
      }
      await expect.poll(() => tool.count()).toBe(1);
      await expect.poll(() => working.textContent()).toContain("Waiting for approval");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("retains current startup progress through delayed history", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
      ...(capture ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 900 } } } : {}),
    });
    const page = await context.newPage();
    const runId = "synthetic-workspace-run";
    const sessionKey = "agent:main:main";
    const sessionInfo = {
      key: sessionKey,
      kind: "direct",
      updatedAt: 1,
      status: "running",
      hasActiveRun: true,
      activeRunIds: [runId],
    };
    const inFlightRun = {
      runId,
      text: "",
      events: [
        {
          runId,
          sessionKey,
          seq: 2,
          stream: "run_status",
          ts: 1,
          data: { phase: "naming_worktree" },
        },
      ],
    };
    const gateway = await installMockGateway(page, {
      sessions: [sessionInfo],
      sessionInfo,
      inFlightRun,
      historyMessages: [],
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const working = page.locator('.chat-working-indicator[role="status"]');
      await expect.poll(() => working.textContent()).toContain("Naming worktree…");
      const before = (await gateway.getRequests("chat.history")).length;
      await gateway.deferNext("chat.history");
      await gateway.emitGatewayEvent("session.message", {
        sessionKey,
        session: sessionInfo,
        hasActiveRun: true,
        activeRunIds: [runId],
        message: {
          role: "user",
          content: [{ type: "text", text: "Workspace check requested." }],
          __openclaw: { id: "synthetic-peer-message", seq: 3 },
        },
        messageId: "synthetic-peer-message",
        messageSeq: 3,
      });
      await gateway.waitForRequest("chat.history", { after: before });
      await gateway.emitGatewayEvent("chat", {
        runId,
        sessionKey,
        seq: 3,
        state: "status",
        phase: "creating_worktree",
      });
      await expect.poll(() => working.textContent()).toContain("Creating worktree…");
      await gateway.resolveDeferred("chat.history", { messages: [], sessionInfo, inFlightRun });
      // Capture the observed result before asserting so the red run leaves honest visual evidence.
      if (capture) {
        await writeFile(
          path.join(proofDir, "history.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [working]),
        );
      }
      await expect.poll(() => working.textContent()).not.toContain("Naming worktree…");
      await expect.poll(() => working.textContent()).toContain("Creating worktree…");
      await gateway.emitChatFinal({
        runId,
        sessionKey,
        text: "Workspace verification complete.",
      });
      await expect.poll(() => working.count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
