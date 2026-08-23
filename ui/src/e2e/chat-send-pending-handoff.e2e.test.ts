// Control UI E2E tests cover the pending-send bubble handoff to authoritative history.
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat send pending handoff",
});

type FrameSample = {
  t: number;
  present: boolean;
  rowKeys: string[];
  imageCount: number;
  loadedImageCount: number;
};

type SamplerWindow = Window & {
  openclawSendFrameSamples?: FrameSample[];
  openclawSendFrameSamplerStop?: () => void;
};

const PROBE_TEXT = "Flicker probe message 4242";
const IMAGE_PROBE_TEXT = "Image flicker probe message 4242";
const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
const ONE_PIXEL_PNG_DATA_URL = `data:image/png;base64,${ONE_PIXEL_PNG_B64}`;
const USER_ECHO_ENTRY_ID = "pending-handoff-user-echo";

async function startFrameSampler(currentPage: Page, probeText = PROBE_TEXT): Promise<void> {
  await currentPage.evaluate((text) => {
    const win = window as SamplerWindow;
    const frames: FrameSample[] = [];
    win.openclawSendFrameSamples = frames;
    let running = true;
    win.openclawSendFrameSamplerStop = () => {
      running = false;
    };
    const sample = () => {
      if (!running) {
        return;
      }
      const rows = [...document.querySelectorAll<HTMLElement>("[data-virtual-row-key]")].filter(
        (row) => (row.textContent ?? "").includes(text),
      );
      const images = rows.flatMap((row) => [
        ...row.querySelectorAll<HTMLImageElement>(".chat-message-image"),
      ]);
      frames.push({
        t: performance.now(),
        present: rows.length > 0,
        rowKeys: rows.map((row) => row.dataset.virtualRowKey ?? ""),
        imageCount: images.length,
        loadedImageCount: images.filter(
          (image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
        ).length,
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, probeText);
}

async function stopFrameSampler(currentPage: Page): Promise<FrameSample[]> {
  return currentPage.evaluate(() => {
    const win = window as SamplerWindow;
    win.openclawSendFrameSamplerStop?.();
    return win.openclawSendFrameSamples ?? [];
  });
}

function analyzeFrameContinuity(
  frames: FrameSample[],
  isHealthy: (frame: FrameSample) => boolean = (frame) => frame.present,
): string[] {
  const firstHealthy = frames.findIndex(isHealthy);
  expect(firstHealthy).toBeGreaterThanOrEqual(0);
  const continuityFrames = frames.slice(firstHealthy);
  expect(
    continuityFrames
      .filter((frame) => !isHealthy(frame))
      .map((frame) => ({
        imageCount: frame.imageCount,
        loadedImageCount: frame.loadedImageCount,
        present: frame.present,
        rowKeys: frame.rowKeys,
        t: frame.t,
      })),
  ).toEqual([]);
  const keyTimeline: string[] = [];
  for (const frame of continuityFrames) {
    for (const key of frame.rowKeys) {
      if (keyTimeline[keyTimeline.length - 1] !== key) {
        keyTimeline.push(key);
      }
    }
  }
  return keyTimeline;
}

const BASE_HISTORY = [
  {
    content: [{ text: "Ready.", type: "text" }],
    role: "assistant",
    timestamp: Date.now() - 5_000,
    __openclaw: { seq: 1 },
  },
];

type ChatSendParams = {
  attachments?: Array<{ content?: string; mimeType?: string }>;
  idempotencyKey?: string;
};

async function openChatAndSubmitProbe(
  currentPage: Page,
  gateway: MockGatewayControls,
  opts: { attachImage?: boolean; deferSend?: boolean; probeText?: string } = {},
): Promise<{ runId: string; sendParams: ChatSendParams }> {
  const probeText = opts.probeText ?? PROBE_TEXT;
  await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
  await currentPage.getByText("Ready.").waitFor({ timeout: 10_000 });
  await gateway.waitForRequest("sessions.list");
  if (opts.attachImage) {
    await currentPage.locator(".agent-chat__file-input").setInputFiles({
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
    });
    await currentPage.locator(".chat-attachment-thumb").waitFor({ state: "visible" });
  }
  if (opts.deferSend) {
    await gateway.deferNext("chat.send");
  }
  await startFrameSampler(currentPage, probeText);
  await currentPage.locator(".agent-chat__input textarea").fill(probeText);
  await currentPage.locator(".agent-chat__input textarea").press("Enter");
  const send = await gateway.waitForRequest("chat.send");
  const sendParams = send.params as ChatSendParams;
  const runId = sendParams.idempotencyKey ?? "";
  expect(runId).toBeTruthy();
  await currentPage
    .locator("[data-virtual-row-key]")
    .getByText(probeText, { exact: true })
    .waitFor({ timeout: 10_000 });
  return { runId, sendParams };
}

async function finishRunAndSettle(
  currentPage: Page,
  gateway: MockGatewayControls,
  runId: string,
  userEcho: Record<string, unknown>,
): Promise<FrameSample[]> {
  await gateway.setHistoryMessages([
    ...BASE_HISTORY,
    userEcho,
    {
      content: [{ text: "Run complete.", type: "text" }],
      role: "assistant",
      timestamp: Date.now() + 1,
      __openclaw: { seq: 3 },
    },
  ]);
  // The terminal reconciliation must re-read history; baseline before the
  // final so either trigger (final event or terminal session row) counts.
  const historyRequestsBeforeTerminal = (await gateway.getRequests("chat.history")).length;
  const finalMessage = {
    content: [{ text: "Run complete.", type: "text" }],
    role: "assistant",
    timestamp: Date.now() + 1,
    __openclaw: { seq: 3 },
  };
  await gateway.emitChatFinal({ runId, text: "Run complete." });
  await currentPage
    .locator(".chat-bubble")
    .getByText("Run complete.", { exact: true })
    .waitFor({ timeout: 10_000 });
  // The Gateway persists the assistant turn and publishes it with a terminal
  // session row; this is what triggers the authoritative history reload.
  await gateway.emitGatewayEvent("session.message", {
    activeRunIds: [],
    clientRunId: runId,
    hasActiveRun: false,
    message: finalMessage,
    messageId: "pending-handoff-final-1",
    messageSeq: 3,
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
  // The handoff must complete: history is re-read and the probe bubble becomes
  // the authoritative copy (its data-entry-id comes only from loaded history,
  // never from the pending queue projection).
  await expect
    .poll(async () => (await gateway.getRequests("chat.history")).length, { timeout: 10_000 })
    .toBeGreaterThan(historyRequestsBeforeTerminal);
  await expect
    .poll(
      () => currentPage.locator(`.chat-bubble[data-entry-id="${USER_ECHO_ENTRY_ID}"]`).count(),
      {
        timeout: 10_000,
      },
    )
    .toBe(1);
  // Let a few more frames elapse so trailing samples cover the settled state.
  await currentPage.waitForTimeout(500);
  return stopFrameSampler(currentPage);
}

function isHealthyImageFrame(frame: FrameSample): boolean {
  return frame.rowKeys.length === 1 && frame.imageCount === 1 && frame.loadedImageCount === 1;
}

suite.define(() => {
  it("keeps a submitted image visible through run completion and history reload", async () => {
    await suite.withPage(
      { viewport: { height: 800, width: 1200 } },
      async ({ page: currentPage }) => {
        const gateway = await installMockGateway(currentPage, { historyMessages: BASE_HISTORY });
        const { runId, sendParams } = await openChatAndSubmitProbe(currentPage, gateway, {
          attachImage: true,
          deferSend: true,
          probeText: IMAGE_PROBE_TEXT,
        });

        expect(sendParams.attachments?.[0]).toMatchObject({
          content: ONE_PIXEL_PNG_B64,
          mimeType: "image/png",
        });
        // A locally submitted turn plays the composer entry animation exactly once.
        expect(await currentPage.locator(".chat-bubble--user-turn-enter").count()).toBe(1);
        await expect
          .poll(() =>
            currentPage.evaluate(() =>
              ((window as SamplerWindow).openclawSendFrameSamples ?? []).some(
                (frame) =>
                  frame.rowKeys.length === 1 &&
                  frame.imageCount === 1 &&
                  frame.loadedImageCount === 1,
              ),
            ),
          )
          .toBe(true);
        await gateway.resolveDeferred("chat.send");

        const frames = await finishRunAndSettle(currentPage, gateway, runId, {
          content: [
            { text: IMAGE_PROBE_TEXT, type: "text" },
            {
              type: "image",
              url: ONE_PIXEL_PNG_DATA_URL,
              source: { type: "url", url: ONE_PIXEL_PNG_DATA_URL },
            },
          ],
          role: "user",
          timestamp: Date.now(),
          __openclaw: { id: USER_ECHO_ENTRY_ID, idempotencyKey: runId, seq: 2 },
        });

        const keyTimeline = analyzeFrameContinuity(frames, isHealthyImageFrame);
        // The bubble keeps one identity through the pending -> history handoff, so
        // the DOM node is never remounted (no animation replay, no layout jump).
        expect(new Set(keyTimeline).size).toBe(1);
        const submittedRow = currentPage
          .locator("[data-virtual-row-key]")
          .filter({ hasText: IMAGE_PROBE_TEXT });
        expect(await submittedRow.getByText("Attached image", { exact: false }).count()).toBe(0);
      },
    );
  });

  it("keeps the submitted user turn visible when the session echo lands before the send ack", async () => {
    await suite.withPage(
      { viewport: { height: 800, width: 1200 } },
      async ({ page: currentPage }) => {
        const gateway = await installMockGateway(currentPage, { historyMessages: BASE_HISTORY });
        const { runId } = await openChatAndSubmitProbe(currentPage, gateway, { deferSend: true });

        // The Gateway persists and broadcasts the user turn before the ack resolves.
        const userEcho = {
          content: [{ text: PROBE_TEXT, type: "text" }],
          role: "user",
          timestamp: Date.now(),
          __openclaw: { id: USER_ECHO_ENTRY_ID, idempotencyKey: runId, seq: 2 },
        };
        await gateway.setHistoryMessages([...BASE_HISTORY, userEcho]);
        const historyRequestsBefore = (await gateway.getRequests("chat.history")).length;
        await gateway.emitGatewayEvent("session.message", {
          activeRunIds: [runId],
          clientRunId: runId,
          hasActiveRun: true,
          message: userEcho,
          messageId: "pending-handoff-echo-1",
          messageSeq: 2,
          session: {
            activeRunIds: [runId],
            hasActiveRun: true,
            key: "main",
            kind: "direct",
            status: "running",
            updatedAt: Date.now(),
          },
          sessionKey: "main",
        });
        await expect
          .poll(async () => (await gateway.getRequests("chat.history")).length, {
            timeout: 10_000,
          })
          .toBeGreaterThan(historyRequestsBefore);
        await currentPage.waitForTimeout(300);
        await gateway.resolveDeferred("chat.send");

        const frames = await finishRunAndSettle(currentPage, gateway, runId, userEcho);
        const keyTimeline = analyzeFrameContinuity(frames);
        expect(new Set(keyTimeline).size).toBe(1);
        // The single stable key above proves the node never remounted, so the
        // entry animation cannot have replayed; at most the one submitted turn
        // still carries the (inert, completed) animation class.
        expect(
          await currentPage.locator(".chat-bubble--user-turn-enter").count(),
        ).toBeLessThanOrEqual(1);
      },
    );
  });
});
