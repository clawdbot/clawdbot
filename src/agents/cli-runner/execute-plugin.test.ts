import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  CliBackendExecute,
  CliBackendExecuteContext,
  CliBackendLiveSessionHandle,
  CliBackendToolPermissionResult,
} from "../../plugins/cli-backend.types.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  beginCliLiveSessionCreate,
  buildCliLiveSessionKey,
  finishCliLiveSessionCreate,
  registerCliLiveSession,
  removeCliLiveSession,
} from "./cli-live-session-registry.js";
import { resetCliLiveSessionsForTest } from "./cli-live-session.test-support.js";
import { executePluginOwnedProcess } from "./execute-plugin.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);
const activeAdmissions: Array<ReturnType<typeof prepareSystemAgentRunAdmission>> = [];
let nextRunId = 0;

const SUCCESS_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "completed",
  session_id: "sdk-session",
};

async function createExecution(
  options: {
    config?: OpenClawConfig;
    sessionEntry?: RunCliAgentParams["sessionEntry"];
    nativeTools?: string[];
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    runId?: string;
    resumeArgs?: string[];
  } = {},
) {
  const runId = options.runId ?? `plugin-owner-${++nextRunId}`;
  const config = options.config ?? { tools: { exec: { security: "full", ask: "off" } } };
  const admission = prepareSystemAgentRunAdmission(config, runId, "main", "plugin-test");
  activeAdmissions.push(admission);
  const backend = {
    command: "/bin/sh",
    args: [],
    output: "jsonl" as const,
    input: "stdin" as const,
    ...(options.resumeArgs ? { resumeArgs: options.resumeArgs } : {}),
  };
  const context: PreparedCliRunContext = {
    params: {
      admittedRunContext: await admission.admit("plugin-harness"),
      agentId: "main",
      sessionId: "sdk-session",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/openclaw-plugin-owner-session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hello",
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      timeoutMs: options.timeoutMs ?? 5_000,
      runId,
      config,
      executionMode: "agent",
      ...(options.sessionEntry ? { sessionEntry: options.sessionEntry } : {}),
      ...(options.nativeTools
        ? { cliToolAvailability: { native: options.nativeTools, openClaw: [] } }
        : {}),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: { id: "claude-cli", config: backend, bundleMcp: false },
    preparedBackend: { backend, env: {} },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "claude-sonnet-4-6",
    normalizedModel: "claude-sonnet-4-6",
    systemPrompt: "  Follow host policy.  ",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 1,
  };

  return { admission, context };
}

function runPlugin(
  context: PreparedCliRunContext,
  execute: CliBackendExecute,
  options: {
    noOutputTimeoutMs?: number;
    consumeStdout?: (chunk: string) => void;
    sessionId?: string;
    useResume?: boolean;
    forceNewSession?: boolean;
    liveSession?: boolean;
    requiredGeneration?: string;
    onNoOutputTimeout?: NonNullable<
      Parameters<typeof executePluginOwnedProcess>[0]["onNoOutputTimeout"]
    >;
  } = {},
) {
  return executePluginOwnedProcess({
    context,
    execute,
    executionCommand: "/bin/sh",
    executionArgs: ["-p", "--permission-mode", "bypassPermissions"],
    env: { PATH: "/bin:/usr/bin", OPENCLAW_TEST_MARKER: "host-owned" },
    prompt: context.params.prompt,
    useResume: options.useResume ?? false,
    sessionId: options.sessionId ?? "sdk-session",
    ...(options.forceNewSession ? { forceNewSession: true } : {}),
    ...(options.liveSession
      ? {
          liveSession: {
            beginCapture: () => {},
            ...(options.requiredGeneration
              ? { requiredGeneration: options.requiredGeneration }
              : {}),
          },
        }
      : {}),
    ...(options.onNoOutputTimeout ? { onNoOutputTimeout: options.onNoOutputTimeout } : {}),
    noOutputTimeoutMs: options.noOutputTimeoutMs ?? 2_000,
    consumeStdout: options.consumeStdout ?? (() => {}),
  });
}

function registerOwnerSession(context: PreparedCliRunContext, generation: string) {
  const key = buildCliLiveSessionKey(context);
  const session: CliBackendLiveSessionHandle = {
    key,
    generation,
    fingerprint: "existing-owner-policy",
    providerId: context.backendResolved.id,
    modelId: context.normalizedModel,
    isIdle: () => true,
    close: vi.fn(() => removeCliLiveSession(session)),
    waitForExit: vi.fn(async () => {}),
    cleanupResources: vi.fn(async () => {}),
  };
  const pending = beginCliLiveSessionCreate(key, generation);
  registerCliLiveSession(session, pending);
  finishCliLiveSessionCreate(key, pending);
  return session;
}

function requestNativeTool(
  execution: CliBackendExecuteContext,
  toolName = "Bash",
  toolInput: Record<string, unknown> = { command: "echo approved" },
) {
  return execution.requestToolPermission({
    toolName,
    toolInput,
    toolCallId: `native-${toolName}`,
    ...(execution.abortSignal ? { abortSignal: execution.abortSignal } : {}),
  });
}

afterEach(() => {
  for (const admission of activeAdmissions.splice(0)) {
    admission.close();
  }
  resetCliLiveSessionsForTest();
  mockCallGatewayTool.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("plugin-owned CLI execution host boundary", () => {
  it("streams plugin events through the canonical host output boundary", async () => {
    const { context } = await createExecution();
    const output: string[] = [];
    let observedExecution: CliBackendExecuteContext | undefined;
    const execute: CliBackendExecute = async function* (execution) {
      observedExecution = execution;
      yield { type: "system", subtype: "init", session_id: "sdk-session" };
      yield SUCCESS_RESULT;
    };

    await expect(
      runPlugin(context, execute, { consumeStdout: output.push.bind(output) }),
    ).resolves.toMatchObject({ reason: "exit", exitCode: 0, timedOut: false });

    expect(output.map((line) => JSON.parse(line))).toEqual([
      { type: "system", subtype: "init", session_id: "sdk-session" },
      SUCCESS_RESULT,
    ]);
    expect(observedExecution).toEqual(
      expect.objectContaining({
        command: "/bin/sh",
        cwd: "/tmp",
        prompt: "hello",
        modelId: "claude-sonnet-4-6",
        systemPrompt: "Follow host policy.",
        sessionId: "sdk-session",
        useResume: false,
        env: { PATH: "/bin:/usr/bin", OPENCLAW_TEST_MARKER: "host-owned" },
        requestToolPermission: expect.any(Function),
      }),
    );
  });

  it("restarts true fresh sessions while preserving legitimate no-resume warm reuse", async () => {
    const reseed = await createExecution({ runId: "plugin-fresh-reseed" });
    reseed.context.openClawHistoryPrompt = "Previously recorded bounded conversation.";
    const reseededSession = registerOwnerSession(reseed.context, "old-reseed-session");

    await runPlugin(
      reseed.context,
      async function* (execution) {
        expect(execution.liveSession?.current()).toBeUndefined();
        yield SUCCESS_RESULT;
      },
      { liveSession: true, forceNewSession: true },
    );
    expect(reseededSession.close).toHaveBeenCalledWith("restart");

    const resumeCapable = await createExecution({
      runId: "plugin-resume-capable-fresh",
      resumeArgs: ["--resume", "{sessionId}"],
    });
    const resumeSession = registerOwnerSession(resumeCapable.context, "resume-capable-session");
    await runPlugin(
      resumeCapable.context,
      async function* () {
        yield SUCCESS_RESULT;
      },
      { liveSession: true, useResume: false },
    );
    expect(resumeSession.close).toHaveBeenCalledWith("restart");

    const noResume = await createExecution({ runId: "plugin-no-resume-warm", resumeArgs: [] });
    const reusableSession = registerOwnerSession(noResume.context, "no-resume-session");
    await runPlugin(
      noResume.context,
      async function* (execution) {
        expect(execution.liveSession?.current()).toBe(reusableSession);
        yield SUCCESS_RESULT;
      },
      { liveSession: true, useResume: false },
    );
    expect(reusableSession.close).not.toHaveBeenCalled();
  });

  it("rejects missing or replaced required generations but permits a deliberate cold recovery", async () => {
    const { context } = await createExecution({ runId: "plugin-required-generation" });
    context.requiredClaudeLiveSessionGeneration = "original-generation";
    const requireCurrentSession: CliBackendExecute = async function* (execution) {
      execution.liveSession?.current();
      yield SUCCESS_RESULT;
    };
    const resumedOptions = {
      liveSession: true,
      useResume: true,
      requiredGeneration: "original-generation",
    };

    await expect(runPlugin(context, requireCurrentSession, resumedOptions)).rejects.toMatchObject({
      reason: "session_expired",
      code: "cli_live_session_missing",
    });

    const replacement = registerOwnerSession(context, "replacement-generation");
    await expect(runPlugin(context, requireCurrentSession, resumedOptions)).rejects.toMatchObject({
      reason: "session_expired",
      code: "cli_live_session_changed",
    });
    expect(replacement.close).not.toHaveBeenCalled();

    context.openClawHistoryPrompt = "Recovered conversation history.";
    await expect(
      runPlugin(context, requireCurrentSession, {
        liveSession: true,
        useResume: false,
        forceNewSession: true,
      }),
    ).resolves.toMatchObject({ reason: "exit" });
    expect(replacement.close).toHaveBeenCalledWith("restart");
  });

  it("applies restrictive session policy even when global policy permits execution", async () => {
    const { context } = await createExecution({
      config: { tools: { exec: { security: "full", ask: "off" } } },
      sessionEntry: { sessionId: "sdk-session", updatedAt: 1, execSecurity: "deny" },
    });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution);
      yield SUCCESS_RESULT;
    });

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("security=deny"),
      }),
    );
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "full policy releases the exact original input",
      security: "full" as const,
      ask: "off" as const,
      behavior: "allow" as const,
    },
    {
      name: "allowlist policy never silently prompts or grants",
      security: "allowlist" as const,
      ask: "off" as const,
      behavior: "deny" as const,
    },
  ])("$name", async ({ security, ask, behavior }) => {
    const { context } = await createExecution({
      config: { tools: { exec: { security, ask } } },
      nativeTools: ["Read"],
    });
    const input = { file_path: "/tmp/example.png", nested: { source: "exact" } };
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution, "Read", input);
      yield SUCCESS_RESULT;
    });

    expect(decision?.behavior).toBe(behavior);
    if (decision?.behavior === "allow") {
      expect(decision.updatedInput).toBe(input);
    }
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("fails closed for unnamed and unavailable native tools before requesting approval", async () => {
    const { context } = await createExecution({ nativeTools: ["Read"] });
    const decisions: CliBackendToolPermissionResult[] = [];

    await runPlugin(context, async function* (execution) {
      decisions.push(await requestNativeTool(execution, "   "));
      decisions.push(await requestNativeTool(execution, "Bash"));
      yield SUCCESS_RESULT;
    });

    expect(decisions).toEqual([
      expect.objectContaining({ behavior: "deny", message: expect.stringContaining("unnamed") }),
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("unavailable"),
      }),
    ]);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("retains safe standing approvals only for the exact live process and current turn policy", async () => {
    const config: OpenClawConfig = { tools: { exec: { security: "allowlist", ask: "on-miss" } } };
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-first", decision: "allow-always" })
      .mockResolvedValueOnce({ id: "approval-second", decision: "allow-always" });

    const first = await createExecution({
      config,
      nativeTools: ["WebFetch"],
      runId: "plugin-approval-first",
    });
    const registerLiveHandle = (generation: string) => {
      const key = buildCliLiveSessionKey(first.context);
      const handle: CliBackendLiveSessionHandle = {
        key,
        generation,
        fingerprint: "same-owner-policy",
        providerId: "claude-cli",
        modelId: "claude-sonnet-4-6",
        isIdle: () => true,
        close: () => removeCliLiveSession(handle),
        waitForExit: async () => {},
        cleanupResources: async () => {},
      };
      const pending = beginCliLiveSessionCreate(key, generation);
      registerCliLiveSession(handle, pending);
      finishCliLiveSessionCreate(key, pending);
      return handle;
    };
    const originalHandle = registerLiveHandle("original-live-process");

    const runApprovedTurn = async (context: PreparedCliRunContext, repeat: boolean) => {
      await runPlugin(context, async function* (execution) {
        await expect(
          requestNativeTool(execution, "WebFetch", { url: "https://example.com" }),
        ).resolves.toMatchObject({ behavior: "allow" });
        if (repeat) {
          await expect(
            requestNativeTool(execution, "WebFetch", { url: "https://example.com/next" }),
          ).resolves.toMatchObject({ behavior: "allow" });
        }
        yield SUCCESS_RESULT;
      });
    };

    await runApprovedTurn(first.context, true);
    const sameProcess = await createExecution({
      config,
      nativeTools: ["WebFetch"],
      runId: "plugin-approval-second",
    });
    await runApprovedTurn(sameProcess.context, false);
    expect(mockCallGatewayTool).toHaveBeenCalledOnce();

    const restricted = await createExecution({
      config,
      nativeTools: ["WebFetch"],
      runId: "plugin-approval-restricted",
      sessionEntry: { sessionId: "sdk-session", updatedAt: 1, execSecurity: "deny" },
    });
    await runPlugin(restricted.context, async function* (execution) {
      await expect(
        requestNativeTool(execution, "WebFetch", { url: "https://example.com/restricted" }),
      ).resolves.toMatchObject({ behavior: "deny" });
      yield SUCCESS_RESULT;
    });
    expect(mockCallGatewayTool).toHaveBeenCalledOnce();

    removeCliLiveSession(originalHandle);
    registerLiveHandle("replacement-live-process");
    const replacement = await createExecution({
      config,
      nativeTools: ["WebFetch"],
      runId: "plugin-approval-replacement",
    });
    await runApprovedTurn(replacement.context, false);

    expect(mockCallGatewayTool).toHaveBeenCalledTimes(2);
  });

  it("denies approval when its exact admitted authority closes during the awaited decision", async () => {
    const { admission, context } = await createExecution({
      config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      nativeTools: ["WebFetch"],
    });
    mockCallGatewayTool.mockImplementationOnce(async () => {
      admission.close();
      return { id: "approval-closed", decision: "allow-once" };
    });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution, "WebFetch", { url: "https://example.com" });
      yield SUCCESS_RESULT;
    });

    expect(decision).toEqual(
      expect.objectContaining({ behavior: "deny", message: expect.stringContaining("closed") }),
    );
  });

  it("fences a retained permission callback as soon as its turn finishes", async () => {
    const { context } = await createExecution();
    let requestToolPermission: CliBackendExecuteContext["requestToolPermission"] | undefined;

    await runPlugin(context, async function* (execution) {
      requestToolPermission = execution.requestToolPermission;
      yield SUCCESS_RESULT;
    });

    await expect(
      requestToolPermission?.({ toolName: "Bash", toolInput: { command: "echo stale" } }),
    ).resolves.toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("no longer active"),
      }),
    );
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("preserves an authoritative terminal error if the plugin throws while draining", async () => {
    const { context } = await createExecution();
    const output: string[] = [];
    const terminal = {
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      result: "Claude subscription rate limit reached.",
    };

    await expect(
      runPlugin(
        context,
        async function* () {
          yield terminal;
          throw new Error("SDK stream closed after the provider error");
        },
        { consumeStdout: output.push.bind(output) },
      ),
    ).resolves.toMatchObject({ reason: "exit", exitCode: 0 });

    expect(output.map((line) => JSON.parse(line))).toEqual([terminal]);
  });

  it.each([
    {
      name: "a stream without a terminal result",
      execute: async function* () {
        yield { type: "system", subtype: "init" };
      },
      error: "without a terminal result",
    },
    {
      name: "a plugin failure after an otherwise successful result",
      execute: async function* () {
        yield SUCCESS_RESULT;
        throw new Error("SDK stream failed after the result");
      },
      error: "SDK stream failed after the result",
    },
  ])("rejects $name", async ({ execute, error }) => {
    const { context } = await createExecution();

    await expect(runPlugin(context, execute)).rejects.toThrow(error);
  });

  it("aborts a silent plugin stream through the host no-output watchdog", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({ timeoutMs: 5_000 });
    const streamStarted = createDeferred<void>();
    const run = runPlugin(
      context,
      async function* (execution) {
        streamStarted.resolve();
        const signal = execution.abortSignal;
        if (!signal) {
          throw new Error("Host execution did not expose its abort signal.");
        }
        await new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        yield SUCCESS_RESULT;
      },
      { noOutputTimeoutMs: 100 },
    );
    await streamStarted.promise;

    await vi.advanceTimersByTimeAsync(100);

    await expect(run).resolves.toMatchObject({
      reason: "no-output-timeout",
      exitCode: null,
      timedOut: true,
      noOutputTimedOut: true,
    });
  });

  it.each([
    {
      name: "init-only resumed traffic remains safely retryable",
      event: { type: "system", subtype: "init", session_id: "sdk-session" },
      code: "cli_no_output_timeout",
    },
    {
      name: "substantive assistant output never becomes replay-safe",
      event: { type: "assistant", message: { content: [{ type: "text", text: "started" }] } },
      code: undefined,
    },
  ])("$name", async ({ event, code }) => {
    vi.useFakeTimers();
    const { context } = await createExecution({ timeoutMs: 5_000 });
    const output: string[] = [];
    const timeout = vi.fn();
    const run = runPlugin(
      context,
      async function* (execution) {
        yield event;
        const signal = execution.abortSignal;
        if (!signal) {
          throw new Error("Host execution did not expose its abort signal.");
        }
        await new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        yield SUCCESS_RESULT;
      },
      {
        useResume: true,
        noOutputTimeoutMs: 100,
        consumeStdout: output.push.bind(output),
        onNoOutputTimeout: timeout,
      },
    );
    await vi.waitFor(() => expect(output).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(100);

    await expect(run).resolves.toMatchObject({ reason: "no-output-timeout" });
    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout.mock.calls[0]?.[0]).toMatchObject({ reason: "timeout" });
    expect(timeout.mock.calls[0]?.[0]?.code).toBe(code);
  });

  it("keeps an active native approval alive beyond the ordinary no-output watchdog", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({
      config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      nativeTools: ["WebFetch"],
    });
    const approval = createDeferred<{ id: string; decision: "allow-once" }>();
    mockCallGatewayTool.mockReturnValueOnce(approval.promise);
    let completed = false;
    const run = runPlugin(
      context,
      async function* (execution) {
        const decision = await requestNativeTool(execution, "WebFetch", {
          url: "https://example.com/approval",
        });
        expect(decision.behavior).toBe("allow");
        yield SUCCESS_RESULT;
      },
      { noOutputTimeoutMs: 100 },
    ).then((result) => {
      completed = true;
      return result;
    });
    await vi.waitFor(() => expect(mockCallGatewayTool).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(150);
    expect(completed).toBe(false);

    approval.resolve({ id: "approval-pending", decision: "allow-once" });
    await expect(run).resolves.toMatchObject({ reason: "exit", timedOut: false });
  });

  it("keeps tracked background work alive beyond the ordinary no-output watchdog", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution();
    const backgroundFinished = createDeferred<void>();
    const received: string[] = [];
    let completed = false;
    const run = runPlugin(
      context,
      async function* () {
        yield {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "background-agent", task_type: "local_agent" }],
        };
        await backgroundFinished.promise;
        yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
        yield SUCCESS_RESULT;
      },
      { noOutputTimeoutMs: 100, consumeStdout: received.push.bind(received) },
    ).then((result) => {
      completed = true;
      return result;
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(150);
    expect(completed).toBe(false);

    backgroundFinished.resolve();
    await expect(run).resolves.toMatchObject({ reason: "exit", timedOut: false });
    expect(received.map((event) => JSON.parse(event))).toHaveLength(3);
  });

  it("propagates caller cancellation and closes the active plugin iterator", async () => {
    const controller = new AbortController();
    const { context } = await createExecution({ abortSignal: controller.signal });
    const streamStarted = createDeferred<void>();
    const streamClosed = vi.fn();
    const run = runPlugin(context, async function* (execution) {
      try {
        streamStarted.resolve();
        const signal = execution.abortSignal;
        if (!signal) {
          throw new Error("Host execution did not expose its abort signal.");
        }
        await new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        yield SUCCESS_RESULT;
      } finally {
        streamClosed();
      }
    });
    await streamStarted.promise;

    controller.abort();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(streamClosed).toHaveBeenCalledOnce();
  });
});
