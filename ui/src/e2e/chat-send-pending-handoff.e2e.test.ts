// Control UI E2E tests cover the pending-send bubble handoff to authoritative history.
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let page: Page | undefined;
let server: ControlUiE2eServer | undefined;

type FrameSample = {
  t: number;
  present: boolean;
  rowKeys: string[];
};

type SamplerWindow = Window & {
  openclawSendFrameSamples?: FrameSample[];
  openclawSendFrameSamplerStop?: () => void;
};

const PROBE_TEXT = "Flicker probe message 4242";
const USER_ECHO_ENTRY_ID = "pending-handoff-user-echo";

async function startFrameSampler(currentPage: Page): Promise<void> {
  await currentPage.evaluate((probeText) => {
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
        (row) => (row.textContent ?? "").includes(probeText),
      );
      frames.push({
        t: performance.now(),
        present: rows.length > 0,
        rowKeys: rows.map((row) => row.dataset.virtualRowKey ?? ""),
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, PROBE_TEXT);
}

async function stopFrameSampler(currentPage: Page): Promise<FrameSample[]> {
  return currentPage.evaluate(() => {
    const win = window as SamplerWindow;
    win.openclawSendFrameSamplerStop?.();
    return win.openclawSendFrameSamples ?? [];
  });
}

/** Presence gaps (frames where the probe text vanished after first paint) and
 * the distinct row keys the probe bubble rendered under, in order. */
function analyzeFrameSamples(frames: FrameSample[]): { gapFrames: number; keyTimeline: string[] } {
  const firstVisible = frames.findIndex((frame) => frame.present);
  expect(firstVisible).toBeGreaterThanOrEqual(0);
  // Counting through the final sample also catches a permanent disappearance.
  expect(frames[frames.length - 1]?.present).toBe(true);
  let gapFrames = 0;
  for (let index = firstVisible; index < frames.length; index++) {
    if (frames[index]?.present === false) {
      gapFrames += 1;
    }
  }
  const keyTimeline: string[] = [];
  for (const frame of frames) {
    for (const key of frame.rowKeys) {
      if (keyTimeline[keyTimeline.length - 1] !== key) {
        keyTimeline.push(key);
      }
    }
  }
  return { gapFrames, keyTimeline };
}

const BASE_HISTORY = [
  {
    content: [{ text: "Ready.", type: "text" }],
    role: "assistant",
    timestamp: Date.now() - 5_000,
    __openclaw: { seq: 1 },
  },
];

async function openChatAndSubmitProbe(
  currentPage: Page,
  gateway: MockGatewayControls,
  opts?: { deferSend?: boolean },
): Promise<string> {
  await currentPage.goto(`${server?.baseUrl ?? ""}chat`);
  await currentPage.getByText("Ready.").waitFor({ timeout: 10_000 });
  await gateway.waitForRequest("sessions.list");
  if (opts?.deferSend) {
    await gateway.deferNext("chat.send");
  }
  await startFrameSampler(currentPage);
  await currentPage.locator(".agent-chat__input textarea").fill(PROBE_TEXT);
  await currentPage.locator(".agent-chat__input textarea").press("Enter");
  const send = await gateway.waitForRequest("chat.send");
  const runId = (send.params as { idempotencyKey?: string }).idempotencyKey ?? "";
  expect(runId).toBeTruthy();
  await currentPage
    .locator("[data-virtual-row-key]")
    .getByText(PROBE_TEXT, { exact: true })
    .waitFor({ timeout: 10_000 });
  return runId;
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

describeControlUiE2e("Control UI chat send pending handoff", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close();
      throw error;
    }
  });

  afterEach(async () => {
    await page
      ?.context()
      .close()
      .catch(() => {});
    page = undefined;
  });

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await server?.close();
  });

  it("keeps the submitted user turn visible through run completion and history reload", async () => {
    const context = await browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, { historyMessages: BASE_HISTORY });

    const runId = await openChatAndSubmitProbe(currentPage, gateway);
    // A locally submitted turn plays the composer entry animation exactly once.
    expect(await currentPage.locator(".chat-bubble--user-turn-enter").count()).toBe(1);

    const frames = await finishRunAndSettle(currentPage, gateway, runId, {
      content: [{ text: PROBE_TEXT, type: "text" }],
      role: "user",
      timestamp: Date.now(),
      __openclaw: { id: USER_ECHO_ENTRY_ID, idempotencyKey: runId, seq: 2 },
    });

    const { gapFrames, keyTimeline } = analyzeFrameSamples(frames);
    // The submitted text must never disappear once visible.
    expect(gapFrames).toBe(0);
    // The bubble keeps one identity through the pending -> history handoff, so
    // the DOM node is never remounted (no animation replay, no layout jump).
    expect(new Set(keyTimeline).size).toBe(1);
  });

  it("keeps the submitted user turn visible when the session echo lands before the send ack", async () => {
    const context = await browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, { historyMessages: BASE_HISTORY });

    const runId = await openChatAndSubmitProbe(currentPage, gateway, { deferSend: true });

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
      .poll(async () => (await gateway.getRequests("chat.history")).length, { timeout: 10_000 })
      .toBeGreaterThan(historyRequestsBefore);
    await currentPage.waitForTimeout(300);
    await gateway.resolveDeferred("chat.send");

    const frames = await finishRunAndSettle(currentPage, gateway, runId, userEcho);

    const { gapFrames, keyTimeline } = analyzeFrameSamples(frames);
    expect(gapFrames).toBe(0);
    expect(new Set(keyTimeline).size).toBe(1);
    // The single stable key above proves the node never remounted, so the
    // entry animation cannot have replayed; at most the one submitted turn
    // still carries the (inert, completed) animation class.
    expect(await currentPage.locator(".chat-bubble--user-turn-enter").count()).toBeLessThanOrEqual(
      1,
    );
  });
});
