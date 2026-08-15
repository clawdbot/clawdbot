// Exercises ordered CLI process faults through recovery, model fallback, and bridge boundaries.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onAgentEvent } from "../infra/agent-events.js";
import type { RunExit } from "../process/supervisor/types.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { runPreparedCliAgent } from "./cli-runner.js";
import {
  buildClaudeLiveRunContext,
  buildPreparedCliRunContext,
  mockClaudeLiveRun,
} from "./cli-runner.test-helpers.js";
import { resetClaudeLiveSessionsForTest } from "./cli-runner/claude-live-session.test-support.js";
import { createManagedRun, supervisorSpawnMock } from "./cli-runner/execute.test-support.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { isFailoverError } from "./failover-error.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import {
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

const testMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(() => ({ profiles: {} })),
  nativeRunBudgetAttempt: vi.fn(),
  resolveAuthProfileOrder: vi.fn(() => []),
  resolveCliRuntimeExecutionProvider: vi.fn(() => undefined),
  resolveModelAuthMode: vi.fn(() => "oauth"),
  resolveRuntimeCliBackends: vi.fn(() => [{ id: "claude-cli", subscriptionAuthDispatch: true }]),
  runCliAgent: vi.fn(),
}));

vi.mock("./model-auth.js", () => ({
  ensureAuthProfileStore: testMocks.ensureAuthProfileStore,
  resolveAuthProfileOrder: testMocks.resolveAuthProfileOrder,
  resolveModelAuthMode: testMocks.resolveModelAuthMode,
}));

vi.mock("../plugins/cli-backends.runtime.js", () => ({
  resolveRuntimeCliBackends: testMocks.resolveRuntimeCliBackends,
}));

vi.mock("./model-runtime-aliases.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-runtime-aliases.js")>()),
  resolveCliRuntimeExecutionProvider: testMocks.resolveCliRuntimeExecutionProvider,
}));

vi.mock("./cli-runner.runtime.js", () => ({
  runCliAgent: (params: RunCliAgentParams) => testMocks.runCliAgent(params),
}));

type CliBoundaryParams = Pick<
  RunCliAgentParams,
  "model" | "onExecutionPhase" | "provider" | "runId" | "sessionKey"
>;

type ScenarioCounts = {
  childProcesses: number;
  nativeRunBudgetAttempts: number;
  outerCandidates: number;
  runCliAgentCalls: number;
  wholeTurnRetries: number;
};

type ScenarioHarness = {
  contextFor: (params: CliBoundaryParams) => PreparedCliRunContext;
  managedChildren: number;
  outerCandidates: Array<{ provider: string; model: string }>;
  wholeTurnRuns: number;
};

type OuterRunOptions = {
  fallbacks?: string[];
  onError?: (error: unknown) => void;
  runCandidate?: (provider: string, model: string) => Promise<EmbeddedAgentRunResult>;
};

const PRIMARY_MODEL = "sonnet-4.6";
const FALLBACK_MODEL = "sonnet-4.5";
const RESEED_PROMPT = [
  "Continue this conversation using the OpenClaw transcript below as prior session history.",
  "",
  "<conversation_history>",
  "User: earlier context",
  "</conversation_history>",
  "",
  "<next_user_message>",
  "latest ask",
  "</next_user_message>",
].join("\n");

let runEmbeddedAgent: typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
let scenarioRoot = "";
let harness: ScenarioHarness;

beforeAll(async () => {
  installEmbeddedRunnerBaseE2eMocks();
  installEmbeddedRunnerFastRunE2eMocks({
    runEmbeddedAttempt: (params) => testMocks.nativeRunBudgetAttempt(params),
  });
  ({ runEmbeddedAgent } = await import("./embedded-agent-runner/run.js"));
});

beforeEach(async () => {
  const rawRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-fault-sequences-"));
  scenarioRoot = await fs.realpath(rawRoot);
  supervisorSpawnMock.mockReset();
  testMocks.nativeRunBudgetAttempt.mockReset();
  testMocks.runCliAgent.mockReset();
  testMocks.runCliAgent.mockImplementation(async (params: CliBoundaryParams) =>
    runPreparedCliAgent(harness.contextFor(params)),
  );
  harness = {
    contextFor: buildProcessContext,
    managedChildren: 0,
    outerCandidates: [],
    wholeTurnRuns: 0,
  };
});

afterEach(async () => {
  resetClaudeLiveSessionsForTest();
  vi.useRealTimers();
  await fs.rm(scenarioRoot, { recursive: true, force: true });
});

function fallbackConfig(fallbacks: string[] = []): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: scenarioRoot,
        model: {
          primary: `claude-cli/${PRIMARY_MODEL}`,
          fallbacks,
        },
      },
    },
  };
}

function makeExit(overrides: Partial<RunExit> = {}): RunExit {
  return {
    reason: "exit",
    exitCode: 0,
    exitSignal: null,
    durationMs: 10,
    stdout: "",
    stderr: "",
    timedOut: false,
    noOutputTimedOut: false,
    ...overrides,
  };
}

function managedRun(overrides: Partial<RunExit> = {}) {
  harness.managedChildren += 1;
  return createManagedRun(makeExit(overrides), 4_000 + harness.managedChildren);
}

function claudeJsonl(events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function successExit(text: string, sessionId = "cli-success"): RunExit {
  return makeExit({
    stdout: claudeJsonl([
      { type: "system", subtype: "init", session_id: sessionId },
      { type: "result", subtype: "success", session_id: sessionId, result: text },
    ]),
  });
}

function applyBoundaryParams(
  context: PreparedCliRunContext,
  params: CliBoundaryParams,
): PreparedCliRunContext {
  context.params = {
    ...context.params,
    sessionId: "openclaw-session",
    sessionKey: params.sessionKey ?? "agent:main:cli-fault-e2e",
    sessionFile: path.join(scenarioRoot, "session.jsonl"),
    workspaceDir: scenarioRoot,
    provider: params.provider,
    model: params.model,
    runId: params.runId,
    onExecutionPhase: params.onExecutionPhase,
  };
  context.workspaceDir = scenarioRoot;
  return context;
}

function buildProcessContext(params: CliBoundaryParams): PreparedCliRunContext {
  return applyBoundaryParams(
    buildPreparedCliRunContext({
      provider: "claude-cli",
      model: params.model ?? PRIMARY_MODEL,
      runId: params.runId,
      workspaceDir: scenarioRoot,
      timeoutMs: 5_000,
    }),
    params,
  );
}

function buildReusableProcessContext(params: CliBoundaryParams): PreparedCliRunContext {
  const context = buildProcessContext(params);
  context.reusableCliSession = { mode: "reuse", sessionId: "source-cli-session" };
  context.openClawHistoryPrompt = RESEED_PROMPT;
  context.preparedBackend.backend = {
    ...context.preparedBackend.backend,
    resumeArgs: ["-p", "--resume", "{sessionId}", "--output-format", "stream-json"],
  };
  context.backendResolved.config = context.preparedBackend.backend;
  context.params.onBeforeFreshCliSessionRetry = vi.fn(async () => true);
  return context;
}

function buildReusableLiveContext(params: CliBoundaryParams): PreparedCliRunContext {
  const context = applyBoundaryParams(
    buildClaudeLiveRunContext({
      model: params.model ?? PRIMARY_MODEL,
      runId: params.runId,
      workspaceDir: scenarioRoot,
      timeoutMs: 5_000,
      backend: {
        resumeArgs: ["-p", "--resume", "{sessionId}", "--output-format", "stream-json"],
        forkArg: "--fork-session",
        resumeAtArg: "--resume-session-at",
        reliability: {
          watchdog: {
            fresh: { noOutputTimeoutRatio: 0.2, minMs: 1_000, maxMs: 1_000 },
            resume: { noOutputTimeoutRatio: 0.2, minMs: 1_000, maxMs: 1_000 },
          },
        },
      },
    }),
    params,
  );
  context.reusableCliSession = { mode: "reuse", sessionId: "source-cli-session" };
  context.openClawHistoryPrompt = RESEED_PROMPT;
  context.params.cliSessionBinding = {
    sessionId: "source-cli-session",
    resumeCheckpointId: "assistant-before-stall",
  };
  context.params.onBeforeForkedCliSessionRetry = vi.fn(async () => true);
  context.params.claimCliSessionFork = vi.fn(async () => true);
  context.params.persistCliSessionForkSuccessor = vi.fn(async () => undefined);
  context.params.restoreCliSessionFork = vi.fn(async () => undefined);
  context.params.onBeforeFreshCliSessionRetry = vi.fn(async () => true);
  return context;
}

async function runOuter(options: OuterRunOptions = {}) {
  harness.wholeTurnRuns += 1;
  return runWithModelFallback<EmbeddedAgentRunResult>({
    cfg: fallbackConfig(options.fallbacks),
    provider: "claude-cli",
    model: PRIMARY_MODEL,
    runId: "run-cli-fault-e2e",
    sessionId: "openclaw-session",
    sessionKey: "agent:main:cli-fault-e2e",
    skipAuthProfileRuntime: true,
    fallbacksOverride: options.fallbacks,
    onError: ({ error }) => options.onError?.(error),
    run: async (provider, model) => {
      harness.outerCandidates.push({ provider, model });
      return options.runCandidate
        ? options.runCandidate(provider, model)
        : testMocks.runCliAgent({
            admittedRunContext: createTestAdmittedRunContext("run-cli-fault-e2e"),
            sessionId: "openclaw-session",
            sessionKey: "agent:main:cli-fault-e2e",
            sessionFile: path.join(scenarioRoot, "session.jsonl"),
            workspaceDir: scenarioRoot,
            prompt: "latest ask",
            provider,
            model,
            timeoutMs: 5_000,
            runId: "run-cli-fault-e2e",
          });
    },
  });
}

function currentCounts(): ScenarioCounts {
  return {
    childProcesses: harness.managedChildren,
    nativeRunBudgetAttempts: testMocks.nativeRunBudgetAttempt.mock.calls.length,
    outerCandidates: harness.outerCandidates.length,
    runCliAgentCalls: testMocks.runCliAgent.mock.calls.length,
    wholeTurnRetries: Math.max(0, harness.wholeTurnRuns - 1),
  };
}

function expectCounts(expected: ScenarioCounts): void {
  expect(currentCounts()).toEqual(expected);
}

function installLiveStall(sessionId: string): void {
  mockClaudeLiveRun(supervisorSpawnMock, {
    cancelable: true,
    events: [{ type: "system", subtype: "init", session_id: sessionId }],
  });
  harness.managedChildren += 1;
}

function installLiveSuccess(sessionId: string, text: string): void {
  mockClaudeLiveRun(supervisorSpawnMock, {
    events: [
      { type: "system", subtype: "init", session_id: sessionId },
      { type: "result", subtype: "success", session_id: sessionId, result: text },
    ],
  });
  harness.managedChildren += 1;
}

function installLiveFailure(sessionId: string, text: string): void {
  mockClaudeLiveRun(supervisorSpawnMock, {
    events: [
      { type: "system", subtype: "init", session_id: sessionId },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: sessionId,
        result: text,
      },
    ],
  });
  harness.managedChildren += 1;
}

describe("CLI runner fault sequences", () => {
  it("dispatches bridge mode through one fresh CLI child and bypasses the native run budget", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(managedRun(successExit("bridge ok")));

    const outcome = await runOuter({
      runCandidate: async (provider, model) =>
        runEmbeddedAgent({
          admittedRunContext: createTestAdmittedRunContext("run-cli-bridge-e2e"),
          sessionId: "openclaw-session",
          sessionKey: "agent:main:cli-bridge-e2e",
          workspaceDir: scenarioRoot,
          agentDir: path.join(scenarioRoot, "agent"),
          config: fallbackConfig(),
          prompt: "latest ask",
          provider,
          model,
          timeoutMs: 5_000,
          runId: "run-cli-bridge-e2e",
          cliBackendDispatch: "subscription-auth",
          toolsAllow: ["memory_search"],
        }),
    });

    expect(outcome.result.payloads).toEqual([{ text: "bridge ok" }]);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    expectCounts({
      childProcesses: 1,
      nativeRunBudgetAttempts: 0,
      outerCandidates: 1,
      runCliAgentCalls: 1,
      wholeTurnRetries: 0,
    });
  });

  it.each([
    {
      label: "spawn rejection",
      install: () => {
        supervisorSpawnMock
          .mockRejectedValueOnce(new Error("spawn failed before activity"))
          .mockResolvedValueOnce(managedRun(successExit("fallback after spawn rejection")));
      },
      expectedChildren: 1,
      expectedCode: undefined,
    },
    {
      label: "nonzero empty exit",
      install: () => {
        supervisorSpawnMock
          .mockResolvedValueOnce(managedRun(makeExit({ exitCode: 1 })))
          .mockResolvedValueOnce(managedRun(successExit("fallback after empty exit")));
      },
      expectedChildren: 2,
      expectedCode: "cli_unknown_empty_failure",
    },
  ])(
    "classifies a pre-activity $label once before advancing the outer candidate",
    async (testCase) => {
      testCase.install();

      const outcome = await runOuter({ fallbacks: [`claude-cli/${FALLBACK_MODEL}`] });

      expect(outcome.provider).toBe("claude-cli");
      expect(outcome.model).toBe(FALLBACK_MODEL);
      expect(outcome.attempts).toMatchObject([
        {
          provider: "claude-cli",
          model: PRIMARY_MODEL,
          reason: "unknown",
          ...(testCase.expectedCode ? { code: testCase.expectedCode } : {}),
        },
      ]);
      expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
      expectCounts({
        childProcesses: testCase.expectedChildren,
        nativeRunBudgetAttempts: 0,
        outerCandidates: 2,
        runCliAgentCalls: 2,
        wholeTurnRetries: 0,
      });
    },
  );

  it("stops max-turns after one parsed tool effect without recovery or model replay", async () => {
    const toolEvents: Array<{ phase?: unknown; name?: unknown }> = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "run-cli-fault-e2e" && event.stream === "tool") {
        toolEvents.push(event.data);
      }
    });
    const stdout = claudeJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "mcp_tool_use",
              id: "effect-1",
              name: "mcp__openclaw__memory_search",
              input: { query: "wings" },
            },
            {
              type: "mcp_tool_result",
              tool_use_id: "effect-1",
              content: [{ type: "text", text: "found" }],
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "error_max_turns",
        session_id: "max-turns-session",
        terminal_reason: "max_turns",
        errors: ["Reached maximum number of turns (1)"],
      },
    ]);
    supervisorSpawnMock.mockResolvedValueOnce(managedRun(makeExit({ exitCode: 1, stdout })));

    let error: unknown;
    try {
      await runOuter({ fallbacks: [`claude-cli/${FALLBACK_MODEL}`] });
    } catch (caught) {
      error = caught;
    } finally {
      stop();
    }

    expect(isFailoverError(error)).toBe(true);
    expect(error).toMatchObject({ code: "cli_max_turns" });
    expect(toolEvents.filter((event) => event.phase === "result")).toEqual([
      expect.objectContaining({ name: "mcp__openclaw__memory_search" }),
    ]);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    expectCounts({
      childProcesses: 1,
      nativeRunBudgetAttempts: 0,
      outerCandidates: 1,
      runCliAgentCalls: 1,
      wholeTurnRetries: 0,
    });
  });

  it.each([
    {
      label: "overall timeout",
      exit: makeExit({
        reason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        timedOut: true,
      }),
      expected: { mode: "overall", timeoutSeconds: 5 },
    },
    {
      label: "no-output watchdog",
      exit: makeExit({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        timedOut: true,
        noOutputTimedOut: true,
      }),
      expected: { mode: "no-output", timeoutSeconds: 4 },
    },
  ])("marks a partial-effect $label replay-unsafe without another attempt", async (testCase) => {
    const phases: string[] = [];
    harness.contextFor = (params) => {
      const context = buildProcessContext(params);
      context.params.onExecutionPhase = (event) => phases.push(event.phase);
      return context;
    };
    const stdout = claudeJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "mcp_tool_use",
              id: "active-effect",
              name: "mcp__openclaw__memory_search",
              input: { query: "wings" },
            },
          ],
        },
      },
    ]);
    supervisorSpawnMock.mockResolvedValueOnce(managedRun({ ...testCase.exit, stdout }));

    let error: unknown;
    try {
      await runOuter();
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      reason: "timeout",
      cliTimeout: {
        ...testCase.expected,
        observedActivity: true,
        activeToolCount: 1,
        backgroundTaskCount: 0,
      },
    });
    expect(phases.filter((phase) => phase === "tool_execution_started")).toHaveLength(1);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    expectCounts({
      childProcesses: 1,
      nativeRunBudgetAttempts: 0,
      outerCandidates: 1,
      runCliAgentCalls: 1,
      wholeTurnRetries: 0,
    });
  });

  it("recovers resume to fork inside one outer candidate", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    harness.contextFor = buildReusableLiveContext;
    installLiveStall("source-cli-session");
    installLiveSuccess("forked-cli-session", "fork recovered");

    const outcomePromise = runOuter();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await outcomePromise;

    expect(outcome.result.payloads).toEqual([{ text: "fork recovered" }]);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
    expectCounts({
      childProcesses: 2,
      nativeRunBudgetAttempts: 0,
      outerCandidates: 1,
      runCliAgentCalls: 1,
      wholeTurnRetries: 0,
    });
  });

  it("recovers a failed fork with one fresh transcript reseed inside one outer candidate", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    harness.contextFor = buildReusableLiveContext;
    installLiveStall("source-cli-session");
    installLiveStall("forked-before-stall");
    installLiveSuccess("fresh-after-fork", "fresh recovered");

    const outcomePromise = runOuter();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await outcomePromise;

    expect(outcome.result.payloads).toEqual([{ text: "fresh recovered" }]);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(3);
    expectCounts({
      childProcesses: 3,
      nativeRunBudgetAttempts: 0,
      outerCandidates: 1,
      runCliAgentCalls: 1,
      wholeTurnRetries: 0,
    });
  });

  it("delivers an exhausted three-child recovery ladder to the outer candidate exactly once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    harness.contextFor = buildReusableLiveContext;
    installLiveStall("source-cli-session");
    installLiveStall("forked-before-failure");
    installLiveFailure("fresh-terminal", "worker exploded after recovery");
    const outerErrors = vi.fn();

    const outcomePromise = runOuter({ onError: outerErrors });
    const rejection = outcomePromise.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await rejection;

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("worker exploded after recovery");
    expect(outerErrors).toHaveBeenCalledTimes(1);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(3);
    expectCounts({
      childProcesses: 3,
      nativeRunBudgetAttempts: 0,
      outerCandidates: 1,
      runCliAgentCalls: 1,
      wholeTurnRetries: 0,
    });
  });

  it("fresh-retries reused-session context overflow once and never crosses models", async () => {
    harness.contextFor = buildReusableProcessContext;
    supervisorSpawnMock
      .mockResolvedValueOnce(
        managedRun(makeExit({ exitCode: 1, stderr: "Prompt is too long for this context window" })),
      )
      .mockResolvedValueOnce(
        managedRun(makeExit({ exitCode: 1, stderr: "Prompt is too long for this context window" })),
      );

    let error: unknown;
    try {
      await runOuter({ fallbacks: [`claude-cli/${FALLBACK_MODEL}`] });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      reason: "context_overflow",
      code: "cli_context_overflow",
    });
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
    expectCounts({
      childProcesses: 2,
      nativeRunBudgetAttempts: 0,
      outerCandidates: 1,
      runCliAgentCalls: 1,
      wholeTurnRetries: 0,
    });
  });
});
