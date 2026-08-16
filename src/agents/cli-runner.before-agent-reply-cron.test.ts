/** Tests cron before_agent_reply gating at the CLI runner entrypoint. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import {
  getAgentEventLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import type { HookRunner } from "../plugins/hooks.js";
import { wrapRunWithTestAdmission } from "./admitted-run-context.test-support.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import type { CliOutput } from "./cli-output-contracts.js";
import { CliAuthProfilePreparationError } from "./cli-runner/auth-profile-preparation-error.js";
import { cliBackendLog } from "./cli-runner/log.js";
import { FailoverError } from "./failover-error.js";

// vi.mock factories are hoisted above imports, so any references inside them
// must come from vi.hoisted() so they exist at hoist time (otherwise they'd
// be TDZ-undefined and the mocks would silently misbehave). This test only
// exercises the hook-gate decision at the runCliAgent entry point — we mock
// the prepareCliRunContext + executePreparedCliRun seams so no broader CLI
// runtime needs to load.
type BeforeAgentReplyResult =
  | undefined
  | {
      handled?: boolean;
      reply?: { text?: string };
    };

const {
  hasHooksMock,
  runBeforeAgentReplyMock,
  runBeforeAgentRunMock,
  executePreparedCliRunMock,
  prepareCliRunContextMock,
  closeClaudeSessionMock,
  closeMcpLoopbackServerMock,
  retireSessionMcpRuntimeForSessionKeyMock,
  retireSessionMcpRuntimeMock,
  loadAuthProfileStoreForRuntimeMock,
  markAuthProfileFailureMock,
  markAuthProfileSuccessMock,
} = vi.hoisted(() => ({
  hasHooksMock: vi.fn<(hookName: string) => boolean>(() => false),
  runBeforeAgentReplyMock: vi.fn<(event: unknown, ctx: unknown) => Promise<BeforeAgentReplyResult>>(
    async () => undefined,
  ),
  runBeforeAgentRunMock: vi.fn<HookRunner["runBeforeAgentRun"]>(async () => undefined),
  executePreparedCliRunMock: vi.fn<
    (_context: unknown, _cliSessionIdToUse?: string) => Promise<CliOutput>
  >(async () => ({ text: "" })),
  prepareCliRunContextMock: vi.fn(),
  closeClaudeSessionMock: vi.fn(),
  closeMcpLoopbackServerMock: vi.fn(),
  retireSessionMcpRuntimeForSessionKeyMock: vi.fn(),
  retireSessionMcpRuntimeMock: vi.fn(),
  loadAuthProfileStoreForRuntimeMock: vi.fn(),
  markAuthProfileFailureMock: vi.fn(),
  markAuthProfileSuccessMock: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: hasHooksMock,
    runBeforeAgentReply: runBeforeAgentReplyMock,
    runBeforeAgentRun: runBeforeAgentRunMock,
  })),
}));

vi.mock("./cli-runner/prepare.runtime.js", () => ({
  prepareCliRunContext: prepareCliRunContextMock,
}));

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executePreparedCliRunMock,
}));

vi.mock("./cli-runner/claude-live-registry.js", () => ({
  closeClaudeSession: closeClaudeSessionMock,
  getClaudeGeneration: vi.fn(() => undefined),
  hasClaudeSession: vi.fn(() => false),
}));

vi.mock("./cli-runner/claude-live-session-policy.js", () => ({
  acceptsClaudeLive: vi.fn(() => false),
}));

vi.mock("../gateway/mcp-http.js", () => ({
  closeMcpLoopbackServer: closeMcpLoopbackServerMock,
}));

vi.mock("./agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: retireSessionMcpRuntimeForSessionKeyMock,
  retireSessionMcpRuntime: retireSessionMcpRuntimeMock,
}));

const baseRunParams = {
  sessionId: "test-session",
  sessionKey: "test-session-key",
  agentId: "main",
  sessionFile: "/tmp/test-session.jsonl",
  workspaceDir: "/tmp/test-workspace",
  prompt: "__openclaw_memory_core_short_term_promotion_dream__",
  provider: "codex-cli",
  model: "gpt-5.5",
  timeoutMs: 30_000,
  runId: "test-run-id",
} as const;

type ProductionRunCliAgent = typeof import("./cli-runner.js").runCliAgent;
type TestRunCliAgent = (
  params: Omit<Parameters<ProductionRunCliAgent>[0], "admittedRunContext">,
) => ReturnType<ProductionRunCliAgent>;
let runCliAgent: TestRunCliAgent;
let restoreCliRunnerTestDeps: typeof import("./cli-runner.js").restoreCliRunnerTestDeps;
let setCliRunnerTestDeps: typeof import("./cli-runner.js").setCliRunnerTestDeps;

async function captureRejectedClaudeRun(
  params: Parameters<typeof runCliAgent>[0],
): Promise<{ error: unknown; events: DiagnosticEventPayload[] }> {
  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
    if ("runId" in event && event.runId === params.runId) {
      events.push(event);
    }
  });
  let error: unknown;
  try {
    await runCliAgent(params);
  } catch (caught) {
    error = caught;
  } finally {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    unsubscribe();
  }
  return { error, events };
}

function makeStubContext(params: typeof baseRunParams & { trigger?: string }) {
  // Stub only the prepared context shape runCliAgent needs after the hook gate.
  return {
    params,
    started: Date.now(),
    workspaceDir: params.workspaceDir,
    modelId: params.model,
    normalizedModel: params.model,
    systemPrompt: "",
    systemPromptReport: {},
    bootstrapPromptWarningLines: [],
    authEpochVersion: 0,
    backendResolved: {},
    preparedBackend: { backend: { sessionMode: "none" } },
    reusableCliSession: { mode: "none" },
  } as unknown;
}

beforeEach(() => {
  hasHooksMock.mockReset();
  hasHooksMock.mockReturnValue(false);
  runBeforeAgentReplyMock.mockReset();
  runBeforeAgentReplyMock.mockResolvedValue(undefined);
  runBeforeAgentRunMock.mockReset();
  runBeforeAgentRunMock.mockResolvedValue(undefined);
  executePreparedCliRunMock.mockReset();
  executePreparedCliRunMock.mockResolvedValue({ text: "" });
  prepareCliRunContextMock.mockReset();
  prepareCliRunContextMock.mockImplementation(async (params) =>
    makeStubContext(params as typeof baseRunParams & { trigger?: string }),
  );
  closeClaudeSessionMock.mockReset();
  closeMcpLoopbackServerMock.mockReset();
  retireSessionMcpRuntimeForSessionKeyMock.mockReset();
  retireSessionMcpRuntimeForSessionKeyMock.mockResolvedValue(true);
  retireSessionMcpRuntimeMock.mockReset();
  retireSessionMcpRuntimeMock.mockResolvedValue(true);
  loadAuthProfileStoreForRuntimeMock.mockReset();
  markAuthProfileFailureMock.mockReset().mockResolvedValue(undefined);
  markAuthProfileSuccessMock.mockReset().mockResolvedValue(undefined);
  setCliRunnerTestDeps?.({
    loadAuthProfileStoreForRuntime: loadAuthProfileStoreForRuntimeMock,
    markAuthProfileFailure: markAuthProfileFailureMock,
    markAuthProfileSuccess: markAuthProfileSuccessMock,
  });
});

beforeAll(async () => {
  const cliRunner = await import("./cli-runner.js");
  runCliAgent = wrapRunWithTestAdmission(cliRunner.runCliAgent);
  ({ restoreCliRunnerTestDeps, setCliRunnerTestDeps } = cliRunner);
});

afterEach(() => {
  restoreCliRunnerTestDeps();
  cliBackendsTesting.resetDepsForTest();
  vi.clearAllMocks();
  resetDiagnosticEventsForTest();
});

describe("runCliAgent before_agent_reply seam", () => {
  it.each([
    ["claude-cli", "user"],
    ["google-gemini-cli", "cron"],
  ])("settles one exhausted %s profile failure for a %s caller", async (provider, trigger) => {
    const profileId = `${provider}:selected`;
    const store = {
      version: 1,
      profiles: { [profileId]: { type: "api_key", provider, key: "secret" } },
    } as const;
    prepareCliRunContextMock.mockImplementationOnce(async (params) => ({
      ...(makeStubContext(params as typeof baseRunParams & { trigger?: string }) as object),
      effectiveAuthProfileId: profileId,
      authProfileStore: store,
      agentDir: "/tmp/agent",
    }));
    executePreparedCliRunMock.mockRejectedValueOnce(
      new FailoverError("selected session expired", { reason: "session_expired", provider }),
    );

    await expect(
      runCliAgent({ ...baseRunParams, provider, trigger: trigger as "user" | "cron" }),
    ).rejects.toMatchObject({ reason: "session_expired" });

    expect(markAuthProfileFailureMock).toHaveBeenCalledOnce();
    expect(markAuthProfileFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        store,
        profileId,
        reason: "session_expired",
        agentDir: "/tmp/agent",
      }),
    );
    expect(markAuthProfileSuccessMock).not.toHaveBeenCalled();
  });

  it.each(["claude-cli", "google-gemini-cli"])(
    "settles a typed %s selected-profile preparation failure before fallback",
    async (provider) => {
      const profileId = `${provider}:selected`;
      const store = {
        version: 1,
        profiles: { [profileId]: { type: "oauth", provider } },
      };
      loadAuthProfileStoreForRuntimeMock.mockReturnValue(store);
      prepareCliRunContextMock.mockRejectedValueOnce(
        new CliAuthProfilePreparationError({
          message: "selected profile needs login",
          profileId,
          provider,
          agentDir: "/tmp/agent",
        }),
      );

      await expect(runCliAgent({ ...baseRunParams, provider })).rejects.toMatchObject({
        name: "CliAuthProfilePreparationError",
        reason: "auth",
        profileId,
      });

      expect(loadAuthProfileStoreForRuntimeMock).toHaveBeenCalledWith(
        "/tmp/agent",
        expect.any(Object),
      );
      expect(markAuthProfileFailureMock).toHaveBeenCalledWith(
        expect.objectContaining({ store, profileId, reason: "auth" }),
      );
    },
  );

  it("does not settle an incompatible explicit profile during isolated preparation", async () => {
    const error = new Error("Gemini CLI execution cannot use a vercel-ai-gateway auth profile.");
    prepareCliRunContextMock.mockRejectedValueOnce(error);

    await expect(
      runCliAgent({
        ...baseRunParams,
        provider: "google-gemini-cli",
        authProfileId: "vercel-ai-gateway:default",
        executionMode: "side-question",
        isolatedCompletion: true,
        disableTools: true,
        cliToolAvailability: { native: [], openClaw: [] },
      }),
    ).rejects.toBe(error);

    expect(loadAuthProfileStoreForRuntimeMock).not.toHaveBeenCalled();
    expect(markAuthProfileFailureMock).not.toHaveBeenCalled();
    expect(markAuthProfileSuccessMock).not.toHaveBeenCalled();
  });

  it("records only success when fresh-session recovery succeeds and clears stale health", async () => {
    const profileId = "google-gemini-cli:selected";
    const store = {
      version: 1,
      profiles: {
        [profileId]: { type: "oauth", provider: "google-gemini-cli", access: "secret" },
      },
      usageStats: {
        [profileId]: { cooldownUntil: Date.now() + 60_000, cooldownReason: "session_expired" },
      },
    };
    prepareCliRunContextMock.mockImplementationOnce(async (params) => ({
      ...(makeStubContext(params as typeof baseRunParams & { trigger?: string }) as object),
      effectiveAuthProfileId: profileId,
      authProfileStore: store,
      agentDir: "/tmp/agent",
      openClawHistoryPrompt: "history",
      reusableCliSession: { mode: "reuse", sessionId: "stale-session" },
      params: {
        ...(params as typeof baseRunParams),
        onBeforeFreshCliSessionRetry: vi.fn(async () => true),
      },
    }));
    executePreparedCliRunMock
      .mockRejectedValueOnce(
        new FailoverError("stale session", {
          reason: "session_expired",
          provider: "google-gemini-cli",
        }),
      )
      .mockResolvedValueOnce({ text: "recovered" });

    await expect(
      runCliAgent({ ...baseRunParams, provider: "google-gemini-cli" }),
    ).resolves.toBeDefined();

    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(2);
    expect(markAuthProfileFailureMock).not.toHaveBeenCalled();
    expect(markAuthProfileSuccessMock).toHaveBeenCalledOnce();
    expect(markAuthProfileSuccessMock).toHaveBeenCalledWith({
      store,
      profileId,
      provider: "google-gemini-cli",
      agentDir: "/tmp/agent",
    });
  });

  it("does not settle auth health when before_agent_run blocks before backend execution", async () => {
    const profileId = "codex-cli:selected";
    const store = {
      version: 1,
      profiles: { [profileId]: { type: "oauth", provider: "codex-cli" } },
    };
    const recorder = {
      persistBlocked: vi.fn(async (message) => ({ message })),
    } as unknown as NonNullable<Parameters<typeof runCliAgent>[0]["userTurnTranscriptRecorder"]>;
    prepareCliRunContextMock.mockImplementationOnce(async (params) => ({
      ...(makeStubContext(params as typeof baseRunParams & { trigger?: string }) as object),
      effectiveAuthProfileId: profileId,
      authProfileStore: store,
      agentDir: "/tmp/agent",
    }));
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_run");
    runBeforeAgentRunMock.mockResolvedValueOnce({
      pluginId: "policy-plugin",
      decision: { outcome: "block", reason: "test policy", message: "Blocked by policy." },
    });

    await expect(
      runCliAgent({ ...baseRunParams, userTurnTranscriptRecorder: recorder }),
    ).resolves.toMatchObject({ meta: { livenessState: "blocked" } });

    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
    expect(markAuthProfileFailureMock).not.toHaveBeenCalled();
    expect(markAuthProfileSuccessMock).not.toHaveBeenCalled();
  });

  it.each([
    new FailoverError("bad transcript", { reason: "format" }),
    new FailoverError("context full", { reason: "context_overflow" }),
    new FailoverError("pre-provider timeout", {
      reason: "timeout",
      cliTimeout: {
        mode: "no-output",
        timeoutSeconds: 30,
        observedActivity: false,
        activeToolCount: 0,
        backgroundTaskCount: 0,
      },
    }),
  ])("does not settle selected-profile health for local failure %#", async (error) => {
    const profileId = "claude-cli:selected";
    prepareCliRunContextMock.mockImplementationOnce(async (params) => ({
      ...(makeStubContext(params as typeof baseRunParams & { trigger?: string }) as object),
      effectiveAuthProfileId: profileId,
      authProfileStore: {
        version: 1,
        profiles: { [profileId]: { type: "api_key", provider: "claude-cli", key: "secret" } },
      },
    }));
    executePreparedCliRunMock.mockRejectedValueOnce(error);

    await expect(runCliAgent({ ...baseRunParams, provider: "claude-cli" })).rejects.toBe(error);
    expect(markAuthProfileFailureMock).not.toHaveBeenCalled();
    expect(markAuthProfileSuccessMock).not.toHaveBeenCalled();
  });

  it("leaves ambient no-profile failures out of shared health", async () => {
    executePreparedCliRunMock.mockRejectedValueOnce(
      new FailoverError("ambient auth failed", { reason: "auth", provider: "claude-cli" }),
    );

    await expect(runCliAgent({ ...baseRunParams, provider: "claude-cli" })).rejects.toMatchObject({
      reason: "auth",
    });
    expect(markAuthProfileFailureMock).not.toHaveBeenCalled();
    expect(markAuthProfileSuccessMock).not.toHaveBeenCalled();
  });

  it("adds Claude CLI harness and run ownership at the runner entrypoint", async () => {
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
      if ("runId" in event && event.runId === "claude-entrypoint-run") {
        events.push(event);
      }
    });
    executePreparedCliRunMock.mockResolvedValue({ text: "real Claude reply" });

    let result: Awaited<ReturnType<typeof runCliAgent>> | undefined;
    try {
      result = await runCliAgent({
        ...baseRunParams,
        provider: "claude-cli",
        modelProvider: "anthropic",
        model: "claude-opus-4-7",
        runId: "claude-entrypoint-run",
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      unsubscribe();
    }

    const harnessStarted = events.find((event) => event.type === "harness.run.started");
    const runStarted = events.find((event) => event.type === "run.started");
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "harness.run.started",
        "run.started",
        "run.completed",
        "harness.run.completed",
      ]),
    );
    expect(harnessStarted).toMatchObject({
      harnessId: "claude-cli",
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(runStarted?.trace?.parentSpanId).toBe(harnessStarted?.trace?.spanId);
    expect(result?.diagnosticTrace).toEqual(harnessStarted?.trace);
  });

  it("bypasses Claude CLI diagnostics when no event listener is active", async () => {
    executePreparedCliRunMock.mockResolvedValue({ text: "real Claude reply" });

    const result = await runCliAgent({
      ...baseRunParams,
      provider: "claude-cli",
      modelProvider: "anthropic",
      model: "claude-opus-4-7",
      runId: "claude-no-diagnostics-listener",
    });

    expect(result.diagnosticTrace).toBeUndefined();
    expect(executePreparedCliRunMock).toHaveBeenCalledOnce();
  });

  it("projects CLI tool summaries onto terminal run metadata", async () => {
    executePreparedCliRunMock.mockResolvedValue({
      text: "done",
      toolSummary: { calls: 1, tools: ["github.search"], failures: 0 },
    });

    const result = await runCliAgent(baseRunParams);

    expect(result.meta.toolSummary).toEqual({
      calls: 1,
      tools: ["github.search"],
      failures: 0,
    });
  });

  it("preserves the send phase when execution fails before successful cleanup", async () => {
    executePreparedCliRunMock.mockRejectedValueOnce(new Error("CLI process failed"));

    const { error, events } = await captureRejectedClaudeRun({
      ...baseRunParams,
      provider: "claude-cli",
      modelProvider: "anthropic",
      model: "claude-opus-4-7",
      runId: "claude-send-error",
      cleanupCliLiveSessionOnRunEnd: true,
    });

    expect(error).toMatchObject({ message: "CLI process failed" });
    expect(closeClaudeSessionMock).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === "harness.run.error")).toMatchObject({
      type: "harness.run.error",
      phase: "send",
    });
  });

  it("classifies post-execution response validation failures as resolve", async () => {
    executePreparedCliRunMock.mockResolvedValueOnce({ text: "" });

    const { error, events } = await captureRejectedClaudeRun({
      ...baseRunParams,
      provider: "claude-cli",
      modelProvider: "anthropic",
      model: "claude-opus-4-7",
      runId: "claude-resolve-error",
    });

    expect(error).toMatchObject({ message: "CLI backend returned an empty response." });
    expect(events.find((event) => event.type === "harness.run.error")).toMatchObject({
      type: "harness.run.error",
      phase: "resolve",
    });
  });

  it("classifies a surfaced outer cleanup failure as cleanup", async () => {
    executePreparedCliRunMock.mockResolvedValueOnce({ text: "real Claude reply" });
    closeClaudeSessionMock.mockRejectedValueOnce(new Error("managed session cleanup failed"));

    const { error, events } = await captureRejectedClaudeRun({
      ...baseRunParams,
      provider: "claude-cli",
      modelProvider: "anthropic",
      model: "claude-opus-4-7",
      runId: "claude-cleanup-error",
      cleanupCliLiveSessionOnRunEnd: true,
    });

    expect(error).toMatchObject({ message: "managed session cleanup failed" });
    expect(events.find((event) => event.type === "harness.run.error")).toMatchObject({
      type: "harness.run.error",
      phase: "cleanup",
    });
  });

  it("rejects stale lifecycle ownership before CLI preparation", async () => {
    await expect(
      runCliAgent({
        ...baseRunParams,
        lifecycleGeneration: "stale-generation",
      }),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "Agent run belongs to a stale gateway lifecycle",
    });

    expect(prepareCliRunContextMock).not.toHaveBeenCalled();
    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
  });

  it("lets before_agent_reply claim cron runs before the CLI subprocess is invoked", async () => {
    const logInfoSpy = vi.spyOn(cliBackendLog, "info").mockImplementation(() => undefined);
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({
      handled: true,
      reply: { text: "dreaming claimed via cli runner" },
    });
    const onExecutionPhase = vi.fn();

    try {
      const result = await runCliAgent({
        ...baseRunParams,
        trigger: "cron",
        jobId: "cron-job-123",
        chatId: "native-chat-123",
        onExecutionPhase,
      });

      expect(runBeforeAgentReplyMock).toHaveBeenCalledTimes(1);
      expect(onExecutionPhase).toHaveBeenCalledWith({
        phase: "before_agent_reply",
        provider: baseRunParams.provider,
        model: baseRunParams.model,
      });
      const [event, context] = runBeforeAgentReplyMock.mock.calls.at(0) ?? [];
      expect(event).toEqual({ cleanedBody: baseRunParams.prompt });
      const hookContext = context as Record<string, unknown> | undefined;
      expect(hookContext?.jobId).toBe("cron-job-123");
      expect(hookContext?.agentId).toBe(baseRunParams.agentId);
      expect(hookContext?.sessionId).toBe(baseRunParams.sessionId);
      expect(hookContext?.sessionKey).toBe(baseRunParams.sessionKey);
      expect(hookContext?.workspaceDir).toBe(baseRunParams.workspaceDir);
      expect(hookContext?.trigger).toBe("cron");
      expect(hookContext?.chatId).toBeUndefined();
      expect(hookContext?.channel).toBeUndefined();
      expect(executePreparedCliRunMock).not.toHaveBeenCalled();
      expect(result.payloads?.[0]?.text).toBe("dreaming claimed via cli runner");
      expect(result.meta.agentMeta?.sessionId).toBe("");
      expect(result.meta.agentMeta?.clearCliSessionBinding).toBeUndefined();

      const syntheticTurnLog = logInfoSpy.mock.calls
        .map(([message]) => message)
        .find((message) => message.startsWith("cli synthetic turn:"));
      // Synthetic turn logs prove the branch without leaking hook reply text.
      expect(syntheticTurnLog).toContain("provider=codex-cli");
      expect(syntheticTurnLog).toContain("model=<synthetic>");
      expect(syntheticTurnLog).toContain("requestedModel=gpt-5.5");
      expect(syntheticTurnLog).toContain("outBytes=31 outHash=96317e453543");
      expect(syntheticTurnLog).not.toContain("dreaming claimed via cli runner");
    } finally {
      logInfoSpy.mockRestore();
    }
  });

  it.each(["manual", "memory", "overflow"] as const)(
    "does not expose internal %s runs to before_agent_reply hooks",
    async (trigger) => {
      hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
      executePreparedCliRunMock.mockResolvedValue({ text: "manual result" });

      await runCliAgent({
        ...baseRunParams,
        trigger,
      });

      expect(runBeforeAgentReplyMock).not.toHaveBeenCalled();
      expect(prepareCliRunContextMock).toHaveBeenCalledTimes(1);
      expect(executePreparedCliRunMock).toHaveBeenCalledTimes(1);
    },
  );

  it("clears stateless CLI bindings when before_agent_reply claims a cron turn", async () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          id: "codex-cli",
          pluginId: "test-codex-cli",
          config: {
            command: "codex",
            args: ["exec"],
            output: "text",
            input: "arg",
            sessionMode: "none",
          },
        },
      ],
    });
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({ handled: true });

    const result = await runCliAgent({
      ...baseRunParams,
      trigger: "cron",
      config: {},
    });

    expect(result.meta.agentMeta?.sessionId).toBe("");
    expect(result.meta.agentMeta?.clearCliSessionBinding).toBe(true);
    expect(prepareCliRunContextMock).not.toHaveBeenCalled();
    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
  });

  it("does not run prepareCliRunContext when the cron hook claims (no resource allocation, no leak)", async () => {
    // Regression for PR #70950 review (greptile-apps, P1): the gate must fire
    // before any backend resources are allocated, otherwise preparedBackend.cleanup
    // is silently skipped on every claimed cron turn.
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({ handled: true });

    await runCliAgent({ ...baseRunParams, trigger: "cron", jobId: "cron-job-123" });

    expect(prepareCliRunContextMock).not.toHaveBeenCalled();
    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
  });

  it("re-arms setup progress when a cron hook does not claim", async () => {
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue(undefined);
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });
    const onExecutionPhase = vi.fn();

    await runCliAgent({
      ...baseRunParams,
      trigger: "cron",
      jobId: "cron-job-123",
      onExecutionPhase,
    });

    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "before_agent_reply",
      provider: baseRunParams.provider,
      model: baseRunParams.model,
    });
    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "runtime_plugins",
      provider: baseRunParams.provider,
      model: baseRunParams.model,
    });
    expect(prepareCliRunContextMock).toHaveBeenCalledTimes(1);
    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(1);
  });

  it("treats empty CLI subprocess output as a failover failure, not a green cron run", async () => {
    executePreparedCliRunMock.mockResolvedValue({ text: "   " });

    await expect(runCliAgent({ ...baseRunParams, trigger: "cron" })).rejects.toMatchObject({
      name: "FailoverError",
      reason: "empty_response",
      provider: baseRunParams.provider,
      model: baseRunParams.model,
      sessionId: baseRunParams.sessionId,
    });
  });

  it("returns a silent payload when a cron hook claims without a reply body", async () => {
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({ handled: true });

    const result = await runCliAgent({ ...baseRunParams, trigger: "cron", jobId: "cron-job-123" });

    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe(SILENT_REPLY_TOKEN);
  });

  it("lets before_agent_reply claim user runs before CLI preparation", async () => {
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({
      handled: true,
      reply: { text: "user turn claimed" },
    });

    const result = await runCliAgent({ ...baseRunParams, trigger: "user" });

    expect(runBeforeAgentReplyMock).toHaveBeenCalledTimes(1);
    const [, hookContext] = runBeforeAgentReplyMock.mock.calls.at(0) ?? [];
    expect(hookContext).toMatchObject({ trigger: "user" });
    expect(prepareCliRunContextMock).not.toHaveBeenCalled();
    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe("user turn claimed");
  });

  it("gives the claim hook the authenticated inbound message and owner bit", async () => {
    // The claim hook decides before the model runs, so it must be able to bind
    // its decision to one exact authenticated message instead of re-deriving
    // the turn from prompt text.
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({ handled: true, reply: { text: "claimed" } });

    await runCliAgent({
      ...baseRunParams,
      trigger: "user",
      senderId: "sender-1",
      senderIsOwner: true,
      chatId: "chat-1",
      currentMessageId: 4242,
    });

    expect(runBeforeAgentReplyMock).toHaveBeenCalledTimes(1);
    const [, hookContext] = runBeforeAgentReplyMock.mock.calls.at(0) ?? [];
    expect(hookContext).toMatchObject({
      trigger: "user",
      senderId: "sender-1",
      chatId: "chat-1",
      messageId: "4242",
      senderIsOwner: true,
    });
  });

  it("keeps the owner bit out of the claim hook for non-user triggers", async () => {
    // senderIsOwner is a user-turn fact; automation turns must not inherit it.
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({ handled: true, reply: { text: "claimed" } });

    await runCliAgent({
      ...baseRunParams,
      trigger: "cron",
      senderId: "sender-1",
      senderIsOwner: true,
      currentMessageId: "msg-1",
    });

    const [, hookContext] = runBeforeAgentReplyMock.mock.calls.at(0) ?? [];
    expect(hookContext).not.toHaveProperty("senderIsOwner");
    expect(hookContext).not.toHaveProperty("messageId");
  });

  it("lets before_agent_reply claim heartbeat runs before CLI preparation", async () => {
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({
      handled: true,
      reply: { text: "heartbeat claimed" },
    });

    const result = await runCliAgent({ ...baseRunParams, trigger: "heartbeat" });

    expect(runBeforeAgentReplyMock).toHaveBeenCalledTimes(1);
    const [, hookContext] = runBeforeAgentReplyMock.mock.calls.at(0) ?? [];
    expect(hookContext).toMatchObject({ trigger: "heartbeat" });
    expect(prepareCliRunContextMock).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe("heartbeat claimed");
  });

  it("dispatches a declining hook once when model fallback re-enters the CLI runner", async () => {
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue(undefined);
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });
    const onExecutionPhase = vi.fn();

    await withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), async () => {
      await runCliAgent({ ...baseRunParams, trigger: "user", onExecutionPhase });
      await runCliAgent({
        ...baseRunParams,
        trigger: "user",
        model: "fallback-model",
        onExecutionPhase,
      });
    });

    expect(runBeforeAgentReplyMock).toHaveBeenCalledTimes(1);
    expect(
      onExecutionPhase.mock.calls.filter(([event]) => event.phase === "before_agent_reply"),
    ).toHaveLength(1);
    expect(prepareCliRunContextMock).toHaveBeenCalledTimes(2);
    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(2);
  });

  it("falls through to the CLI subprocess when no before_agent_reply hook is registered", async () => {
    hasHooksMock.mockReturnValue(false);
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });

    await runCliAgent({ ...baseRunParams, trigger: "cron" });

    expect(runBeforeAgentReplyMock).not.toHaveBeenCalled();
    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(1);
  });

  it("reports confirmed CLI messaging delivery evidence without leaking it to later invocations", async () => {
    executePreparedCliRunMock.mockResolvedValueOnce({
      text: "sent",
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "telegram",
          to: "chat123",
        },
      ],
    });
    executePreparedCliRunMock.mockResolvedValueOnce({ text: "later" });

    const firstResult = await runCliAgent(baseRunParams);
    expect(firstResult.didSendViaMessagingTool).toBe(true);
    expect(firstResult.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
      }),
    ]);

    const laterResult = await runCliAgent(baseRunParams);
    expect(laterResult.didSendViaMessagingTool).toBeUndefined();
    expect(laterResult.messagingToolSentTargets).toBeUndefined();
  });

  it("can close temporary CLI live sessions after a run", async () => {
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });

    await runCliAgent({ ...baseRunParams, cleanupCliLiveSessionOnRunEnd: true });

    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(1);
    expect(closeClaudeSessionMock).toHaveBeenCalledTimes(1);
    expect(closeClaudeSessionMock).toHaveBeenCalledWith(
      await expectDefined(
        prepareCliRunContextMock.mock.results[0],
        "prepareCliRunContextMock.mock.results[0] test invariant",
      ).value,
      "restart",
    );
  });

  it("keeps concurrent authenticated MCP streams alive until gateway-owned shutdown", async () => {
    const mcpHttp =
      await vi.importActual<typeof import("../gateway/mcp-http.js")>("../gateway/mcp-http.js");
    const { getActiveMcpLoopbackRuntime } = await vi.importActual<
      typeof import("../gateway/mcp-http.loopback-runtime.js")
    >("../gateway/mcp-http.loopback-runtime.js");
    const server = await mcpHttp.ensureMcpLoopbackServer();
    const runtime = getActiveMcpLoopbackRuntime();
    if (!runtime) {
      throw new Error("expected an active MCP loopback runtime");
    }

    // Make the old per-run teardown exercise the actual listener, not merely a
    // mock; unrelated CLI sessions must retain their authenticated streams.
    closeMcpLoopbackServerMock.mockImplementation(() => mcpHttp.closeMcpLoopbackServer());
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    const openStreams = async (sessionKeys: readonly string[]) => {
      const responses = await Promise.all(
        sessionKeys.map((sessionKey) =>
          fetch(`http://127.0.0.1:${server.port}/mcp`, {
            method: "GET",
            headers: {
              authorization: `Bearer ${runtime.ownerToken}`,
              "x-session-key": sessionKey,
            },
          }),
        ),
      );
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("expected an authenticated MCP notification stream");
        }
        readers.push(reader);
        const firstFrame = await reader.read();
        expect(firstFrame.done).toBe(false);
        expect(new TextDecoder().decode(firstFrame.value)).toContain(":\n\n");
      }
    };

    try {
      await openStreams(["agent:main:concurrent-one", "agent:main:concurrent-two"]);

      const unauthorized = await fetch(`http://127.0.0.1:${server.port}/mcp`);
      expect(unauthorized.status).toBe(401);
      await unauthorized.body?.cancel();

      await runCliAgent({ ...baseRunParams, cleanupBundleMcpOnRunEnd: true });

      const survivingRuntime = getActiveMcpLoopbackRuntime();
      if (!survivingRuntime) {
        throw new Error("helper cleanup incorrectly closed the active MCP loopback server");
      }
      expect(survivingRuntime.port).toBe(server.port);
      expect(survivingRuntime.ownerToken === runtime.ownerToken).toBe(true);
      const originalStreamStates = await Promise.all(
        readers.map(async (reader) => {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              reader.closed.then(
                () => "closed" as const,
                () => "closed" as const,
              ),
              new Promise<"open">((resolve) => {
                timeout = setTimeout(() => resolve("open"), 100);
              }),
            ]);
          } finally {
            if (timeout) {
              clearTimeout(timeout);
            }
          }
        }),
      );
      expect(originalStreamStates).toEqual(["open", "open"]);
      await openStreams(["agent:main:concurrent-three", "agent:main:concurrent-four"]);
      expect(closeMcpLoopbackServerMock).not.toHaveBeenCalled();

      await mcpHttp.closeMcpLoopbackServer();
      expect(getActiveMcpLoopbackRuntime()).toBeUndefined();
      for (const result of await Promise.all(readers.map((reader) => reader.read()))) {
        expect(result.done).toBe(true);
      }
      await expect(fetch(`http://127.0.0.1:${server.port}/mcp`)).rejects.toThrow();
    } finally {
      await mcpHttp.closeMcpLoopbackServer();
      await Promise.allSettled(readers.map((reader) => reader.cancel()));
    }
  });

  it("retires only the run's session-scoped MCP runtime, not the process-wide loopback server", async () => {
    // Regression guard for #98435: closing the process-wide loopback server on
    // a single run's cleanup strands concurrent CLI turns and restart-recovered
    // sessions on a dead loopback port.
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });

    await runCliAgent({ ...baseRunParams, cleanupBundleMcpOnRunEnd: true });

    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(1);
    expect(retireSessionMcpRuntimeMock).toHaveBeenCalledTimes(1);
    expect(retireSessionMcpRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "test-session", reason: "cli-run-end" }),
    );
    expect(retireSessionMcpRuntimeForSessionKeyMock).not.toHaveBeenCalled();
    expect(closeMcpLoopbackServerMock).not.toHaveBeenCalled();
  });

  it("does not retire a newer MCP runtime after its stable session key is rebound", async () => {
    const mcpTools = await vi.importActual<typeof import("./agent-bundle-mcp-tools.js")>(
      "./agent-bundle-mcp-tools.js",
    );
    const sessionKey = "agent:main:rebound-cli-cleanup";
    const originalSessionId = "rebound-cli-cleanup-original";
    const successorSessionId = "rebound-cli-cleanup-successor";
    const runtimeParams = {
      sessionKey,
      workspaceDir: baseRunParams.workspaceDir,
      cfg: { mcp: { servers: {} } },
    };
    retireSessionMcpRuntimeForSessionKeyMock.mockImplementation(
      mcpTools.retireSessionMcpRuntimeForSessionKey,
    );
    retireSessionMcpRuntimeMock.mockImplementation(mcpTools.retireSessionMcpRuntime);
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });

    try {
      await mcpTools.getOrCreateSessionMcpRuntime({
        ...runtimeParams,
        sessionId: originalSessionId,
      });
      const successorRuntime = await mcpTools.getOrCreateSessionMcpRuntime({
        ...runtimeParams,
        sessionId: successorSessionId,
      });

      await runCliAgent({
        ...baseRunParams,
        sessionId: originalSessionId,
        sessionKey,
        cleanupBundleMcpOnRunEnd: true,
      });

      expect(mcpTools.peekSessionMcpRuntime({ sessionId: originalSessionId })).toBeUndefined();
      expect(mcpTools.peekSessionMcpRuntime({ sessionId: successorSessionId })).toBe(
        successorRuntime,
      );
      expect(mcpTools.peekSessionMcpRuntime({ sessionKey })).toBe(successorRuntime);
      expect(retireSessionMcpRuntimeForSessionKeyMock).not.toHaveBeenCalled();
      expect(closeMcpLoopbackServerMock).not.toHaveBeenCalled();
    } finally {
      await mcpTools.retireSessionMcpRuntime({ sessionId: originalSessionId, reason: "test-end" });
      await mcpTools.retireSessionMcpRuntime({ sessionId: successorSessionId, reason: "test-end" });
    }
  });

  it("retires the immutable session ID without resolving a rebound session key", async () => {
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });

    await runCliAgent({ ...baseRunParams, cleanupBundleMcpOnRunEnd: true });

    expect(retireSessionMcpRuntimeMock).toHaveBeenCalledTimes(1);
    expect(retireSessionMcpRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "test-session", reason: "cli-run-end" }),
    );
    expect(retireSessionMcpRuntimeForSessionKeyMock).not.toHaveBeenCalled();
    expect(closeMcpLoopbackServerMock).not.toHaveBeenCalled();
  });

  it("preserves confirmed delivery when session MCP retirement fails", async () => {
    executePreparedCliRunMock.mockResolvedValue({
      text: "",
      didSendViaMessagingTool: true,
    });
    retireSessionMcpRuntimeMock.mockImplementation(
      async ({ onError }: { onError?: (error: unknown) => void }) => {
        onError?.(new Error("session mcp retire failed"));
        return false;
      },
    );

    await expect(
      runCliAgent({ ...baseRunParams, cleanupBundleMcpOnRunEnd: true }),
    ).resolves.toMatchObject({
      didSendViaMessagingTool: true,
    });
  });

  it("surfaces session MCP retirement failures when nothing was delivered", async () => {
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });
    retireSessionMcpRuntimeMock.mockImplementation(
      async ({ onError }: { onError?: (error: unknown) => void }) => {
        onError?.(new Error("session mcp retire failed"));
        return false;
      },
    );

    await expect(runCliAgent({ ...baseRunParams, cleanupBundleMcpOnRunEnd: true })).rejects.toThrow(
      "session mcp retire failed",
    );
  });
});
