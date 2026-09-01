import { appendFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
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
// Valid frame-queued runs commit 115-144 host updates for this burst. A direct
// update per delta produces 241, so this ceiling catches lost coalescing while
// retaining headroom for runner cadence.
const MAX_BURST_HOST_UPDATES = 180;
// Minimum share of host invalidations that must execute inside an animation
// frame callback. The queue guarantees this for every stream-driven update;
// only rare timer-driven strays (poll controllers) fall outside frames.
const FRAME_SCHEDULED_MIN_RATIO = 0.9;

// Shipped live-tool ceiling: ui/src/pages/chat/tool-stream.ts TOOL_STREAM_LIMIT.
const TOOL_STREAM_LIMIT_CONTRACT = 50;
// Realistic agent cadence: narration deltas separate complete tool lifecycles.
// Calls stay above the shipped limit to prove eviction under sustained load.
const TOOL_FLOOD_PAIR_COUNT = 60;
// The lifecycle spans the 80ms projection throttle so start/update/input_delta
// exercise its deferred flush before result forces the final projection.
const TOOL_FLOOD_PHASE_INTERVAL_MS = 30;
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
const IDLE_TASK_DURATION_CEILING_MS = 600;

type StreamPerfProbe = {
  mutationBatches: number;
  rafCount: number;
  hostUpdates: number;
  hostUpdatesInsideFrame: number;
};

type ToolProjectionProbe = {
  beforeThrottleCardCount: number | null;
  afterThrottleCardCount: number | null;
  afterThrottleText: string | null;
  ready: boolean;
};

type ScopedWindow = Window & {
  ocStreamPerf?: StreamPerfProbe;
  ocIdleProbe?: { longTasks: number; longTaskMs: number };
  ocBurstDone?: boolean;
  ocToolProjectionProbe?: ToolProjectionProbe;
  openclawControlUiE2eGateway?: {
    emit: (event: string, payload?: unknown) => void;
  };
};

let metricsArtifactDir: string;
beforeEach(() => {
  metricsArtifactDir = createControlUiE2eArtifactDir("stream-runtime-budgets");
});

async function recordBudgetMetrics(
  testName: string,
  metrics: Record<string, number>,
): Promise<void> {
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
    scope.ocStreamPerf = {
      mutationBatches: 0,
      rafCount: 0,
      hostUpdates: 0,
      hostUpdatesInsideFrame: 0,
    };
    new MutationObserver((records) => {
      if (records.length > 0) {
        scope.ocStreamPerf!.mutationBatches += 1;
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    let insideFrame = false;
    const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
      originalRequestAnimationFrame((time) => {
        scope.ocStreamPerf!.rafCount += 1;
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
      const probe = scope.ocStreamPerf!;
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
    scope.ocStreamPerf = {
      mutationBatches: 0,
      rafCount: 0,
      hostUpdates: 0,
      hostUpdatesInsideFrame: 0,
    };
  });
}

async function readRenderProbe(page: ChatFlowPage): Promise<StreamPerfProbe> {
  return page.evaluate(() => (window as ScopedWindow).ocStreamPerf!);
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
    ({ runId: targetRunId, count: targetCount }) => {
      const gateway = (window as ScopedWindow).openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("mock gateway handle missing");
      }
      const scope = window as ScopedWindow;
      scope.ocBurstDone = false;
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
          runId: targetRunId,
          sessionKey: "main",
          state: "delta",
        });
        if (emitted < targetCount) {
          setTimeout(emitNext, 0);
        } else {
          scope.ocBurstDone = true;
        }
      };
      setTimeout(emitNext, 0);
    },
    { runId, count },
  );
  await page.waitForFunction(() => (window as ScopedWindow).ocBurstDone === true, undefined, {
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

async function probeDeferredToolProjection(page: ChatFlowPage, runId: string): Promise<void> {
  await page.evaluate(
    ({ runId: targetRunId, seqSeed }) => {
      const scope = window as ScopedWindow;
      const gateway = scope.openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("mock gateway handle missing");
      }
      const probe: ToolProjectionProbe = {
        beforeThrottleCardCount: null,
        afterThrottleCardCount: null,
        afterThrottleText: null,
        ready: false,
      };
      scope.ocToolProjectionProbe = probe;
      let seq = seqSeed;
      const emitToolPhase = (phase: string, data: Record<string, unknown>) => {
        gateway.emit("agent", {
          data: { name: "edit", phase, toolCallId: "call-1", ...data },
          runId: targetRunId,
          seq: ++seq,
          sessionKey: "main",
          stream: "tool",
          ts: Date.now(),
        });
      };
      const cardSelector = '[data-message-id^="tool:assistant:call-1:"]';
      gateway.emit("chat", {
        deltaText: " working on step 1",
        message: {
          content: [{ text: " working on step 1", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId: targetRunId,
        sessionKey: "main",
        state: "delta",
      });
      emitToolPhase("start", { args: { path: "src/file-1.ts" } });
      setTimeout(() => emitToolPhase("update", { partialResult: "partial output 1" }), 10);
      setTimeout(() => emitToolPhase("input_delta", { diff: { added: 1, removed: 1 } }), 20);
      // Sample before the 80ms owner timer. An eager non-terminal projection
      // makes the card visible here and fails the absence contract.
      setTimeout(() => {
        probe.beforeThrottleCardCount = document.querySelectorAll(cardSelector).length;
      }, 50);
      // Leave result un-emitted. After the owner timer and two render frames,
      // the running card must expose the latest update/input_delta projection.
      setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const cards = document.querySelectorAll(cardSelector);
            probe.afterThrottleCardCount = cards.length;
            probe.afterThrottleText = cards[0]?.textContent ?? null;
            probe.ready = true;
          });
        });
      }, 120);
    },
    { runId, seqSeed: TOOL_FLOOD_SEQ_SEED },
  );
  await page.waitForFunction(
    () => (window as ScopedWindow).ocToolProjectionProbe?.ready === true,
    undefined,
    { timeout: 10_000, polling: 20 },
  );
}

async function completeFirstToolLifecycle(page: ChatFlowPage, runId: string): Promise<void> {
  await page.evaluate(
    ({ runId: targetRunId, seq }) => {
      const gateway = (window as ScopedWindow).openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("mock gateway handle missing");
      }
      gateway.emit("agent", {
        data: {
          name: "edit",
          phase: "result",
          result: "tool output 1",
          toolCallId: "call-1",
        },
        runId: targetRunId,
        seq,
        sessionKey: "main",
        stream: "tool",
        ts: Date.now(),
      });
    },
    { runId, seq: TOOL_FLOOD_SEQ_SEED + 4 },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function emitRemainingToolLifecycleFlood(
  page: ChatFlowPage,
  runId: string,
  pairCount: number,
): Promise<void> {
  // Gateway frames arrive as separate socket messages. Space each lifecycle
  // phase across timer ticks so the live stream exercises deferred projection,
  // not only the result path's forced flush.
  await page.evaluate(
    ({ runId: targetRunId, pairCount: targetPairCount, phaseIntervalMs, seqSeed }) => {
      const scope = window as ScopedWindow;
      const gateway = scope.openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("mock gateway handle missing");
      }
      scope.ocBurstDone = false;
      let emitted = 1;
      let seq = seqSeed + 4;
      const emitToolPhase = (phase: string, data: Record<string, unknown>) => {
        gateway.emit("agent", {
          data: {
            name: "edit",
            phase,
            toolCallId: `call-${emitted}`,
            ...data,
          },
          runId: targetRunId,
          seq: ++seq,
          sessionKey: "main",
          stream: "tool",
          ts: Date.now(),
        });
      };
      const emitCall = () => {
        emitted += 1;
        const chunk = ` working on step ${emitted}`;
        gateway.emit("chat", {
          deltaText: chunk,
          message: {
            content: [{ text: chunk, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
          runId: targetRunId,
          sessionKey: "main",
          state: "delta",
        });
        emitToolPhase("start", { args: { path: `src/file-${emitted}.ts` } });
        setTimeout(() => {
          emitToolPhase("update", { partialResult: `partial output ${emitted}` });
          setTimeout(() => {
            emitToolPhase("input_delta", { diff: { added: emitted, removed: 1 } });
            setTimeout(() => {
              emitToolPhase("result", { result: `tool output ${emitted}` });
              if (emitted < targetPairCount) {
                setTimeout(emitCall, phaseIntervalMs);
              } else {
                scope.ocBurstDone = true;
              }
            }, phaseIntervalMs);
          }, phaseIntervalMs);
        }, phaseIntervalMs);
      };
      setTimeout(emitCall, phaseIntervalMs);
    },
    {
      runId,
      pairCount,
      phaseIntervalMs: TOOL_FLOOD_PHASE_INTERVAL_MS,
      seqSeed: TOOL_FLOOD_SEQ_SEED,
    },
  );
  await page.waitForFunction(() => (window as ScopedWindow).ocBurstDone === true, undefined, {
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
            await new Promise((resolve) => {
              setTimeout(resolve, 200);
            });
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
        expect(probe.hostUpdates).toBeLessThanOrEqual(MAX_BURST_HOST_UPDATES);
        expect(probe.hostUpdatesInsideFrame / probe.hostUpdates).toBeGreaterThanOrEqual(
          FRAME_SCHEDULED_MIN_RATIO,
        );
      },
    );
  });

  it("keeps the live tool stream bounded under complete tool lifecycles", async () => {
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

        await probeDeferredToolProjection(page, runId);
        const projection = await page.evaluate(
          () => (window as ScopedWindow).ocToolProjectionProbe!,
        );
        expect(projection.beforeThrottleCardCount).toBe(0);
        expect(projection.afterThrottleCardCount).toBe(1);
        expect(projection.afterThrottleText).toContain("Editing");
        expect(projection.afterThrottleText).toContain("+1");
        expect(projection.afterThrottleText).toContain("-1");

        await completeFirstToolLifecycle(page, runId);
        const firstCard = page.locator('[data-message-id^="tool:assistant:call-1:"]');
        expect(await firstCard.count()).toBe(1);
        expect(await firstCard.textContent()).toContain("Edited");

        await emitRemainingToolLifecycleFlood(page, runId, TOOL_FLOOD_PAIR_COUNT);
        const floodCards = page.locator('[data-message-id^="tool:assistant:call-"]');
        // Eviction drops the oldest entries and keeps the freshest ones.
        await expect
          .poll(() => floodCards.count(), { timeout: 15_000 })
          .toBe(TOOL_STREAM_LIMIT_CONTRACT);
        const firstRetainedCall = TOOL_FLOOD_PAIR_COUNT - TOOL_STREAM_LIMIT_CONTRACT + 1;
        expect(await page.locator('[data-message-id^="tool:assistant:call-1:"]').count()).toBe(0);
        expect(
          await page
            .locator(`[data-message-id^="tool:assistant:call-${firstRetainedCall}:"]`)
            .count(),
        ).toBe(1);
        expect(
          await page
            .locator(`[data-message-id^="tool:assistant:call-${TOOL_FLOOD_PAIR_COUNT}:"]`)
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
      async ({ page, context }) => {
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");

        const runId = await openStreamingTurn(page, gateway, "idle quiescence probe");
        await gateway.emitChatFinal({ runId, text: "short finalized turn" });
        await page.locator(".chat-thread-inner").getByText("short finalized turn").waitFor();

        const cdpSession = await context.newCDPSession(page);
        await cdpSession.send("Performance.enable");
        const beforeMetrics = await cdpSession.send("Performance.getMetrics");
        const taskDurationBefore = beforeMetrics.metrics.find(
          (metric) => metric.name === "TaskDuration",
        )!.value;
        await page.evaluate(() => {
          const scope = window as ScopedWindow;
          scope.ocIdleProbe = { longTasks: 0, longTaskMs: 0 };
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              scope.ocIdleProbe!.longTasks += 1;
              scope.ocIdleProbe!.longTaskMs += entry.duration;
            }
          }).observe({ entryTypes: ["longtask"] });
        });

        await new Promise((resolve) => {
          setTimeout(resolve, IDLE_WINDOW_MS);
        });

        const afterMetrics = await cdpSession.send("Performance.getMetrics");
        const taskDurationAfter = afterMetrics.metrics.find(
          (metric) => metric.name === "TaskDuration",
        )!.value;
        const taskDurationMs = (taskDurationAfter - taskDurationBefore) * 1_000;
        const idle = await page.evaluate(() => (window as ScopedWindow).ocIdleProbe!);
        await recordBudgetMetrics("idle-quiescence", {
          longTasks: idle.longTasks,
          longTaskMs: Math.round(idle.longTaskMs),
          taskDurationMs: Math.round(taskDurationMs),
        });

        expect(idle.longTaskMs).toBeLessThanOrEqual(IDLE_LONGTASK_TOTAL_CEILING_MS);
        expect(taskDurationMs).toBeLessThanOrEqual(IDLE_TASK_DURATION_CEILING_MS);
      },
    );
  });
});
