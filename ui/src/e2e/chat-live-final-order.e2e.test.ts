import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps multiple live replies after their delayed prompt before history catches up", async () => {
    const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
    }
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { width: 1280, height: 900 } } }
        : {}),
    });
    const page = await context.newPage();
    const runId = "multi-reply-run";
    const replies = ["First part of the current answer.", "Second part of the current answer."];
    const previous = "Previous durable conversation.";
    const prompt = "Please give me both parts.";
    try {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["chat.history"],
        methodResponses: {
          "chat.startup": {
            deltaCursor: "before-multi-reply",
            messages: [],
            sessionId: "control-ui-e2e-session",
            sessionInfo: {
              activeRunIds: [],
              hasActiveRun: false,
              key: "main",
              kind: "direct",
              status: "done",
              updatedAt: Date.now(),
            },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      for (const [index, text] of replies.entries()) {
        await gateway.emitGatewayEvent("chat", {
          runId,
          seq: index + 1,
          sessionKey: "main",
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() },
        });
        await page.locator(".chat-thread-inner").getByText(text, { exact: true }).waitFor();
      }
      for (const [id, seq, role, text, idempotencyKey] of [
        ["previous", 10, "user", previous, "previous-run:user"],
        ["current-prompt", 11, "user", prompt, `${runId}:user`],
      ] as const) {
        await gateway.emitGatewayEvent("session.message", {
          message: {
            role,
            content: [{ type: "text", text }],
            __openclaw: { id, seq, idempotencyKey },
            timestamp: Date.now(),
          },
          messageId: id,
          messageSeq: seq,
          sessionKey: "main",
          session: {
            activeRunIds: [],
            hasActiveRun: false,
            key: "main",
            kind: "direct",
            status: "done",
            updatedAt: Date.now(),
          },
        });
        await page.locator(".chat-thread-inner").getByText(text, { exact: true }).waitFor();
      }
      if (artifactDir) {
        await page.screenshot({
          path: path.join(artifactDir, "multi-reply-order.png"),
          fullPage: true,
        });
      }
      await expect
        .poll(() =>
          page.locator(".chat-thread-inner").evaluate(
            (thread, texts) => {
              const rows = Array.from(thread.querySelectorAll(".chat-bubble"));
              return texts.map((text) => rows.findIndex((row) => row.textContent?.includes(text)));
            },
            [previous, prompt, ...replies],
          ),
        )
        .toEqual([0, 1, 2, 3]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps durable turns ordered when a live final arrives before transcript events", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const currentRunId = "current-run";
    const previousPrompt = "What happened before this run?";
    const currentPrompt = "Why did this request fail?";
    const currentFinal = "The control layer failed before the retry.";
    const durableMessages = [
      {
        __openclaw: { id: "previous-user", seq: 369 },
        content: [{ text: previousPrompt, type: "text" }],
        role: "user",
        timestamp: Date.now(),
      },
      {
        __openclaw: { id: "current-user", seq: 371 },
        content: [{ text: currentPrompt, type: "text" }],
        role: "user",
        timestamp: Date.now(),
      },
      {
        __openclaw: { id: "current-final", runId: currentRunId, seq: 372 },
        content: [{ text: currentFinal, type: "text" }],
        role: "assistant",
        timestamp: Date.now(),
      },
    ];
    const historyDelta = {
      deltaCursor: "after-final",
      kind: "delta",
      messages: [
        {
          message: durableMessages[0],
          messageId: "previous-user",
          messageSeq: 369,
          sessionKey: "main",
        },
        {
          message: durableMessages[1],
          messageId: "current-user",
          messageSeq: 371,
          sessionKey: "main",
        },
        {
          message: durableMessages[2],
          messageId: "current-final",
          messageSeq: 372,
          runId: currentRunId,
          sessionKey: "main",
        },
      ],
      sessionInfo: {
        activeRunIds: [],
        hasActiveRun: false,
        key: "main",
        kind: "direct",
        status: "done",
        updatedAt: Date.now(),
      },
    };

    try {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["chat.history"],
        methodResponses: {
          "chat.startup": {
            deltaCursor: "before-final",
            messages: [],
            sessionId: "control-ui-e2e-session",
            sessionInfo: {
              activeRunIds: [],
              hasActiveRun: false,
              key: "main",
              kind: "direct",
              status: "done",
              updatedAt: Date.now(),
            },
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.emitGatewayEvent("chat", {
        deltaText: "Checking request state...",
        message: {
          content: [{ text: "Checking request state...", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId: currentRunId,
        seq: 1,
        sessionKey: "main",
        state: "delta",
      });
      await gateway.emitChatFinal({ runId: currentRunId, text: currentFinal });
      await page.locator(".chat-thread-inner").getByText(currentFinal, { exact: true }).waitFor();
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [],
        hasActiveRun: false,
        message: durableMessages[1],
        messageId: "current-user",
        messageSeq: 371,
        session: {
          activeRunIds: [],
          hasActiveRun: false,
          key: "main",
          kind: "direct",
          status: "done",
          updatedAt: Date.now(),
        },
        sessionKey: "main",
      });
      await gateway.waitForRequest("chat.history");
      await gateway.resolveDeferred("chat.history", historyDelta);
      await expect
        .poll(async () =>
          (await gateway.getRequests("chat.history")).some(
            (request) => requireRecord(request.params).cursor === "before-final",
          ),
        )
        .toBe(true);

      const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactDir) {
        await mkdir(artifactDir, { recursive: true });
        await page.screenshot({
          path: path.join(artifactDir, "live-final-transcript-order.png"),
          fullPage: true,
        });
      }
      const visibleTexts = [previousPrompt, currentPrompt, currentFinal];
      await expect
        .poll(() =>
          page.locator(".chat-thread-inner").evaluate((thread, texts) => {
            const rows = Array.from(thread.querySelectorAll(".chat-bubble"));
            return texts.map((text) => rows.findIndex((row) => row.textContent?.includes(text)));
          }, visibleTexts),
        )
        .toEqual([0, 1, 2]);
      await expect
        .poll(() => page.locator(".chat-group.assistant", { hasText: currentFinal }).count())
        .toBe(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
