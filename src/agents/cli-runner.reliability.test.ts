import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
/** Tests CLI runner reliability paths for hooks, transcripts, failover, and reply ops. */
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import {
  ensureSessionEntrySync,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  markMcpLoopbackRequestClassified,
  markMcpLoopbackRequestFinished,
  markMcpLoopbackRequestStarted,
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult,
  resolveMcpLoopbackYieldContext,
  updateMcpLoopbackToolCallCapture,
} from "../gateway/mcp-http.loopback-runtime.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import type {
  CliBackendConfig,
  CliBackendExecute,
  CliBackendLiveSessionHandle,
} from "../plugins/cli-backend.types.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { getProcessSupervisor } from "../process/supervisor/index.js";
import type { RunExit } from "../process/supervisor/types.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../sessions/user-turn-transcript.test-support.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import {
  restoreCliRunnerTestDeps,
  runPreparedCliAgent,
  setCliRunnerTestDeps,
} from "./cli-runner.js";
import {
  createManagedRun,
  enqueueSystemEventMock,
  requestHeartbeatMock,
  supervisorSpawnMock,
} from "./cli-runner.test-support.js";
import { runCliRecovery } from "./cli-runner/cli-run-recovery.js";
import { executePreparedCliRun } from "./cli-runner/execute.js";
import {
  resolveCliNoOutputTimeoutMs,
  resolveCliRunTimeoutOverrideMs,
} from "./cli-runner/helpers.js";
import { prepareCliRunContext } from "./cli-runner/prepare.js";
import { hashCliReseedPrompt } from "./cli-runner/reseed-envelope.js";
import * as sessionHistoryModule from "./cli-runner/session-history.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";
import { FailoverError } from "./failover-error.js";
import { runAgentHarnessBeforeMessageWriteHook } from "./harness/hook-helpers.js";
import { MAX_AGENT_HOOK_HISTORY_MESSAGES } from "./harness/hook-history.js";
import { SessionManager } from "./sessions/session-manager.js";

const MAX_CLI_SESSION_HISTORY_MESSAGES = MAX_AGENT_HOOK_HISTORY_MESSAGES;

// Gateway unit coverage owns quiet-admission timing. These reliability cases only
// need to drain calls already in flight, so skip the repeated 250 ms quiet window.
vi.mock("../gateway/mcp-http.loopback-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/mcp-http.loopback-runtime.js")>();
  return {
    ...actual,
    waitForMcpLoopbackToolCallCaptureIdle: (
      captureKey: string,
      options: Parameters<typeof actual.waitForMcpLoopbackToolCallCaptureIdle>[1],
    ) =>
      actual.waitForMcpLoopbackToolCallCaptureIdle(captureKey, {
        ...options,
        admissionGraceMs: 0,
      }),
  };
});

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");
const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);
let sessionFileEnvSnapshot: ReturnType<typeof captureEnv> | undefined;

type HookRunnerGlobalStateForTest = {
  hookRunner: unknown;
  registry: unknown;
};

function setHookRunnerForTest(hookRunner: unknown): void {
  // Keep the module-level hook runner singleton aligned with the mocked getter.
  mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const state = (globalStore[hookRunnerGlobalStateKey] as
    | HookRunnerGlobalStateForTest
    | undefined) ?? {
    hookRunner: null,
    registry: null,
  };
  state.hookRunner = hookRunner;
  state.registry = null;
  globalStore[hookRunnerGlobalStateKey] = state;
}

function createSessionFixture(params?: {
  history?: Array<{ role: "user"; content: string }>;
  sessionKey?: string;
}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-hooks-")));
  sessionFileEnvSnapshot ??= captureEnv(["OPENCLAW_STATE_DIR"]);
  setTestEnvValue("OPENCLAW_STATE_DIR", dir);
  const storePath = path.join(dir, "agents", "main", "sessions", "sessions.json");
  const sessionTarget: SessionTranscriptRuntimeTarget = {
    agentId: "main",
    sessionId: "s1",
    sessionKey: params?.sessionKey ?? "agent:main:main",
    storePath,
  };
  ensureSessionEntrySync(sessionTarget, { sessionId: "s1", updatedAt: Date.now() });
  const manager = SessionManager.open(sessionTarget, dir);
  for (const [index, entry] of (params?.history ?? []).entries()) {
    manager.appendMessage({ ...entry, timestamp: index + 1 });
  }
  return { dir, sessionFile: sessionTarget.sessionKey, sessionTarget, storePath };
}

type PreparedContextOverrides = Partial<{
  sessionKey: string;
  cliSessionId: string;
  runId: string;
  lane: string;
  openClawHistoryPrompt: string;
  provider: string;
  model: string;
  executionMode: PreparedCliRunContext["params"]["executionMode"];
  allowEmptyAssistantReplyAsSilent: boolean;
}>;

function buildPreparedContext(params: PreparedContextOverrides = {}): PreparedCliRunContext {
  // Common prepared context fixture for runPreparedCliAgent reliability branches.
  const provider = params?.provider ?? "codex-cli";
  const model = params?.model ?? "gpt-5.4";
  const backend = {
    command: "codex",
    args: ["exec", "--json"],
    output: "text" as const,
    input: "arg" as const,
    modelArg: "--model",
    sessionMode: "existing" as const,
    serialize: true,
  };
  const runId = params?.runId ?? "run-2";
  return {
    params: {
      admittedRunContext: createTestAdmittedRunContext(runId),
      sessionId: "s1",
      sessionKey: params?.sessionKey,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider,
      model,
      thinkLevel: "low",
      timeoutMs: 1_000,
      runId,
      lane: params?.lane,
      executionMode: params?.executionMode,
      allowEmptyAssistantReplyAsSilent: params?.allowEmptyAssistantReplyAsSilent,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: provider,
      config: backend,
      bundleMcp: false,
      pluginId: provider === "claude-cli" ? "anthropic" : "openai",
    },
    executionTarget: { kind: "process" },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: params?.cliSessionId
      ? { mode: "reuse", sessionId: params.cliSessionId }
      : { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: model,
    normalizedModel: model,
    contextWindowInfo: {
      tokens: 150_000,
      referenceTokens: 200_000,
      source: "modelsConfig",
    },
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    ...(params?.openClawHistoryPrompt
      ? { openClawHistoryPrompt: params.openClawHistoryPrompt }
      : {}),
    authEpochVersion: 2,
  };
}

function makeClaudePreparedContext(
  overrides: PreparedContextOverrides = {},
): PreparedCliRunContext {
  return buildPreparedContext({ provider: "claude-cli", model: "opus", ...overrides });
}

async function usePluginLiveBackend(context: PreparedCliRunContext, execute: CliBackendExecute) {
  const backend: CliBackendConfig = {
    command: "/bin/sh",
    args: [],
    resumeArgs: ["--resume", "{sessionId}"],
    output: "jsonl",
    jsonlDialect: "claude-stream-json",
    input: "stdin",
    sessionMode: "existing",
    liveSession: "claude-stdio",
    freshSessionRecovery: "invalidated-only",
  };
  context.preparedBackend.backend = backend;
  context.backendResolved.config = backend;
  context.executionTarget = { kind: "plugin", execute };
  const admission = prepareSystemAgentRunAdmission(
    {},
    context.params.runId,
    "main",
    "plugin-recovery-test",
  );
  context.params.admittedRunContext = await admission.admit("plugin-harness");
  return { admission, context };
}

const failClosedPluginResumeCases: Array<{
  name: string;
  warm?: boolean;
  invalidate?: boolean;
  managed?: boolean;
  resume?: boolean;
  event?: Record<string, unknown>;
}> = [
  { name: "a valid required generation", warm: true, resume: true },
  { name: "a fresh managed turn", managed: true },
  { name: "an unbound managed resume", managed: true, resume: true },
  { name: "a one-shot turn" },
  {
    name: "assistant output",
    warm: true,
    invalidate: true,
    resume: true,
    event: { type: "assistant", message: { content: [{ type: "text", text: "started" }] } },
  },
  {
    name: "thinking output",
    warm: true,
    invalidate: true,
    resume: true,
    event: { type: "assistant", message: { content: [{ type: "thinking", thinking: "work" }] } },
  },
  {
    name: "tool output with an active parsed tool",
    warm: true,
    invalidate: true,
    resume: true,
    event: {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }] },
    },
  },
  {
    name: "background work",
    warm: true,
    invalidate: true,
    resume: true,
    event: {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "task-1", task_type: "local_agent" }],
    },
  },
  {
    name: "an unknown event",
    warm: true,
    invalidate: true,
    resume: true,
    event: { type: "future_event" },
  },
];

function makeRunExit(overrides: Partial<RunExit> = {}): RunExit {
  return {
    reason: "exit",
    exitCode: 0,
    exitSignal: null,
    durationMs: 50,
    stdout: "",
    stderr: "",
    timedOut: false,
    noOutputTimedOut: false,
    ...overrides,
  };
}

function makeManagedRun(overrides: Partial<RunExit> = {}) {
  return createManagedRun(makeRunExit(overrides));
}

const requireRecord = createRequireRecord("object", "expected-label");

function requireArray(value: unknown, label: string): Array<unknown> {
  expect(Array.isArray(value), label).toBe(true);
  return value as Array<unknown>;
}

function callArg(
  mock: { mock: { calls: Array<Array<unknown>> } },
  callIndex: number,
  argIndex: number,
  label: string,
) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call: ${label}`);
  }
  if (argIndex >= call.length) {
    throw new Error(`Expected mock call argument ${argIndex}: ${label}`);
  }
  return call[argIndex];
}

function firstSystemEventCall(): Array<unknown> {
  const call = enqueueSystemEventMock.mock.calls[0];
  if (!call) {
    throw new Error("expected system event call");
  }
  return call;
}

async function expectFailoverAttribution(
  run: Promise<unknown>,
  expected: { sessionId: string; lane: string },
) {
  try {
    await run;
    throw new Error("expected run to fail");
  } catch (error) {
    const failure = requireRecord(error, "failover error");
    expect(failure.name).toBe("FailoverError");
    expect(failure.sessionId).toBe(expected.sessionId);
    expect(failure.lane).toBe(expected.lane);
  }
}

function expectTextMessage(value: unknown, fields: { role: string; content: string }) {
  const message = requireRecord(value, "message");
  expect(message.role).toBe(fields.role);
  expect(message.content).toBe(fields.content);
  expect(message.timestamp).toBeTypeOf("number");
}

async function readTranscriptMessages(
  sessionTarget: SessionTranscriptRuntimeTarget,
): Promise<unknown[]> {
  const events = await loadTranscriptEvents(sessionTarget);
  return events.flatMap((entry) =>
    typeof entry === "object" && entry !== null && "message" in entry ? [entry.message] : [],
  );
}

function createCliUserTurnRecorder(params: {
  text: string;
  sessionTarget: SessionTranscriptRuntimeTarget;
  sessionKey?: string;
  workspaceDir: string;
}) {
  return createUserTurnTranscriptRecorder({
    input: { text: params.text },
    target: createTestUserTurnTranscriptTarget({
      ...params.sessionTarget,
      sessionKey: params.sessionKey ?? params.sessionTarget.sessionKey,
      cwd: params.workspaceDir,
    }),
  });
}

const CLI_RESEED_PROMPT =
  "Continue this conversation using the OpenClaw transcript below as prior session history.\n\n<conversation_history>\nUser: earlier context\n</conversation_history>\n\n<next_user_message>\nhi\n</next_user_message>";

describe("runCliAgent reliability", () => {
  beforeEach(() => {
    // Failed attempts must not leave queued spawn results for the next case.
    supervisorSpawnMock.mockReset();
    // Binding-flush retry timing has dedicated coverage. Reliability cases only
    // need its stable not-yet-flushed outcome, without filesystem polling/sleeps.
    setCliRunnerTestDeps({
      claudeCliSessionTranscriptHasContent: async () => false,
      delay: async () => {},
    });
  });

  afterEach(() => {
    restoreCliRunnerTestDeps();
    replyRunTesting.resetReplyRunRegistry();
    mockGetGlobalHookRunner.mockReset();
    setHookRunnerForTest(null);
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    sessionFileEnvSnapshot?.restore();
    sessionFileEnvSnapshot = undefined;
    resetDiagnosticEventsForTest();
    cliBackendsTesting.resetDepsForTest();
    vi.useRealTimers();
  });

  it("fails with timeout when no-output watchdog trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expect(
      executePreparedCliRun(
        buildPreparedContext({ cliSessionId: "thread-123", runId: "run-2" }),
        "thread-123",
      ),
    ).rejects.toThrow("produced no output");
  });

  it("adds request attribution to CLI watchdog failover errors", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expectFailoverAttribution(
      executePreparedCliRun(
        buildPreparedContext({
          cliSessionId: "thread-123",
          lane: "custom-lane",
          runId: "run-attribution",
        }),
        "thread-123",
      ),
      { sessionId: "s1", lane: "custom-lane" },
    );
  });

  it("enqueues a system event and heartbeat wake on no-output watchdog timeout for session runs", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expect(
      executePreparedCliRun(
        buildPreparedContext({
          sessionKey: "agent:main:main",
          cliSessionId: "thread-123",
          runId: "run-2b",
        }),
        "thread-123",
      ),
    ).rejects.toThrow("produced no output");

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [notice, opts] = firstSystemEventCall();
    expect(String(notice)).toContain("produced no output");
    expect(String(notice)).toContain("interactive input or an approval prompt");
    expect(requireRecord(opts, "system event options").sessionKey).toBe("agent:main:main");
    expect(requestHeartbeatMock).toHaveBeenCalledWith({
      source: "cli-watchdog",
      intent: "event",
      reason: "cli:watchdog:stall",
      sessionKey: "agent:main:main",
    });
  });

  it("does not enqueue watchdog system events for side-question no-output timeouts", async () => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatMock.mockClear();
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expect(
      executePreparedCliRun(
        buildPreparedContext({
          sessionKey: "agent:main:main",
          cliSessionId: "thread-123",
          executionMode: "side-question",
          runId: "run-side-question-timeout",
        }),
        "thread-123",
      ),
    ).rejects.toThrow("produced no output");

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("fails with timeout when overall timeout trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        reason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        timedOut: true,
      }),
    );

    await expect(
      executePreparedCliRun(
        buildPreparedContext({ cliSessionId: "thread-123", runId: "run-3" }),
        "thread-123",
      ),
    ).rejects.toThrow("exceeded timeout");
  });

  it("does not retry recoverable failover when no reusable CLI session was used", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expect(
      runPreparedCliAgent(
        makeClaudePreparedContext({
          sessionKey: "agent:main:fresh",
          runId: "run-fresh-timeout",
        }),
      ),
    ).rejects.toThrow("produced no output");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a resumed CLI session after the hard overall timeout", async () => {
    const clearBeforeRetry = vi.fn(async () => false);
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        reason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        timedOut: true,
      }),
    );
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:overall-timeout",
      runId: "run-overall-timeout",
      cliSessionId: "stale-cli-session",
    });

    await expect(
      runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          onBeforeFreshCliSessionRetry: clearBeforeRetry,
        },
      }),
    ).rejects.toThrow("exceeded timeout");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    expect(clearBeforeRetry).not.toHaveBeenCalled();
  });

  it("does not retry a resumed recoverable failover without a reseed prompt", async () => {
    const clearBeforeRetry = vi.fn(async () => false);
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:no-reseed",
      runId: "run-no-reseed",
      cliSessionId: "stale-cli-session",
    });

    await expect(
      runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          onBeforeFreshCliSessionRetry: clearBeforeRetry,
        },
      }),
    ).rejects.toThrow("produced no output");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    expect(clearBeforeRetry).not.toHaveBeenCalled();
  });

  it("keeps cold transcript reseed for stalled sessions without a checkpoint", async () => {
    supervisorSpawnMock
      .mockResolvedValueOnce(
        makeManagedRun({
          reason: "no-output-timeout",
          exitCode: null,
          exitSignal: "SIGKILL",
          durationMs: 200,
          timedOut: true,
          noOutputTimedOut: true,
        }),
      )
      .mockResolvedValueOnce(makeManagedRun({ stdout: "fresh fallback" }));
    const prepareForkRetry = vi.fn(async () => true);
    const clearBeforeRetry = vi.fn(async () => true);
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:no-checkpoint",
      runId: "run-no-checkpoint",
      cliSessionId: "legacy-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    context.preparedBackend.backend = {
      ...context.preparedBackend.backend,
      resumeArgs: ["--resume", "{sessionId}"],
      forkArg: "--fork-session",
      resumeAtArg: "--resume-session-at",
    };

    const result = await runPreparedCliAgent({
      ...context,
      params: {
        ...context.params,
        onBeforeForkedCliSessionRetry: prepareForkRetry,
        onBeforeFreshCliSessionRetry: clearBeforeRetry,
      },
    });

    expect(result.payloads).toEqual([{ text: "fresh fallback" }]);
    expect(prepareForkRetry).not.toHaveBeenCalled();
    expect(clearBeforeRetry).toHaveBeenCalledOnce();
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
    const freshArgv = requireArray(
      requireRecord(
        callArg(supervisorSpawnMock, 1, 0, "fresh fallback spawn"),
        "fresh fallback spawn",
      ).argv,
      "fresh fallback argv",
    );
    expect(freshArgv).not.toContain("--fork-session");
    expect(freshArgv).not.toContain("--resume-session-at");
  });

  it("falls back to cold reseed when Claude lacks the checkpoint flag", async () => {
    supervisorSpawnMock
      .mockResolvedValueOnce(
        makeManagedRun({
          reason: "no-output-timeout",
          exitCode: null,
          exitSignal: "SIGKILL",
          durationMs: 200,
          timedOut: true,
          noOutputTimedOut: true,
        }),
      )
      .mockResolvedValueOnce(
        makeManagedRun({
          exitCode: 1,
          durationMs: 25,
          stderr: "error: unknown option '--resume-session-at'",
        }),
      )
      .mockResolvedValueOnce(makeManagedRun({ stdout: "fresh fallback" }));
    const prepareForkRetry = vi.fn(async () => true);
    const claimFork = vi.fn(async () => true);
    const restoreFork = vi.fn(async () => {});
    const clearBeforeRetry = vi.fn(async () => true);
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:old-claude",
      runId: "run-old-claude",
      cliSessionId: "old-claude-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    context.preparedBackend.backend = {
      ...context.preparedBackend.backend,
      resumeArgs: ["--resume", "{sessionId}"],
      forkArg: "--fork-session",
      resumeAtArg: "--resume-session-at",
    };
    context.params.cliSessionBinding = {
      sessionId: "old-claude-session",
      resumeCheckpointId: "assistant-before-stall",
    };

    const result = await runPreparedCliAgent({
      ...context,
      params: {
        ...context.params,
        onBeforeForkedCliSessionRetry: prepareForkRetry,
        claimCliSessionFork: claimFork,
        restoreCliSessionFork: restoreFork,
        persistCliSessionForkSuccessor: vi.fn(async () => {}),
        onBeforeFreshCliSessionRetry: clearBeforeRetry,
      },
    });

    expect(result.payloads).toEqual([{ text: "fresh fallback" }]);
    expect(prepareForkRetry).toHaveBeenCalledOnce();
    expect(claimFork).toHaveBeenCalledOnce();
    expect(restoreFork).toHaveBeenCalledOnce();
    expect(clearBeforeRetry).toHaveBeenCalledWith({
      provider: "claude-cli",
      reason: "timeout",
      sessionId: "old-claude-session",
    });
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(3);
  });

  it("cold reseeds an initially armed checkpoint after a Claude downgrade", async () => {
    supervisorSpawnMock
      .mockResolvedValueOnce(
        makeManagedRun({
          exitCode: 1,
          durationMs: 25,
          stderr: "error: unknown option '--resume-session-at'",
        }),
      )
      .mockResolvedValueOnce(makeManagedRun({ stdout: "fresh fallback" }));
    const claimFork = vi.fn(async () => true);
    const restoreFork = vi.fn(async () => {});
    const clearBeforeRetry = vi.fn(async () => true);
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:downgraded-claude",
      runId: "run-downgraded-claude",
      cliSessionId: "downgraded-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    context.preparedBackend.backend = {
      ...context.preparedBackend.backend,
      resumeArgs: ["--resume", "{sessionId}"],
      forkArg: "--fork-session",
      resumeAtArg: "--resume-session-at",
    };
    context.params.cliSessionBinding = {
      sessionId: "downgraded-session",
      resumeCheckpointId: "assistant-before-stall",
      forkNextResume: true,
    };

    const result = await runPreparedCliAgent({
      ...context,
      params: {
        ...context.params,
        forkCliSessionOnResume: true,
        claimCliSessionFork: claimFork,
        restoreCliSessionFork: restoreFork,
        persistCliSessionForkSuccessor: vi.fn(async () => {}),
        onBeforeFreshCliSessionRetry: clearBeforeRetry,
      },
    });

    expect(result.payloads).toEqual([{ text: "fresh fallback" }]);
    expect(claimFork).toHaveBeenCalledOnce();
    expect(restoreFork).toHaveBeenCalledOnce();
    expect(clearBeforeRetry).toHaveBeenCalledWith({
      provider: "claude-cli",
      reason: "session_expired",
      sessionId: "downgraded-session",
    });
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
  });

  it("does not treat unsupported-flag wording fragments as a Claude downgrade", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        exitCode: 1,
        durationMs: 25,
        stderr: "Claude exited unexpectedly while using --resume-session-at",
      }),
    );
    const clearBeforeRetry = vi.fn(async () => true);
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:resume-token-boundary",
      runId: "run-resume-token-boundary",
      cliSessionId: "existing-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    context.preparedBackend.backend = {
      ...context.preparedBackend.backend,
      resumeArgs: ["--resume", "{sessionId}"],
      forkArg: "--fork-session",
      resumeAtArg: "--resume-session-at",
    };
    context.params.cliSessionBinding = {
      sessionId: "existing-session",
      resumeCheckpointId: "assistant-before-stall",
      forkNextResume: true,
    };

    await expect(
      runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          forkCliSessionOnResume: true,
          claimCliSessionFork: vi.fn(async () => true),
          restoreCliSessionFork: vi.fn(async () => {}),
          persistCliSessionForkSuccessor: vi.fn(async () => {}),
          onBeforeFreshCliSessionRetry: clearBeforeRetry,
        },
      }),
    ).rejects.toThrow("exited unexpectedly");

    expect(clearBeforeRetry).not.toHaveBeenCalled();
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("preserves fresh retry for direct CLI callers without a pre-clear hook", async () => {
    // Image preparation must not consume this retry-policy fixture's budget.
    vi.useFakeTimers({ toFake: ["Date"] });
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        exitCode: 1,
        durationMs: 150,
        stderr: "session expired",
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from fresh cli" }));
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:direct",
      runId: "run-direct-retry",
      cliSessionId: "stale-cli-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    context.preparedBackend.backend = {
      ...context.preparedBackend.backend,
      resumeArgs: ["exec", "resume", "{sessionId}", "--json"],
      imageArg: "--image",
      imageMode: "repeat",
    };
    const stateDir = autoCleanupTempDirs.make("openclaw-cli-retry-images-");
    const workspaceDir = path.join(stateDir, "workspace");
    const inboundDir = path.join(stateDir, "media", "inbound");
    const mediaId = "offloaded.png";
    const offloadedImage = createSolidPngBuffer(1, 1, { r: 255, g: 0, b: 0 });
    const inlineImage = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(inboundDir, { recursive: true });
    fs.writeFileSync(path.join(inboundDir, mediaId), offloadedImage);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const currentTurn = `compare these\n[media attached: media://inbound/${mediaId}]`;
    context.workspaceDir = workspaceDir;
    context.params = {
      ...context.params,
      workspaceDir,
      prompt: `[Retry after failure]\n\n${currentTurn}`,
      imagePrompt: currentTurn,
      images: [
        {
          type: "image",
          data: inlineImage.toString("base64"),
          mimeType: "image/png",
        },
      ],
      imageOrder: ["offloaded", "inline"],
      // Offloaded attachments are carried as structured facts; the trailing
      // marker text is presentation only and is never parsed for hydration.
      media: [{ url: `media://inbound/${mediaId}`, contentType: "image/png" }],
    };

    const result = await runPreparedCliAgent(context);

    expect(result.payloads).toEqual([{ text: "hello from fresh cli" }]);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
    for (const [index, label] of ["resumed", "fresh"].entries()) {
      const spawn = requireRecord(
        callArg(supervisorSpawnMock, index, 0, `${label} image CLI spawn`),
        `${label} image CLI spawn`,
      );
      const argv = requireArray(spawn.argv, `${label} image CLI argv`);
      const imagePaths = argv.flatMap((arg, argIndex) =>
        arg === "--image" && typeof argv[argIndex + 1] === "string"
          ? [argv[argIndex + 1] as string]
          : [],
      );
      expect(imagePaths).toHaveLength(2);
      expect(fs.readFileSync(expectDefined(imagePaths[0], "imagePaths[0] test invariant"))).toEqual(
        offloadedImage,
      );
      expect(fs.readFileSync(expectDefined(imagePaths[1], "imagePaths[1] test invariant"))).toEqual(
        inlineImage,
      );
      expect(argv.includes("resume")).toBe(index === 0);
      expect(argv.includes("stale-cli-session")).toBe(index === 0);
    }
  });

  it("does not retry or fail over after a confirmed message send", async () => {
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureKey = input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "";
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey,
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "done",
          mediaUrl: "https://example.com/done.png",
        },
      });
      if (!captureHandle) {
        throw new Error("Expected message delivery capture");
      }
      setTimeout(() => {
        recordMcpLoopbackToolCallResult({
          captureHandle,
          toolName: "message",
          args: {
            action: "send",
            channel: "telegram",
            target: "chat123",
            message: "done",
            mediaUrl: "https://example.com/done.png",
          },
          result: { status: "sent" },
          outcome: "completed",
        });
        markMcpLoopbackToolCallFinished(captureHandle);
      }, 10);
      return makeManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        timedOut: true,
        noOutputTimedOut: true,
      });
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:delivered-timeout",
      runId: "run-delivered-timeout",
      cliSessionId: "stale-cli-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    context.mcpDeliveryCapture = true;

    const result = await runPreparedCliAgent(context);

    expect(result.payloads).toBeUndefined();
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toEqual(["done"]);
    expect(result.messagingToolSentMediaUrls).toEqual(["https://example.com/done.png"]);
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({ tool: "message", provider: "telegram", to: "chat123" }),
    ]);
    expect(result.meta.executionTrace?.attempts?.[0]?.result).toBe("error");
    expect(result.meta.agentMeta?.clearCliSessionBinding).toBe(true);
    expect(result.meta.agentMeta?.contextTokens).toBe(150_000);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("projects explicit outbound MCP media without retaining echoed image bytes", async () => {
    const echoedBase64 = "private-echoed-base64";
    const mediaUrls = [
      "https://example.test/one.png",
      "https://example.test/two.png",
      "https://example.test/three.png",
    ];
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureKey = input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "";
      for (const [index, mediaUrl] of mediaUrls.entries()) {
        const captureHandle = markMcpLoopbackToolCallStarted({
          captureKey,
          toolName: "image_generate",
          args: { prompt: `image ${index + 1}` },
        });
        if (!captureHandle) {
          throw new Error("Expected outbound media capture");
        }
        recordMcpLoopbackToolCallResult({
          captureHandle,
          toolName: "image_generate",
          args: { prompt: `image ${index + 1}` },
          result: {
            content: [
              {
                type: "image",
                data: echoedBase64,
                mimeType: "image/png",
              },
            ],
            details: { media: { mediaUrls: [mediaUrl] } },
          },
          outcome: "completed",
        });
        markMcpLoopbackToolCallFinished(captureHandle);
      }
      for (const [toolName, media] of [
        ["image", { mediaUrls: ["/tmp/private.png"], outbound: false }],
        ["untrusted_tool", { mediaUrls: ["/tmp/untrusted.png"] }],
      ] as const) {
        const captureHandle = markMcpLoopbackToolCallStarted({
          captureKey,
          toolName,
          args: {},
        });
        if (!captureHandle) {
          throw new Error("Expected private media capture");
        }
        recordMcpLoopbackToolCallResult({
          captureHandle,
          toolName,
          args: {},
          result: {
            content: [{ type: "image", data: echoedBase64, mimeType: "image/png" }],
            details: { media },
          },
          outcome: "completed",
        });
        markMcpLoopbackToolCallFinished(captureHandle);
      }
      return makeManagedRun({ stdout: "done" });
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:outbound-media",
      runId: "run-outbound-media",
    });
    context.mcpDeliveryCapture = true;

    const result = await runPreparedCliAgent(context);

    expect(result.payloads).toEqual([
      {
        text: "done",
        mediaUrls,
        mediaUrl: mediaUrls[0],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(echoedBase64);
    expect(JSON.stringify(result)).not.toContain("/tmp/private.png");
    expect(JSON.stringify(result)).not.toContain("/tmp/untrusted.png");
  });

  it("deduplicates a CLI Markdown image selected from structured tool media", async () => {
    const mediaUrl = "/root/.openclaw/media/tool-image-generation/our-agent-soviet-meme.png";
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "image_generate",
        args: { prompt: "our agent" },
      });
      if (!captureHandle) {
        throw new Error("Expected outbound media capture");
      }
      recordMcpLoopbackToolCallResult({
        captureHandle,
        toolName: "image_generate",
        args: { prompt: "our agent" },
        result: {
          content: [{ type: "text", text: "Image generated" }],
          details: { media: { mediaUrls: [mediaUrl], trustedLocalMedia: true } },
        },
        outcome: "completed",
      });
      markMcpLoopbackToolCallFinished(captureHandle);
      return makeManagedRun({
        stdout: `Our agent.\n\n![Our Agent meme](${mediaUrl})`,
      });
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:markdown-tool-media",
      runId: "run-markdown-tool-media",
    });
    context.mcpDeliveryCapture = true;

    const result = await runPreparedCliAgent(context);

    expect(result.payloads).toEqual([
      {
        text: "Our agent.",
        mediaUrls: [mediaUrl],
        mediaUrl,
        trustedLocalMedia: true,
      },
    ]);
  });

  it("surfaces a CLI failure after a delivered progress reply", async () => {
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: { action: "send", message: "still working", final: false },
      });
      if (!captureHandle) {
        throw new Error("Expected message delivery capture");
      }
      recordMcpLoopbackToolCallResult({
        captureHandle,
        toolName: "message",
        args: { action: "send", message: "still working", final: false },
        result: { status: "sent", messageId: "progress-1" },
        outcome: "completed",
      });
      markMcpLoopbackToolCallFinished(captureHandle);
      return makeManagedRun({ exitCode: 1, durationMs: 150, stderr: "failed after progress" });
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:telegram:direct:chat123",
      runId: "run-progress-failure",
    });
    context.mcpDeliveryCapture = true;
    context.params.sourceReplyDeliveryMode = "message_tool_only";
    context.params.messageChannel = "telegram";
    context.params.currentChannelId = "chat123";

    const result = await runPreparedCliAgent(context);

    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({ sourceReplyFinal: false }),
    ]);
    expect(result.payloads).toEqual([
      { text: "The reply stopped after sending progress. Please try again.", isError: true },
    ]);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("clears a soft-resumed binding after confirmed message send followed by failure", async () => {
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "sent before failure",
        },
      });
      if (!captureHandle) {
        throw new Error("Expected message delivery capture");
      }
      recordMcpLoopbackToolCallResult({
        captureHandle,
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "sent before failure",
        },
        outcome: "completed",
        result: { status: "sent" },
      });
      markMcpLoopbackToolCallFinished(captureHandle);
      return makeManagedRun({
        exitCode: 1,
        durationMs: 150,
        stderr: "failed after delivery",
      });
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:soft-drift-delivered-failure",
      runId: "run-soft-drift-delivered-failure",
      cliSessionId: "soft-cli-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    context.reusableCliSession = {
      mode: "reuse-with-drift",
      sessionId: "soft-cli-session",
      drift: { reasons: ["system-prompt"] },
    };
    context.mcpDeliveryCapture = true;

    const result = await runPreparedCliAgent(context);

    expect(result.payloads).toBeUndefined();
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toEqual(["sent before failure"]);
    expect(result.meta.agentMeta?.clearCliSessionBinding).toBe(true);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry context overflow after a confirmed message send", async () => {
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "sent before overflow",
        },
      });
      if (!captureHandle) {
        throw new Error("Expected message delivery capture");
      }
      recordMcpLoopbackToolCallResult({
        captureHandle,
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "sent before overflow",
        },
        result: { status: "sent" },
        outcome: "completed",
      });
      markMcpLoopbackToolCallFinished(captureHandle);
      return makeManagedRun({
        exitCode: 1,
        durationMs: 150,
        stderr: "Prompt is too long",
      });
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:delivered-overflow",
      runId: "run-delivered-overflow",
      cliSessionId: "stale-cli-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    context.mcpDeliveryCapture = true;

    const result = await runPreparedCliAgent(context);

    expect(result.payloads).toBeUndefined();
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toEqual(["sent before overflow"]);
    expect(result.meta.executionTrace?.attempts?.[0]?.result).toBe("error");
    expect(result.meta.agentMeta?.clearCliSessionBinding).toBe(true);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("preserves first-turn delivery through cleanup without binding the OpenClaw session id", async () => {
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          message: "sent before failure",
        },
      });
      if (!captureHandle) {
        throw new Error("Expected message delivery capture");
      }
      recordMcpLoopbackToolCallResult({
        captureHandle,
        toolName: "message",
        args: {
          action: "send",
          message: "sent before failure",
        },
        result: {
          details: {
            deliveryStatus: "sent",
            messageDelivery: {
              status: "settled",
              partialDelivery: false,
              createdThreadIds: [],
            },
            sourceReplySink: "internal-ui",
            sourceReply: { text: "sent before failure" },
          },
        },
        outcome: "completed",
      });
      markMcpLoopbackToolCallFinished(captureHandle);
      return makeManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        timedOut: true,
        noOutputTimedOut: true,
      });
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:first-turn-delivered",
      runId: "run-first-turn-delivered",
    });
    context.preparedBackend.backend.sessionMode = "none";
    context.backendResolved.config = context.preparedBackend.backend;
    context.mcpDeliveryCapture = true;
    context.params.sourceReplyDeliveryMode = "message_tool_only";
    context.preparedBackend.cleanup = async () => {
      throw new Error("cleanup failed");
    };

    const result = await runPreparedCliAgent(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(result.messagingToolSourceReplyPayloads).toEqual([
      { text: "sent before failure", sourceReplyFinal: true },
    ]);
    expect(result.payloads).toEqual([{ text: "sent before failure" }]);
    expect(getReplyPayloadMetadata(result.payloads?.[0] as object)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main:first-turn-delivered",
        text: "sent before failure",
        idempotencyKey: "run-first-turn-delivered:internal-source-reply:0",
      },
    });
    expect(result.meta.agentMeta?.sessionId).toBe("");
    expect(result.meta.agentMeta?.clearCliSessionBinding).toBe(true);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes soft-resumed binding hashes without clearing the stored binding", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "ok" }));
    const context = buildPreparedContext({
      sessionKey: "agent:main:soft-drift-refresh",
      runId: "run-soft-drift-refresh",
      cliSessionId: "soft-cli-session",
      provider: "codex-cli",
      model: "gpt-5.4",
    });
    context.reusableCliSession = {
      mode: "reuse-with-drift",
      sessionId: "soft-cli-session",
      drift: { reasons: ["system-prompt"] },
    };
    context.extraSystemPromptHash = "new-system-prompt-hash";

    const result = await runPreparedCliAgent(context);

    expect(result.meta.agentMeta?.clearCliSessionBinding).toBeUndefined();
    expect(result.meta.agentMeta?.cliSessionBinding).toMatchObject({
      sessionId: "soft-cli-session",
      extraSystemPromptHash: "new-system-prompt-hash",
    });
  });

  it("returns only the source-reply mirror after a successful CLI turn", async () => {
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          message: "sent through source reply",
        },
      });
      if (!captureHandle) {
        throw new Error("Expected message delivery capture");
      }
      recordMcpLoopbackToolCallResult({
        captureHandle,
        toolName: "message",
        args: {
          action: "send",
          message: "sent through source reply",
        },
        result: {
          details: {
            deliveryStatus: "sent",
            messageDelivery: {
              status: "settled",
              partialDelivery: false,
              createdThreadIds: [],
            },
            sourceReplySink: "internal-ui",
            sourceReply: { text: "sent through source reply" },
          },
        },
        outcome: "completed",
      });
      markMcpLoopbackToolCallFinished(captureHandle);
      return makeManagedRun({ stdout: "ordinary final should stay private" });
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:successful-source-reply",
      runId: "run-successful-source-reply",
    });
    context.mcpDeliveryCapture = true;
    context.params.sourceReplyDeliveryMode = "message_tool_only";

    const result = await runPreparedCliAgent(context);

    expect(result.payloads).toEqual([{ text: "sent through source reply" }]);
    expect(getReplyPayloadMetadata(result.payloads?.[0] as object)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main:successful-source-reply",
        text: "sent through source reply",
        idempotencyKey: "run-successful-source-reply:internal-source-reply:0",
      },
    });
    expect(result.meta.finalAssistantVisibleText).toBe("sent through source reply");
  });

  it("hooks the visible source reply without pre-persisting its dispatch mirror", async () => {
    const { dir, sessionFile, sessionTarget, storePath } = createSessionFixture();
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => ["llm_output", "agent_end"].includes(hookName)),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    setHookRunnerForTest(hookRunner);
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          message: "visible source reply",
        },
      });
      if (!captureHandle) {
        throw new Error("Expected message delivery capture");
      }
      recordMcpLoopbackToolCallResult({
        captureHandle,
        toolName: "message",
        args: {
          action: "send",
          message: "visible source reply",
        },
        result: {
          details: {
            deliveryStatus: "sent",
            messageDelivery: {
              status: "settled",
              partialDelivery: false,
              createdThreadIds: [],
            },
            sourceReplySink: "internal-ui",
            sourceReply: { text: "visible source reply" },
          },
        },
        outcome: "completed",
      });
      markMcpLoopbackToolCallFinished(captureHandle);
      return makeManagedRun({ stdout: "private terminal confirmation" });
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:main",
      runId: "run-visible-source-reply",
    });
    context.mcpDeliveryCapture = true;
    context.params.sourceReplyDeliveryMode = "message_tool_only";
    context.params.sessionFile = sessionFile;
    context.params.sessionTarget = sessionTarget;
    context.params.storePath = storePath;
    context.params.persistAssistantTranscript = true;

    try {
      await runPreparedCliAgent(context);

      const transcriptMessages = await readTranscriptMessages(sessionTarget);
      expect(transcriptMessages).toHaveLength(0);
      const llmOutputEvent = requireRecord(
        callArg(hookRunner.runLlmOutput, 0, 0, "llm_output event"),
        "llm_output event",
      );
      expect(llmOutputEvent.assistantTexts).toEqual(["visible source reply"]);
      const agentEndEvent = requireRecord(
        callArg(hookRunner.runAgentEnd, 0, 0, "agent_end event"),
        "agent_end event",
      );
      const messages = requireArray(agentEndEvent.messages, "agent_end messages");
      const lastMessage = requireRecord(messages.at(-1), "agent_end assistant message");
      expect(lastMessage.role).toBe("assistant");
      expect(lastMessage.content).toEqual([{ type: "text", text: "visible source reply" }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts empty terminal output after a confirmed message delivery", async () => {
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "sent without a terminal reply",
        },
      });
      if (!captureHandle) {
        throw new Error("Expected message delivery capture");
      }
      recordMcpLoopbackToolCallResult({
        captureHandle,
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "sent without a terminal reply",
        },
        result: { status: "sent" },
        outcome: "completed",
      });
      markMcpLoopbackToolCallFinished(captureHandle);
      input.onStdout?.(
        `${JSON.stringify({ type: "result", session_id: "claude-session", result: "" })}\n`,
      );
      return makeManagedRun();
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:successful-empty-delivery",
      runId: "run-successful-empty-delivery",
    });
    context.backendResolved.config.output = "jsonl";
    context.mcpDeliveryCapture = true;

    const result = await runPreparedCliAgent(context);

    expect(result.payloads).toBeUndefined();
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.meta.executionTrace?.attempts?.[0]?.result).toBe("success");
  });

  it("does not persist an emitted CLI session id when sessions are disabled", async () => {
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      input.onStdout?.(
        `${JSON.stringify({ type: "result", session_id: "stateless-cli-id", result: "ok" })}\n`,
      );
      return makeManagedRun();
    });
    setCliRunnerTestDeps({
      claudeCliSessionTranscriptHasContent: async () => true,
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:stateless",
      runId: "run-stateless-session-id",
    });
    context.preparedBackend.backend.output = "jsonl";
    context.preparedBackend.backend.input = "stdin";
    context.preparedBackend.backend.sessionMode = "none";
    context.backendResolved.config = context.preparedBackend.backend;

    const result = await runPreparedCliAgent(context);

    expect(result.payloads).toEqual([{ text: "ok" }]);
    expect(result.meta.agentMeta?.sessionId).toBe("s1");
    expect(result.meta.agentMeta?.cliSessionBinding).toBeUndefined();
    expect(result.meta.agentMeta?.clearCliSessionBinding).toBe(true);
  });

  it("keeps unresolved internal source replies retryable", async () => {
    vi.useFakeTimers();
    let captureStarted: (() => void) | undefined;
    const captureStartedPromise = new Promise<void>((resolve) => {
      captureStarted = resolve;
    });
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          message: "pending internal source reply",
        },
      });
      if (!captureHandle) {
        throw new Error("Expected internal source reply capture");
      }
      updateMcpLoopbackToolCallCapture(captureHandle, {
        toolName: "message",
        args: {
          action: "send",
          message: "pending internal source reply",
        },
      });
      captureStarted?.();
      return makeManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        timedOut: true,
        noOutputTimedOut: true,
      });
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:unresolved-internal-source-reply",
      runId: "run-unresolved-internal-source-reply",
    });
    context.mcpDeliveryCapture = true;
    context.params.config = {};
    context.params.messageChannel = "webchat";
    context.params.sourceReplyDeliveryMode = "message_tool_only";

    const resultPromise = runPreparedCliAgent(context);
    const resultAssertion = expect(resultPromise).rejects.toThrow("CLI produced no output");
    await captureStartedPromise;
    await vi.runAllTimersAsync();
    await resultAssertion;

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an unresolved implicit send resolves to an external session route", async () => {
    vi.useFakeTimers();
    let captureStarted: (() => void) | undefined;
    const captureStartedPromise = new Promise<void>((resolve) => {
      captureStarted = resolve;
    });
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          message: "pending external session reply",
        },
      });
      if (!captureHandle) {
        throw new Error("Expected external session reply capture");
      }
      updateMcpLoopbackToolCallCapture(captureHandle, {
        toolName: "message",
        args: {
          action: "send",
          message: "pending external session reply",
        },
      });
      captureStarted?.();
      return makeManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        timedOut: true,
        noOutputTimedOut: true,
      });
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:telegram:direct:123456789",
      runId: "run-unresolved-external-session-reply",
    });
    context.mcpDeliveryCapture = true;
    context.params.config = {};
    context.params.messageChannel = "webchat";
    context.params.sourceReplyDeliveryMode = "message_tool_only";

    const resultPromise = runPreparedCliAgent(context);
    await captureStartedPromise;
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces prepared backend cleanup failures when nothing was delivered", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "ok" }));
    const context = buildPreparedContext({
      sessionKey: "agent:main:cleanup-failure",
      runId: "run-cleanup-failure",
    });
    context.preparedBackend.cleanup = async () => {
      throw new Error("cleanup failed");
    };

    await expect(runPreparedCliAgent(context)).rejects.toThrow("cleanup failed");
  });

  it("bounds unresolved message sends and does not retry them", async () => {
    vi.useFakeTimers();
    let captureStarted: (() => void) | undefined;
    const captureStartedPromise = new Promise<void>((resolve) => {
      captureStarted = resolve;
    });
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "react",
          channel: "telegram",
          target: "chat123",
        },
      });
      if (!captureHandle) {
        throw new Error("Expected message delivery capture");
      }
      updateMcpLoopbackToolCallCapture(captureHandle, {
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "possibly sent",
        },
      });
      captureStarted?.();
      return makeManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        timedOut: true,
        noOutputTimedOut: true,
      });
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:unresolved-send",
      runId: "run-unresolved-send",
      cliSessionId: "stale-cli-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    context.mcpDeliveryCapture = true;

    const resultPromise = runPreparedCliAgent(context);
    await captureStartedPromise;
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.payloads).toBeUndefined();
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("bounds admitted requests that have not finished uploading", async () => {
    vi.useFakeTimers();
    let captureStarted: (() => void) | undefined;
    const captureStartedPromise = new Promise<void>((resolve) => {
      captureStarted = resolve;
    });
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureHandle = markMcpLoopbackRequestStarted(
        input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
      );
      if (!captureHandle) {
        throw new Error("Expected request delivery capture");
      }
      captureStarted?.();
      return makeManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        timedOut: true,
        noOutputTimedOut: true,
      });
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:unresolved-request",
      runId: "run-unresolved-request",
      cliSessionId: "stale-cli-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    context.mcpDeliveryCapture = true;

    const resultPromise = runPreparedCliAgent(context);
    await captureStartedPromise;
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.payloads).toBeUndefined();
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not treat classified non-message requests as delivery", async () => {
    vi.useFakeTimers();
    let captureStarted: (() => void) | undefined;
    const captureStartedPromise = new Promise<void>((resolve) => {
      captureStarted = resolve;
    });
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const requestCaptureHandle = markMcpLoopbackRequestStarted(
        input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
      );
      if (!requestCaptureHandle) {
        throw new Error("Expected request delivery capture");
      }
      markMcpLoopbackToolCallStarted({
        requestCaptureHandle,
        toolName: "exec",
        args: { command: "sleep 30" },
      });
      markMcpLoopbackRequestClassified(requestCaptureHandle);
      captureStarted?.();
      return makeManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        timedOut: true,
        noOutputTimedOut: true,
      });
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:unresolved-non-message-request",
      runId: "run-unresolved-non-message-request",
      cliSessionId: "stale-cli-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    context.mcpDeliveryCapture = true;

    const resultPromise = runPreparedCliAgent(context);
    const resultAssertion = expect(resultPromise).rejects.toThrow("produced no output");
    await captureStartedPromise;
    await vi.runAllTimersAsync();
    await resultAssertion;

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("fails normally after an unresolved prepared dry-run send", async () => {
    vi.useFakeTimers();
    let captureStarted: (() => void) | undefined;
    const captureStartedPromise = new Promise<void>((resolve) => {
      captureStarted = resolve;
    });
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "preview",
        },
      });
      updateMcpLoopbackToolCallCapture(captureHandle, {
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "chat123",
          message: "preview",
          dryRun: true,
        },
      });
      captureStarted?.();
      return makeManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        timedOut: true,
        noOutputTimedOut: true,
      });
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:unresolved-dry-run",
      runId: "run-unresolved-dry-run",
      cliSessionId: "stale-cli-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    context.mcpDeliveryCapture = true;

    const resultPromise = runPreparedCliAgent(context);
    const resultAssertion = expect(resultPromise).rejects.toThrow("produced no output");
    await captureStartedPromise;
    await vi.runAllTimersAsync();
    await resultAssertion;

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry an unclassified CLI failure with diagnostic output", async () => {
    const clearBeforeRetry = vi.fn(async () => true);
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        exitCode: 1,
        durationMs: 150,
        stderr: "worker crashed without details",
      }),
    );
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:unknown-output",
      runId: "run-unknown-output",
      cliSessionId: "stale-cli-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });

    await expect(
      runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          onBeforeFreshCliSessionRetry: clearBeforeRetry,
        },
      }),
    ).rejects.toThrow("worker crashed without details");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    expect(clearBeforeRetry).not.toHaveBeenCalled();
  });

  it("does not fresh retry when the run timeout budget is exhausted", async () => {
    const clearBeforeRetry = vi.fn(async () => true);
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 1_000,
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:expired-budget",
      runId: "run-expired-budget",
      cliSessionId: "stale-cli-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    const expiredBudgetContext = {
      ...context,
      started: Date.now() - context.params.timeoutMs - 1,
    };

    await expect(
      runPreparedCliAgent({
        ...expiredBudgetContext,
        params: {
          ...expiredBudgetContext.params,
          onBeforeFreshCliSessionRetry: clearBeforeRetry,
        },
      }),
    ).rejects.toThrow("produced no output");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    expect(clearBeforeRetry).not.toHaveBeenCalled();
  });

  it("does not fresh retry context overflow when the run timeout budget is exhausted", async () => {
    const clearBeforeRetry = vi.fn(async () => true);
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        exitCode: 1,
        durationMs: 150,
        stderr: "Prompt is too long",
      }),
    );
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:expired-overflow-budget",
      runId: "run-expired-overflow-budget",
      cliSessionId: "stale-cli-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    const expiredBudgetContext = {
      ...context,
      started: Date.now() - context.params.timeoutMs - 1,
    };

    await expect(
      runPreparedCliAgent({
        ...expiredBudgetContext,
        params: {
          ...expiredBudgetContext.params,
          onBeforeFreshCliSessionRetry: clearBeforeRetry,
        },
      }),
    ).rejects.toThrow("Prompt is too long");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    expect(clearBeforeRetry).not.toHaveBeenCalled();
  });

  it("does not fresh retry a no-output timeout after CLI diagnostic output", async () => {
    enqueueSystemEventMock.mockClear();
    const clearBeforeRetry = vi.fn(async () => true);
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 500,
        stdout: "partial progress before the stall",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:timeout-after-output",
      runId: "run-timeout-after-output",
      cliSessionId: "stale-cli-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });

    await expect(
      runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          onBeforeFreshCliSessionRetry: clearBeforeRetry,
        },
      }),
    ).rejects.toThrow("produced no output");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    expect(clearBeforeRetry).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });

  it("does not fresh retry an empty supervisor cancellation", async () => {
    const clearBeforeRetry = vi.fn(async () => true);
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        reason: "manual-cancel",
        exitCode: null,
      }),
    );
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:manual-cancel",
      runId: "run-manual-cancel",
      cliSessionId: "stale-cli-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });

    await expect(
      runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          onBeforeFreshCliSessionRetry: clearBeforeRetry,
        },
      }),
    ).rejects.toThrow("CLI failed");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    expect(clearBeforeRetry).not.toHaveBeenCalled();
  });

  it("does not start a fresh CLI attempt when format recovery retains the binding", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        stdout: [
          JSON.stringify({
            type: "assistant",
            message: {
              model: "<synthetic>",
              content: [{ type: "text", text: "No response requested." }],
            },
          }),
          JSON.stringify({ type: "result", subtype: "success", result: "" }),
        ].join("\n"),
      }),
    );
    const clearBeforeRetry = vi.fn(async () => false);
    const { dir, sessionFile, sessionTarget } = createSessionFixture({
      sessionKey: "agent:main:subagent:retained-format",
      history: [{ role: "user", content: "earlier context" }],
    });

    try {
      const context = makeClaudePreparedContext({
        sessionKey: "agent:main:subagent:retained-format",
        runId: "run-retained-format",
        cliSessionId: "retained-cli-session",
        openClawHistoryPrompt: CLI_RESEED_PROMPT,
      });
      context.preparedBackend.backend = {
        ...context.preparedBackend.backend,
        freshSessionRecovery: "invalidated-only",
        output: "jsonl",
        input: "stdin",
        jsonlDialect: "claude-stream-json",
      };
      context.backendResolved.config = context.preparedBackend.backend;

      await expect(
        runPreparedCliAgent({
          ...context,
          params: {
            ...context.params,
            agentId: "main",
            sessionFile,
            sessionTarget,
            workspaceDir: dir,
            onBeforeFreshCliSessionRetry: clearBeforeRetry,
          },
        }),
      ).rejects.toMatchObject({ reason: "format", code: "cli_synthetic_no_response" });

      expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
      expect(clearBeforeRetry).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["format", "cli_synthetic_no_response"],
    ["timeout", "cli_no_output_timeout"],
  ] as const)(
    "keeps undefined Gemini recovery policy compatible after %s failover",
    async (reason, code) => {
      const context = buildPreparedContext({
        provider: "google-gemini-cli",
        sessionKey: `agent:main:gemini-${reason}`,
        cliSessionId: "gemini-resumed-session",
        openClawHistoryPrompt: CLI_RESEED_PROMPT,
      });
      context.preparedBackend.backend = {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
        resumeArgs: ["--resume", "{sessionId}", "--prompt", "{prompt}"],
        output: "jsonl",
        jsonlDialect: "gemini-stream-json",
        input: "arg",
        sessionMode: "existing",
      };
      context.backendResolved.config = context.preparedBackend.backend;
      expect(context.preparedBackend.backend.freshSessionRecovery).toBeUndefined();

      const executeAttempt = vi
        .fn()
        .mockRejectedValueOnce(
          new FailoverError(`Gemini ${reason} failure`, {
            reason,
            code,
            provider: "google-gemini-cli",
            model: "gemini-3.1-pro-preview",
          }),
        )
        .mockResolvedValueOnce({ sessionId: `gemini-fresh-${reason}` });
      const clearBeforeRetry = vi.fn(async () => true);

      const result = await runCliRecovery({
        context: {
          ...context,
          params: {
            ...context.params,
            onBeforeFreshCliSessionRetry: clearBeforeRetry,
          },
        },
        executeAttempt,
        finishAttempt: async (attempt: { sessionId: string }) =>
          ({
            payloads: [{ text: "Gemini recovered" }],
            meta: { cliSessionId: attempt.sessionId },
          }) as never,
        finishDeliveredFailure: async () => undefined,
        onTerminalFailure: async () => {},
      });

      expect(executeAttempt).toHaveBeenCalledTimes(2);
      expect(executeAttempt.mock.calls[0]?.[0]).toBe("gemini-resumed-session");
      expect(executeAttempt.mock.calls[1]?.[0]).toBeUndefined();
      expect(clearBeforeRetry).toHaveBeenCalledWith({
        provider: "google-gemini-cli",
        reason,
        sessionId: "gemini-resumed-session",
      });
      expect(requireRecord(result.meta, "result meta").cliSessionId).toBe(`gemini-fresh-${reason}`);
    },
  );

  it.each(["timeout", "unknown", "context_overflow", "format"] as const)(
    "retries a fresh CLI session after recoverable %s failover without a failed agent_end",
    async (reason) => {
      const runId = `run-retry-${reason}`;
      const modelCallEvents: Array<{ callId: string; type: string }> = [];
      setDiagnosticsEnabledForProcess(true);
      const stopDiagnostics = onTrustedInternalDiagnosticEvent((event) => {
        if (
          event.type !== "model.call.started" &&
          event.type !== "model.call.completed" &&
          event.type !== "model.call.error"
        ) {
          return;
        }
        if (event.runId === runId) {
          modelCallEvents.push({ callId: event.callId, type: event.type });
        }
      });
      const hookRunner = {
        hasHooks: vi.fn((hookName: string) =>
          ["llm_input", "llm_output", "agent_end"].includes(hookName),
        ),
        runLlmInput: vi.fn(async () => undefined),
        runLlmOutput: vi.fn(async () => undefined),
        runAgentEnd: vi.fn(async () => undefined),
      };
      setHookRunnerForTest(hookRunner);
      enqueueSystemEventMock.mockClear();
      requestHeartbeatMock.mockClear();
      const events: string[] = [];
      let spawnCount = 0;
      supervisorSpawnMock.mockImplementation(async () => {
        spawnCount += 1;
        events.push(`spawn-${spawnCount}`);
        if (spawnCount === 1 && reason === "timeout") {
          return makeManagedRun({
            reason: "no-output-timeout",
            exitCode: null,
            exitSignal: "SIGKILL",
            durationMs: 200,
            timedOut: true,
            noOutputTimedOut: true,
          });
        }
        if (spawnCount === 1 && reason === "context_overflow") {
          return makeManagedRun({
            exitCode: 1,
            durationMs: 150,
            stderr: "Prompt is too long",
          });
        }
        if (spawnCount === 1 && reason === "format") {
          return makeManagedRun({
            stdout: [
              JSON.stringify({
                type: "assistant",
                message: {
                  model: "<synthetic>",
                  content: [{ type: "text", text: "No response requested." }],
                },
              }),
              JSON.stringify({ type: "result", subtype: "success", result: "" }),
            ].join("\n"),
          });
        }
        if (spawnCount === 1) {
          return makeManagedRun({
            exitCode: 1,
            durationMs: 150,
          });
        }
        if (reason === "format") {
          return makeManagedRun({
            stdout: JSON.stringify({ type: "result", result: "hello from fresh cli" }),
          });
        }
        return makeManagedRun({ stdout: "hello from fresh cli" });
      });
      const { dir, sessionFile, sessionTarget } = createSessionFixture({
        sessionKey: "agent:main:subagent:retry",
        history: [{ role: "user", content: "earlier context" }],
      });
      const clearBeforeRetry = vi.fn(async () => {
        events.push(`clear-${reason}`);
        return true;
      });

      try {
        const context = makeClaudePreparedContext({
          sessionKey: "agent:main:subagent:retry",
          runId,
          cliSessionId: "stale-cli-session",
          openClawHistoryPrompt: CLI_RESEED_PROMPT,
        });
        if (reason === "format") {
          context.preparedBackend.backend = {
            ...context.preparedBackend.backend,
            output: "jsonl",
            input: "stdin",
            jsonlDialect: "claude-stream-json",
          };
          context.backendResolved.config = context.preparedBackend.backend;
        }
        const result = await runPreparedCliAgent({
          ...context,
          params: {
            ...context.params,
            agentId: "main",
            sessionFile,
            sessionTarget,
            workspaceDir: dir,
            onBeforeFreshCliSessionRetry: clearBeforeRetry,
          },
        });

        expect(result.payloads).toEqual([{ text: "hello from fresh cli" }]);
        expect(result.meta.finalPromptText).toContain("User: earlier context");
        expect(result.meta.finalPromptText).toContain("<next_user_message>");
        expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
        expect(events).toEqual(["spawn-1", `clear-${reason}`, "spawn-2"]);
        if (reason === "timeout") {
          expect(enqueueSystemEventMock).not.toHaveBeenCalled();
          expect(requestHeartbeatMock).not.toHaveBeenCalled();
        }
        expect(clearBeforeRetry).toHaveBeenCalledWith({
          provider: "claude-cli",
          reason,
          sessionId: "stale-cli-session",
        });
        await vi.waitFor(() => {
          expect(hookRunner.runLlmInput).toHaveBeenCalledTimes(1);
          expect(hookRunner.runLlmOutput).toHaveBeenCalledTimes(1);
          expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
        });
        const agentEndEvent = requireRecord(
          callArg(hookRunner.runAgentEnd, 0, 0, "agent_end event"),
          "agent_end event",
        );
        expect(agentEndEvent.success).toBe(true);
        expect(agentEndEvent.error).toBeUndefined();
        await waitForDiagnosticEventsDrained();
        expect(modelCallEvents.map((event) => event.type)).toEqual([
          "model.call.started",
          "model.call.error",
          "model.call.started",
          "model.call.completed",
        ]);
        expect(modelCallEvents[0]?.callId).toBe(modelCallEvents[1]?.callId);
        expect(modelCallEvents[2]?.callId).toBe(modelCallEvents[3]?.callId);
        expect(modelCallEvents[0]?.callId).not.toBe(modelCallEvents[2]?.callId);
      } finally {
        stopDiagnostics();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("rethrows the retry failure when session-expired recovery retry also fails", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => ["llm_input", "agent_end"].includes(hookName)),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    setHookRunnerForTest(hookRunner);
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        exitCode: 1,
        durationMs: 150,
        stderr: "session expired",
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        exitCode: 1,
        durationMs: 150,
        stderr: "rate limit exceeded",
      }),
    );
    const { dir, sessionFile, sessionTarget } = createSessionFixture({
      sessionKey: "agent:main:subagent:retry",
      history: [{ role: "user", content: "earlier context" }],
    });
    const context = buildPreparedContext({
      sessionKey: "agent:main:subagent:retry",
      runId: "run-retry-failure",
      cliSessionId: "thread-123",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    const clearBeforeRetry = vi.fn(async () => true);

    try {
      await expect(
        runPreparedCliAgent({
          ...context,
          params: {
            ...context.params,
            agentId: "main",
            sessionFile,
            sessionTarget,
            workspaceDir: dir,
            onBeforeFreshCliSessionRetry: clearBeforeRetry,
          },
        }),
      ).rejects.toThrow("rate limit exceeded");

      expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => {
        expect(hookRunner.runLlmInput).toHaveBeenCalledTimes(1);
        expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
      });
      const agentEndEvent = requireRecord(
        callArg(hookRunner.runAgentEnd, 0, 0, "agent_end event"),
        "agent_end event",
      );
      expect(agentEndEvent.success).toBe(false);
      expect(agentEndEvent.error).toBe("rate limit exceeded");
      const messages = requireArray(agentEndEvent.messages, "agent_end messages");
      expect(messages).toHaveLength(2);
      expectTextMessage(messages[0], { role: "user", content: "earlier context" });
      expectTextMessage(messages[1], { role: "user", content: "hi" });
      expect(callArg(hookRunner.runAgentEnd, 0, 1, "agent_end context")).toBeTypeOf("object");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the assembled CLI prompt in meta for raw trace consumers", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from cli" }));

    const result = await runPreparedCliAgent(buildPreparedContext());

    expect(result.meta.finalPromptText).toContain("hi");
    expect(result.meta.finalAssistantRawText).toBe("hello from cli");
    const executionTrace = requireRecord(result.meta.executionTrace, "execution trace");
    expect(executionTrace.winnerProvider).toBe("codex-cli");
    expect(executionTrace.winnerModel).toBe("gpt-5.4");
    expect(executionTrace.fallbackUsed).toBe(false);
    expect(executionTrace.runner).toBe("cli");
    expect(executionTrace.attempts).toEqual([
      { provider: "codex-cli", model: "gpt-5.4", result: "success" },
    ]);
    const requestShaping = requireRecord(result.meta.requestShaping, "request shaping");
    expect(requestShaping.thinking).toBe("low");
    const completion = requireRecord(result.meta.completion, "completion");
    expect(completion.finishReason).toBe("stop");
    expect(completion.stopReason).toBe("completed");
    expect(completion.refusal).toBe(false);
    expect(result.meta.agentMeta?.contextTokens).toBeUndefined();
  });

  it("reports the prepared context budget for successful claude-cli runs", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from claude" }));

    const result = await runPreparedCliAgent(
      makeClaudePreparedContext({ model: "claude-opus-4-7" }),
    );

    expect(result.meta.agentMeta?.contextTokens).toBe(150_000);
  });

  it("returns accepted CLI session spawns when sessions_yield pauses the requester", async () => {
    const requesterTurnRunId = "run-cli-yield";
    const childRunId = "run-cli-child";
    const childSessionKey = "agent:main:subagent:cli-child";
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const spawnCapture = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY,
        toolName: "sessions_spawn",
        args: { task: "review" },
      });
      if (!spawnCapture) {
        throw new Error("missing sessions_spawn capture");
      }
      recordMcpLoopbackToolCallResult({
        captureHandle: spawnCapture,
        toolName: "sessions_spawn",
        args: { task: "review" },
        outcome: "completed",
        result: {
          details: {
            status: "accepted",
            runId: childRunId,
            childSessionKey,
            expectsCompletionMessage: true,
          },
        },
      });
      markMcpLoopbackToolCallFinished(spawnCapture);
      const captureHandle = markMcpLoopbackRequestStarted(input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY);
      await resolveMcpLoopbackYieldContext(captureHandle)?.onYield("waiting on subagents");
      markMcpLoopbackRequestFinished(captureHandle);
      input.onStdout?.("yield acknowledged");
      return makeManagedRun();
    });
    const context = buildPreparedContext({
      sessionKey: "agent:main:main",
      runId: requesterTurnRunId,
    });
    context.mcpDeliveryCapture = true;

    const result = await runPreparedCliAgent(context);

    expect(result).toMatchObject({
      acceptedSessionSpawns: [
        { runId: childRunId, childSessionKey, expectsCompletionMessage: true },
      ],
      meta: {
        yielded: true,
        livenessState: "paused",
        stopReason: "end_turn",
        completion: {
          finishReason: "end_turn",
          stopReason: "end_turn",
          refusal: false,
        },
      },
    });
  });

  it.each([
    ["rejected", { details: { status: "rejected", error: "not accepted" } }],
    ["malformed accepted", { details: { status: "accepted", runId: "run-without-session" } }],
  ] as const)("does not retain a %s CLI session spawn", async (_label, spawnResult) => {
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const spawnCapture = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY,
        toolName: "sessions_spawn",
        args: { task: "review" },
      });
      if (!spawnCapture) {
        throw new Error("missing sessions_spawn capture");
      }
      recordMcpLoopbackToolCallResult({
        captureHandle: spawnCapture,
        toolName: "sessions_spawn",
        args: { task: "review" },
        outcome: "completed",
        result: spawnResult,
      });
      markMcpLoopbackToolCallFinished(spawnCapture);
      const yieldCapture = markMcpLoopbackRequestStarted(input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY);
      await resolveMcpLoopbackYieldContext(yieldCapture)?.onYield("waiting on subagents");
      markMcpLoopbackRequestFinished(yieldCapture);
      input.onStdout?.("yield acknowledged");
      return makeManagedRun();
    });
    const context = buildPreparedContext({
      sessionKey: "agent:main:main",
      runId: "run-cli-unproven-spawn",
    });
    context.mcpDeliveryCapture = true;

    const result = await runPreparedCliAgent(context);

    expect(result.acceptedSessionSpawns).toBeUndefined();
    expect(result.meta).toMatchObject({ yielded: true, livenessState: "paused" });
  });

  it("seeds fresh CLI sessions from the OpenClaw transcript", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from cli" }));

    const result = await runPreparedCliAgent(
      buildPreparedContext({
        openClawHistoryPrompt:
          "Continue this conversation using the OpenClaw transcript below.\n\nUser: earlier ask\n\nAssistant: earlier answer\n\n<next_user_message>\nhi\n</next_user_message>",
      }),
    );

    expect(result.meta.finalPromptText).toContain("User: earlier ask");
    expect(result.meta.finalPromptText).toContain("Assistant: earlier answer");
  });

  it("keeps resumed CLI sessions on native resume history", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from cli" }));

    const result = await runPreparedCliAgent(
      buildPreparedContext({
        cliSessionId: "cli-session",
        openClawHistoryPrompt: "User: earlier ask",
      }),
    );

    expect(result.meta.finalPromptText).not.toContain("User: earlier ask");
    expect(result.meta.finalPromptText).toContain("hi");
  });

  it("keeps CLI reply backend cancellation attached until the managed run finishes", async () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "s1",
      resetTriggered: false,
    });
    operation.setPhase("running");
    let finishRun: (() => void) | undefined;
    const waitForExit = new Promise<
      Awaited<ReturnType<ReturnType<typeof createManagedRun>["wait"]>>
    >((resolve) => {
      finishRun = () => {
        resolve(makeRunExit({ stdout: "hello from cli" }));
      };
    });
    supervisorSpawnMock.mockResolvedValueOnce({
      ...makeManagedRun({ stdout: "unused" }),
      wait: vi.fn(() => waitForExit),
    });

    const run = executePreparedCliRun({
      ...buildPreparedContext({ sessionKey: "agent:main:main" }),
      params: {
        ...buildPreparedContext({ sessionKey: "agent:main:main" }).params,
        replyOperation: operation,
      },
    });

    finishRun?.();
    const result = await run;
    expect(result.text).toBe("hello from cli");
    operation.complete();
  });

  it("keeps raw assistant output separate from transformed visible CLI output", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from cli" }));

    const result = await runPreparedCliAgent({
      ...buildPreparedContext(),
      backendResolved: {
        ...buildPreparedContext().backendResolved,
        textTransforms: {
          output: [{ from: "hello", to: "goodbye" }],
        },
      },
    });

    expect(result.payloads).toEqual([{ text: "goodbye from cli" }]);
    expect(result.meta.finalAssistantVisibleText).toBe("goodbye from cli");
    expect(result.meta.finalAssistantRawText).toBe("hello from cli");
  });

  it("emits llm_input, llm_output, and agent_end hooks for successful CLI runs", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) =>
        ["llm_input", "llm_output", "agent_end"].includes(hookName),
      ),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    setHookRunnerForTest(hookRunner);
    const { dir, sessionFile, sessionTarget } = createSessionFixture();

    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from cli" }));

    try {
      await runPreparedCliAgent({
        ...buildPreparedContext(),
        params: {
          ...buildPreparedContext().params,
          sessionFile,
          sessionTarget,
          workspaceDir: dir,
          sessionKey: "agent:main:main",
          agentId: "main",
          messageProvider: "acp",
          messageChannel: "telegram",
          trigger: "user",
          senderId: "sender-1",
          chatId: "chat-1",
          channelContext: {
            sender: { id: "sender-1" },
            chat: { id: "chat-1" },
          },
        },
      });

      await vi.waitFor(() => {
        expect(hookRunner.runLlmInput).toHaveBeenCalledTimes(1);
        expect(hookRunner.runLlmOutput).toHaveBeenCalledTimes(1);
        expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
      });

      const llmInputEvent = requireRecord(
        callArg(hookRunner.runLlmInput, 0, 0, "llm_input event"),
        "llm_input event",
      );
      expect(llmInputEvent.runId).toBe("run-2");
      expect(llmInputEvent.sessionId).toBe("s1");
      expect(llmInputEvent.provider).toBe("codex-cli");
      expect(llmInputEvent.model).toBe("gpt-5.4");
      expect(llmInputEvent.prompt).toBe("hi");
      expect(llmInputEvent.systemPrompt).toBe("You are a helpful assistant.");
      expect(Array.isArray(llmInputEvent.historyMessages)).toBe(true);
      expect(llmInputEvent.imagesCount).toBe(0);

      const llmInputContext = requireRecord(
        callArg(hookRunner.runLlmInput, 0, 1, "llm_input context"),
        "llm_input context",
      );
      expect(llmInputContext.runId).toBe("run-2");
      expect(llmInputContext.agentId).toBe("main");
      expect(llmInputContext.sessionKey).toBe("agent:main:main");
      expect(llmInputContext.sessionId).toBe("s1");
      expect(llmInputContext.workspaceDir).toBe(dir);
      expect(llmInputContext.messageProvider).toBe("acp");
      expect(llmInputContext.trigger).toBe("user");
      expect(llmInputContext.channel).toBe("telegram");
      expect(llmInputContext.channelId).toBe("telegram");
      expect(llmInputContext.senderId).toBe("sender-1");
      expect(llmInputContext.chatId).toBe("chat-1");
      expect(llmInputContext.channelContext).toEqual({
        sender: { id: "sender-1" },
        chat: { id: "chat-1" },
      });

      const llmOutputEvent = requireRecord(
        callArg(hookRunner.runLlmOutput, 0, 0, "llm_output event"),
        "llm_output event",
      );
      expect(llmOutputEvent.runId).toBe("run-2");
      expect(llmOutputEvent.sessionId).toBe("s1");
      expect(llmOutputEvent.provider).toBe("codex-cli");
      expect(llmOutputEvent.model).toBe("gpt-5.4");
      expect(llmOutputEvent.contextTokenBudget).toBe(150_000);
      expect(llmOutputEvent.contextWindowSource).toBe("modelsConfig");
      expect(llmOutputEvent.contextWindowReferenceTokens).toBe(200_000);
      expect(llmOutputEvent.assistantTexts).toEqual(["hello from cli"]);
      const lastAssistant = requireRecord(llmOutputEvent.lastAssistant, "last assistant");
      expect(lastAssistant.role).toBe("assistant");
      expect(lastAssistant.content).toEqual([{ type: "text", text: "hello from cli" }]);
      expect(lastAssistant.provider).toBe("codex-cli");
      expect(lastAssistant.model).toBe("gpt-5.4");
      const llmOutputContext = requireRecord(
        callArg(hookRunner.runLlmOutput, 0, 1, "llm_output context"),
        "llm_output context",
      );
      expect(llmOutputContext.contextTokenBudget).toBe(150_000);
      expect(llmOutputContext.contextWindowSource).toBe("modelsConfig");
      expect(llmOutputContext.contextWindowReferenceTokens).toBe(200_000);

      const agentEndEvent = requireRecord(
        callArg(hookRunner.runAgentEnd, 0, 0, "agent_end event"),
        "agent_end event",
      );
      expect(agentEndEvent.success).toBe(true);
      const messages = requireArray(agentEndEvent.messages, "agent_end messages");
      expect(messages).toHaveLength(2);
      expectTextMessage(messages[0], { role: "user", content: "hi" });
      const assistantMessage = requireRecord(messages[1], "assistant message");
      expect(assistantMessage.role).toBe("assistant");
      expect(assistantMessage.content).toEqual([{ type: "text", text: "hello from cli" }]);
      const agentEndContext = requireRecord(
        callArg(hookRunner.runAgentEnd, 0, 1, "agent_end context"),
        "agent_end context",
      );
      expect(agentEndContext.senderId).toBe("sender-1");
      expect(agentEndContext.chatId).toBe("chat-1");
      expect(agentEndContext.channelContext).toEqual({
        sender: { id: "sender-1" },
        chat: { id: "chat-1" },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for agent_end hooks before resolving successful CLI runs", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "agent_end"),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(() => agentEndSettled),
    };
    setHookRunnerForTest(hookRunner);

    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from cli" }));

    let resolved = false;
    const run = runPreparedCliAgent(buildPreparedContext()).then((result) => {
      resolved = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseAgentEnd();
    await expect(run).resolves.toMatchObject({
      payloads: [{ text: "hello from cli" }],
    });
    expect(resolved).toBe(true);
  });

  it("does not wait for agent_end hooks before resolving channel-backed CLI runs", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "agent_end"),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(() => agentEndSettled),
    };
    setHookRunnerForTest(hookRunner);

    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from cli" }));

    const context = buildPreparedContext();
    let resolved = false;
    const run = runPreparedCliAgent({
      ...context,
      params: {
        ...context.params,
        messageProvider: "acp",
        messageChannel: "telegram",
      },
    }).then((result) => {
      resolved = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(resolved).toBe(true);
    });

    await expect(run).resolves.toMatchObject({
      payloads: [{ text: "hello from cli" }],
    });
    expect(callArg(hookRunner.runAgentEnd, 0, 2, "agent_end options")).toEqual({
      unrefTimeout: true,
    });

    releaseAgentEnd();
  });

  it("persists approved CLI user turns and successful assistant output", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from cli" }));
    const { dir, sessionFile, sessionTarget, storePath } = createSessionFixture();
    const onUserMessagePersisted = vi.fn();

    try {
      const context = buildPreparedContext({
        sessionKey: "agent:main:main",
        runId: "run-persist-cli",
      });
      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "display prompt",
          timestamp: 123,
          idempotencyKey: "run-persist-cli:user",
        },
        target: {
          sessionId: "s1",
          sessionKey: "agent:main:main",
          sessionEntry: {
            sessionId: "s1",
            sessionFile,
            updatedAt: 10,
          },
          storePath,
          agentId: "main",
          cwd: dir,
        },
        updateMode: "none",
      });
      const result = await runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          agentId: "main",
          sessionFile,
          sessionTarget,
          storePath,
          workspaceDir: dir,
          prompt: "runtime prompt",
          persistAssistantTranscript: true,
          userTurnTranscriptRecorder: recorder,
          onUserMessagePersisted,
        },
      });

      expect(result.payloads).toEqual([{ text: "hello from cli" }]);
      expect(getReplyPayloadMetadata(result.payloads?.[0] ?? {})).toMatchObject({
        assistantTranscriptOwned: true,
        assistantTranscriptIdempotencyKey: "cli-assistant:run-persist-cli",
      });
      expect(onUserMessagePersisted).toHaveBeenCalledOnce();
      expect(onUserMessagePersisted).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "user",
          content: "display prompt",
        }),
      );

      const messages = await readTranscriptMessages(sessionTarget);
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "user",
          content: "display prompt",
          timestamp: 123,
          idempotencyKey: "run-persist-cli:user",
        }),
      );
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "hello from cli" }],
          api: "cli",
          provider: "codex-cli",
          model: "gpt-5.4",
          idempotencyKey: "cli-assistant:run-persist-cli",
        }),
      );
      expect(
        messages.filter((message) => (message as { role?: string }).role === "user"),
      ).toHaveLength(1);
      expect(JSON.stringify(messages)).not.toContain("runtime prompt");
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionId: "s1",
        sessionKey: "agent:main:main",
        storePath,
      });
      expect(events).toContainEqual(expect.objectContaining({ type: "session", cwd: dir }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors CLI retry suppression before approved user-turn persistence", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from retry" }));
    const { dir, sessionFile, sessionTarget, storePath } = createSessionFixture();
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "suppressed display prompt",
        idempotencyKey: "run-suppressed-cli:user",
      },
      target: {
        sessionId: "s1",
        sessionKey: "agent:main:main",
        sessionEntry: {
          sessionId: "s1",
          sessionFile,
          updatedAt: 10,
        },
        storePath,
        agentId: "main",
      },
      updateMode: "none",
    });
    const persistApprovedSpy = vi.spyOn(recorder, "persistApproved");
    const onUserMessagePersisted = vi.fn();

    try {
      const context = buildPreparedContext({
        sessionKey: "agent:main:main",
        runId: "run-suppressed-cli",
      });
      const result = await runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          agentId: "main",
          sessionFile,
          sessionTarget,
          workspaceDir: dir,
          prompt: "runtime prompt",
          storePath,
          userTurnTranscriptRecorder: recorder,
          suppressNextUserMessagePersistence: true,
          onUserMessagePersisted,
        },
      });

      expect(result.payloads).toEqual([{ text: "hello from retry" }]);
      expect(persistApprovedSpy).not.toHaveBeenCalled();
      expect(onUserMessagePersisted).not.toHaveBeenCalled();
      await expect(readTranscriptMessages(sessionTarget)).resolves.toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors a CLI user-turn recorder target that skips after session rebound", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello after rebound" }));
    const { dir, sessionFile, sessionTarget, storePath } = createSessionFixture();
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "stale rebound prompt",
        idempotencyKey: "run-rebound-recorder:user",
      },
      target: () => undefined,
      updateMode: "none",
    });
    const persistApprovedSpy = vi.spyOn(recorder, "persistApproved");
    const onUserMessagePersisted = vi.fn();

    try {
      const context = buildPreparedContext({
        sessionKey: "agent:main:main",
        runId: "run-rebound-recorder",
      });
      const result = await runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          agentId: "main",
          sessionFile,
          sessionTarget,
          workspaceDir: dir,
          prompt: "runtime prompt",
          storePath,
          userTurnTranscriptRecorder: recorder,
          onUserMessagePersisted,
        },
      });

      expect(result.payloads).toEqual([{ text: "hello after rebound" }]);
      expect(persistApprovedSpy).toHaveBeenCalledOnce();
      expect(onUserMessagePersisted).not.toHaveBeenCalled();
      await expect(readTranscriptMessages(sessionTarget)).resolves.toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records transformed fresh Claude reseed prompts with durable local proof", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from claude" }));
    const { dir, sessionFile, sessionTarget } = createSessionFixture();
    const historyPrompt = [
      "Continue this conversation using the OpenClaw transcript below as prior session history.",
      "Treat it as authoritative context for this fresh CLI session.",
      "",
      "<conversation_history>",
      "User: earlier ask",
      "</conversation_history>",
      "",
      "<next_user_message>",
      "current ask",
      "</next_user_message>",
    ].join("\n");

    try {
      setCliRunnerTestDeps({
        claudeCliSessionTranscriptHasContent: async () => true,
      });
      const context = makeClaudePreparedContext({
        model: "claude-opus-4-6",
        openClawHistoryPrompt: historyPrompt,
      });
      context.preparedBackend.backend.sessionMode = "always";
      context.backendResolved.textTransforms = {
        input: [{ from: /[<>]/g, to: "_" }],
      };
      context.params = {
        ...context.params,
        agentId: "main",
        sessionFile,
        sessionTarget,
        workspaceDir: dir,
        userTurnTranscriptRecorder: createCliUserTurnRecorder({
          text: "current ask",
          sessionTarget,
          workspaceDir: dir,
        }),
      };

      const result = await runPreparedCliAgent(context);
      const binding = result.meta.agentMeta?.cliSessionBinding;

      expect(binding?.reseedReceipt).toEqual({
        version: 1,
        promptHash: hashCliReseedPrompt(historyPrompt.replace(/[<>]/g, "_")),
        localSessionId: "s1",
        userTurnDisposition: "persisted",
      });
    } finally {
      restoreCliRunnerTestDeps();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not mint a reseed receipt without caller-owned durable proof", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from claude" }));
    const { dir, sessionFile, sessionTarget } = createSessionFixture();

    try {
      setCliRunnerTestDeps({
        claudeCliSessionTranscriptHasContent: async () => true,
      });
      const context = makeClaudePreparedContext({
        model: "claude-opus-4-6",
        openClawHistoryPrompt: CLI_RESEED_PROMPT,
      });
      context.preparedBackend.backend.sessionMode = "always";
      context.params = {
        ...context.params,
        agentId: "main",
        sessionFile,
        sessionTarget,
        workspaceDir: dir,
        transcriptPrompt: "canonical current ask",
      };

      const result = await runPreparedCliAgent(context);

      expect(result.meta.agentMeta?.cliSessionBinding?.reseedReceipt).toBeUndefined();
      await expect(readTranscriptMessages(sessionTarget)).resolves.not.toContainEqual(
        expect.objectContaining({ role: "user" }),
      );
    } finally {
      restoreCliRunnerTestDeps();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mints an omission receipt for a trusted suppressed reseed turn", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from claude" }));
    const { dir, sessionFile, sessionTarget } = createSessionFixture();
    const recorder = createUserTurnTranscriptRecorder({
      target: createTestUserTurnTranscriptTarget({
        sessionId: "s1",
        sessionKey: "agent:main:main",
        agentId: "main",
        cwd: dir,
        storePath: sessionTarget.storePath,
      }),
    });
    recorder.markBlocked();

    try {
      setCliRunnerTestDeps({
        claudeCliSessionTranscriptHasContent: async () => true,
      });
      const context = makeClaudePreparedContext({
        model: "claude-opus-4-6",
        openClawHistoryPrompt: CLI_RESEED_PROMPT,
      });
      context.preparedBackend.backend.sessionMode = "always";
      context.params = {
        ...context.params,
        agentId: "main",
        sessionFile,
        sessionTarget,
        workspaceDir: dir,
        suppressNextUserMessagePersistence: true,
        userTurnTranscriptRecorder: recorder,
      };

      const result = await runPreparedCliAgent(context);

      expect(result.meta.agentMeta?.cliSessionBinding?.reseedReceipt).toEqual({
        version: 1,
        promptHash: hashCliReseedPrompt(CLI_RESEED_PROMPT),
        localSessionId: "s1",
        userTurnDisposition: "omitted",
      });
      await expect(readTranscriptMessages(sessionTarget)).resolves.toEqual([]);
    } finally {
      restoreCliRunnerTestDeps();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses durable local proof when a fallback suppresses duplicate persistence", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from claude" }));
    const { dir, sessionFile, sessionTarget } = createSessionFixture();
    const recorder = createCliUserTurnRecorder({
      text: "current ask",
      sessionTarget,
      workspaceDir: dir,
    });

    try {
      const persisted = await recorder.persistApproved();
      expect(persisted?.messageId).toEqual(expect.any(String));
      setCliRunnerTestDeps({
        claudeCliSessionTranscriptHasContent: async () => true,
      });
      const context = makeClaudePreparedContext({
        model: "claude-opus-4-6",
        openClawHistoryPrompt: CLI_RESEED_PROMPT,
      });
      context.preparedBackend.backend.sessionMode = "always";
      const onUserMessagePersisted = vi.fn();
      context.params = {
        ...context.params,
        agentId: "main",
        sessionFile,
        sessionTarget,
        workspaceDir: dir,
        suppressNextUserMessagePersistence: true,
        userTurnTranscriptRecorder: recorder,
        onUserMessagePersisted,
      };

      const result = await runPreparedCliAgent(context);

      expect(result.meta.agentMeta?.cliSessionBinding?.reseedReceipt).toEqual({
        version: 1,
        promptHash: hashCliReseedPrompt(CLI_RESEED_PROMPT),
        localSessionId: "s1",
        userTurnDisposition: "persisted",
      });
      expect(onUserMessagePersisted).not.toHaveBeenCalled();
    } finally {
      restoreCliRunnerTestDeps();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses runtime-owned persistence proof", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from claude" }));
    const { dir, sessionFile, sessionTarget } = createSessionFixture();
    const recorder = createCliUserTurnRecorder({
      text: "current ask",
      sessionTarget,
      workspaceDir: dir,
    });
    recorder.markRuntimePersisted({
      role: "user",
      content: "current ask",
      timestamp: Date.now(),
    });

    try {
      setCliRunnerTestDeps({
        claudeCliSessionTranscriptHasContent: async () => true,
      });
      const context = makeClaudePreparedContext({
        model: "claude-opus-4-6",
        openClawHistoryPrompt: CLI_RESEED_PROMPT,
      });
      context.preparedBackend.backend.sessionMode = "always";
      context.params = {
        ...context.params,
        agentId: "main",
        sessionFile,
        sessionTarget,
        workspaceDir: dir,
        suppressNextUserMessagePersistence: true,
        userTurnTranscriptRecorder: recorder,
      };

      const result = await runPreparedCliAgent(context);

      expect(result.meta.agentMeta?.cliSessionBinding?.reseedReceipt).toEqual({
        version: 1,
        promptHash: hashCliReseedPrompt(CLI_RESEED_PROMPT),
        localSessionId: "s1",
        userTurnDisposition: "persisted",
      });
    } finally {
      restoreCliRunnerTestDeps();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves a reseed receipt when reusing the same Claude CLI session", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello again" }));
    const reseedReceipt = {
      version: 1 as const,
      promptHash: "a".repeat(64),
      localSessionId: "s1",
      userTurnDisposition: "persisted" as const,
    };
    const context = makeClaudePreparedContext({
      model: "claude-opus-4-6",
      cliSessionId: "existing-cli-session",
    });
    context.params.cliSessionBinding = {
      sessionId: "existing-cli-session",
      reseedReceipt,
    };

    setCliRunnerTestDeps({
      claudeCliSessionTranscriptHasContent: async () => true,
    });
    const result = await runPreparedCliAgent(context).finally(() => {
      restoreCliRunnerTestDeps();
    });

    expect(result.meta.agentMeta?.cliSessionBinding?.reseedReceipt).toEqual(reseedReceipt);
  });

  it("lets before_message_write block CLI assistant persistence without delivery fallback", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_message_write"),
      runBeforeMessageWrite: vi.fn(() => ({ block: true })),
    };
    setHookRunnerForTest(hookRunner);
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "secret CLI output" }));
    const { dir, sessionFile, sessionTarget, storePath } = createSessionFixture();

    try {
      const context = buildPreparedContext({
        sessionKey: "agent:main:main",
        runId: "run-blocked-cli",
      });
      context.preparedBackend.backend.sessionMode = "none";
      context.backendResolved.config = context.preparedBackend.backend;
      const result = await runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          agentId: "main",
          sessionFile,
          sessionTarget,
          workspaceDir: dir,
          persistAssistantTranscript: true,
          storePath,
        },
      });

      expect(result.payloads).toEqual([{ text: "secret CLI output" }]);
      expect(getReplyPayloadMetadata(result.payloads?.[0] ?? {})).toMatchObject({
        assistantTranscriptOwned: true,
      });
      await expect(readTranscriptMessages(sessionTarget)).resolves.toEqual([]);
      expect(hookRunner.runBeforeMessageWrite).toHaveBeenCalledOnce();
      expect(
        callArg(hookRunner.runBeforeMessageWrite, 0, 1, "before_message_write context"),
      ).toEqual({
        agentId: "main",
        sessionKey: "agent:main:main",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not append late CLI output after the session key is rebound", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "late CLI output" }));
    const { dir, sessionFile, sessionTarget, storePath } = createSessionFixture();
    const replacementTarget = { ...sessionTarget, sessionId: "s2" };
    await upsertSessionEntryCore(sessionTarget, { sessionId: "s2", updatedAt: Date.now() });

    try {
      const context = buildPreparedContext({
        sessionKey: "agent:main:main",
        runId: "run-rebound-cli",
      });
      const result = await runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          agentId: "main",
          sessionFile,
          sessionTarget,
          workspaceDir: dir,
          persistAssistantTranscript: true,
          storePath,
        },
      });

      expect(result.payloads).toEqual([{ text: "late CLI output" }]);
      expect(getReplyPayloadMetadata(result.payloads?.[0] ?? {})).toMatchObject({
        assistantTranscriptOwned: true,
      });
      await expect(readTranscriptMessages(sessionTarget)).resolves.toEqual([]);
      await expect(readTranscriptMessages(replacementTarget)).resolves.toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not persist private room-event assistant output", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "private ambient output" }));
    const { dir, sessionFile, sessionTarget, storePath } = createSessionFixture();

    try {
      const context = buildPreparedContext({
        sessionKey: "agent:main:main",
        runId: "run-private-room-event",
      });
      const result = await runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          agentId: "main",
          sessionFile,
          sessionTarget,
          workspaceDir: dir,
          persistAssistantTranscript: true,
          storePath,
          currentInboundEventKind: "room_event",
        },
      });

      expect(result.payloads).toEqual([{ text: "private ambient output" }]);
      expect(getReplyPayloadMetadata(result.payloads?.[0] ?? {})).toMatchObject({
        assistantTranscriptOwned: true,
      });
      await expect(readTranscriptMessages(sessionTarget)).resolves.toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes cwd to approved CLI user-turn persistence", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from cli" }));
    const { dir, sessionFile, sessionTarget } = createSessionFixture();
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-persist-cwd-"));
    let capturedCwd: unknown;
    const recorder = {
      message: undefined,
      resolveMessage: vi.fn(async () => undefined),
      markRuntimePersistencePending: vi.fn(),
      markRuntimePersisted: vi.fn(),
      markBlocked: vi.fn(),
      hasPersisted: vi.fn(() => false),
      isBlocked: vi.fn(() => false),
      hasRuntimePersistencePending: vi.fn(() => false),
      waitForRuntimePersistence: vi.fn(async () => undefined),
      persistApproved: vi.fn(async (options?: { cwd?: unknown }) => {
        capturedCwd = options?.cwd;
        return {
          sessionFile,
          sessionEntry: undefined,
          messageId: "message-1",
          message: {
            role: "user",
            content: "display prompt",
          },
        };
      }),
      persistFallback: vi.fn(async () => undefined),
    } as unknown as UserTurnTranscriptRecorder;

    try {
      const context = buildPreparedContext({
        sessionKey: "agent:main:main",
        runId: "run-persist-cli-cwd",
      });
      const result = await runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          agentId: "main",
          sessionFile,
          sessionTarget,
          workspaceDir: dir,
          cwd: taskDir,
          prompt: "runtime prompt",
          userTurnTranscriptRecorder: recorder,
        },
      });

      expect(result.payloads).toEqual([{ text: "hello from cli" }]);
      expect(recorder.persistApproved).toHaveBeenCalledOnce();
      expect(capturedCwd).toBe(taskDir);
    } finally {
      fs.rmSync(taskDir, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses an existing user-turn recorder for approved CLI persistence", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from cli" }));
    const { dir, sessionFile, sessionTarget } = createSessionFixture();
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "recorder display prompt",
        media: [{ path: "/tmp/image.png", contentType: "image/png" }],
        timestamp: 123,
        idempotencyKey: "cli-recorder:user",
      },
      target: createTestUserTurnTranscriptTarget({
        sessionId: "s1",
        sessionKey: "agent:main:main",
        cwd: dir,
        storePath: sessionTarget.storePath,
      }),
      updateMode: "none",
    });

    try {
      const context = buildPreparedContext({
        sessionKey: "agent:main:main",
        runId: "run-persist-cli-recorder",
      });
      const result = await runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          agentId: "main",
          sessionFile,
          sessionTarget,
          workspaceDir: dir,
          prompt: "runtime prompt",
          userTurnTranscriptRecorder: recorder,
        },
      });

      expect(result.payloads).toEqual([{ text: "hello from cli" }]);
      expect(recorder.hasPersisted()).toBe(true);

      const messages = await readTranscriptMessages(sessionTarget);
      expect(messages).toEqual([
        expect.objectContaining({
          role: "user",
          content: "recorder display prompt",
          __openclaw: {
            media: [expect.objectContaining({ path: "/tmp/image.png", contentType: "image/png" })],
          },
          timestamp: 123,
          idempotencyKey: "cli-recorder:user",
        }),
      ]);
      expect(JSON.stringify(messages)).not.toContain("legacy display prompt");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks a before_message_write-rejected CLI user turn as blocked", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_message_write"),
      runBeforeMessageWrite: vi.fn(() => ({ block: true })),
    };
    setHookRunnerForTest(hookRunner);
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from cli" }));
    const { dir, sessionFile, sessionTarget } = createSessionFixture();
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "blocked user turn" },
      target: createTestUserTurnTranscriptTarget({
        sessionId: "s1",
        sessionKey: "agent:main:main",
        cwd: dir,
        storePath: sessionTarget.storePath,
      }),
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });

    try {
      const context = buildPreparedContext({
        sessionKey: "agent:main:main",
        runId: "run-blocked-cli-user-turn",
      });
      const result = await runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          agentId: "main",
          sessionFile,
          sessionTarget,
          workspaceDir: dir,
          prompt: "runtime prompt",
          userTurnTranscriptRecorder: recorder,
        },
      });

      expect(result.payloads).toEqual([{ text: "hello from cli" }]);
      expect(recorder.hasPersisted()).toBe(false);
      expect(recorder.isBlocked()).toBe(true);
      await expect(readTranscriptMessages(sessionTarget)).resolves.toEqual([]);
      expect(hookRunner.runBeforeMessageWrite).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not fail CLI execution when persistence notification fails", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({ stdout: "hello despite notification failure" }),
    );
    const { dir, sessionFile, sessionTarget } = createSessionFixture();

    try {
      const context = buildPreparedContext({
        sessionKey: "agent:main:main",
        runId: "run-persist-notify-fail",
      });
      const result = await runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          agentId: "main",
          sessionFile,
          sessionTarget,
          workspaceDir: dir,
          prompt: "runtime prompt",
          userTurnTranscriptRecorder: createCliUserTurnRecorder({
            text: "display prompt",
            sessionTarget,
            sessionKey: "agent:main:main",
            workspaceDir: dir,
          }),
          onUserMessagePersisted: () => {
            throw new Error("notification failed");
          },
        },
      });

      expect(result.payloads).toEqual([{ text: "hello despite notification failure" }]);
      expect(supervisorSpawnMock).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not execute the CLI when approved user turn persistence fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-persist-fail-"));
    const onUserMessagePersisted = vi.fn();
    // SQLite-backed persistence no longer fails via blocked transcript
    // directories; a rejecting recorder models the same persistence failure.
    const recorder = {
      message: undefined,
      resolveMessage: vi.fn(async () => undefined),
      markRuntimePersistencePending: vi.fn(),
      markRuntimePersisted: vi.fn(),
      markBlocked: vi.fn(),
      hasPersisted: vi.fn(() => false),
      isBlocked: vi.fn(() => false),
      hasRuntimePersistencePending: vi.fn(() => false),
      waitForRuntimePersistence: vi.fn(async () => undefined),
      persistApproved: vi.fn(async () => {
        throw new Error("user turn persistence failed");
      }),
      persistFallback: vi.fn(async () => undefined),
    } as unknown as UserTurnTranscriptRecorder;

    try {
      const context = buildPreparedContext({
        sessionKey: "agent:main:main",
        runId: "run-persist-fails",
      });

      await expect(
        runPreparedCliAgent({
          ...context,
          params: {
            ...context.params,
            agentId: "main",
            sessionFile: path.join(dir, "s1.jsonl"),
            workspaceDir: dir,
            prompt: "runtime prompt",
            userTurnTranscriptRecorder: recorder,
            onUserMessagePersisted,
          },
        }),
      ).rejects.toThrow();

      expect(supervisorSpawnMock).not.toHaveBeenCalled();
      expect(onUserMessagePersisted).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks CLI runs before llm_input and model execution when before_agent_run blocks", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) =>
        ["before_agent_run", "llm_input", "agent_end"].includes(hookName),
      ),
      runBeforeAgentRun: vi.fn(async () => ({
        pluginId: "policy-plugin",
        decision: {
          outcome: "block" as const,
          reason: "matched secret prompt: secret prompt",
          message: "The agent cannot read this message.",
        },
      })),
      runLlmInput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(() => agentEndSettled),
    };
    setHookRunnerForTest(hookRunner);
    const { dir, sessionFile, sessionTarget, storePath } = createSessionFixture({
      history: [{ role: "user", content: "earlier context" }],
    });

    try {
      let resolved = false;
      const context = makeClaudePreparedContext({
        sessionKey: "agent:main:main",
        runId: "run-blocked-cli",
      });
      context.preparedBackend.backend.sessionMode = "none";
      const run = runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          agentId: "main",
          sessionFile,
          sessionTarget,
          storePath,
          workspaceDir: dir,
          prompt: "secret prompt",
        },
      }).then((result) => {
        resolved = true;
        return result;
      });

      await vi.waitFor(() => {
        expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
      });
      await Promise.resolve();
      expect(resolved).toBe(false);

      releaseAgentEnd();
      const result = await run;

      expect(result.payloads).toEqual([
        {
          text: "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)",
          isError: true,
        },
      ]);
      expect(result.meta.livenessState).toBe("blocked");
      expect(result.meta.agentMeta?.clearCliSessionBinding).toBe(true);
      expect(result.meta.agentMeta?.contextTokens).toBe(150_000);
      expect(supervisorSpawnMock).not.toHaveBeenCalled();
      expect(hookRunner.runLlmInput).not.toHaveBeenCalled();
      const transcriptEvents = await loadTranscriptEvents({
        agentId: "main",
        sessionId: context.params.sessionId,
        sessionKey: "agent:main:main",
        storePath,
      });
      expect(transcriptEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "user",
              content: expect.arrayContaining([
                expect.objectContaining({
                  text: "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)",
                }),
              ]),
            }),
          }),
        ]),
      );
      const beforeRunEvent = requireRecord(
        callArg(hookRunner.runBeforeAgentRun, 0, 0, "before_agent_run event"),
        "before_agent_run event",
      );
      expect(beforeRunEvent.prompt).toBe("secret prompt");
      const beforeRunMessages = requireArray(beforeRunEvent.messages, "before_agent_run messages");
      expect(
        beforeRunMessages.some((message) => {
          const record = requireRecord(message, "before_agent_run message");
          return record.role === "user" && record.content === "earlier context";
        }),
      ).toBe(true);
      const beforeRunContext = requireRecord(
        callArg(hookRunner.runBeforeAgentRun, 0, 1, "before_agent_run context"),
        "before_agent_run context",
      );
      expect(beforeRunContext.runId).toBe("run-blocked-cli");
      expect(beforeRunContext.agentId).toBe("main");
      expect(beforeRunContext.sessionKey).toBe("agent:main:main");
      expect(resolved).toBe(true);
      const agentEndEvent = requireRecord(
        callArg(hookRunner.runAgentEnd, 0, 0, "agent_end event"),
        "agent_end event",
      );
      expect(agentEndEvent.success).toBe(false);
      expect(agentEndEvent.error).toBe(
        "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)",
      );
      const agentEndMessages = requireArray(agentEndEvent.messages, "agent_end messages");
      expect(
        agentEndMessages.some((message) => {
          const record = requireRecord(message, "agent_end message");
          return (
            record.role === "user" &&
            record.content ===
              "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)"
          );
        }),
      ).toBe(true);
      expect(callArg(hookRunner.runAgentEnd, 0, 1, "agent_end context")).toBeTypeOf("object");
      expect(JSON.stringify(hookRunner.runAgentEnd.mock.calls)).not.toContain("secret prompt");

      const blockedLine = requireRecord(
        expectDefined(
          transcriptEvents.find((entry) => {
            const event = requireRecord(entry, "transcript entry");
            return (
              event.type === "message" &&
              requireRecord(event.message, "transcript message").idempotencyKey ===
                "hook-block:before_agent_run:user:run-blocked-cli"
            );
          }),
          "blocked transcript message",
        ),
        "blocked transcript message",
      );
      const blockedMessage = requireRecord(blockedLine.message, "blocked message");
      const blockedContent = requireArray(blockedMessage.content, "blocked content");
      expect(requireRecord(blockedContent[0], "blocked text").text).toBe(
        "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)",
      );
      expect(JSON.stringify(blockedLine)).not.toContain("secret prompt");
      expect(JSON.stringify(blockedLine)).not.toContain("matched secret prompt");
      const blockedMetadata = requireRecord(blockedMessage["__openclaw"], "blocked metadata");
      const blockedState = requireRecord(blockedMetadata.beforeAgentRunBlocked, "blocked state");
      expect(blockedState.blockedBy).toBe("policy-plugin");
      expect(blockedState).not.toHaveProperty("reason");
      expect(Object.hasOwn(blockedMetadata, "beforeAgentRunBlocked")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not rebind a reset session when a stale before_agent_run hook blocks", async () => {
    const { dir, sessionFile, sessionTarget, storePath } = createSessionFixture();
    const sessionKey = "agent:main:main";
    const context = makeClaudePreparedContext({
      sessionKey,
      runId: "run-blocked-cli-rebound",
    });
    context.params.sessionEntry = { sessionId: "s1", updatedAt: 1 };
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_agent_run"),
      runBeforeAgentRun: vi.fn(async () => {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey, storePath },
          { sessionId: "replacement-session", updatedAt: 2 },
        );
        return {
          pluginId: "policy-plugin",
          decision: {
            outcome: "block" as const,
            message: "Blocked after reset.",
          },
        };
      }),
    };
    setHookRunnerForTest(hookRunner);

    try {
      await expect(
        runPreparedCliAgent({
          ...context,
          params: {
            ...context.params,
            agentId: "main",
            sessionFile,
            sessionTarget,
            storePath,
            workspaceDir: dir,
            prompt: "secret prompt",
          },
        }),
      ).resolves.toMatchObject({ meta: { livenessState: "blocked" } });

      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })?.sessionId).toBe(
        "replacement-session",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists a blocked bare-key turn under its fixed-store owner", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_agent_run"),
      runBeforeAgentRun: vi.fn(async () => ({
        pluginId: "policy-plugin",
        decision: {
          outcome: "block" as const,
          message: "Blocked by policy.",
        },
      })),
    };
    setHookRunnerForTest(hookRunner);
    const dir = autoCleanupTempDirs.make("openclaw-cli-fixed-owner-");
    const storePath = path.join(dir, "shared-sessions.json");
    const sessionKey = "global";
    const context = makeClaudePreparedContext({
      sessionKey,
      runId: "run-blocked-fixed-owner",
    });
    context.preparedBackend.backend.sessionMode = "none";

    try {
      await expect(
        runPreparedCliAgent({
          ...context,
          params: {
            ...context.params,
            config: {
              session: { store: storePath },
              agents: {
                ownership: "explicit",
                defaults: { sessionStore: { agentId: "ops" } },
                entries: { ops: {}, research: {} },
              },
            },
            sessionFile: sessionKey,
            storePath,
            workspaceDir: dir,
            prompt: "secret prompt",
          },
        }),
      ).resolves.toMatchObject({ meta: { livenessState: "blocked" } });

      await expect(
        loadTranscriptEvents({
          agentId: "ops",
          sessionId: context.params.sessionId,
          sessionKey,
          storePath,
        }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({ role: "user" }),
          }),
        ]),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists before_agent_run CLI blocks through the canonical recorder", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_agent_run"),
      runBeforeAgentRun: vi.fn(async () => ({
        pluginId: "policy-plugin",
        decision: {
          outcome: "block" as const,
          reason: "matched secret prompt: secret prompt",
          message: "The agent cannot read this message.",
        },
      })),
    };
    setHookRunnerForTest(hookRunner);
    const { dir, sessionFile, sessionTarget, storePath } = createSessionFixture();
    const onUserMessagePersisted = vi.fn();

    try {
      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "secret prompt",
          idempotencyKey: "run-blocked-cli-sqlite:user",
        },
        target: {
          sessionId: "s1",
          sessionKey: "agent:main:main",
          sessionEntry: {
            sessionId: "s1",
            sessionFile,
            updatedAt: 10,
          },
          storePath,
          agentId: "main",
          cwd: dir,
        },
        updateMode: "none",
      });
      const persistBlockedSpy = vi.spyOn(recorder, "persistBlocked");
      const context = buildPreparedContext({
        sessionKey: "agent:main:main",
        runId: "run-blocked-cli-sqlite",
      });

      const result = await runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          agentId: "main",
          sessionFile,
          sessionTarget,
          workspaceDir: dir,
          prompt: "secret prompt",
          storePath,
          userTurnTranscriptRecorder: recorder,
          onUserMessagePersisted,
        },
      });

      expect(result.meta.livenessState).toBe("blocked");
      expect(supervisorSpawnMock).not.toHaveBeenCalled();
      expect(persistBlockedSpy).toHaveBeenCalledOnce();
      expect(onUserMessagePersisted).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "user",
          content: [
            {
              type: "text",
              text: "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)",
            },
          ],
        }),
      );
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionId: "s1",
        sessionKey: "agent:main:main",
        storePath,
      });
      const messages = events.flatMap((entry) =>
        typeof entry === "object" && entry !== null && "message" in entry ? [entry.message] : [],
      );
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "user",
          content: [
            {
              type: "text",
              text: "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)",
            },
          ],
          idempotencyKey: "hook-block:before_agent_run:user:run-blocked-cli-sqlite",
        }),
      );
      expect(JSON.stringify(messages)).not.toContain("secret prompt");
      expect(JSON.stringify(messages)).not.toContain("matched secret prompt");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forwards channel identity context to CLI before_agent_run hooks", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_agent_run"),
      runBeforeAgentRun: vi.fn(async () => ({
        pluginId: "policy-plugin",
        decision: {
          outcome: "block" as const,
          reason: "sender scoped policy",
          message: "The agent cannot read this message.",
        },
      })),
    };
    setHookRunnerForTest(hookRunner);
    const { dir, sessionFile, sessionTarget } = createSessionFixture({
      sessionKey: "agent:main:telegram:chat-1",
    });

    try {
      const context = buildPreparedContext({
        sessionKey: "agent:main:telegram:chat-1",
        runId: "run-cli-channel-before-agent-run",
      });
      const result = await runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          agentId: "main",
          sessionFile,
          sessionTarget,
          workspaceDir: dir,
          prompt: "sender scoped prompt",
          messageChannel: "telegram",
          messageProvider: "telegram",
          currentChannelId: "telegram:chat-1",
          senderId: "user-42",
          senderIsOwner: true,
        },
      });

      expect(result.payloads).toEqual([
        {
          text: "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)",
          isError: true,
        },
      ]);
      expect(supervisorSpawnMock).not.toHaveBeenCalled();
      const beforeRunEvent = requireRecord(
        callArg(hookRunner.runBeforeAgentRun, 0, 0, "before_agent_run event"),
        "before_agent_run event",
      );
      expect(beforeRunEvent.channelId).toBe("chat-1");
      expect(beforeRunEvent.senderId).toBe("user-42");
      expect(beforeRunEvent.senderIsOwner).toBe(true);
      const beforeRunContext = requireRecord(
        callArg(hookRunner.runBeforeAgentRun, 0, 1, "before_agent_run context"),
        "before_agent_run context",
      );
      expect(beforeRunContext.messageProvider).toBe("telegram");
      expect(beforeRunContext.chatId).toBe("chat-1");
      expect(beforeRunContext.channelId).toBe("chat-1");
      expect(beforeRunContext.senderId).toBe("user-42");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not emit llm_output when the CLI run returns no assistant text", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "llm_output"),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    setHookRunnerForTest(hookRunner);

    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "   " }));

    await expect(runPreparedCliAgent(buildPreparedContext())).rejects.toThrow(
      "CLI backend returned an empty response.",
    );
    expect(hookRunner.runLlmOutput).not.toHaveBeenCalled();
  });

  it("returns silent payload for empty CLI output when silence is allowed", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "llm_output"),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    setHookRunnerForTest(hookRunner);

    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "   " }));

    const result = await runPreparedCliAgent(
      makeClaudePreparedContext({
        model: "claude-sonnet-4-6",
        allowEmptyAssistantReplyAsSilent: true,
      }),
    );

    expect(result.payloads).toEqual([{ text: SILENT_REPLY_TOKEN }]);
    expect(result.meta.executionTrace?.fallbackUsed).toBe(false);
    expect(hookRunner.runLlmOutput).not.toHaveBeenCalled();
  });

  it("emits agent_end with failure details when the CLI run fails", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => ["llm_input", "agent_end"].includes(hookName)),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(() => agentEndSettled),
    };
    setHookRunnerForTest(hookRunner);

    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        exitCode: 1,
        stderr: "rate limit exceeded",
      }),
    );

    let settled = false;
    const run = runPreparedCliAgent(buildPreparedContext()).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(hookRunner.runLlmInput).toHaveBeenCalledTimes(1);
      expect(hookRunner.runLlmOutput).not.toHaveBeenCalled();
      expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseAgentEnd();
    await expect(run).rejects.toThrow("rate limit exceeded");
    expect(settled).toBe(true);

    const agentEndEvent = requireRecord(
      callArg(hookRunner.runAgentEnd, 0, 0, "agent_end event"),
      "agent_end event",
    );
    expect(agentEndEvent.success).toBe(false);
    expect(agentEndEvent.error).toBe("rate limit exceeded");
    const messages = requireArray(agentEndEvent.messages, "agent_end messages");
    expect(messages).toHaveLength(1);
    expectTextMessage(messages[0], { role: "user", content: "hi" });
    expect(callArg(hookRunner.runAgentEnd, 0, 1, "agent_end context")).toBeTypeOf("object");
  });

  it("does not emit duplicate llm_input when session-expired recovery succeeds", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) =>
        ["llm_input", "llm_output", "agent_end"].includes(hookName),
      ),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    setHookRunnerForTest(hookRunner);
    const { dir, sessionFile, sessionTarget } = createSessionFixture({
      history: Array.from({ length: MAX_CLI_SESSION_HISTORY_MESSAGES + 5 }, (_, index) => ({
        role: "user" as const,
        content: `history-${index}`,
      })),
    });

    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        exitCode: 1,
        stderr: "session expired",
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "recovered output" }));

    const context = buildPreparedContext({
      sessionKey: "agent:main:main",
      runId: "run-retry-success",
      cliSessionId: "thread-123",
      openClawHistoryPrompt:
        "Continue this conversation using the OpenClaw transcript below.\n\nUser: recovered history\n\n<next_user_message>\nhi\n</next_user_message>",
    });
    context.preparedBackend.backend.freshSessionRecovery = "invalidated-only";
    const clearBeforeRetry = vi.fn(async () => true);

    try {
      const result = await runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          agentId: "main",
          onBeforeFreshCliSessionRetry: clearBeforeRetry,
          sessionFile,
          sessionTarget,
          workspaceDir: dir,
        },
      });

      expect(result.payloads).toEqual([{ text: "recovered output" }]);
      expect(result.meta.finalPromptText).toContain("User: recovered history");
      expect(clearBeforeRetry).toHaveBeenCalledWith({
        provider: "codex-cli",
        reason: "session_expired",
        sessionId: "thread-123",
      });

      await vi.waitFor(() => {
        expect(hookRunner.runLlmInput).toHaveBeenCalledTimes(1);
        expect(hookRunner.runLlmOutput).toHaveBeenCalledTimes(1);
        expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
      });
      const llmInputEvent = requireRecord(
        callArg(hookRunner.runLlmInput, 0, 0, "llm_input event"),
        "llm_input event",
      );
      const historyMessages = requireArray(llmInputEvent.historyMessages, "history messages");
      expect(historyMessages).toHaveLength(MAX_CLI_SESSION_HISTORY_MESSAGES);
      const firstHistoryMessage = requireRecord(historyMessages[0], "first history message");
      expect(firstHistoryMessage.role).toBe("user");
      expect(firstHistoryMessage.content).toBe(`history-5`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fresh-reseeds one invalidated control-only plugin resume without duplicate hooks", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) =>
        ["llm_input", "llm_output", "agent_end"].includes(hookName),
      ),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    setHookRunnerForTest(hookRunner);
    let attempts = 0;
    let liveHandle: CliBackendLiveSessionHandle | undefined;
    const execute: CliBackendExecute = async function* (execution) {
      attempts += 1;
      const capability = execution.liveSession;
      if (!capability) {
        throw new Error("Expected a managed live-session capability.");
      }
      if (attempts === 1) {
        const handle: CliBackendLiveSessionHandle = {
          generation: "warm-generation",
          fingerprint: capability.fingerprint,
          isIdle: () => true,
          close: () => capability.remove(handle),
          waitForExit: async () => {},
        };
        liveHandle = handle;
        capability.register(handle);
        yield { type: "result", subtype: "success", is_error: false, result: "warm" };
        return;
      }
      if (attempts === 2) {
        expect(execution.useResume).toBe(true);
        yield { type: "system", subtype: "init", session_id: "warm-session" };
        capability.current()?.close("abort");
        return;
      }
      expect(execution.useResume).toBe(false);
      expect(execution.prompt).toContain("earlier context");
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "recovered output",
        session_id: "fresh-session",
      };
    };
    const { admission, context } = await usePluginLiveBackend(
      makeClaudePreparedContext({
        sessionKey: "agent:main:plugin-resume-recovery",
        runId: "run-plugin-resume-recovery",
        cliSessionId: "warm-session",
        openClawHistoryPrompt: CLI_RESEED_PROMPT,
      }),
      execute,
    );
    const clearBeforeRetry = vi.fn(async () => true);

    try {
      await executePreparedCliRun({ ...context, openClawHistoryPrompt: undefined }, undefined);
      context.requiredClaudeLiveSessionGeneration = liveHandle?.generation;
      const result = await runPreparedCliAgent({
        ...context,
        params: {
          ...context.params,
          onBeforeFreshCliSessionRetry: clearBeforeRetry,
        },
      });

      expect(result.payloads).toEqual([{ text: "recovered output" }]);
      expect(attempts).toBe(3);
      expect(clearBeforeRetry).toHaveBeenCalledOnce();
      expect(hookRunner.runLlmInput).toHaveBeenCalledOnce();
      expect(hookRunner.runLlmOutput).toHaveBeenCalledOnce();
      expect(hookRunner.runAgentEnd).toHaveBeenCalledOnce();
    } finally {
      liveHandle?.close("restart");
      admission.close();
    }
  });

  it.each(failClosedPluginResumeCases)(
    "keeps the original failure after $name",
    async ({ name, event, invalidate, managed, resume, warm }) => {
      let attempts = 0;
      let liveHandle: CliBackendLiveSessionHandle | undefined;
      const streamError = new Error("plugin stream failed without a retry-safe termination");
      const execute: CliBackendExecute = async function* (execution) {
        attempts += 1;
        const capability = execution.liveSession;
        if (warm && attempts === 1) {
          if (!capability) {
            throw new Error("Expected a managed live-session capability.");
          }
          const handle: CliBackendLiveSessionHandle = {
            generation: "warm-generation",
            fingerprint: capability.fingerprint,
            isIdle: () => true,
            close: () => capability.remove(handle),
            waitForExit: async () => {},
          };
          liveHandle = handle;
          capability.register(handle);
          yield { type: "result", subtype: "success", is_error: false, result: "warm" };
          return;
        }
        yield { type: "system", subtype: "init", session_id: "warm-session" };
        if (event) {
          yield event;
        }
        if (invalidate) {
          capability?.current()?.close("abort");
        }
        throw streamError;
      };
      const { admission, context } = await usePluginLiveBackend(
        makeClaudePreparedContext({
          runId: `run-plugin-fail-closed-${name.replaceAll(" ", "-")}`,
          openClawHistoryPrompt: CLI_RESEED_PROMPT,
        }),
        execute,
      );
      if (!managed && !warm) {
        delete context.preparedBackend.backend.liveSession;
      }

      try {
        if (warm) {
          await executePreparedCliRun({ ...context, openClawHistoryPrompt: undefined }, undefined);
          context.requiredClaudeLiveSessionGeneration = liveHandle?.generation;
        }
        await expect(
          executePreparedCliRun(context, resume ? "warm-session" : undefined),
        ).rejects.toBe(streamError);
        expect(attempts).toBe(warm ? 2 : 1);
      } finally {
        liveHandle?.close("restart");
        admission.close();
      }
    },
  );

  it("does not retry again when the fresh plugin recovery attempt fails", async () => {
    let attempts = 0;
    let liveHandle: CliBackendLiveSessionHandle | undefined;
    const freshError = new Error("fresh plugin attempt failed");
    const execute: CliBackendExecute = async function* (execution) {
      attempts += 1;
      const capability = execution.liveSession;
      if (!capability) {
        throw new Error("Expected a managed live-session capability.");
      }
      if (attempts === 1) {
        const handle: CliBackendLiveSessionHandle = {
          generation: "warm-generation",
          fingerprint: capability.fingerprint,
          isIdle: () => true,
          close: () => capability.remove(handle),
          waitForExit: async () => {},
        };
        liveHandle = handle;
        capability.register(handle);
        yield { type: "result", subtype: "success", is_error: false, result: "warm" };
        return;
      }
      if (attempts === 2) {
        yield { type: "system", subtype: "init", session_id: "warm-session" };
        capability.current()?.close("abort");
        return;
      }
      throw freshError;
    };
    const { admission, context } = await usePluginLiveBackend(
      makeClaudePreparedContext({
        sessionKey: "agent:main:plugin-resume-recovery-failure",
        runId: "run-plugin-resume-recovery-failure",
        cliSessionId: "warm-session",
        openClawHistoryPrompt: CLI_RESEED_PROMPT,
      }),
      execute,
    );
    const clearBeforeRetry = vi.fn(async () => true);

    try {
      await executePreparedCliRun({ ...context, openClawHistoryPrompt: undefined }, undefined);
      context.requiredClaudeLiveSessionGeneration = liveHandle?.generation;
      await expect(
        runPreparedCliAgent({
          ...context,
          params: {
            ...context.params,
            onBeforeFreshCliSessionRetry: clearBeforeRetry,
          },
        }),
      ).rejects.toBe(freshError);

      expect(attempts).toBe(3);
      expect(clearBeforeRetry).toHaveBeenCalledOnce();
    } finally {
      liveHandle?.close("restart");
      admission.close();
    }
  });

  it("skips transcript loading when only llm_output hooks are active", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "llm_output"),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    setHookRunnerForTest(hookRunner);
    const historySpy = vi.spyOn(sessionHistoryModule, "loadCliSessionHistoryMessages");

    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from cli" }));

    try {
      await runPreparedCliAgent(buildPreparedContext());

      expect(historySpy).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(hookRunner.runLlmOutput).toHaveBeenCalledTimes(1);
      });
    } finally {
      historySpy.mockRestore();
    }
  });

  it("builds fresh-session history reseed prompts from hook-mutated prompts", async () => {
    const { dir, sessionFile, sessionTarget } = createSessionFixture({
      history: [{ role: "user", content: "earlier ask" }],
    });
    const manager = SessionManager.open(sessionTarget, dir);
    manager.appendCompaction(
      "compacted earlier ask",
      expectDefined(manager.getLeafId(), "retained history entry"),
      10_000,
    );
    const config: OpenClawConfig = { agents: { defaults: { workspace: dir } } };
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          id: "codex-cli",
          pluginId: "test-codex",
          config: {
            command: "codex",
            args: ["exec"],
            output: "text",
            input: "arg",
            sessionMode: "existing",
          },
        },
      ],
    });
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => ({ prependContext: "hook context" })),
    };
    setHookRunnerForTest(hookRunner);

    try {
      const context = await prepareCliRunContext({
        admittedRunContext: createTestAdmittedRunContext("run-history-hook"),
        sessionId: "s1",
        sessionFile,
        sessionTarget,
        workspaceDir: dir,
        config,
        prompt: "current ask",
        provider: "codex-cli",
        model: "gpt-5.4",
        timeoutMs: 1_000,
        runId: "run-history-hook",
      });

      expect(context.params.prompt).toBe("hook context\n\ncurrent ask");
      expect(context.openClawHistoryPrompt).toContain("Compaction summary: compacted earlier ask");
      expect(context.openClawHistoryPrompt).toContain("hook context");
      expect(context.openClawHistoryPrompt).toContain("current ask");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps native control operations out of restrictive prompt preparation", async () => {
    const { dir, sessionFile, sessionTarget } = createSessionFixture({
      history: [{ role: "user", content: "earlier ask" }],
    });
    const config: OpenClawConfig = { agents: { defaults: { workspace: dir } } };
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          id: "control-cli",
          pluginId: "test-control",
          config: {
            command: "claude",
            args: ["-p"],
            resumeArgs: ["-p", "--resume", "{sessionId}"],
            output: "jsonl",
            input: "arg",
            sessionMode: "existing",
          },
        },
      ],
    });
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => ({
        prependContext: "mutated",
        toolsAllow: [],
      })),
    };
    setHookRunnerForTest(hookRunner);

    try {
      const context = await prepareCliRunContext({
        admittedRunContext: createTestAdmittedRunContext("run-native-compact"),
        sessionId: "s1",
        sessionFile,
        sessionTarget,
        workspaceDir: dir,
        config,
        prompt: "/compact",
        extraSystemPrompt: "must not attach to a control operation",
        finalizePromptForResolvedTools: () => "mutated",
        provider: "control-cli",
        model: "model",
        timeoutMs: 180_000,
        runId: "run-native-compact",
        cliSessionId: "native-session",
        cliSessionBinding: {
          sessionId: "native-session",
          mcpConfigHash: "persisted-mcp-config",
          mcpResumeHash: "persisted-mcp-resume",
        },
        controlOperation: "compact",
      });

      expect(hookRunner.runBeforePromptBuild).not.toHaveBeenCalled();
      expect(context.params.prompt).toBe("/compact");
      expect(context.params.cliToolAvailability).toBeUndefined();
      expect(context.reusableCliSession).toEqual({ mode: "reuse", sessionId: "native-session" });
      expect(context.systemPrompt).toBe("");
      expect(context.contextEngine).toBeUndefined();
      expect(context.claudeSkillsPluginArgs).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveCliNoOutputTimeoutMs", () => {
  it("gives expected-quiet controls the caller-owned overall timeout budget", () => {
    expect(
      resolveCliNoOutputTimeoutMs({
        backend: { command: "claude" },
        timeoutMs: 180_000,
        useResume: true,
        expectedQuiet: true,
        trigger: "manual",
      }),
    ).toBe(180_000);
    expect(
      resolveCliNoOutputTimeoutMs({
        backend: { command: "claude" },
        timeoutMs: 600_000,
        useResume: true,
        expectedQuiet: true,
        trigger: "manual",
      }),
    ).toBe(600_000);
  });

  it("lets explicit cron timeouts lift the default resume no-output ceiling", () => {
    const timeoutMs = resolveCliNoOutputTimeoutMs({
      backend: { command: "agent-cli" },
      timeoutMs: 600_000,
      useResume: true,
      trigger: "cron",
    });
    expect(timeoutMs).toBe(480_000);
  });

  it("lets explicit embedded run timeouts lift the default resume no-output ceiling", () => {
    const timeoutMs = resolveCliNoOutputTimeoutMs({
      backend: { command: "agent-cli" },
      timeoutMs: 600_000,
      runTimeoutOverrideMs: 600_000,
      useResume: true,
      trigger: "user",
    });
    expect(timeoutMs).toBe(480_000);
  });

  it("keeps inherited user resume timeouts on the default resume no-output ceiling", () => {
    const timeoutMs = resolveCliNoOutputTimeoutMs({
      backend: { command: "agent-cli" },
      timeoutMs: 600_000,
      useResume: true,
      trigger: "user",
    });
    expect(timeoutMs).toBe(180_000);
  });

  it("preserves explicit backend watchdog tuning for resumed cron runs", () => {
    const timeoutMs = resolveCliNoOutputTimeoutMs({
      backend: {
        command: "agent-cli",
        reliability: {
          watchdog: {
            resume: { noOutputTimeoutRatio: 0.2, minMs: 1_000, maxMs: 120_000 },
          },
        },
      },
      timeoutMs: 600_000,
      useResume: true,
      trigger: "cron",
    });
    expect(timeoutMs).toBe(120_000);
  });
});

describe("resolveCliRunTimeoutOverrideMs", () => {
  it("preserves configured timeouts for normal channel runs", () => {
    expect(
      resolveCliRunTimeoutOverrideMs({
        config: { agents: { defaults: { timeoutSeconds: 600 } } },
        timeoutMs: 600_000,
      }),
    ).toBe(600_000);
  });

  it("does not treat configured timeouts as subagent overrides", () => {
    expect(
      resolveCliRunTimeoutOverrideMs({
        config: { agents: { defaults: { timeoutSeconds: 600 } } },
        lane: "subagent",
        timeoutMs: 600_000,
      }),
    ).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
