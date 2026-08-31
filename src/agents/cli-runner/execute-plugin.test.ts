import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
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
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  closeCliLiveSession,
  createCliLiveSessionCapability,
} from "./cli-live-session-registry.js";
import { executePluginOwnedProcess } from "./execute-plugin.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);
const activeAdmissions: Array<ReturnType<typeof prepareSystemAgentRunAdmission>> = [];
const activeSessions = new Set<CliBackendLiveSessionHandle>();
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
  const context = buildPreparedCliRunContext({
    provider: "claude-cli",
    model: "claude-sonnet-4-6",
    agentId: "main",
    runId,
    sessionId: "sdk-session",
    sessionKey: "agent:main:main",
    prompt: "hello",
    config,
    executionMode: "agent",
    timeoutMs: options.timeoutMs ?? 5_000,
    sessionEntry: options.sessionEntry,
    ...(options.nativeTools
      ? { cliToolAvailability: { native: options.nativeTools, openClaw: [] } }
      : {}),
    systemPrompt: "  Follow host policy.  ",
    backend: {
      command: "/bin/sh",
      args: [],
      ...(options.resumeArgs ? { resumeArgs: options.resumeArgs } : {}),
    },
  });
  context.params.admittedRunContext = await admission.admit("plugin-harness");
  if (options.abortSignal) {
    context.params.abortSignal = options.abortSignal;
  }

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
    onInterrupted?: (reason: "aborted" | "timeout") => boolean;
  } = {},
) {
  return executePluginOwnedProcess({
    context,
    execute,
    executionCommand: "/bin/sh",
    executionArgs: ["-p", "--permission-mode", "bypassPermissions"],
    env: { PATH: "/bin:/usr/bin", OPENCLAW_TEST_MARKER: "host-owned" },
    prompt: context.params.prompt,
    promptContext: context.promptContext,
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
    ...(options.onInterrupted ? { onInterrupted: options.onInterrupted } : {}),
    noOutputTimeoutMs: options.noOutputTimeoutMs ?? 2_000,
    consumeStdout: options.consumeStdout ?? (() => {}),
  });
}

function registerOwnerSession(context: PreparedCliRunContext, generation: string) {
  const capability = createCliLiveSessionCapability({
    context,
    argv: ["/bin/sh", "-p", "--permission-mode", "bypassPermissions"],
    env: { PATH: "/bin:/usr/bin", OPENCLAW_TEST_MARKER: "host-owned" },
    beginCapture: () => {},
    abortSignal: new AbortController().signal,
  });
  const close = vi.fn(() => capability.remove(session));
  const session: CliBackendLiveSessionHandle = {
    generation,
    fingerprint: capability.fingerprint,
    isIdle: () => true,
    close,
    waitForExit: vi.fn(async () => {}),
  };
  capability.register(session);
  activeSessions.add(session);
  return { handle: session, close };
}

function waitUntilAborted(execution: CliBackendExecuteContext): Promise<void> {
  const signal = execution.abortSignal;
  if (!signal) {
    throw new Error("Host execution did not expose its abort signal.");
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () =>
        reject(
          signal.reason instanceof Error ? signal.reason : new Error("CLI test run was aborted."),
        ),
      { once: true },
    );
  });
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
  for (const session of activeSessions) {
    session.close("restart");
  }
  activeSessions.clear();
  for (const admission of activeAdmissions.splice(0)) {
    admission.close();
  }
  mockCallGatewayTool.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("plugin-owned CLI execution host boundary", () => {
  it("streams plugin events through the canonical host output boundary", async () => {
    const { context } = await createExecution();
    context.systemPrompt = `  Follow host policy.${SYSTEM_PROMPT_CACHE_BOUNDARY}Keep credentials private.  `;
    context.promptContext = {
      prependContext: "private red prefix",
      appendContext: "private red suffix",
    };
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
        promptContext: {
          prependContext: "private red prefix",
          appendContext: "private red suffix",
        },
        modelId: "claude-sonnet-4-6",
        systemPrompt: "Follow host policy.\nKeep credentials private.",
        sessionId: "sdk-session",
        useResume: false,
        env: { PATH: "/bin:/usr/bin", OPENCLAW_TEST_MARKER: "host-owned" },
        requestToolPermission: expect.any(Function),
        requestUserInput: expect.any(Function),
      }),
    );
  });

  it("runs plugin user questions through the shared Gateway question flow", async () => {
    const { context } = await createExecution({
      runId: "plugin-user-input",
      nativeTools: ["AskUserQuestion"],
    });
    let promptDelivered = createDeferred();
    const onBlockReply = vi.fn(async () => {
      promptDelivered.resolve();
    });
    context.params.onBlockReply = onBlockReply;
    const requests = new Map<string, { questions: Array<{ questionId: string }> }>();
    mockCallGatewayTool.mockImplementation(async (method, _opts, rawParams) => {
      const params = rawParams as { id: string; questions?: Array<{ questionId: string }> };
      if (method === "question.request") {
        requests.set(params.id, { questions: params.questions ?? [] });
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        const request = requests.get(params.id);
        await promptDelivered.promise;
        promptDelivered = createDeferred();
        return {
          status: "answered",
          answers: {
            answers: Object.fromEntries(
              (request?.questions ?? []).map((question) => [
                question.questionId,
                [question.questionId],
              ]),
            ),
          },
        };
      }
      if (method === "question.resolve") {
        return { status: "cancelled" };
      }
      throw new Error(`Unexpected Gateway method: ${method}`);
    });
    let result: unknown;

    await runPlugin(context, async function* (execution) {
      result = await execution.requestUserInput({
        toolName: "AskUserQuestion",
        toolCallId: "claude-question",
        questions: [
          {
            id: "one",
            header: "One",
            question: "First question?",
            isOther: true,
            options: [{ label: "A" }, { label: "B" }],
          },
          {
            id: "two",
            header: "Two",
            question: "Second question?",
            isOther: true,
            options: [{ label: "A" }, { label: "B" }],
          },
          {
            id: "three",
            header: "Three",
            question: "Third question?",
            isOther: true,
            options: [{ label: "A" }, { label: "B" }],
          },
          {
            id: "four",
            header: "Four",
            question: "Fourth question?",
            isOther: true,
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      });
      yield SUCCESS_RESULT;
    });

    expect(result).toEqual({
      status: "answered",
      answers: {
        one: ["one"],
        two: ["two"],
        three: ["three"],
        four: ["four"],
      },
    });
    expect([...requests.keys()]).toEqual(["claude-question:0", "claude-question:1"]);
    expect([...requests.values()].map((request) => request.questions.length)).toEqual([3, 1]);
    expect(onBlockReply).toHaveBeenCalledTimes(2);
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
        expect(execution.liveSession?.current()).toBe(reusableSession.handle);
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

  it("claims prepared resources only for the original process and cleans after its exit", async () => {
    const first = await createExecution({ runId: "plugin-prepared-resource-owner" });
    const cleanup = vi.fn(async () => {});
    first.context.preparedBackend.claimLiveSessionResources = vi.fn(() => cleanup);
    const exited = createDeferred();
    let handle: CliBackendLiveSessionHandle | undefined;

    await runPlugin(
      first.context,
      async function* (execution) {
        const capability = execution.liveSession;
        if (!capability) {
          throw new Error("Expected a reusable plugin execution capability.");
        }
        const session: CliBackendLiveSessionHandle = {
          generation: "prepared-resource-process",
          fingerprint: capability.fingerprint,
          isIdle: () => true,
          close: vi.fn(() => capability.remove(session)),
          waitForExit: () => exited.promise,
        };
        handle = session;
        capability.register(session);
        activeSessions.add(session);
        yield SUCCESS_RESULT;
      },
      { liveSession: true },
    );

    expect(first.context.preparedBackend.claimLiveSessionResources).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();

    const resumed = await createExecution({ runId: "plugin-prepared-resource-reuse" });
    const unusedResourceClaim = vi.fn(() => vi.fn(async () => {}));
    resumed.context.preparedBackend.claimLiveSessionResources = unusedResourceClaim;

    await runPlugin(
      resumed.context,
      async function* (execution) {
        expect(execution.liveSession?.current()).toBe(handle);
        yield SUCCESS_RESULT;
      },
      { liveSession: true },
    );

    expect(unusedResourceClaim).not.toHaveBeenCalled();
    const closing = closeCliLiveSession(first.context, "restart");
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();

    exited.resolve();
    await closing;
    expect(cleanup).toHaveBeenCalledOnce();
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
    const originalHandle = registerOwnerSession(first.context, "original-live-process");

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
      sessionEntry: { sessionId: "sdk-session", updatedAt: 1, permissionMode: "read-only" },
    });
    await runPlugin(restricted.context, async function* (execution) {
      await expect(
        requestNativeTool(execution, "WebFetch", { url: "https://example.com/restricted" }),
      ).resolves.toMatchObject({ behavior: "deny" });
      yield SUCCESS_RESULT;
    });
    expect(mockCallGatewayTool).toHaveBeenCalledOnce();

    originalHandle.handle.close("restart");
    registerOwnerSession(first.context, "replacement-live-process");
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

  it("cancels an in-flight native approval and never releases its late decision", async () => {
    const controller = new AbortController();
    const { context } = await createExecution({
      abortSignal: controller.signal,
      config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      nativeTools: ["WebFetch"],
    });
    const approval = createDeferred<{ id: string; decision: "allow-always" }>();
    mockCallGatewayTool.mockReturnValueOnce(approval.promise);
    const granted = vi.fn();
    const closed = vi.fn();
    const run = runPlugin(context, async function* (execution) {
      try {
        const decision = await requestNativeTool(execution, "WebFetch", {
          url: "https://example.com/canceled-approval",
        });
        if (decision.behavior === "allow") {
          granted();
        }
        yield SUCCESS_RESULT;
      } finally {
        closed();
      }
    });
    await vi.waitFor(() => expect(mockCallGatewayTool).toHaveBeenCalledOnce());
    const approvalSignal = mockCallGatewayTool.mock.calls[0]?.[3]?.signal;

    controller.abort();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(approvalSignal?.aborted).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
    expect(granted).not.toHaveBeenCalled();

    approval.resolve({ id: "canceled-approval", decision: "allow-always" });
    await Promise.resolve();
    expect(granted).not.toHaveBeenCalled();
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

  it.each([
    {
      name: "a 429 error-marked success",
      terminal: {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 429,
        result: "Claude subscription rate limit reached.",
      },
    },
    {
      name: "a 529 provider-error subtype despite an unset error flag",
      terminal: {
        type: "result",
        subtype: "error_during_execution",
        is_error: false,
        api_error_status: 529,
        errors: ["Anthropic API overloaded (529)."],
      },
    },
  ])("preserves $name if the plugin throws while draining", async ({ terminal }) => {
    const { context } = await createExecution();
    const output: string[] = [];

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
      async *execute() {
        yield { type: "system", subtype: "init" };
      },
      error: "without a terminal result",
    },
    {
      name: "a plugin failure after an otherwise successful result",
      async *execute() {
        yield SUCCESS_RESULT;
        throw new Error("SDK stream failed after the result");
      },
      error: "SDK stream failed after the result",
    },
  ])("rejects $name", async (testCase) => {
    const { context } = await createExecution();

    await expect(runPlugin(context, () => testCase.execute())).rejects.toThrow(testCase.error);
  });

  it("aborts a silent plugin stream through the host no-output watchdog", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({ timeoutMs: 5_000 });
    const streamStarted = createDeferred();
    const run = runPlugin(
      context,
      async function* (execution) {
        streamStarted.resolve();
        await waitUntilAborted(execution);
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
      name: "actual SDK command lifecycle traffic remains safely retryable",
      event: {
        type: "command_lifecycle",
        subtype: "started",
        command: "resume",
        session_id: "sdk-session",
      },
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
        await waitUntilAborted(execution);
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

  it("keeps the overall deadline authoritative while a native approval is outstanding", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({
      config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      nativeTools: ["WebFetch"],
      timeoutMs: 150,
    });
    const approval = createDeferred<{ id: string; decision: "allow-once" }>();
    mockCallGatewayTool.mockReturnValueOnce(approval.promise);
    const run = runPlugin(
      context,
      async function* (execution) {
        await requestNativeTool(execution, "WebFetch", { url: "https://example.com/slow" });
        yield SUCCESS_RESULT;
      },
      { noOutputTimeoutMs: 100 },
    );
    await vi.waitFor(() => expect(mockCallGatewayTool).toHaveBeenCalledOnce());
    const approvalSignal = mockCallGatewayTool.mock.calls[0]?.[3]?.signal;

    await vi.advanceTimersByTimeAsync(150);

    await expect(run).resolves.toMatchObject({
      reason: "overall-timeout",
      timedOut: true,
      noOutputTimedOut: false,
    });
    expect(approvalSignal?.aborted).toBe(true);
    approval.resolve({ id: "late-approval", decision: "allow-once" });
  });

  it("keeps tracked background work alive beyond the ordinary no-output watchdog", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution();
    const backgroundFinished = createDeferred();
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

  it("keeps the overall deadline authoritative while background work remains active", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({ timeoutMs: 150 });
    const received: string[] = [];
    const run = runPlugin(
      context,
      async function* (execution) {
        yield {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "background-agent", task_type: "local_agent" }],
        };
        await waitUntilAborted(execution);
        yield SUCCESS_RESULT;
      },
      { noOutputTimeoutMs: 100, consumeStdout: received.push.bind(received) },
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(150);

    await expect(run).resolves.toMatchObject({
      reason: "overall-timeout",
      timedOut: true,
      noOutputTimedOut: false,
    });
  });

  it("propagates caller cancellation and closes the active plugin iterator", async () => {
    const controller = new AbortController();
    const { context } = await createExecution({ abortSignal: controller.signal });
    const streamStarted = createDeferred();
    const streamClosed = vi.fn();
    const run = runPlugin(context, async function* (execution) {
      try {
        streamStarted.resolve();
        await waitUntilAborted(execution);
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

  it.each([
    {
      name: "AbortError",
      reason: "aborted" as const,
      abort: (controller: AbortController) => controller.abort(),
    },
    {
      name: "the caller's TimeoutError",
      reason: "timeout" as const,
      abort: (controller: AbortController) => {
        const timeout = new Error("caller deadline exceeded");
        timeout.name = "TimeoutError";
        controller.abort(timeout);
      },
    },
    {
      name: "AbortError wrapping a TimeoutError",
      reason: "aborted" as const,
      abort: (controller: AbortController) => {
        const timeout = new Error("caller deadline exceeded");
        timeout.name = "TimeoutError";
        const cancellation = new Error("caller cancelled", { cause: timeout });
        cancellation.name = "AbortError";
        controller.abort(cancellation);
      },
    },
  ])("preserves streamed assistant output after $name", async ({ abort, reason }) => {
    const controller = new AbortController();
    const { context } = await createExecution({ abortSignal: controller.signal });
    const output: string[] = [];
    const preserveOutput = vi.fn(() => output.length > 0);
    const run = runPlugin(
      context,
      async function* (execution) {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Here is the answer so far" }] },
        };
        await waitUntilAborted(execution);
        yield SUCCESS_RESULT;
      },
      {
        consumeStdout: output.push.bind(output),
        onInterrupted: preserveOutput,
      },
    );
    await vi.waitFor(() => expect(output).toHaveLength(1));

    abort(controller);

    await expect(run).resolves.toMatchObject({ reason: "manual-cancel", exitCode: null });
    expect(preserveOutput).toHaveBeenCalledExactlyOnceWith(reason);
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      message: { content: [{ text: "Here is the answer so far" }] },
    });
  });
});
