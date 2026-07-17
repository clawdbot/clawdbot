// The agent-runner `finally` must NOT
// consume/claim queued delegates. `consumePendingDelegates` is a TaskFlow claim
// (queued -> running), not a delete, so calling it in cleanup and discarding the
// rows would strand a delegate matured/queued during a failed turn. The finally
// now only re-stages the in-memory preserve list; the shim `consumePendingDelegates`
// (whose only caller was this finally) must never be invoked here, and the
// dispatch-idle safety-net still fires.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
} from "../../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { clearMemoryPluginState } from "../../plugins/memory-state.js";
import { resetDelegateDispatchHedgesForTests } from "../continuation/delegate-dispatch.js";
import { resetContinuationStateForTests } from "../continuation/state.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { testing as replyRunRegistryTesting } from "./reply-run-registry.test-support.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const consumePendingDelegatesMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
  isFallbackSummaryError: () => false,
}));

vi.mock("../../agents/model-auth.js", () => ({
  isMissingProviderAuthError: () => false,
  resolveModelAuthMode: () => "api-key",
}));

vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: vi.fn().mockResolvedValue({ compacted: false }),
  queueEmbeddedAgentMessage: vi.fn().mockReturnValue(false),
  runEmbeddedAgent: (params: unknown) => runEmbeddedAgentMock(params),
  abortEmbeddedAgentRun: (sessionId: string) => abortEmbeddedAgentRun(sessionId),
  isEmbeddedAgentRunActive: (sessionId: string) => isEmbeddedAgentRunActive(sessionId),
}));

vi.mock("../../agents/cli-runner.js", () => ({ runCliAgent: vi.fn() }));

vi.mock("../../agents/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  SUBAGENT_SPAWN_SANDBOX_MODES: ["inherit", "require"],
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  spawnSubagentDirect: vi.fn().mockResolvedValue({ status: "accepted", childSessionKey: "c" }),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));

vi.mock("../../infra/heartbeat-wake.js", () => ({ requestHeartbeatNow: vi.fn() }));

vi.mock("./queue.js", () => ({
  enqueueFollowupRun: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
  clearSessionQueues: vi.fn().mockReturnValue({ followupCleared: 0, laneCleared: 0, keys: [] }),
  refreshQueuedFollowupSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [],
  }),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: () => false,
}));

vi.mock("../../cron/store.js", () => ({
  loadCronStore: vi.fn().mockResolvedValue({ version: 1, jobs: [] }),
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

vi.mock("../continuation/delegate-store.js", async (importOriginal) => {
  const original = await importOriginal<
    Record<string, unknown> & {
      consumePendingDelegates: (...args: unknown[]) => unknown;
    }
  >();
  return {
    ...original,
    consumePendingDelegates: (...args: unknown[]) => {
      consumePendingDelegatesMock(...args);
      return original.consumePendingDelegates(...args);
    },
  };
});

import { runReplyAgent } from "./agent-runner.js";

beforeEach(() => {
  embeddedRunTesting.resetActiveEmbeddedRuns();
  replyRunRegistryTesting.resetReplyRunRegistry();
  runEmbeddedAgentMock.mockReset();
  runWithModelFallbackMock.mockReset();
  consumePendingDelegatesMock.mockReset();
  runWithModelFallbackMock.mockImplementation(
    async ({
      provider,
      model,
      run,
    }: {
      provider: string;
      model: string;
      run: (p: string, m: string) => Promise<unknown>;
    }) => ({
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
  clearRuntimeConfigSnapshot();
  clearMemoryPluginState();
  replyRunRegistryTesting.resetReplyRunRegistry();
  embeddedRunTesting.resetActiveEmbeddedRuns();
});

function createRun(sessionKey: string) {
  const typing = createMockTypingController();
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
  const sessionCtx = {
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    OriginatingTo: "channel:1",
    AccountId: "primary",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  return { typing, followupRun, sessionCtx, config };
}

describe("runReplyAgent :: finally does not claim queued delegates (I4)", () => {
  it("does not consume/claim queued delegates in the finally, and still marks dispatch idle", async () => {
    const sessionKey = "i4-finally-drain";
    const { typing, followupRun, sessionCtx, config } = createRun(sessionKey);
    setRuntimeConfigSnapshot(config);
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });

    const sessionEntry = { sessionId: "session", updatedAt: Date.now() } satisfies SessionEntry;

    await expect(
      runReplyAgent({
        commandBody: "hello",
        followupRun,
        queueKey: sessionKey,
        resolvedQueue: { mode: "interrupt" } as unknown as QueueSettings,
        shouldSteer: false,
        shouldFollowup: false,
        isActive: false,
        isStreaming: false,
        typing,
        sessionCtx,
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
        defaultModel: "anthropic/claude-opus-4-6",
        resolvedVerboseLevel: "off",
        isNewSession: false,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: "instant",
      }),
    ).resolves.not.toThrow();

    // Normal post-turn dispatch claims once. A second call would be the
    // forbidden finally cleanup claim that strands rows in `running`.
    expect(consumePendingDelegatesMock).toHaveBeenCalledTimes(1);
    // The dispatch-idle safety-net still fires.
    expect(typing.markDispatchIdle).toHaveBeenCalled();
  });
});
