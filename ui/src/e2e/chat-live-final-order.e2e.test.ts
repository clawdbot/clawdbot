import path from "node:path";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

function canvasPreview(viewId: string) {
  return {
    kind: "canvas",
    surface: "assistant_message",
    render: "url",
    viewId,
    title: `Preview ${viewId}`,
    url: `/__openclaw__/canvas/documents/${viewId}/index.html`,
    preferredHeight: 120,
    sandbox: "scripts",
  };
}

function canvasToolResult(viewId: string, toolCallId: string, timestamp: number) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "show_widget",
    timestamp,
    content: JSON.stringify({
      kind: "canvas",
      view: {
        backend: "canvas",
        id: viewId,
        url: `/__openclaw__/canvas/documents/${viewId}/index.html`,
      },
      presentation: {
        target: "assistant_message",
        title: `Preview ${viewId}`,
        preferred_height: 120,
        sandbox: "scripts",
      },
    }),
  };
}

function canvasBlock(viewId: string) {
  return { type: "canvas", preview: canvasPreview(viewId) };
}

suite.define(() => {
  const canvasView = useCanvasSandboxFixture();
  it("renders each persisted Canvas view once after reload", async () => {
    const artifactRoot = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactRoot
      ? createControlUiE2eArtifactDir("chat-canvas-history-stability", artifactRoot)
      : undefined;
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const documentIds = ["cv_first", "cv_second"];
    const finalText = "Both previews are ready.";
    const messages = [
      {
        role: "user",
        timestamp: 1_000,
        content: [{ type: "text", text: "Show both previews." }],
      },
      canvasToolResult("cv_first", "call-first", 1_001),
      canvasToolResult("cv_second", "call-second", 1_002),
      {
        role: "assistant",
        timestamp: 1_003,
        content: [
          {
            type: "text",
            text: `[embed ref="cv_first" /]\n[embed ref="cv_second" /]\n${finalText}`,
          },
          canvasBlock("cv_first"),
          canvasBlock("cv_second"),
        ],
      },
    ];

    try {
      const gateway = await installMockGateway(page, {
        historyMessages: messages,
        methodResponses: {
          "canvas.document.view": {
            cases: documentIds.map((docId) => ({
              match: { docId },
              response: canvasView(
                buildWidgetDocument(`Preview ${docId}`, `<p>Rendered ${docId}</p>`),
              ),
            })),
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const readPreviews = () =>
        page
          .locator(".chat-tool-card__widget-host iframe")
          .evaluateAll((frames) => frames.map((frame) => frame.getAttribute("title")));
      const expectedPreviews = ["Preview cv_first", "Preview cv_second"];
      const expectRenderedPreviews = async () => {
        await expect.poll(readPreviews).toEqual(expectedPreviews);
        for (const docId of documentIds) {
          await page
            .locator(`.chat-tool-card__widget-host iframe[title="Preview ${docId}"]`)
            .contentFrame()
            .frameLocator("iframe")
            .getByText(`Rendered ${docId}`, { exact: true })
            .waitFor();
        }
        expect(
          (await gateway.getRequests("canvas.document.view"))
            .map((request) =>
              requireString(requireRecord(request.params).docId, "Canvas document ID"),
            )
            .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(documentIds);
      };

      await expectRenderedPreviews();
      await expect.poll(() => page.getByText(finalText, { exact: true }).isVisible()).toBe(true);
      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "before-reload.png"),
        });
      }

      await page.reload();
      // Reload reinstalls the in-page mock Gateway and its request ring, so the
      // first startup request in the new document is the synchronization point.
      await gateway.waitForRequest("chat.startup");
      await expectRenderedPreviews();
      await expect.poll(() => page.getByText(finalText, { exact: true }).isVisible()).toBe(true);
      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "after-reload.png"),
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps multiple live replies after their delayed prompt before history catches up", async () => {
    const artifactRoot = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactRoot
      ? createControlUiE2eArtifactDir("chat-live-final-order", artifactRoot)
      : undefined;
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
            sessionId: "session:agent:main:main",
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
            sessionId: "session:agent:main:main",
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

      const artifactRoot = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
      const artifactDir = artifactRoot
        ? createControlUiE2eArtifactDir("chat-live-final-order", artifactRoot)
        : undefined;
      if (artifactDir) {
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
