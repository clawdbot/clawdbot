// Official channel-ingress composed proof: monitor claim → reply-options bind →
// runReplyAgent production setter before memory flush. Lives beside
// ingress-monitor.test.ts so that suite stays under the test max-lines cap.
// The after-fix path must not call markIngressBoundedProcessingStarted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import type { QueueSettings } from "../../auto-reply/reply/queue.js";
import { createMockTypingController } from "../../auto-reply/reply/test-helpers.js";
import type { TemplateContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { bindIngressLifecycleToReplyOptions } from "./ingress-drain-lifecycle.js";
import {
  createChannelIngressMonitor,
  type CreateChannelIngressMonitorOptions,
} from "./ingress-monitor.js";
import { createChannelIngressQueue, type ChannelIngressQueue } from "./ingress-queue.js";

const resolveQueuedReplyExecutionConfigMock = vi.fn();
const resolveReplyToModeMock = vi.fn();
const createReplyToModeFilterForChannelMock = vi.fn();
const createReplyMediaContextMock = vi.fn();
const createReplyMediaPathNormalizerMock = vi.fn();
const runSessionCompactionIfNeededMock = vi.fn();
const runMemoryFlushIfNeededMock = vi.fn();
const executeAgentTurnMock = vi.fn();
const prepareGitCoauthorAttributionMock = vi.fn();
const resetReplyRunSessionMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();

vi.mock("../../auto-reply/reply/agent-runner-utils.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../auto-reply/reply/agent-runner-utils.js")
  >("../../auto-reply/reply/agent-runner-utils.js");
  return {
    ...actual,
    resolveQueuedReplyExecutionConfig: (...args: unknown[]) =>
      resolveQueuedReplyExecutionConfigMock(...args),
  };
});

vi.mock("../../auto-reply/reply/reply-threading.js", async () => {
  const actual = await vi.importActual<typeof import("../../auto-reply/reply/reply-threading.js")>(
    "../../auto-reply/reply/reply-threading.js",
  );
  return {
    ...actual,
    resolveReplyToMode: (...args: unknown[]) => resolveReplyToModeMock(...args),
    createReplyToModeFilterForChannel: (...args: unknown[]) =>
      createReplyToModeFilterForChannelMock(...args),
  };
});

vi.mock("../../auto-reply/reply/reply-media-paths.js", () => ({
  createReplyMediaContext: (...args: unknown[]) => {
    createReplyMediaContextMock(...args);
    return {
      normalizePayload: createReplyMediaPathNormalizerMock(...args),
    };
  },
  createReplyMediaPathNormalizer: (...args: unknown[]) =>
    createReplyMediaPathNormalizerMock(...args),
}));

vi.mock("../../auto-reply/reply/agent-runner-memory.js", () => ({
  runSessionCompactionIfNeeded: (...args: unknown[]) => runSessionCompactionIfNeededMock(...args),
  runMemoryFlushIfNeeded: (...args: unknown[]) => runMemoryFlushIfNeededMock(...args),
}));

vi.mock("../../auto-reply/reply/agent-runner-execution.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../auto-reply/reply/agent-runner-execution.js")
  >("../../auto-reply/reply/agent-runner-execution.js");
  return {
    ...actual,
    executeAgentTurn: (...args: unknown[]) => executeAgentTurnMock(...args),
  };
});

vi.mock("../../agents/git-coauthor-attribution.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/git-coauthor-attribution.js")>(
    "../../agents/git-coauthor-attribution.js",
  );
  return {
    ...actual,
    prepareGitCoauthorAttribution: (...args: unknown[]) =>
      prepareGitCoauthorAttributionMock(...args),
  };
});

vi.mock("../../auto-reply/reply/agent-runner-session-reset.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../auto-reply/reply/agent-runner-session-reset.js")
  >("../../auto-reply/reply/agent-runner-session-reset.js");
  return {
    ...actual,
    resetReplyRunSession: (...args: unknown[]) => resetReplyRunSessionMock(...args),
  };
});

vi.mock("../../auto-reply/reply/queue.js", async () => {
  const actual = await vi.importActual<typeof import("../../auto-reply/reply/queue.js")>(
    "../../auto-reply/reply/queue.js",
  );
  return {
    ...actual,
    enqueueFollowupRun: (...args: unknown[]) => enqueueFollowupRunMock(...args),
  };
});

const { runReplyAgent } = await import("../../auto-reply/reply/agent-runner.js");

type RawEvent = { id: string; lane: string; text: string };
type StoredEvent = { version: 1; rawEvent: string };
type MonitorOptions = CreateChannelIngressMonitorOptions<RawEvent, string, StoredEvent, unknown>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const freshCfg = { runtimeFresh: true };

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

beforeEach(() => {
  resolveQueuedReplyExecutionConfigMock.mockReset();
  resolveReplyToModeMock.mockReset();
  createReplyToModeFilterForChannelMock.mockReset();
  createReplyMediaContextMock.mockReset();
  createReplyMediaPathNormalizerMock.mockReset();
  runSessionCompactionIfNeededMock.mockReset();
  runMemoryFlushIfNeededMock.mockReset();
  executeAgentTurnMock.mockReset();
  prepareGitCoauthorAttributionMock.mockReset();
  resetReplyRunSessionMock.mockReset();
  enqueueFollowupRunMock.mockReset();

  resolveQueuedReplyExecutionConfigMock.mockResolvedValue(freshCfg);
  resolveReplyToModeMock.mockReturnValue("all");
  createReplyToModeFilterForChannelMock.mockReturnValue((payload: unknown) => payload);
  createReplyMediaPathNormalizerMock.mockReturnValue((payload: unknown) => payload);
  runSessionCompactionIfNeededMock.mockResolvedValue(undefined);
  runMemoryFlushIfNeededMock.mockResolvedValue({ sessionEntry: undefined, outcome: "skipped" });
  executeAgentTurnMock.mockResolvedValue({
    runId: "ingress-watchdog-handoff",
    outcome: { kind: "rejected", payload: { text: "main reply" } },
  });
  prepareGitCoauthorAttributionMock.mockReturnValue(undefined);
  resetReplyRunSessionMock.mockResolvedValue(false);
});

async function withQueue<T>(
  run: (queue: ChannelIngressQueue<StoredEvent>) => Promise<T>,
): Promise<T> {
  const stateDir = tempDirs.make("openclaw-ingress-monitor-handoff-");
  try {
    return await run(
      createChannelIngressQueue<StoredEvent>({ channelId: "test", accountId: "a", stateDir }),
    );
  } finally {
    closeOpenClawStateDatabaseForTest();
  }
}

function createMonitor(queue: MonitorOptions["queue"], deliver: MonitorOptions["deliver"]) {
  return createChannelIngressMonitor<RawEvent, string, StoredEvent>({
    queue,
    inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
    payload: {
      storage: "raw-event",
      version: 1,
      serialize: (raw) => JSON.stringify(raw),
      deserialize: (body) => JSON.parse(body) as RawEvent,
      createClaimError: (kind) => new Error(kind),
    },
    deliver,
    pollIntervalMs: 10,
    retention: { pruneIntervalMs: 60_000 },
    drain: {
      adoptionStallTimeoutMs: 5_000,
      retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
    },
  });
}

function createRunnerParams(): Parameters<typeof runReplyAgent>[0] {
  const staleCfg = { runtimeFresh: false } as OpenClawConfig;
  const followupRun = createTestFollowupRun({
    sessionId: "session-1",
    sessionKey: "agent:main:telegram:default:direct:test",
    messageProvider: "telegram",
    config: staleCfg,
    provider: "openai",
    model: "gpt-5.4",
  });
  return {
    commandBody: "hello",
    followupRun,
    queueKey: "main",
    resolvedQueue: { mode: "interrupt" } as QueueSettings,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    typing: createMockTypingController(),
    sessionCtx: {
      Provider: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "12345",
      AccountId: "default",
      ChatType: "dm",
      MessageSid: "msg-1",
    } as unknown as TemplateContext,
    defaultModel: "openai/gpt-5.4",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  };
}

describe("channel ingress monitor watchdog handoff", () => {
  it("retries when delivery never enters bounded processing and the ingress watchdog fires", async () => {
    // Supplemental: current-main class when bounded processing never starts.
    vi.useFakeTimers();
    await withQueue(async (queue) => {
      let releaseDelivery!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      let adopted = 0;
      const monitor = createMonitor(queue, async (_raw, lifecycle) => {
        await held;
        await lifecycle.onAdopted();
        adopted += 1;
      });
      try {
        monitor.start();
        await monitor.admit({ id: "event-watchdog-retry", lane: "a", text: "hello" });
        await vi.advanceTimersByTimeAsync(20);
        expect(await queue.listClaims()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          {
            id: "event-watchdog-retry",
            attempts: 1,
            lastError: expect.stringContaining("handler-timeout"),
          },
        ]);
        expect(adopted).toBe(0);
        expect(runMemoryFlushIfNeededMock).not.toHaveBeenCalled();
      } finally {
        releaseDelivery();
        await monitor.stop();
        vi.useRealTimers();
      }
    });
  });

  it("retains one claim through runner memory flush longer than the ingress watchdog", async () => {
    vi.useFakeTimers();
    await withQueue(async (queue) => {
      let releaseFlush!: () => void;
      const flushHeld = new Promise<void>((resolve) => {
        releaseFlush = resolve;
      });
      runMemoryFlushIfNeededMock.mockImplementationOnce(async () => {
        await flushHeld;
        return { sessionEntry: undefined, outcome: "skipped" };
      });
      const monitor = createMonitor(queue, async (_raw, lifecycle) => {
        const replyParams = createRunnerParams();
        replyParams.opts = bindIngressLifecycleToReplyOptions(lifecycle);
        await runReplyAgent(replyParams);
      });
      try {
        monitor.start();
        await monitor.admit({ id: "event-processing-hold", lane: "a", text: "hello" });
        await vi.waitFor(() => {
          expect(runMemoryFlushIfNeededMock).toHaveBeenCalledTimes(1);
        });
        await vi.advanceTimersByTimeAsync(15_000);
        expect(await queue.listClaims()).toHaveLength(1);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        expect(executeAgentTurnMock).not.toHaveBeenCalled();

        releaseFlush();
        await vi.advanceTimersByTimeAsync(0);
        await monitor.waitForIdle();
        expect(executeAgentTurnMock).toHaveBeenCalledTimes(1);
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        await expect(
          queue.enqueue("event-processing-hold", { version: 1, rawEvent: "duplicate" }),
        ).resolves.toMatchObject({ kind: "completed" });
      } finally {
        await monitor.stop();
        vi.useRealTimers();
      }
    });
  });
});
