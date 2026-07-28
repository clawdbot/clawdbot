import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectDefined,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
  scrollChatThreadToTop,
  visibleChatBubbleTexts,
  waitForChatScrollIdle,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("shows persisted user messages after opening History and scrolling mixed history", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const currentSessionMessages = [
      {
        content: [{ text: "Current session placeholder", type: "text" }],
        role: "assistant",
        timestamp: baseTs - 1,
      },
    ];
    const historyMessages = Array.from({ length: 70 }, (_, index) => ({
      content: [
        {
          text: `${index % 2 === 0 ? "User history question" : "Assistant history answer"} ${index}\n${"history detail line\n".repeat(4)}`,
          type: index % 2 === 0 ? "input_text" : "output_text",
        },
      ],
      role: index % 2 === 0 ? "user" : "assistant",
      timestamp: baseTs + index,
    }));
    const gateway = await installMockGateway(page, {
      historyMessages: currentSessionMessages,
      methodResponses: {
        "chat.startup": {
          cases: [
            {
              match: { sessionKey: "agent:main:session-b" },
              response: {
                messages: historyMessages,
                sessionId: "control-ui-e2e-history-session-b",
                thinkingLevel: null,
              },
            },
            {
              match: { sessionKey: "agent:main:session-a" },
              response: {
                messages: currentSessionMessages,
                sessionId: "control-ui-e2e-history-session-a",
                thinkingLevel: null,
              },
            },
          ],
        },
        "sessions.list": chatSessionListResponse(),
      },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Current session placeholder").waitFor({ timeout: 10_000 });

      const startupCountBeforeSwitch = (await gateway.getRequests("chat.startup")).length;
      await page
        .locator(
          '.sidebar-recent-session[data-session-key="agent:main:session-b"] a.sidebar-recent-session__link',
        )
        .click();
      const startupRequests = await waitForRequests(
        gateway,
        "chat.startup",
        startupCountBeforeSwitch + 1,
      );
      const historyRequest = expectDefined(startupRequests.at(-1), "session B startup request");
      expect(requireRecord(historyRequest.params)).toMatchObject({
        sessionKey: "agent:main:session-b",
      });
      await page.locator(".chat-thread").getByText("User history question 68").waitFor({
        timeout: 10_000,
      });
      await page.locator(".chat-thread").getByText("Assistant history answer 69").waitFor({
        timeout: 10_000,
      });
      await expect
        .poll(
          async () => {
            const texts = await visibleChatBubbleTexts(page);
            return (
              texts.some((text) => text.includes("User history question 68")) &&
              texts.some((text) => text.includes("Assistant history answer 69"))
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);

      await waitForChatScrollIdle(page);
      await scrollChatThreadToTop(page);
      await page.locator(".chat-thread").getByText("User history question 10").waitFor({
        timeout: 10_000,
      });
      await scrollChatThreadToTop(page);
      await page.locator(".chat-thread").getByText("User history question 0").waitFor({
        timeout: 10_000,
      });
      await scrollChatThreadToTop(page);
      await expect
        .poll(
          async () => {
            const texts = await visibleChatBubbleTexts(page);
            return (
              texts.some((text) => text.includes("User history question 0")) &&
              texts.some((text) => text.includes("Assistant history answer 1"))
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps retained paginated history stable when returning to a session", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.newBrowserContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const historyMessage = (seq: number, label: string) => ({
      __openclaw: { id: `history-${seq}`, seq },
      content: [
        {
          text: `${label} ${seq}\n${"retained transcript detail\n".repeat(3)}`,
          type: seq % 2 === 0 ? "output_text" : "input_text",
        },
      ],
      role: seq % 2 === 0 ? "assistant" : "user",
      timestamp: 1_800_000_000_000 + seq,
    });
    const shortMessages = [historyMessage(1, "short session"), historyMessage(2, "short session")];
    const recentMessages = Array.from({ length: 100 }, (_, index) =>
      historyMessage(index + 41, "recent retained message"),
    );
    const olderMessages = Array.from({ length: 40 }, (_, index) =>
      historyMessage(index + 1, "older retained message"),
    );
    const gateway = await installMockGateway(page, {
      historyMessages: shortMessages,
      methodResponses: {
        "chat.history": {
          cases: [
            {
              match: { offset: 100, sessionKey: "agent:main:session-b" },
              response: {
                hasMore: false,
                messages: olderMessages,
                sessionId: "retained-history-session",
                thinkingLevel: null,
                totalMessages: 140,
              },
            },
            {
              match: { sessionKey: "agent:main:session-b" },
              response: {
                hasMore: true,
                messages: recentMessages,
                nextOffset: 100,
                sessionId: "retained-history-session",
                thinkingLevel: null,
                totalMessages: 140,
              },
            },
            {
              match: { sessionKey: "agent:main:session-a" },
              response: {
                hasMore: false,
                messages: shortMessages,
                sessionId: "short-history-session",
                thinkingLevel: null,
                totalMessages: 2,
              },
            },
          ],
        },
        "chat.startup": {
          cases: [
            {
              match: { sessionKey: "agent:main:session-b" },
              response: {
                hasMore: true,
                messages: recentMessages,
                nextOffset: 100,
                sessionId: "retained-history-session",
                thinkingLevel: null,
                totalMessages: 140,
              },
            },
            {
              match: {},
              response: {
                hasMore: false,
                messages: shortMessages,
                sessionId: "short-history-session",
                thinkingLevel: null,
                totalMessages: 2,
              },
            },
          ],
        },
        "sessions.list": chatSessionListResponse(),
      },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText(/^short session 2\n/).waitFor({ timeout: 10_000 });

      const sessionB = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-b"] a.sidebar-recent-session__link',
      );
      const sessionA = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-a"] a.sidebar-recent-session__link',
      );
      await sessionB.click();
      await page.getByText(/^recent retained message 140\n/).waitFor({ timeout: 10_000 });
      const thread = page.locator(".chat-thread");
      await thread.hover();
      await page.mouse.wheel(0, -1_000_000);
      await expect
        .poll(() =>
          page
            .locator("openclaw-chat-pane")
            .evaluate(
              (element) =>
                (element as HTMLElement & { state: { chatMessages: unknown[] } }).state.chatMessages
                  .length,
            ),
        )
        .toBe(140);
      // Prepending preserves the visible anchor. A renewed upward gesture
      // reaches the newly loaded start instead of teleporting the reader.
      await page.mouse.wheel(0, -1_000_000);
      await page.getByText(/^older retained message 1\n/).waitFor({ timeout: 10_000 });

      await sessionA.click();
      await page.getByText(/^short session 2\n/).waitFor({ timeout: 10_000 });
      const historyRequestsBeforeReturn = (await gateway.getRequests("chat.history")).length;
      await page.evaluate(() => {
        type FrameSample = {
          hiddenNotice: boolean;
          loading: boolean;
          messageCount: number;
          minOpacity: number;
          sessionKey: string;
        };
        const samples: FrameSample[] = [];
        (
          globalThis as typeof globalThis & {
            chatSessionReturnSamples: FrameSample[];
          }
        ).chatSessionReturnSamples = samples;
        const deadline = performance.now() + 750;
        const sample = () => {
          const pane = document.querySelector("openclaw-chat-pane") as
            | (HTMLElement & {
                state?: { chatMessages?: unknown[]; sessionKey?: string };
              })
            | null;
          const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-chat-row-key]"));
          samples.push({
            hiddenNotice: document.body.textContent?.includes("Showing last") ?? false,
            loading: document.querySelector(".chat-history-loading") !== null,
            messageCount: pane?.state?.chatMessages?.length ?? 0,
            minOpacity: rows.reduce(
              (minimum, row) => Math.min(minimum, Number.parseFloat(getComputedStyle(row).opacity)),
              1,
            ),
            sessionKey: pane?.state?.sessionKey ?? "",
          });
          if (performance.now() < deadline) {
            requestAnimationFrame(sample);
          }
        };
        requestAnimationFrame(sample);
      });

      await sessionB.click();
      // Returning preserves the reading position at the loaded-history start;
      // the user can still use the normal jump-to-end control for message 140.
      await page.getByText(/^older retained message 1\n/).waitFor({ timeout: 10_000 });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 800);
      });
      const samples = await page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              chatSessionReturnSamples: Array<{
                hiddenNotice: boolean;
                loading: boolean;
                messageCount: number;
                minOpacity: number;
                sessionKey: string;
              }>;
            }
          ).chatSessionReturnSamples,
      );
      const returnedSamples = samples.filter(
        (sample) => sample.sessionKey === "agent:main:session-b",
      );
      const restoredIndex = returnedSamples.findIndex((sample) => sample.messageCount === 140);
      expect(restoredIndex).toBeGreaterThanOrEqual(0);
      expect(
        returnedSamples.slice(restoredIndex).every((sample) => sample.messageCount === 140),
      ).toBe(true);
      expect(returnedSamples.every((sample) => sample.minOpacity === 1)).toBe(true);
      expect(returnedSamples.every((sample) => !sample.hiddenNotice)).toBe(true);
      expect(returnedSamples.every((sample) => !sample.loading)).toBe(true);
      expect(await page.getByRole("button", { name: "Load older" }).count()).toBe(0);
      await expectRequestCountStable(gateway, "chat.history", historyRequestsBeforeReturn + 1);
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/retained-history-return.png`,
          fullPage: true,
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps rejected pre-ACK sends visible and restores the draft", async () => {
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

      const prompt = "policy should not eat this";
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await gateway.waitForRequest("chat.send");

      await gateway.rejectDeferred("chat.send", {
        code: "INVALID_REQUEST",
        message: "send blocked by session policy",
      });

      await page.locator(".chat-queue").getByText("Failed").waitFor({ timeout: 10_000 });
      await page.locator(".chat-queue").getByText(prompt).waitFor({ timeout: 10_000 });
      expect(await composer.inputValue()).toBe(prompt);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("parks an ACK-lost send for review before a same-key manual retry", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": {
          messages: [],
          sessionId: "control-ui-e2e-session",
          sessionInfo: { hasActiveRun: false, status: "done" },
          thinkingLevel: null,
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.deferNext("chat.send");

      const prompt = "retry with the same key";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const firstRequest = await gateway.waitForRequest("chat.send");
      const firstParams = requireRecord(firstRequest.params);
      const runId = requireString(firstParams.idempotencyKey, "first idempotency key");

      await gateway.closeLatest(1006, "lost ack");

      const queue = page.locator(".chat-queue");
      await queue.getByText("Needs review").waitFor({ timeout: 10_000 });
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      await queue.locator(".chat-queue__retry").click();

      const sends = await waitForRequests(gateway, "chat.send", 2);
      const secondParams = requireRecord(sends[1]?.params);
      expect(secondParams.idempotencyKey).toBe(runId);
      expect(secondParams.message).toBe(prompt);
      await queue.waitFor({ state: "detached", timeout: 10_000 });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("stores new input while offline and sends it after reconnect", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.newBrowserContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": {
          messages: [],
          sessionId: "control-ui-e2e-session",
          sessionInfo: { hasActiveRun: false, status: "done" },
          thinkingLevel: null,
        },
      },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "global"));
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 10_000 });

      await gateway.setOnline(false);
      await page.locator(".agent-chat__offline-hint").waitFor({ timeout: 10_000 });

      const prompt = "send this when the Gateway returns";
      const attachmentName = "offline-proof.txt";
      const attachmentMimeType = "text/plain";
      const attachmentText = "offline attachment proof";
      const attachmentBase64 = Buffer.from(attachmentText).toString("base64");
      const attachmentDataUrl = `data:${attachmentMimeType};base64,${attachmentBase64}`;
      const composerEnabled = await composer.isEnabled();
      expect(composerEnabled).toBe(true);
      await composer.fill(prompt);
      await page.locator(".agent-chat__file-input").setInputFiles({
        name: attachmentName,
        mimeType: attachmentMimeType,
        buffer: Buffer.from(attachmentText),
      });
      await page.locator(".chat-attachment-file__name", { hasText: attachmentName }).waitFor({
        timeout: 10_000,
      });
      const send = page.getByRole("button", { name: "Send message" });
      const sendEnabled = await send.isEnabled();
      expect(sendEnabled).toBe(true);
      await send.click();

      const queue = page.locator(".chat-queue");
      await queue.getByText("Waiting for reconnect").waitFor({ timeout: 10_000 });
      await queue.getByText(prompt).waitFor({ timeout: 10_000 });
      const requestsBeforeReconnect = await gateway.getRequests("chat.send");
      expect(requestsBeforeReconnect).toHaveLength(0);
      const readStoredProof = () =>
        page.evaluate(
          ({ expectedAttachmentName, expectedAttachmentDataUrl, expectedPrompt }) => {
            const storedValues = Object.entries(sessionStorage)
              .filter(([key]) => key.startsWith("openclaw.control.chatComposer.v2:"))
              .map(([, value]) => value);
            const stored = storedValues.join("\n");
            let runId: string | null = null;
            for (const value of storedValues) {
              try {
                const parsed = JSON.parse(value) as {
                  sessions?: Record<
                    string,
                    {
                      queue?: Array<{
                        attachments?: Array<{ dataUrl?: unknown; fileName?: unknown }>;
                        sendRunId?: unknown;
                        text?: unknown;
                      }>;
                    }
                  >;
                };
                const item = Object.values(parsed.sessions ?? {})
                  .flatMap((session) => session.queue ?? [])
                  .find((entry) => entry.text === expectedPrompt);
                if (typeof item?.sendRunId === "string") {
                  runId = item.sendRunId;
                  const attachment = item.attachments?.find(
                    (entry) => entry.fileName === expectedAttachmentName,
                  );
                  return {
                    attachment: attachment?.dataUrl === expectedAttachmentDataUrl,
                    prompt: true,
                    runId,
                    waitingReconnect: value.includes('"sendState":"waiting-reconnect"'),
                  };
                }
              } catch {
                // Ignore unrelated malformed session storage in this focused proof.
              }
            }
            return {
              attachment: false,
              prompt: stored.includes(expectedPrompt),
              runId,
              waitingReconnect: stored.includes('"sendState":"waiting-reconnect"'),
            };
          },
          {
            expectedAttachmentDataUrl: attachmentDataUrl,
            expectedAttachmentName: attachmentName,
            expectedPrompt: prompt,
          },
        );
      await expect.poll(readStoredProof).toEqual({
        attachment: true,
        prompt: true,
        runId: expect.any(String),
        waitingReconnect: true,
      });
      const storedProof = await readStoredProof();
      const storedRunId = requireString(storedProof.runId, "stored offline send idempotency key");
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/01-offline-queued.png`, fullPage: true });
      }

      await page.reload();
      await expect.poll(readStoredProof).toEqual({
        attachment: true,
        prompt: true,
        runId: storedRunId,
        waitingReconnect: true,
      });
      // A cold reload waits for initial Gateway bootstrap before rebuilding the
      // UI. Storage survival here plus replay below is the reload contract.
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await gateway.setOnline(true);
      await page.locator("openclaw-chat-pane").waitFor({ state: "attached", timeout: 10_000 });

      const request = await gateway.waitForRequest("chat.send");
      const params = requireRecord(request.params);
      const runId = requireString(params.idempotencyKey, "offline send idempotency key");
      expect(params.message).toBe(prompt);
      expect(runId).toBe(storedRunId);
      expect(params.attachments).toEqual([
        {
          content: attachmentBase64,
          fileName: attachmentName,
          mimeType: attachmentMimeType,
          type: "file",
        },
      ]);
      await queue.getByText("Needs review").waitFor({ timeout: 10_000 });
      await queue
        .getByText("Delivery could not be confirmed after reconnect.", { exact: false })
        .waitFor({ timeout: 10_000 });
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/02-reconnected-review.png`, fullPage: true });
      }
      await expectRequestCountStable(gateway, "chat.send", 1);
      const requestsAfterReconnect = await gateway.getRequests("chat.send");
      await gateway.setHistoryMessages([
        {
          role: "user",
          __openclaw: { idempotencyKey: `${runId}:user` },
        },
      ]);
      await gateway.emitChatFinal({ runId, text: "Delivered after reconnect." });
      await queue.waitFor({ state: "detached", timeout: 10_000 });
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      await expect
        .poll(async () => {
          const proof = await readStoredProof();
          return proof.attachment || proof.prompt || proof.runId === runId;
        })
        .toBe(false);
      await page.locator(".agent-chat__offline-hint").waitFor({ state: "detached" });
      await expectRequestCountStable(gateway, "chat.send", 1);
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/03-online-delivered.png`, fullPage: true });
      }
      if (process.env.OPENCLAW_BEHAVIOR_PROOF === "1") {
        process.stdout.write(
          `${JSON.stringify({
            proof: "offline-chat-reconnect",
            composerEnabled,
            sendEnabled,
            waitingStateVisible: true,
            storedPrompt: storedProof.prompt,
            storedWaitingState: storedProof.waitingReconnect,
            requestsBeforeReconnect: requestsBeforeReconnect.length,
            requestsAfterReconnect: requestsAfterReconnect.length,
            idempotencyKeyPresent: runId.length > 0,
            queueClearedAfterDelivery: true,
          })}\n`,
        );
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
