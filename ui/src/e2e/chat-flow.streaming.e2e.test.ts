import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX } from "../pages/chat/scroll.ts";
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

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps streamed audio and video metadata pinned without overriding manual scroll", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
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
          text: `Existing transcript message ${index}\n${"Existing streamed history.\n".repeat(5)}`,
          type: "text",
        },
      ],
      role: index % 2 === 0 ? "user" : "assistant",
      timestamp: baseTs + index,
    }));
    const gateway = await installMockGateway(page, { historyMessages });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Existing transcript message 49", { exact: false }).waitFor({
        timeout: 10_000,
      });
      await waitForChatScrollIdle(page);

      const prompt = "stream a voice note and video";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      const runId = requireString(
        requireRecord(sendRequest.params).idempotencyKey,
        "chat send idempotency key",
      );
      const mediaText =
        "Here is the narrated update.\n" +
        "MEDIA:https://example.com/voice.ogg\n" +
        "MEDIA:https://example.com/clip.mp4";
      await gateway.emitGatewayEvent("chat", {
        deltaText: mediaText,
        message: {
          content: [{ text: mediaText, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      const thread = page.locator(".chat-thread");
      const activeStream = thread.locator(".chat-bubble.streaming");
      await activeStream.waitFor({ state: "visible", timeout: 10_000 });
      const stopGenerating = page.getByRole("button", { name: "Stop generating" });
      await stopGenerating.waitFor({ state: "visible", timeout: 10_000 });
      const growMedia = async (
        selector: "audio" | "video",
        height: number,
        presentation: "active" | "committed" = "active",
      ) => {
        const media = (presentation === "active" ? activeStream : thread).locator(selector);
        await media.waitFor({ state: "attached", timeout: 10_000 });
        await waitForChatScrollIdle(page);
        const scrollHeightBefore = await thread.evaluate((element) => element.scrollHeight);
        await media.evaluate(
          (element, { mediaKind, nextHeight }) => {
            const layoutOwner =
              mediaKind === "video"
                ? element.closest<HTMLElement>(".chat-assistant-video-frame")
                : element.closest<HTMLElement>("openclaw-chat-audio-player");
            if (!layoutOwner) {
              throw new Error(`expected assistant ${mediaKind} layout owner`);
            }
            layoutOwner.style.display = "block";
            layoutOwner.style.height = `${nextHeight}px`;
            layoutOwner.style.minHeight = `${nextHeight}px`;
            if (mediaKind === "video") {
              layoutOwner.style.maxHeight = "none";
              element.style.height = "100%";
              element.style.maxHeight = "none";
            }
            element.dispatchEvent(new Event("loadedmetadata", { bubbles: true }));
          },
          { mediaKind: selector, nextHeight: height },
        );
        await expect
          .poll(() => thread.evaluate((element) => element.scrollHeight), { timeout: 10_000 })
          .toBeGreaterThan(scrollHeightBefore);
        await waitForChatScrollIdle(page);
      };

      await growMedia("audio", 320);
      await stopGenerating.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
      expect(await page.getByRole("button", { name: "Scroll to latest" }).count()).toBe(0);

      await growMedia("video", 480);
      await stopGenerating.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
      expect(await page.getByRole("button", { name: "Scroll to latest" }).count()).toBe(0);

      if (artifactDir) {
        await mkdir(artifactDir, { recursive: true });
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "streamed-media-pinned.png"),
        });
      }

      await thread.hover();
      await page.mouse.wheel(0, -600);
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeGreaterThan(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
      const scrollToLatest = page.getByRole("button", { name: "Scroll to latest" });
      await scrollToLatest.waitFor({ state: "visible", timeout: 10_000 });
      await waitForChatScrollIdle(page);
      const readingScrollTop = await thread.evaluate((element) => element.scrollTop);

      await growMedia("audio", 720);
      await stopGenerating.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeGreaterThan(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
      await expect
        .poll(
          async () =>
            Math.abs((await thread.evaluate((element) => element.scrollTop)) - readingScrollTop),
          { timeout: 10_000 },
        )
        .toBeLessThanOrEqual(1);
      await scrollToLatest.waitFor({ state: "visible", timeout: 10_000 });

      if (artifactDir) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "streamed-media-manual-scroll.png"),
        });
      }

      await scrollToLatest.click();
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
      await scrollToLatest.waitFor({ state: "detached", timeout: 10_000 });
      await stopGenerating.waitFor({ state: "visible", timeout: 10_000 });

      await gateway.emitChatFinal({ runId, text: mediaText });
      await activeStream.waitFor({ state: "detached", timeout: 10_000 });
      await stopGenerating.waitFor({ state: "detached", timeout: 10_000 });
      await growMedia("video", 800, "committed");
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
      expect(await scrollToLatest.count()).toBe(0);
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
    async ({ viewport }) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
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
        const alert = page.locator(".chat-run-error");
        await alert.getByText(errorText).waitFor({ timeout: 10_000 });
        expect(await alert.locator("button").count()).toBe(0);
        expect(await page.locator(".chat-thread-inner").getByText(errorText).count()).toBe(0);
        expect(
          await alert.evaluate((element) =>
            element.nextElementSibling?.classList.contains("agent-chat__composer-shell"),
          ),
        ).toBe(true);
        const [alertBox, composerBox] = await Promise.all([
          alert.boundingBox(),
          page.locator(".agent-chat__composer-shell").boundingBox(),
        ]);
        expect(alertBox).not.toBeNull();
        expect(composerBox).not.toBeNull();
        expect(Math.abs((alertBox?.x ?? 0) - (composerBox?.x ?? 0))).toBeLessThan(1);
        expect(Math.abs((alertBox?.width ?? 0) - (composerBox?.width ?? 0))).toBeLessThan(1);

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
        .toBe("2.4k tokens");

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

      await page.getByText(response).waitFor({ timeout: 10_000 });
      await indicator.waitFor({ timeout: 10_000 });
      const streamingLayout = await pendingRow.evaluate(
        (row, visibleResponse) => ({
          connected: row.isConnected,
          hasResponse: row.textContent?.includes(visibleResponse) ?? false,
          hasTokens: row.textContent?.includes("2.4k tokens") ?? false,
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
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
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
        sessionKey: "main",
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

      await gateway.closeLatest(1006, "lost during tool call");

      await page
        .locator(".chat-thread-inner")
        .getByText("Recovered from refreshed history.")
        .waitFor({ timeout: 15_000 });
      expect(await page.locator(".chat-queue").count()).toBe(0);
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

      await gateway.emitGatewayEvent("chat", {
        deltaText: "I will inspect the file.",
        message: {
          content: [{ text: "I will inspect the file.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });
      await page.getByText("I will inspect the file.").waitFor({ timeout: 10_000 });

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

      const visibleOrder = await page.locator(".chat-thread").evaluate((thread: Element) => {
        return Array.from(thread.querySelectorAll(".chat-group")).flatMap((group: Element) => {
          const text = group.textContent ?? "";
          if (text.includes("I will inspect the file.")) {
            return ["assistant stream"];
          }
          if (group.querySelector('[data-message-id^="tool:assistant:call-read"]')) {
            return ["tool card"];
          }
          return [];
        });
      });

      expect(visibleOrder).toEqual(["assistant stream", "tool card"]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
