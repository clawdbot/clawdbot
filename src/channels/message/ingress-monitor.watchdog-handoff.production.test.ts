// Production-boundary proof: Discord-style ingress + real runSessionCompactionIfNeeded.
// compactEmbeddedAgentSession is the engine, not the preflight owner.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createTestFollowupRun,
  withTestModelContextTokens,
  writeTestSessionStore,
} from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import type { QueueSettings } from "../../auto-reply/reply/queue.js";
import { createMockTypingController } from "../../auto-reply/reply/test-helpers.js";
import type { TemplateContext } from "../../auto-reply/templating.js";
import type { SessionEntry } from "../../config/sessions.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { bindIngressLifecycleToReplyOptions } from "./ingress-drain-lifecycle.js";
import { DEFAULT_INGRESS_ADOPTION_STALL_MS } from "./ingress-drain.js";
import {
  createChannelIngressMonitor,
  type CreateChannelIngressMonitorOptions,
} from "./ingress-monitor.js";
import { createChannelIngressQueue, type ChannelIngressQueue } from "./ingress-queue.js";

const compactEmbeddedAgentSessionMock = vi.fn();
const resolveQueuedReplyExecutionConfigMock = vi.fn();
const resolveReplyToModeMock = vi.fn();
const createReplyToModeFilterForChannelMock = vi.fn();
const createReplyMediaContextMock = vi.fn();
const createReplyMediaPathNormalizerMock = vi.fn();
const executeAgentTurnMock = vi.fn();
const prepareGitCoauthorAttributionMock = vi.fn();
const resetReplyRunSessionMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();

vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: (...args: unknown[]) => compactEmbeddedAgentSessionMock(...args),
  runEmbeddedAgent: vi.fn(),
}));

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
const sessionKey = "agent:main:discord:default:direct:proof";

function productionCfg(): OpenClawConfig {
  return withTestModelContextTokens({
    cfg: {
      agents: { defaults: { compaction: { maxActiveTranscriptBytes: "10b" } } },
    } as OpenClawConfig,
    followupRun: createTestFollowupRun({
      provider: "openai",
      model: "gpt-5.4",
    }),
    defaultModel: "openai/gpt-5.4",
    contextTokens: 100_000,
  });
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

beforeEach(() => {
  compactEmbeddedAgentSessionMock.mockReset();
  resolveQueuedReplyExecutionConfigMock.mockReset();
  resolveReplyToModeMock.mockReset();
  createReplyToModeFilterForChannelMock.mockReset();
  createReplyMediaContextMock.mockReset();
  createReplyMediaPathNormalizerMock.mockReset();
  executeAgentTurnMock.mockReset();
  prepareGitCoauthorAttributionMock.mockReset();
  resetReplyRunSessionMock.mockReset();
  enqueueFollowupRunMock.mockReset();

  resolveQueuedReplyExecutionConfigMock.mockResolvedValue(productionCfg());
  resolveReplyToModeMock.mockReturnValue("all");
  createReplyToModeFilterForChannelMock.mockReturnValue((payload: unknown) => payload);
  createReplyMediaPathNormalizerMock.mockReturnValue((payload: unknown) => payload);
  executeAgentTurnMock.mockResolvedValue({
    runId: "ingress-watchdog-production",
    outcome: { kind: "rejected", payload: { text: "main reply" } },
  });
  prepareGitCoauthorAttributionMock.mockReturnValue(undefined);
  resetReplyRunSessionMock.mockResolvedValue(false);
});

async function withQueue<T>(
  run: (queue: ChannelIngressQueue<StoredEvent>) => Promise<T>,
): Promise<T> {
  const stateDir = tempDirs.make("openclaw-ingress-monitor-production-");
  try {
    return await run(
      createChannelIngressQueue<StoredEvent>({
        channelId: "discord",
        accountId: "default",
        stateDir,
      }),
    );
  } finally {
    closeOpenClawStateDatabaseForTest();
  }
}

function createMonitor(
  queue: MonitorOptions["queue"],
  deliver: MonitorOptions["deliver"],
  onLog: (message: string) => void,
) {
  return createChannelIngressMonitor<RawEvent, string, StoredEvent>({
    queue,
    inspect: (raw) => ({ eventId: raw.id, laneKey: `channel:${raw.lane}` }),
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
      adoptionStallTimeoutMs: DEFAULT_INGRESS_ADOPTION_STALL_MS,
      retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
      onLog,
    },
  });
}

async function createOversizedReplyParams(): Promise<Parameters<typeof runReplyAgent>[0]> {
  const storePath = `${tempDirs.make("openclaw-ingress-handoff-session-")}/sessions.json`;
  const sessionEntry: SessionEntry = {
    sessionId: "session-1",
    updatedAt: Date.now(),
    totalTokens: 80_000,
    totalTokensFresh: true,
    totalTokensVersion: 1,
    compactionCount: 0,
  };
  await writeTestSessionStore(storePath, sessionKey, sessionEntry);
  await appendTranscriptMessage(
    { agentId: "main", sessionId: sessionEntry.sessionId, sessionKey, storePath },
    { message: { role: "user", content: "x".repeat(256) } },
  );
  const followupRun = createTestFollowupRun({
    sessionId: "session-1",
    sessionKey,
    messageProvider: "discord",
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
      Provider: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel-1",
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
    sessionKey,
    storePath,
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
  };
}

describe("channel ingress production-boundary watchdog handoff", () => {
  it("adopts once when production preflight compaction outlives the ingress watchdog", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    await withQueue(async (queue) => {
      let releaseCompaction!: () => void;
      const compactionHeld = new Promise<void>((resolve) => {
        releaseCompaction = resolve;
      });
      compactEmbeddedAgentSessionMock.mockImplementationOnce(async () => {
        await compactionHeld;
        return {
          ok: true,
          compacted: true,
          result: { tokensAfter: 12, sessionId: "session-1" },
        };
      });
      const monitor = createMonitor(
        queue,
        async (_raw, lifecycle) => {
          const replyParams = await createOversizedReplyParams();
          replyParams.opts = bindIngressLifecycleToReplyOptions(lifecycle);
          await runReplyAgent(replyParams);
        },
        (message) => logs.push(message),
      );
      try {
        monitor.start();
        await monitor.admit({ id: "evt-preflight-hold", lane: "channel-1", text: "hello" });
        await vi.waitFor(() => {
          expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
        });
        await vi.advanceTimersByTimeAsync(DEFAULT_INGRESS_ADOPTION_STALL_MS + 10_000);
        expect(logs.join("\n")).not.toContain("handler-timeout");
        expect(await queue.listClaims()).toHaveLength(1);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        expect(executeAgentTurnMock).not.toHaveBeenCalled();

        releaseCompaction();
        await vi.advanceTimersByTimeAsync(0);
        await monitor.waitForIdle();
        expect(executeAgentTurnMock).toHaveBeenCalledTimes(1);
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        await expect(
          queue.enqueue("evt-preflight-hold", { version: 1, rawEvent: "duplicate" }),
        ).resolves.toMatchObject({ kind: "completed" });
      } finally {
        await monitor.stop();
        vi.useRealTimers();
      }
    });
  });

  it("retries when production preflight compaction fails before adoption", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    await withQueue(async (queue) => {
      compactEmbeddedAgentSessionMock.mockRejectedValueOnce(new Error("compaction engine crashed"));
      const monitor = createMonitor(
        queue,
        async (_raw, lifecycle) => {
          const replyParams = await createOversizedReplyParams();
          replyParams.opts = bindIngressLifecycleToReplyOptions(lifecycle);
          await runReplyAgent(replyParams);
        },
        (message) => logs.push(message),
      );
      try {
        monitor.start();
        await monitor.admit({ id: "evt-preflight-fail", lane: "channel-1", text: "hello" });
        await monitor.waitForIdle();
        expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
        expect(executeAgentTurnMock).not.toHaveBeenCalled();
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          {
            id: "evt-preflight-fail",
            attempts: 1,
            lastError: expect.stringContaining("compaction engine crashed"),
          },
        ]);
        expect(logs.join("\n")).toMatch(/keeping for retry/);
      } finally {
        await monitor.stop();
        vi.useRealTimers();
      }
    });
  });
});
