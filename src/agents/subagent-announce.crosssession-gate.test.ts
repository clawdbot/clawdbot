import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupRun, QueueSettings } from "../auto-reply/reply/queue.js";
import { testing as replyRunRegistryTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
import { createMockTypingController } from "../auto-reply/reply/test-helpers.js";
import type { TemplateContext } from "../auto-reply/templating.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  resetContinuationTracer,
  setContinuationTracer,
  type Span,
  type SpanAttributes,
  type SpanStatus,
  type StartSpanOptions,
  type Tracer,
} from "../infra/continuation-tracer.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import { abortEmbeddedAgentRun, isEmbeddedAgentRunActive } from "./embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "./embedded-agent-runner/runs.test-support.js";

const runEmbeddedAgentMock = vi.fn();
const runCliAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const runtimeErrorMock = vi.fn();
const abortEmbeddedAgentRunMock = vi.fn();
const clearSessionQueuesMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const compactState = vi.hoisted(() => ({
  compactEmbeddedAgentSessionMock: vi.fn(),
}));
const requestHeartbeatNowMock = vi.hoisted(() => vi.fn());
const spawnSubagentDirectMock = vi.hoisted(() => vi.fn());

vi.mock("./model-fallback-runner.js", () => ({
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
}));

vi.mock("./model-fallback-attempt.js", () => ({
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("./model-auth.js", () => ({
  isMissingProviderAuthError: () => false,
  resolveModelAuthMode: () => "api-key",
}));

vi.mock("./embedded-agent.js", () => ({
  runEmbeddedAgent: (params: unknown) => runEmbeddedAgentMock(params),
  compactEmbeddedAgentSession: (params: unknown) =>
    compactState.compactEmbeddedAgentSessionMock(params),
  queueEmbeddedAgentMessage: vi.fn().mockReturnValue(false),
  abortEmbeddedAgentRun: (sessionId: string) => {
    abortEmbeddedAgentRunMock(sessionId);
    return abortEmbeddedAgentRun(sessionId);
  },
  isEmbeddedAgentRunActive: (sessionId: string) => isEmbeddedAgentRunActive(sessionId),
}));

vi.mock("./cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => runCliAgentMock(...args),
}));

vi.mock("./subagents/spawn/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  SUBAGENT_SPAWN_SANDBOX_MODES: ["inherit", "require"],
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: (...args: unknown[]) => runtimeErrorMock(...args),
    exit: vi.fn(),
  },
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  markTrustedContinuationHeartbeatWake: <T>(request: T) => request,
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

vi.mock("../auto-reply/reply/queue.js", () => ({
  enqueueFollowupRun: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
  clearSessionQueues: (...args: unknown[]) => clearSessionQueuesMock(...args),
  refreshQueuedFollowupSession: (...args: unknown[]) => refreshQueuedFollowupSessionMock(...args),
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [],
  }),
}));

vi.mock("../utils/provider-utils.js", () => ({
  isReasoningTagProvider: (provider: string | undefined | null) =>
    provider === "google" || provider === "google-gemini-cli",
}));

const loadCronStoreMock = vi.fn();
vi.mock("../cron/store.js", () => ({
  loadCronStore: (...args: unknown[]) => loadCronStoreMock(...args),
  resolveCronStorePath: (storePath?: string) => storePath ?? "/tmp/openclaw-cron-store.json",
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => ({ kind: "none" }),
    cancelSession: async () => {},
  }),
}));

vi.mock("./subagents/registry/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey: () => null,
  getSwarmRunByLaunchReplayKey: () => undefined,
  initSubagentRegistry: () => {},
  listSubagentRunsForController: () => [],
  markSubagentRunTerminated: () => 0,
}));

import { runReplyAgent } from "../auto-reply/reply/agent-runner.js";

type RunWithModelFallbackParams = {
  provider: string;
  model: string;
  run: (provider: string, model: string) => Promise<unknown>;
};

type RecordedSpan = {
  name: string;
  attributes: SpanAttributes;
  status: SpanStatus | undefined;
  ended: boolean;
};

function createRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer = {
    startSpan(name: string, opts?: StartSpanOptions): Span {
      const rec: RecordedSpan = {
        name,
        attributes: { ...opts?.attributes },
        status: undefined,
        ended: false,
      };
      spans.push(rec);
      return {
        setAttributes(attrs: SpanAttributes): void {
          Object.assign(rec.attributes, attrs);
        },
        setStatus(status: SpanStatus): void {
          rec.status = status;
        },
        recordException(_err: unknown): void {},
        end(): void {
          rec.ended = true;
        },
      };
    },
  };
  return { tracer, spans };
}

function continuationConfig(crossSessionTargeting: "disabled" | "enabled"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        continuation: {
          enabled: true,
          minDelayMs: 0,
          maxDelayMs: 5_000,
          defaultDelayMs: 1_000,
          maxChainLength: 4,
          maxDelegatesPerTurn: 4,
          crossSessionTargeting,
        },
      },
    },
  };
}

function createContinuationRun(params: {
  sessionKey: string;
  crossSessionTargeting: "disabled" | "enabled";
}) {
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "discord",
    OriginatingTo: "channel:1",
    AccountId: "primary",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const sessionEntry = {
    sessionId: "session",
    updatedAt: Date.now(),
  } satisfies SessionEntry;
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey: params.sessionKey,
      messageProvider: "discord",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: continuationConfig(params.crossSessionTargeting),
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;

  return {
    sessionKey: params.sessionKey,
    sessionEntry,
    typing,
    sessionCtx,
    resolvedQueue,
    followupRun,
  };
}

async function runDelegateTurn(run: ReturnType<typeof createContinuationRun>): Promise<unknown> {
  setRuntimeConfigSnapshot(run.followupRun.run.config);
  return runReplyAgent({
    commandBody: "hello",
    followupRun: run.followupRun,
    queueKey: run.sessionKey,
    resolvedQueue: run.resolvedQueue,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    typing: run.typing,
    sessionCtx: run.sessionCtx,
    sessionEntry: run.sessionEntry,
    sessionStore: { [run.sessionKey]: run.sessionEntry },
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

beforeEach(() => {
  embeddedRunTesting.resetActiveEmbeddedRuns();
  replyRunRegistryTesting.resetReplyRunRegistry();
  runEmbeddedAgentMock.mockReset();
  runCliAgentMock.mockReset();
  runtimeErrorMock.mockReset();
  abortEmbeddedAgentRunMock.mockReset();
  compactState.compactEmbeddedAgentSessionMock.mockReset().mockResolvedValue({
    compacted: false,
    reason: "test-preflight-disabled",
  });
  clearSessionQueuesMock
    .mockReset()
    .mockReturnValue({ followupCleared: 0, laneCleared: 0, keys: [] });
  refreshQueuedFollowupSessionMock.mockReset().mockResolvedValue(undefined);
  loadCronStoreMock.mockReset().mockResolvedValue({ version: 1, jobs: [] });
  requestHeartbeatNowMock.mockReset();
  spawnSubagentDirectMock.mockReset().mockResolvedValue({
    status: "accepted",
    childSessionKey: "agent:main:subagent:spawned",
    runId: "run-spawned",
  });
  runWithModelFallbackMock
    .mockReset()
    .mockImplementation(async ({ provider, model, run }: RunWithModelFallbackParams) => ({
      result: await run(provider, model),
      provider,
      model,
    }));
  resetSystemEventsForTest();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetContinuationTracer();
  resetSystemEventsForTest();
  replyRunRegistryTesting.resetReplyRunRegistry();
  embeddedRunTesting.resetActiveEmbeddedRuns();
});

describe("continuation cross-session targeting bracket gate", () => {
  it("case 7: disabled rejects bracket target syntax with a disabled span and system event", async () => {
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);
    const run = createContinuationRun({
      sessionKey: "agent:main:dispatcher-bracket-target",
      crossSessionTargeting: "disabled",
    });
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [
        {
          text: "Reply\n[[CONTINUE_DELEGATE: inspect sibling | target=agent:main:other]]",
        },
      ],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });

    await runDelegateTurn(run);

    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(peekSystemEventEntries(run.sessionKey).map((event) => event.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("cross-session targeting is disabled by policy"),
      ]),
    );
    expect(spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "continuation.disabled",
          attributes: expect.objectContaining({
            "disabled.reason": "policy.cross_session_targeting",
            "signal.kind": "bracket-delegate",
            "delegate.delivery": "immediate",
            "continuation.disabled": true,
          }),
        }),
      ]),
    );
  });

  it("case 10: enabled allows bracket fanout=all", async () => {
    const run = createContinuationRun({
      sessionKey: "agent:main:enabled-bracket-fanout",
      crossSessionTargeting: "enabled",
    });
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Reply\n[[CONTINUE_DELEGATE: inspect host state | fanout=all]]" }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });

    await runDelegateTurn(run);

    expect(spawnSubagentDirectMock.mock.calls[0]?.[0]).toMatchObject({
      continuationFanoutMode: "all",
    });
  });

  it("case 11: enabled preserves no-target delegate dispatch behavior", async () => {
    const run = createContinuationRun({
      sessionKey: "agent:main:enabled-bracket-default",
      crossSessionTargeting: "enabled",
    });
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Reply\n[[CONTINUE_DELEGATE: continue default route]]" }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });

    await runDelegateTurn(run);

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(spawnSubagentDirectMock.mock.calls[0]?.[0]).toMatchObject({
      task: expect.stringContaining("continue default route"),
      drainsContinuationDelegateQueue: true,
    });
    expect(spawnSubagentDirectMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "continuationTargetSessionKey",
    );
    expect(spawnSubagentDirectMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "continuationTargetSessionKeys",
    );
    expect(spawnSubagentDirectMock.mock.calls[0]?.[0]).not.toHaveProperty("continuationFanoutMode");
  });

  it("case 15: disabled rejects bracket fanout=all with a disabled span and system event", async () => {
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);
    const run = createContinuationRun({
      sessionKey: "agent:main:disabled-bracket-fanout",
      crossSessionTargeting: "disabled",
    });
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Reply\n[[CONTINUE_DELEGATE: inspect host state | fanout=all]]" }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });

    await runDelegateTurn(run);

    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(peekSystemEventEntries(run.sessionKey).map((event) => event.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("cross-session targeting is disabled by policy"),
      ]),
    );
    expect(spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "continuation.disabled",
          attributes: expect.objectContaining({
            "disabled.reason": "policy.cross_session_targeting",
            "signal.kind": "bracket-delegate",
            "delegate.delivery": "immediate",
            "delegate.mode": "normal",
            "continuation.disabled": true,
          }),
        }),
      ]),
    );
  });
});
