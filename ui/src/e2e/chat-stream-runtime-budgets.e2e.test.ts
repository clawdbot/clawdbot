import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

// Durable runtime budgets for the chat streaming surface. Byte budgets
// (scripts/check-control-ui-performance.mts) cannot see rendering work, so
// these tests protect the landed streaming optimizations at the DOM boundary:
// the animation-frame render queue (ui/src/pages/chat/chat-state-render.ts),
// the bounded live tool stream (ui/src/pages/chat/tool-stream.ts), and the
// transcript/heap cost of long sessions. Structural counts are exact and
// machine-speed independent; wall-clock/heap ceilings carry several-fold
// headroom so shared runners stay green while algorithmic regressions
// (per-event renders, quadratic transcript work, retained stream buffers)
// still violate them by an order of magnitude.
const suite = createChatFlowE2eSuite();

type ChatFlowSuite = ReturnType<typeof createChatFlowE2eSuite>;
type ChatFlowPage = Parameters<Parameters<ChatFlowSuite["withPage"]>[1]>[0]["page"];

// Burst size for the render-scheduling gate. Each delta lands in its own
// macrotask, so every event forces an invalidation; the animation-frame queue
// is what keeps those invalidations executing inside frame callbacks instead
// of on message/timer tasks.
const BURST_DELTA_COUNT = 240;
// Sanity floor: the burst must invalidate the chat page host at least twice,
// proving the probe observed the streaming path at all.
const MIN_BURST_HOST_UPDATES = 2;
// Minimum share of host invalidations that must execute inside an animation
// frame callback. The queue guarantees this for every stream-driven update;
// only rare timer-driven strays (poll controllers) fall outside frames.
const FRAME_SCHEDULED_MIN_RATIO = 0.9;

// Shipped live-tool ceiling: ui/src/pages/chat/tool-stream.ts TOOL_STREAM_LIMIT.
const TOOL_STREAM_LIMIT_CONTRACT = 50;
// Realistic agent cadence: narration deltas separate tool calls, so each pair
// (assistant delta, tool result) lands on its own timer tick. Pairs stay above
// the shipped limit to prove eviction under sustained load.
const TOOL_FLOOD_PAIR_COUNT = 60;
const TOOL_FLOOD_PAIR_INTERVAL_MS = 60;
// Gateway activity fencing drops any event whose seq is at or below the
// newest seq already accepted, so flood events seed above every sequence the
// mocked startup handshake has already delivered.
const TOOL_FLOOD_SEQ_SEED = 1_000_000;

const LONG_TRANSCRIPT_MESSAGE_COUNT = 400;
// Wall ceiling with multi-x headroom over the measured baseline
// (.artifacts/control-ui-e2e/stream-runtime-budgets/metrics.jsonl); sized to
// tolerate loaded shared runners while still failing quadratic transcript work.
const LONG_TRANSCRIPT_LOAD_CEILING_MS = 30_000;
const RICH_TURN_CHUNK_COUNT = 150;
// Post-GC resident JS heap after loading the long transcript and streaming the
// rich turn. Headroom over the measured baseline retains transient parser and
// renderer allocations; a leak that keeps streamed deltas alive breaks it.
const STREAM_SESSION_HEAP_CEILING_BYTES = 96 * 1024 * 1024;

const IDLE_WINDOW_MS = 4_000;
const IDLE_LONGTASK_TOTAL_CEILING_MS = 600;

type StreamPerfProbe = {
  mutationBatches: number;
  rafCount: number;
  hostUpdates: number;
  hostUpdatesInsideFrame: number;
};

type ScopedWindow = Window & {
  __ocStreamPerf?: StreamPerfProbe;
  __ocIdleProbe?: { longTasks: number; longTaskMs: number; rafCount: number };
  __ocBurstDone?: boolean;
  openclawControlUiE2eGateway?: {
    emit: (event: string, payload?: unknown) => void;
  };
};

const metricsArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "stream-runtime-budgets",
);

async function recordBudgetMetrics(
  testName: string,
  metrics: Record<string, number>,
): Promise<void> {
  await mkdir(metricsArtifactDir, { recursive: true });
  await appendFile(
    path.join(metricsArtifactDir, "metrics.jsonl"),
    `${JSON.stringify({ testName, metrics, recordedAt: new Date().toISOString() })}\n`,
  );
}

// Rendered transcripts strip markdown markers, so visibility polls match the
// plain-text projection of the burst chunk emitted in-page
// (`delta N with **boldN** and \`codeN\` tail`).
function renderedChunkText(index: number): string {
  return `delta ${index} with bold${index}`;
}

async function installRenderProbe(page: ChatFlowPage) {
  await page.evaluate(() => {
    const scope = window as ScopedWindow;
    const chatPage = document.querySelector("openclaw-chat-page");
    if (!chatPage) {
      throw new Error("openclaw-chat-page is not mounted");
    }
    scope.__ocStreamPerf = {
      mutationBatches: 0,
      rafCount: 0,
      hostUpdates: 0,
      hostUpdatesInsideFrame: 0,
    };
    new MutationObserver((records) => {
      if (records.length > 0) {
        scope.__ocStreamPerf!.mutationBatches += 1;
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    let insideFrame = false;
    const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
      originalRequestAnimationFrame((time) => {
        scope.__ocStreamPerf!.rafCount += 1;
        const previous = insideFrame;
        insideFrame = true;
        try {
          callback(time);
        } finally {
          insideFrame = previous;
        }
      });
    // Walk to the Lit base that owns requestUpdate and shadow it there so
    // every host invalidation (any element) is attributed to whether it ran
    // inside an animation frame callback. Stream-driven updates dominate the
    // window, so the frame-scheduled share stays representative.
    let owner: object | null = Object.getPrototypeOf(chatPage);
    while (owner && !Object.hasOwn(owner, "requestUpdate")) {
      owner = Object.getPrototypeOf(owner);
    }
    if (!owner || typeof (owner as { requestUpdate?: unknown }).requestUpdate !== "function") {
      throw new Error("requestUpdate owner not found on chat page prototype chain");
    }
    const ownerPrototype = owner as { requestUpdate: (...args: unknown[]) => unknown };
    const originalRequestUpdate = ownerPrototype.requestUpdate;
    ownerPrototype.requestUpdate = function patchedRequestUpdate(this: object, ...args: unknown[]) {
      const probe = scope.__ocStreamPerf!;
      const tag = (this as HTMLElement).localName;
      if (tag === "openclaw-chat-page" || tag === "openclaw-chat-pane") {
        probe.hostUpdates += 1;
        if (insideFrame) {
          probe.hostUpdatesInsideFrame += 1;
        }
      }
      return originalRequestUpdate.apply(this, args);
    };
  });
}

async function resetRenderProbe(page: ChatFlowPage) {
  await page.evaluate(() => {
    const scope = window as ScopedWindow;
    scope.__ocStreamPerf = {
      mutationBatches: 0,
      rafCount: 0,
      hostUpdates: 0,
      hostUpdatesInsideFrame: 0,
    };
  });
}

async function readRenderProbe(page: ChatFlowPage): Promise<StreamPerfProbe> {
  return page.evaluate(() => (window as ScopedWindow).__ocStreamPerf!);
}

// Emits each delta from its own macrotask so render work cannot hide inside
// one task's microtask batching: the queue under test schedules commits per
// animation frame, not per task.
async function emitDeltaBurstInPage(
  page: ChatFlowPage,
  runId: string,
  count: number,
): Promise<void> {
  await page.evaluate(
    ({ runId, count }) => {
      const gateway = (window as ScopedWindow).openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("mock gateway handle missing");
      }
      const scope = window as ScopedWindow;
      scope.__ocBurstDone = false;
      let emitted = 0;
      const emitNext = () => {
        emitted += 1;
        const chunk = ` delta ${emitted} with **bold${emitted}** and \`code${emitted}\` tail`;
        gateway.emit("chat", {
          deltaText: chunk,
          message: {
            content: [{ text: chunk, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
          runId,
          sessionKey: "main",
          state: "delta",
        });
        if (emitted < count) {
          setTimeout(emitNext, 0);
        } else {
          scope.__ocBurstDone = true;
        }
      };
      setTimeout(emitNext, 0);
    },
    { runId, count },
  );
  await page.waitForFunction(() => (window as ScopedWindow).__ocBurstDone === true, undefined, {
    timeout: 30_000,
    polling: 50,
  });
}

async function openStreamingTurn(
  page: ChatFlowPage,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  prompt: string,
): Promise<string> {
  await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  const sendRequest = await gateway.waitForRequest("chat.send");
  const params = requireRecord(sendRequest.params);
  const runId = requireString(params.idempotencyKey, "chat send idempotency key");
  // One visible warm-up delta puts the transcript into the live streaming
  // state the burst and flood events attach to; it lands before any probe
  // counters reset, so measured windows stay clean.
  await gateway.emitGatewayEvent("chat", {
    deltaText: " warmup",
    message: {
      content: [{ text: " warmup", type: "text" }],
      role: "assistant",
      timestamp: Date.now(),
    },
    runId,
    sessionKey: "main",
    state: "delta",
  });
  await page.locator(".chat-bubble.streaming").getByText("warmup").waitFor();
  return runId;
}

async function emitToolResultFlood(
  page: ChatFlowPage,
  runId: string,
  pairCount: number,
): Promise<void> {
  // Real agent turns alternate narration deltas and tool results, and Gateway
  // frames arrive as separate socket messages; deliver each pair on its own
  // timer tick so the live stream sees production-shaped input.
  await page.evaluate(
    ({ runId, pairCount, intervalMs, seqSeed }) => {
      const scope = window as ScopedWindow;
      const gateway = scope.openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("mock gateway handle missing");
      }
      scope.__ocBurstDone = false;
      let emitted = 0;
      const emitPair = () => {
        emitted += 1;
        const chunk = ` working on step ${emitted}`;
        gateway.emit("chat", {
          deltaText: chunk,
          message: {
            content: [{ text: chunk, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
          runId,
          sessionKey: "main",
          state: "delta",
        });
        gateway.emit("agent", {
          data: {
            name: "exec",
            phase: "result",
            result: `tool output ${emitted}`,
            toolCallId: `call-${emitted}`,
          },
          runId,
          seq: seqSeed + emitted,
          sessionKey: "main",
          stream: "tool",
          ts: Date.now(),
        });
        if (emitted < pairCount) {
          setTimeout(emitPair, intervalMs);
        } else {
          scope.__ocBurstDone = true;
        }
      };
      setTimeout(emitPair, 0);
    },
    { runId, pairCount, intervalMs: TOOL_FLOOD_PAIR_INTERVAL_MS, seqSeed: TOOL_FLOOD_SEQ_SEED },
  );
  await page.waitForFunction(() => (window as ScopedWindow).__ocBurstDone === true, undefined, {
    timeout: 60_000,
    polling: 200,
  });
}

function buildLongTranscriptFixture(messageCount: number): Array<Record<string, unknown>> {
  return Array.from({ length: messageCount }, (_, index) => {
    const role = index % 2 === 0 ? "user" : "assistant";
    const sentinel = index === messageCount - 1 ? " LONG-TAIL-SENTINEL" : "";
    const text =
      role === "user"
        ? `history question ${index}: ${"detail ".repeat(12)}`
        : `history answer ${index}: ${"context ".repeat(16)}${sentinel}`;
    return {
      role,
      content: [{ type: "text", text }],
      timestamp: Date.now() - (messageCount - index) * 1_000,
    };
  });
}

suite.define(() => {
  it("commits a streamed delta burst in frame-bound transcript batches", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const runId = await openStreamingTurn(page, gateway, "burst coalescing probe");

        await installRenderProbe(page);
        await resetRenderProbe(page);

        await emitDeltaBurstInPage(page, runId, BURST_DELTA_COUNT);
        await expect
          .poll(() =>
            page.evaluate(
              (finalChunk) =>
                (document.querySelector(".chat-thread-inner")?.textContent ?? "").includes(
                  finalChunk,
                ),
              renderedChunkText(BURST_DELTA_COUNT),
            ),
          )
          .toBe(true);
        // Sample after the trailing animation frame drained so the batch count
        // reflects the whole burst, not a mid-render snapshot.
        await expect
          .poll(async () => {
            const before = await readRenderProbe(page);
            await new Promise((resolve) => setTimeout(resolve, 200));
            const after = await readRenderProbe(page);
            return before.mutationBatches === after.mutationBatches ? after : null;
          })
          .not.toBeNull();

        const probe = await readRenderProbe(page);
        await recordBudgetMetrics("delta-burst-commits", {
          mutationBatches: probe.mutationBatches,
          rafCount: probe.rafCount,
          hostUpdates: probe.hostUpdates,
          hostUpdatesInsideFrame: probe.hostUpdatesInsideFrame,
        });

        expect(probe.hostUpdates).toBeGreaterThanOrEqual(MIN_BURST_HOST_UPDATES);
        expect(probe.hostUpdatesInsideFrame / probe.hostUpdates).toBeGreaterThanOrEqual(
          FRAME_SCHEDULED_MIN_RATIO,
        );
      },
    );
  });

  it("keeps the live tool stream bounded under a tool result flood", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const runId = await openStreamingTurn(page, gateway, "tool flood probe");

        await emitToolResultFlood(page, runId, TOOL_FLOOD_PAIR_COUNT);
        const floodCards = page.locator('[data-message-id^="tool:assistant:call-"]');
        // Eviction drops the oldest entries and keeps the freshest ones.
        await expect
          .poll(() => floodCards.count(), { timeout: 15_000 })
          .toBe(TOOL_STREAM_LIMIT_CONTRACT);
        expect(await page.locator('[data-message-id^="tool:assistant:call-0"]').count()).toBe(0);
        expect(
          await page
            .locator(`[data-message-id^="tool:assistant:call-${TOOL_FLOOD_PAIR_COUNT}"]`)
            .count(),
        ).toBe(1);
      },
    );
  });

  it("loads a long transcript and streams a rich turn inside budget ceilings", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page, context }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: buildLongTranscriptFixture(LONG_TRANSCRIPT_MESSAGE_COUNT),
        });

        const loadStartedAt = Date.now();
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        await page
          .locator(".chat-thread-inner")
          .getByText("LONG-TAIL-SENTINEL")
          .waitFor({ timeout: LONG_TRANSCRIPT_LOAD_CEILING_MS });
        const loadMs = Date.now() - loadStartedAt;
        expect(loadMs).toBeLessThanOrEqual(LONG_TRANSCRIPT_LOAD_CEILING_MS);

        const runId = await openStreamingTurn(page, gateway, "rich streaming turn");
        await emitDeltaBurstInPage(page, runId, RICH_TURN_CHUNK_COUNT);
        await gateway.emitChatFinal({ runId, text: "rich turn finalized" });
        await page.locator(".chat-thread-inner").getByText("rich turn finalized").waitFor();

        const cdpSession = await context.newCDPSession(page);
        // Metric collection requires the domain to be enabled first.
        await cdpSession.send("Performance.enable");
        await cdpSession.send("HeapProfiler.collectGarbage");
        await cdpSession.send("HeapProfiler.collectGarbage");
        const { metrics } = await cdpSession.send("Performance.getMetrics");
        const heapUsedBytes = metrics.find((metric) => metric.name === "JSHeapUsedSize")!.value;
        expect(heapUsedBytes).toBeLessThanOrEqual(STREAM_SESSION_HEAP_CEILING_BYTES);

        await recordBudgetMetrics("long-transcript-rich-turn", {
          loadMs,
          heapUsedBytes: Math.round(heapUsedBytes),
        });
      },
    );
  });

  it("stays quiet while idle after a settled stream", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");

        const runId = await openStreamingTurn(page, gateway, "idle quiescence probe");
        await gateway.emitChatFinal({ runId, text: "short finalized turn" });
        await page.locator(".chat-thread-inner").getByText("short finalized turn").waitFor();

        await page.evaluate(() => {
          const scope = window as ScopedWindow;
          scope.__ocIdleProbe = { longTasks: 0, longTaskMs: 0, rafCount: 0 };
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              scope.__ocIdleProbe!.longTasks += 1;
              scope.__ocIdleProbe!.longTaskMs += entry.duration;
            }
          }).observe({ entryTypes: ["longtask"] });
          const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
          window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
            originalRequestAnimationFrame((time) => {
              scope.__ocIdleProbe!.rafCount += 1;
              callback(time);
            });
        });

        await new Promise((resolve) => setTimeout(resolve, IDLE_WINDOW_MS));

        const idle = await page.evaluate(() => (window as ScopedWindow).__ocIdleProbe!);
        await recordBudgetMetrics("idle-quiescence", {
          longTasks: idle.longTasks,
          longTaskMs: Math.round(idle.longTaskMs),
          rafCount: idle.rafCount,
        });

        expect(idle.longTaskMs).toBeLessThanOrEqual(IDLE_LONGTASK_TOTAL_CEILING_MS);
        // rAF stays recorded but unasserted: the idle shell animates a
        // continuous low-cost loop (~20 requests/s measured), so only long-task
        // time discriminates runaway work from that baseline.
      },
    );
  });
});
