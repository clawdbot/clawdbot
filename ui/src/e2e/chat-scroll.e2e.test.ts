import path from "node:path";
import { expect, it } from "vitest";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX } from "../pages/chat/scroll.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  chatThreadDistanceFromBottom,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
  scrollChatThreadToTop,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps a bottom-anchored transcript pinned while the composer grows", async () => {
    const artifactDirParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactDirParent
      ? createControlUiE2eArtifactDir("chat-flow.streaming", artifactDirParent)
      : undefined;
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const historyMessages = Array.from({ length: 50 }, (_, index) => ({
      content: [
        {
          text: `Composer resize history ${index}\n${"extra transcript line\n".repeat(4)}`,
          type: "text",
        },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: baseTs + index,
    }));
    await installMockGateway(page, { historyMessages });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Composer resize history 49").waitFor({ timeout: 10_000 });
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
      await waitForChatScrollIdle(page);

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      for (let line = 1; line <= 8; line += 1) {
        await composer.fill(
          Array.from({ length: line }, (_, index) => `Growing composer line ${index + 1}`).join(
            "\n",
          ),
        );
        await waitForChatScrollIdle(page);
        expect(
          await chatThreadDistanceFromBottom(page),
          `composer line count ${line}`,
        ).toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
      }
      if (artifactDir) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "composer-resize-pinned.png"),
        });
      }

      await composer.fill("Growing composer line 1");
      await waitForChatScrollIdle(page);
      await scrollChatThreadToTop(page);
      const readingScrollTop = await page
        .locator(".chat-thread")
        .evaluate((element) => element.scrollTop);
      await composer.fill(
        Array.from({ length: 8 }, (_, index) => `Reading composer line ${index + 1}`).join("\n"),
      );
      await waitForChatScrollIdle(page);
      expect(
        await page
          .locator(".chat-thread")
          .evaluate((element, initial) => Math.abs(element.scrollTop - initial), readingScrollTop),
      ).toBeLessThanOrEqual(1);

      if (artifactDir) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "composer-resize-manual-scroll.png"),
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("scrolls a delayed pending send past expanding progress before the ACK resolves", async () => {
    const artifactDirParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactDirParent
      ? createControlUiE2eArtifactDir("chat-send-scroll", artifactDirParent)
      : undefined;
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const historyMessages = Array.from({ length: 50 }, (_, index) => ({
      content: [
        {
          text: `History message ${index}\n${"extra transcript line\n".repeat(4)}`,
          type: "text",
        },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: baseTs + index,
    }));
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
      historyMessages,
      methodResponses: {
        "progressCard.get": {
          card: {
            revision: 1,
            sessionKey: "agent:main:main",
            updatedAt: baseTs,
            steps: [
              { step: "Inspect the conversation", status: "completed" },
              { step: "Review the requested changes", status: "completed" },
              { step: "Check the latest result", status: "in_progress" },
              { step: "Verify the next reply", status: "pending" },
            ],
          },
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("History message 49").waitFor({ timeout: 10_000 });
      const progress = page.locator('[data-progress-card-placement="composer"]');
      await expect.poll(() => progress.getAttribute("open")).toBe("");
      await progress.locator("summary").click();
      await expect.poll(() => progress.getAttribute("open")).toBeNull();
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(4);

      await waitForChatScrollIdle(page);
      await expect
        .poll(
          async () => {
            await scrollChatThreadToTop(page);
            return chatThreadDistanceFromBottom(page);
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThan(200);

      await gateway.deferNext("chat.send");

      const prompt = `pending send should scroll before ack\n${"visible now\n".repeat(6)}`;
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill(prompt);
      const draftHeight = await composer.evaluate((element) => element.clientHeight);
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "before-send.png"), fullPage: true });
      }
      // Keyboard submission can land while the progress disclosure is resizing;
      // a pointer click on the moving send button would wait for stable layout.
      await progress.locator("summary").click();
      await composer.press("Enter");

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");

      await expect.poll(() => progress.getAttribute("open")).toBe("");
      await expect.poll(() => composer.inputValue()).toBe("");
      await expect
        .poll(() => composer.evaluate((element) => element.clientHeight))
        .toBeLessThan(draftHeight);
      await page.locator(".chat-thread").getByText("pending send should scroll").waitFor({
        timeout: 10_000,
      });
      await waitForChatScrollIdle(page);
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "after-send.png"), fullPage: true });
      }
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(4);

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("overlays the scroll-to-bottom affordance without shrinking the transcript", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const historyMessages = Array.from({ length: 50 }, (_, index) => ({
      content: [
        {
          text: `Scrollable history ${index}\n${"extra transcript line\n".repeat(4)}`,
          type: "text",
        },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: baseTs + index,
    }));
    await installMockGateway(page, { historyMessages });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Scrollable history 49").waitFor({ timeout: 10_000 });
      await waitForChatScrollIdle(page);

      const readLayout = () =>
        page.locator(".chat-main").evaluate((container) => {
          const thread = container.querySelector<HTMLElement>(".chat-thread");
          const composer = container.querySelector<HTMLElement>(".agent-chat__composer-shell");
          const button = container.querySelector<HTMLElement>(".chat-scroll-to-bottom");
          if (!thread || !composer) {
            throw new Error("expected chat thread and composer");
          }
          const threadRect = thread.getBoundingClientRect();
          const composerRect = composer.getBoundingClientRect();
          const buttonRect = button?.getBoundingClientRect();
          return {
            buttonBottom: buttonRect ? Math.round(buttonRect.bottom) : null,
            composerTop: Math.round(composerRect.top),
            threadBottom: Math.round(threadRect.bottom),
          };
        });

      const before = await readLayout();
      expect(before.buttonBottom).toBeNull();

      await scrollChatThreadToTop(page);
      await page.getByRole("button", { name: "Scroll to latest" }).waitFor({ timeout: 10_000 });
      const after = await readLayout();

      expect(after.threadBottom).toBe(before.threadBottom);
      expect(after.composerTop).toBe(before.composerTop);
      expect(after.buttonBottom).not.toBeNull();
      expect(after.buttonBottom!).toBeLessThan(after.composerTop);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
