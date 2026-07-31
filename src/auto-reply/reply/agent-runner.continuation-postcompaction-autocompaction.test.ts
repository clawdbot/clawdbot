// C1 regression: a bracket [[CONTINUE_DELEGATE: ... | post-compaction]] staged
// on a turn where auto-compaction ALSO fires must survive to the next compaction
// seam. dispatchPostCompactionDelegates runs before staging, and the staged
// delegate must remain queued in the TaskFlow-backed post-compaction store until
// the next seam consumes it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
} from "../../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { clearMemoryPluginState } from "../../plugins/memory-state.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resetDelegateDispatchHedgesForTests } from "../continuation/delegate-dispatch.js";
import { stagedPostCompactionDelegateCount } from "../continuation/delegate-store-post-compaction.js";
import { resetContinuationStateForTests } from "../continuation/state.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { testing as replyRunRegistryTesting } from "./reply-run-registry.test-support.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const runtimeErrorMock = vi.fn();
const abortEmbeddedAgentRunMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const compactState = vi.hoisted(() => ({
  compactEmbeddedAgentSessionMock: vi.fn(),
}));
const spawnSubagentDirectMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/model-auth.js", () => ({
  isMissingProviderAuthError: () => false,
  resolveModelAuthMode: () => "api-key",
}));

vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: (params: unknown) =>
    compactState.compactEmbeddedAgentSessionMock(params),
  queueEmbeddedAgentMessage: vi.fn().mockReturnValue(false),
  runEmbeddedAgent: (params: unknown) => runEmbeddedAgentMock(params),
  abortEmbeddedAgentRun: (sessionId: string) => {
    abortEmbeddedAgentRunMock(sessionId);
    return abortEmbeddedAgentRun(sessionId);
  },
  isEmbeddedAgentRunActive: (sessionId: string) => isEmbeddedAgentRunActive(sessionId),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: vi.fn(),
}));

vi.mock("../../agents/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  SUBAGENT_SPAWN_SANDBOX_MODES: ["inherit", "require"],
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: (...args: unknown[]) => runtimeErrorMock(...args),
    exit: vi.fn(),
  },
}));

vi.mock("../../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: vi.fn(),
}));

vi.mock("./queue.js", () => ({
  enqueueFollowupRun: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
  clearSessionQueues: vi.fn().mockReturnValue({ followupCleared: 0, laneCleared: 0, keys: [] }),
  refreshQueuedFollowupSession: (...args: unknown[]) => refreshQueuedFollowupSessionMock(...args),
}));

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [],
  }),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: (provider: string | undefined | null) =>
    provider === "google" || provider === "google-gemini-cli",
}));

const loadCronStoreMock = vi.fn();
vi.mock("../../cron/store.js", () => ({
  loadCronStore: (...args: unknown[]) => loadCronStoreMock(...args),
  resolveCronStorePath: (storePath?: string) => storePath ?? "/tmp/openclaw-cron-store.json",
}));

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => ({ kind: "none" }),
    cancelSession: async () => {},
  }),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey: () => null,
  listSubagentRunsForController: () => [],
  markSubagentRunTerminated: () => 0,
}));

import { runReplyAgent } from "./agent-runner.js";

type RunWithModelFallbackParams = {
  provider: string;
  model: string;
  run: (provider: string, model: string) => Promise<unknown>;
};

beforeEach(() => {
  embeddedRunTesting.resetActiveEmbeddedRuns();
  replyRunRegistryTesting.resetReplyRunRegistry();
  resetTaskFlowRegistryForTests({ persist: false });
  runEmbeddedAgentMock.mockReset();
  runWithModelFallbackMock.mockReset();
  runtimeErrorMock.mockClear();
  abortEmbeddedAgentRunMock.mockClear();
  compactState.compactEmbeddedAgentSessionMock.mockReset();
  compactState.compactEmbeddedAgentSessionMock.mockResolvedValue({
    compacted: false,
    reason: "test-preflight-disabled",
  });
  refreshQueuedFollowupSessionMock.mockReset();
  refreshQueuedFollowupSessionMock.mockResolvedValue(undefined);
  loadCronStoreMock.mockReset();
  loadCronStoreMock.mockResolvedValue({ version: 1, jobs: [] });
  spawnSubagentDirectMock.mockReset().mockResolvedValue({
    status: "accepted",
    childSessionKey: "agent:main:subagent:spawned",
    runId: "run-spawned",
  });
  runWithModelFallbackMock.mockImplementation(
    async ({ provider, model, run }: RunWithModelFallbackParams) => ({
      result: await run(provider, model),
      provider,
      model,
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  resetDelegateDispatchHedgesForTests();
  resetContinuationStateForTests();
  resetTaskFlowRegistryForTests({ persist: false });
  clearRuntimeConfigSnapshot();
  clearMemoryPluginState();
  replyRunRegistryTesting.resetReplyRunRegistry();
  embeddedRunTesting.resetActiveEmbeddedRuns();
});

function createContinuationRun(params: { sessionKey: string; compactionCount: number }) {
  const sessionKey = params.sessionKey;
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    OriginatingTo: "channel:1",
    AccountId: "primary",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const sessionEntry = {
    sessionId: "session",
    updatedAt: Date.now(),
  } satisfies SessionEntry;
  const config = {
    agents: {
      defaults: {
        continuation: {
          enabled: true,
          minDelayMs: 0,
          maxDelayMs: 5_000,
          defaultDelayMs: 1_000,
          maxChainLength: 4,
          maxDelegatesPerTurn: 4,
        },
      },
    },
  } satisfies Record<string, unknown>;
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      sessionId: "session",
      sessionKey,
      messageProvider: "discord",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config,
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
    originatingChannel: "discord",
    originatingAccountId: "primary",
    originatingTo: "channel:1",
  } as unknown as FollowupRun;

  runEmbeddedAgentMock.mockResolvedValueOnce({
    payloads: [{ text: "Reply\n[[CONTINUE_DELEGATE: lifeboat survival task | post-compaction]]" }],
    meta: {
      agentMeta: {
        usage: { input: 1, output: 1 },
        ...(params.compactionCount > 0 ? { compactionCount: params.compactionCount } : {}),
      },
    },
  });

  return { sessionKey, sessionEntry, config, typing, sessionCtx, resolvedQueue, followupRun };
}

async function runDelegateTurn(
  run: ReturnType<typeof createContinuationRun>,
  sessionStore: Record<string, SessionEntry>,
): Promise<void> {
  setRuntimeConfigSnapshot(run.followupRun.run.config);
  await runReplyAgent({
    commandBody: "hello",
    followupRun: run.followupRun,
    queueKey: run.sessionKey,
    resolvedQueue: run.resolvedQueue,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    isStreaming: false,
    typing: run.typing,
    sessionCtx: run.sessionCtx,
    sessionEntry: run.sessionEntry,
    sessionStore,
    sessionKey: run.sessionKey,
    defaultModel: "anthropic/claude-opus-4-6",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  });
}

describe("runReplyAgent :: post-compaction delegate survives same-turn auto-compaction (C1)", () => {
  it("persists the staged delegate when auto-compaction fires the same turn", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-c1-autocompaction-" },
      async () => {
        resetTaskFlowRegistryForTests({ persist: false });
        const run = createContinuationRun({ sessionKey: "c1-autocompaction", compactionCount: 1 });
        const sessionStore: Record<string, SessionEntry> = { [run.sessionKey]: run.sessionEntry };

        await runDelegateTurn(run, sessionStore);

        expect(stagedPostCompactionDelegateCount(run.sessionKey)).toBe(1);
        expect(sessionStore[run.sessionKey]?.pendingPostCompactionDelegates ?? []).toHaveLength(0);
      },
    );
  });

  it("persists the staged delegate on the normal path with no compaction (baseline)", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-c1-baseline-" },
      async () => {
        resetTaskFlowRegistryForTests({ persist: false });
        const run = createContinuationRun({ sessionKey: "c1-baseline", compactionCount: 0 });
        const sessionStore: Record<string, SessionEntry> = { [run.sessionKey]: run.sessionEntry };

        await runDelegateTurn(run, sessionStore);

        expect(stagedPostCompactionDelegateCount(run.sessionKey)).toBe(1);
        expect(sessionStore[run.sessionKey]?.pendingPostCompactionDelegates ?? []).toHaveLength(0);
      },
    );
  });
});
