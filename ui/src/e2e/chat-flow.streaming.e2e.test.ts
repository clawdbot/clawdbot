import path from "node:path";
import { expect, it } from "vitest";
import type { ChatHost } from "../pages/chat/chat-send-contract.ts";
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
  waitForRequests,
} from "./chat-flow.test-support.ts";
import { waitForCommittedState } from "./settle.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    { label: "desktop hover", mobile: false, viewport: { height: 900, width: 1280 } },
    { label: "mobile tap", mobile: true, viewport: { height: 844, width: 390 } },
  ])("shows turn metadata only after completion on $label", async ({ mobile, viewport }) => {
    const artifactDirParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactDirParent
      ? createControlUiE2eArtifactDir("chat-flow.streaming", artifactDirParent)
      : undefined;
    const context = await suite.newBrowserContext({
      hasTouch: mobile,
      isMobile: mobile,
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        { role: "assistant", content: "Earlier completed reply.", timestamp: Date.now() - 60_000 },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Earlier completed reply.").waitFor();
      const earlierAssistant = page.locator(".chat-group.assistant").first();
      const footerPresentation = (group: typeof earlierAssistant) =>
        group.locator(".chat-group-footer").evaluate((element) => {
          const style = getComputedStyle(element);
          return { opacity: style.opacity, pointerEvents: style.pointerEvents };
        });
      await page.mouse.move(0, 0);
      await expect
        .poll(() => footerPresentation(earlierAssistant))
        .toEqual(
          mobile
            ? { opacity: "0", pointerEvents: "none" }
            : { opacity: "1", pointerEvents: "auto" },
        );
      if (artifactDir && !mobile) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "before-user-follow-up-actions-visible.png"),
        });
      }
      await page.locator(".agent-chat__composer-combobox textarea").fill("show turn metadata");
      await page.getByRole("button", { name: "Send message" }).click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      await page.mouse.move(0, 0);
      await expect
        .poll(() => footerPresentation(earlierAssistant))
        .toEqual({ opacity: "0", pointerEvents: "none" });
      if (artifactDir && !mobile) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "after-user-follow-up-actions-hidden.png"),
        });
      }
      const runId = requireString(
        requireRecord(sendRequest.params).idempotencyKey,
        "chat send idempotency key",
      );
      const streamingText = "This response is still streaming.";
      await gateway.emitGatewayEvent("chat", {
        deltaText: streamingText,
        message: {
          content: [{ text: streamingText, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      const activeStream = page.locator(".chat-bubble.streaming");
      await activeStream.waitFor({ state: "visible" });
      const activeGroup = page.locator(".chat-group.assistant").last();
      const reveal = async () => {
        if (mobile) {
          await activeGroup.locator(".chat-bubble").last().tap();
        } else {
          await activeGroup.hover();
        }
      };
      await reveal();
      expect(await activeGroup.locator(".chat-group-footer").count()).toBe(0);
      await page.mouse.move(0, 0);
      await expect
        .poll(() => footerPresentation(earlierAssistant))
        .toEqual({
          opacity: "0",
          pointerEvents: "none",
        });

      // Settled commentary is still part of an active turn while a tool runs.
      await gateway.emitGatewayEvent("agent", {
        data: {
          args: { path: "README.md" },
          name: "read",
          phase: "start",
          toolCallId: "footer-read",
        },
        runId,
        seq: 1,
        sessionKey: "main",
        stream: "tool",
        ts: Date.now(),
      });
      // The working indicator predates the tool event; wait for its deferred projection
      // before scrolling a bubble that the stream-to-tool render may replace.
      await page.locator('[data-message-id^="tool:assistant:footer-read"]').waitFor();
      await page.locator(".chat-working-indicator").waitFor({ state: "visible" });
      const heldTouch = mobile ? await context.newCDPSession(page) : null;
      if (heldTouch) {
        // A touch can begin during work and disclose the row when released after completion.
        const bubble = activeGroup.locator(".chat-bubble").last();
        await bubble.scrollIntoViewIfNeeded();
        const point = await bubble.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        });
        await heldTouch.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [point],
        });
      } else {
        await reveal();
      }
      expect(await activeGroup.locator(".chat-group-footer").count()).toBe(0);

      await gateway.emitChatFinal({ runId, text: "The turn is complete." });
      await activeGroup.getByText("The turn is complete.", { exact: true }).waitFor();
      if (heldTouch) {
        await heldTouch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect
          .poll(() => footerPresentation(activeGroup))
          .toEqual({
            opacity: "1",
            pointerEvents: "auto",
          });
        // Mouse movement cannot clear touch disclosure; select another row before testing rest.
        await earlierAssistant.locator(".chat-bubble").last().tap();
      }
      await page.mouse.move(0, 0);
      const footer = activeGroup.locator(".chat-group-footer");
      await expect
        .poll(() => footerPresentation(activeGroup))
        .toEqual(
          mobile
            ? { opacity: "0", pointerEvents: "none" }
            : { opacity: "1", pointerEvents: "auto" },
        );
      await reveal();
      await expect
        .poll(() => footer.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
      expect(await footer.locator(".chat-sender-name").textContent()).toBe("OpenClaw");
      expect(await footer.locator(".chat-group-timestamp").count()).toBe(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

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

  it("renders stable markdown during a streaming chat turn and finalizes the tail", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const prompt = "stream markdown through the GUI";
      await gateway.deferNext("chat.send");
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      const streamingText = "## Streaming heading\n\nworking **tail";
      await gateway.emitGatewayEvent("chat", {
        deltaText: streamingText,
        message: {
          content: [{ text: streamingText, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      await page.locator(".chat-thread h2").getByText("Streaming heading").waitFor({
        timeout: 10_000,
      });
      await page.locator(".chat-bubble.streaming strong").getByText("tail").waitFor({
        timeout: 10_000,
      });
      expect(await page.locator(".markdown-plain-text-fallback").count()).toBe(0);

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      await page.locator(".chat-thread h2").getByText("Streaming heading").waitFor({
        timeout: 10_000,
      });

      await gateway.emitChatFinal({
        runId,
        text: "## Streaming heading\n\nworking **tail**",
      });

      await page.locator(".chat-thread strong").getByText("tail").waitFor({ timeout: 10_000 });
      expect(await page.locator(".markdown-plain-text-fallback").count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("normalizes Unicode line separators in streaming and final chat DOM", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      await gateway.deferNext("chat.send");
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill("render Unicode separators");
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      const streamingText = "## Unicode stream\u2028\u2028working **tail";
      await gateway.emitGatewayEvent("chat", {
        deltaText: streamingText,
        message: {
          content: [{ text: streamingText, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      await page.locator(".chat-thread h2").getByText("Unicode stream").waitFor({
        timeout: 10_000,
      });
      await page.locator(".chat-bubble.streaming strong").getByText("tail").waitFor({
        timeout: 10_000,
      });
      expect(await page.locator(".markdown-plain-text-fallback").count()).toBe(0);

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      await gateway.emitChatFinal({
        runId,
        text: "## Unicode final\u2028\u2028- first\u2029- second",
      });

      await page.locator(".chat-thread h2").getByText("Unicode final").waitFor({
        timeout: 10_000,
      });
      await expect
        .poll(() => page.locator(".chat-thread li").allTextContents(), { timeout: 10_000 })
        .toEqual(["first", "second"]);
      const finalChatText = await page.locator(".chat-thread .chat-text").last().textContent();
      expect(finalChatText).not.toContain("\u2028");
      expect(finalChatText).not.toContain("\u2029");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each([
    { label: "desktop", viewport: { height: 900, width: 1280 } },
    { label: "mobile", viewport: { height: 844, width: 390 } },
  ])(
    "keeps streamed text visible when a chat error terminates the turn on $label",
    async ({ label, viewport }) => {
      const artifactDirParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      const artifactDir = artifactDirParent
        ? createControlUiE2eArtifactDir("chat-flow.streaming", artifactDirParent)
        : undefined;
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        ...(artifactDir
          ? {
              recordVideo: {
                dir: artifactDir,
                size: { height: viewport.height, width: viewport.width },
              },
            }
          : {}),
      });
      const page = await context.newPage();
      const gateway = await installMockGateway(page);

      try {
        await page.goto(`${suite.server.baseUrl}chat`);

        const prompt = "stream before terminal error";
        await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
        await page.getByRole("button", { name: "Send message" }).click();

        const sendRequest = await gateway.waitForRequest("chat.send");
        const params = requireRecord(sendRequest.params);
        const runId = requireString(params.idempotencyKey, "chat send idempotency key");
        const partialText = "Partial answer before gateway error.";
        await gateway.emitGatewayEvent("chat", {
          deltaText: partialText,
          message: {
            content: [{ text: partialText, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
          runId,
          sessionKey: "main",
          state: "delta",
        });
        await page
          .locator(".chat-thread-inner")
          .getByText(partialText)
          .waitFor({ timeout: 10_000 });
        await gateway.emitGatewayEvent("agent", {
          data: {
            args: { path: "README.md" },
            name: "read",
            phase: "start",
            toolCallId: "call-before-terminal-error",
          },
          runId,
          seq: 1,
          sessionKey: "main",
          stream: "tool",
          ts: Date.now(),
        });

        const gatewayErrorText =
          "⚠️ Model login expired on the gateway for openai. Send `/login codex` from a private chat or Web UI session to pair a new Codex login, or re-auth with `openclaw models auth login --provider openai` in a terminal, then try again.";
        const errorText = gatewayErrorText.replace(/^⚠️\s*/u, "");
        await gateway.emitGatewayEvent("chat", {
          errorMessage: gatewayErrorText,
          message: {
            content: [{ text: gatewayErrorText, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
          runId,
          sessionKey: "main",
          state: "error",
        });

        await page
          .locator(".chat-thread-inner")
          .getByText(partialText)
          .waitFor({ timeout: 10_000 });
        expect(
          await page.locator(".chat-thread-inner").getByText(partialText, { exact: true }).count(),
        ).toBe(1);
        if (artifactDir) {
          await page.screenshot({ path: path.join(artifactDir, `terminal-partial-${label}.png`) });
        }
        const alert = page.locator(".chat-error");
        await alert.getByText("Error details", { exact: true }).click();
        await alert.getByText(errorText, { exact: true }).waitFor({ timeout: 10_000 });
        await alert.getByText("Error details", { exact: true }).click();
        expect(await alert.getByRole("button", { name: "Dismiss error" }).count()).toBe(0);
        expect(await alert.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
        expect(await page.locator(".chat-thread-inner").getByText(errorText).count()).toBe(0);
        const [alertBox, composerBox] = await Promise.all([
          alert.boundingBox(),
          page.locator(".agent-chat__composer-shell").boundingBox(),
        ]);
        expect(alertBox).not.toBeNull();
        expect(composerBox).not.toBeNull();
        expect(
          Math.abs(
            (alertBox?.x ?? 0) +
              (alertBox?.width ?? 0) / 2 -
              ((composerBox?.x ?? 0) + (composerBox?.width ?? 0) / 2),
          ),
        ).toBeLessThan(1);
        expect(alertBox?.width ?? 0).toBeLessThanOrEqual(composerBox?.width ?? 0);

        await page.locator(".agent-chat__composer-combobox textarea").fill("retry after error");
        await page.getByRole("button", { name: "Send message" }).click();
        await waitForRequests(gateway, "chat.send", 2);
        await alert.waitFor({ state: "detached", timeout: 10_000 });
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("keeps the pending telemetry row stable through acknowledgement and streaming", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.deferNext("chat.send");

      const prompt = "hold this until the ack arrives";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      await expect
        .poll(() => page.locator(".agent-chat__composer-combobox textarea").inputValue(), {
          timeout: 10_000,
        })
        .toBe("");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");

      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      const indicator = page.locator(".chat-reading-indicator");
      await indicator.waitFor({ timeout: 10_000 });
      expect(await page.locator(".chat-queue").count()).toBe(0);
      await page.locator(".chat-working-indicator").evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      const pendingRow = await indicator
        .locator(
          "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' chat-virtual-row ')][1]",
        )
        .elementHandle();
      if (!pendingRow) {
        throw new Error("expected pending working indicator virtual row");
      }
      const pendingLayout = await pendingRow.evaluate((row) => {
        const rect = row.getBoundingClientRect();
        Reflect.set(window, "__openclawPendingWorkingRow", row);
        return {
          height: rect.height,
          key: row.getAttribute("data-virtual-row-key"),
          top: rect.top,
        };
      });
      expect(pendingLayout.key).not.toBeNull();
      await page.evaluate(() => {
        const samples: Array<{
          height: number | null;
          key: string | null;
          sameRow: boolean;
          top: number | null;
        }> = [];
        Reflect.set(window, "__openclawWorkingRowSamples", samples);
        let remaining = 20;
        const sample = () => {
          const originalRow = Reflect.get(window, "__openclawPendingWorkingRow");
          const currentRow = document
            .querySelector(".chat-reading-indicator")
            ?.closest<HTMLElement>(".chat-virtual-row");
          const rect = currentRow?.getBoundingClientRect();
          samples.push({
            height: rect?.height ?? null,
            key: currentRow?.getAttribute("data-virtual-row-key") ?? null,
            sameRow: currentRow === originalRow,
            top: rect?.top ?? null,
          });
          remaining -= 1;
          if (remaining > 0) {
            requestAnimationFrame(sample);
          }
        };
        sample();
      });

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });

      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      await indicator.waitFor({ timeout: 10_000 });
      const samples = await page.evaluate(
        () =>
          new Promise<
            Array<{
              height: number | null;
              key: string | null;
              sameRow: boolean;
              top: number | null;
            }>
          >((resolve) => {
            const read = () => {
              const current = Reflect.get(window, "__openclawWorkingRowSamples");
              if (Array.isArray(current) && current.length >= 20) {
                resolve(current);
                return;
              }
              requestAnimationFrame(read);
            };
            read();
          }),
      );
      const layouts = samples.filter(
        (sample): sample is { height: number; key: string; sameRow: true; top: number } =>
          sample.sameRow &&
          typeof sample.height === "number" &&
          typeof sample.key === "string" &&
          typeof sample.top === "number",
      );
      expect(layouts).toHaveLength(20);
      expect(new Set(layouts.map((sample) => sample.key))).toEqual(new Set([pendingLayout.key]));
      const tops = layouts.map((sample) => sample.top);
      const heights = layouts.map((sample) => sample.height);
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);

      await gateway.emitGatewayEvent("agent", {
        data: { outputTokens: 2_400 },
        runId,
        seq: 1,
        sessionKey: "main",
        stream: "usage",
        ts: Date.now(),
      });
      await expect
        .poll(async () =>
          (await page.locator(".chat-working-indicator__tokens").textContent())?.trim(),
        )
        .toBe("2,400 output tokens");

      const response = "The streamed response is now visible.";
      await gateway.emitGatewayEvent("chat", {
        deltaText: response,
        message: {
          content: [{ text: response, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      await page.locator(".chat-thread-inner").getByText(response).waitFor({ timeout: 10_000 });
      await indicator.waitFor({ timeout: 10_000 });
      const streamingLayout = await pendingRow.evaluate(
        (row, visibleResponse) => ({
          connected: row.isConnected,
          hasResponse: row.textContent?.includes(visibleResponse) ?? false,
          hasTokens: row.textContent?.includes("2,400 output tokens") ?? false,
          key: row.getAttribute("data-virtual-row-key"),
        }),
        response,
      );
      expect(streamingLayout).toEqual({
        connected: true,
        hasResponse: true,
        hasTokens: true,
        key: pendingLayout.key,
      });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("scrolls a delayed pending send into view before the ACK resolves", async () => {
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
          text: `History message ${index}\n${"extra transcript line\n".repeat(4)}`,
          type: "text",
        },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: baseTs + index,
    }));
    const gateway = await installMockGateway(page, { historyMessages });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("History message 49").waitFor({ timeout: 10_000 });
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
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");

      await page.locator(".chat-thread").getByText("pending send should scroll").waitFor({
        timeout: 10_000,
      });
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

  it("refreshes history after a tool-call window disconnects and reconnects", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const prompt = "use a tool then reconnect";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await gateway.deferNext("chat.send");
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      const sessionKey = requireString(params.sessionKey, "accepted session key");
      // The Gateway registers the run before its started ACK; losing the socket
      // during a tool call must not turn this fixture into a lost-delivery test.
      const acceptedSession = {
        key: sessionKey,
        sessionId: `session:${sessionKey}`,
        hasActiveRun: true,
        activeRunIds: [runId],
        status: "running",
      };
      await gateway.setMethodResponse("chat.history", {
        sessionId: acceptedSession.sessionId,
        sessionInfo: acceptedSession,
        messages: [],
      });
      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      // Publish acceptance after the ACK settles, then wait for its durable
      // retirement before disconnecting this already accepted tool run.
      await waitForCommittedState(
        page,
        ({ runId: expectedRunId }) => {
          const state = document.querySelector<HTMLElement & { state: ChatHost }>(
            "openclaw-chat-pane",
          )?.state;
          return state !== undefined && state.chatRunId === expectedRunId && !state.chatSending;
        },
        { runId },
      );
      await gateway.emitGatewayEvent("sessions.changed", acceptedSession);
      await waitForCommittedState(
        page,
        ({ runId: expectedRunId }) => {
          const state = document.querySelector<HTMLElement & { state: ChatHost }>(
            "openclaw-chat-pane",
          )?.state;
          return (
            state !== undefined && state.chatRunId === expectedRunId && state.chatQueue.length === 0
          );
        },
        { runId },
      );
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });

      await gateway.emitGatewayEvent("agent", {
        data: {
          args: { query: "status" },
          name: "status",
          phase: "start",
          toolCallId: "tool-1",
        },
        runId,
        seq: 1,
        sessionKey,
        stream: "tool",
        ts: Date.now(),
      });
      await gateway.setHistoryMessages([
        {
          __openclaw: { idempotencyKey: `${runId}:user` },
          content: [{ text: prompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
        {
          content: [{ text: "Recovered from refreshed history.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ]);

      // This scenario loses the connection during an already accepted tool run.
      expect(await page.locator(".chat-send-status").count()).toBe(0);

      await gateway.closeLatest(1006, "lost during tool call");

      await page
        .locator(".chat-thread-inner")
        .getByText("Recovered from refreshed history.")
        .waitFor({ timeout: 15_000 });
      expect(await page.locator(".chat-queue").count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps live assistant stream text before the matching tool card", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const prompt = "stream before tool";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");

      const initialStream = `I will inspect the file. ${"Prior streamed output. ".repeat(20)}`;
      await gateway.emitGatewayEvent("chat", {
        deltaText: initialStream,
        message: {
          content: [{ text: initialStream, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });
      const transcript = page.locator(".chat-thread-inner");
      await transcript.getByText("I will inspect the file.").waitFor({ timeout: 10_000 });

      await gateway.emitGatewayEvent("agent", {
        data: {
          name: "read",
          phase: "result",
          result: "file contents",
          toolCallId: "call-read",
        },
        runId,
        seq: 1,
        sessionKey: "main",
        stream: "tool",
        ts: Date.now() - 10_000,
      });
      const toolBubble = page.locator('[data-message-id^="tool:assistant:call-read"]');
      await toolBubble.waitFor({ timeout: 10_000 });

      const nextStream = "```ts\nconst answer = 42;";
      await gateway.emitGatewayEvent("chat", {
        deltaText: nextStream,
        message: {
          content: [{ text: nextStream, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });
      await expect
        .poll(() => page.locator(".chat-bubble.streaming code.language-ts").textContent())
        .toContain("const answer = 42;");

      const composedGroup = transcript
        .locator(".chat-group.assistant")
        .filter({ hasText: "I will inspect the file." });
      expect(await composedGroup.count()).toBe(1);
      const visibleOrder = await composedGroup.evaluate((group: Element) =>
        Array.from(group.querySelectorAll(".chat-bubble")).flatMap((bubble: Element) => {
          if ((bubble.textContent ?? "").includes("I will inspect the file.")) {
            return ["assistant stream"];
          }
          if (bubble.matches('[data-message-id^="tool:assistant:call-read"]')) {
            return ["tool card"];
          }
          if ((bubble.textContent ?? "").includes("const answer = 42;")) {
            return ["assistant continuation"];
          }
          return [];
        }),
      );

      expect(visibleOrder).toEqual(["assistant stream", "tool card", "assistant continuation"]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
