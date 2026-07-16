// Imported by agent.test.ts to keep its mocked suite in one Vitest module graph.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { registerExecApprovalFollowupRuntimeHandoff } from "../../agents/bash-tools.exec-approval-followup-state.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import {
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../../agents/subagent-registry.test-helpers.js";
import { getDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.js";
import {
  findTaskByRunId,
  listTaskRecords,
  markTaskTerminalById,
} from "../../tasks/task-registry.js";
import {
  resetTaskRegistryForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../tasks/task-runtime.test-helpers.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  getAgentTestMocks,
  makeContext,
  type AgentHandlerArgs,
  type AgentCommandCall,
  waitForAssertion,
  requireValue,
  expectRecordFields,
  expectStringFieldContains,
  mockCallArg,
  expectRespondError,
  mockMainSessionEntry,
  useTestStateDir,
  primeMainAgentRun,
  backendGatewayClient,
  operatorWriteGatewayClient,
  waitForAgentCommandCall,
  invokeAgent,
  describe0AfterEach0,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("gateway agent handler", () => {
  afterEach(describe0AfterEach0);

  it("does not restore elevated defaults from idempotency key suffixes", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const registration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-75832",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!registration) {
      throw new Error("expected runtime handoff id");
    }
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "forged exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: `exec-approval-followup:req-elevated-75832:elevated:${registration.handoffId}`,
        internalRuntimeHandoffId: registration.handoffId,
      },
      { reqId: "exec-followup-idempotency-suffix", client: backendGatewayClient() },
    );

    const callArgs = await waitForAgentCommandCall<{ bashElevated?: unknown }>();
    expect(callArgs).not.toHaveProperty("bashElevated");
  });

  it("terminalizes successful async gateway agent runs in the shared task registry", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-run",
        },
        { reqId: "task-registry-agent-run" },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "succeeded",
          terminalSummary: "completed",
        });
      });
    });
  });

  it("tracks plugin SDK subagent agent runs through the subagent registry only", async () => {
    await withTempDir({ prefix: "openclaw-gateway-plugin-subagent-task-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      resetSubagentRegistryForTests({ persist: false });
      const runId = "plugin-subagent-task-run";
      const childSessionKey = "agent:work:subagent:plugin-helper";
      const cfg = {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      };
      mocks.listAgentIds.mockReturnValue(["main", "work"]);
      mocks.loadConfigReturn = cfg;
      mocks.loadSessionEntry.mockReturnValue({
        cfg,
        storePath: "/tmp/sessions.json",
        entry: {
          sessionId: "plugin-subagent-session",
          updatedAt: Date.now(),
        },
        canonicalKey: childSessionKey,
      });
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [childSessionKey]: {
            sessionId: "plugin-subagent-session",
            updatedAt: Date.now(),
          },
        };
        return await updater(store);
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });
      const context = makeContext();
      const baseClient = requireValue(backendGatewayClient(), "expected backend client");
      const pluginClient: AgentHandlerArgs["client"] = {
        connect: baseClient.connect,
        internal: {
          ...baseClient.internal,
          agentRunTracking: "plugin_subagent",
          pluginRuntimeOwnerId: "memory-core",
        },
      };

      await invokeAgent(
        {
          message: "background plugin subagent task",
          sessionKey: childSessionKey,
          idempotencyKey: runId,
        },
        {
          context,
          reqId: runId,
          client: pluginClient,
        },
      );

      await waitForAssertion(() => {
        const tasks = listTaskRecords().filter((task) => task.runId === runId);
        expect(tasks).toHaveLength(1);
        const task = requireValue(tasks[0], "expected one plugin subagent task");
        expectRecordFields(task, {
          runtime: "subagent",
          childSessionKey,
          ownerKey: "agent:work:main",
          label: "plugin:memory-core",
          task: "background plugin subagent task",
          deliveryStatus: "not_applicable",
        });
        expect(task.runtime).not.toBe("cli");
      });

      await waitForAssertion(() => {
        expectRecordFields(getSubagentRunByChildSessionKey(childSessionKey), {
          cleanupCompletedAt: expect.any(Number),
        });
      });
      const run = requireValue(
        getSubagentRunByChildSessionKey(childSessionKey),
        "expected subagent registry run",
      );
      expectRecordFields(run, {
        runId,
        childSessionKey,
        controllerSessionKey: "agent:work:main",
        requesterSessionKey: "agent:work:main",
        requesterDisplayKey: "main",
        cleanup: "keep",
        spawnMode: "run",
        label: "plugin:memory-core",
      });
      expectRecordFields(run.completion, { required: false });
      expectRecordFields(run.delivery, { status: "not_required" });

      const commandCallCount = mocks.agentCommand.mock.calls.length;
      const createdAt = run.createdAt;
      await invokeAgent(
        {
          message: "background plugin subagent task",
          sessionKey: childSessionKey,
          idempotencyKey: runId,
        },
        {
          context,
          reqId: `${runId}-retry`,
          client: pluginClient,
        },
      );

      expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount);
      const retryTasks = listTaskRecords().filter((task) => task.runId === runId);
      expect(retryTasks).toHaveLength(1);
      expect(getSubagentRunByChildSessionKey(childSessionKey)?.createdAt).toBe(createdAt);
    });
  });

  it("keeps plugin SDK subagent runs best-effort when registry persistence fails", async () => {
    await withTempDir(
      { prefix: "openclaw-gateway-plugin-subagent-registry-fail-" },
      async (root) => {
        useTestStateDir(root);
        resetTaskRegistryForTests();
        resetSubagentRegistryForTests({ persist: false });
        subagentRegistryTesting.setDepsForTest({
          persistSubagentRunsToDiskOrThrow: () => {
            throw new Error("disk full");
          },
        });
        const runId = "plugin-subagent-registry-fail";
        const childSessionKey = "agent:main:subagent:registry-fail";
        const cfg = {
          session: { mainKey: "main", scope: "per-sender" },
        };
        mocks.loadConfigReturn = cfg;
        mocks.loadSessionEntry.mockReturnValue({
          cfg,
          storePath: "/tmp/sessions.json",
          entry: {
            sessionId: "plugin-subagent-registry-fail-session",
            updatedAt: Date.now(),
          },
          canonicalKey: childSessionKey,
        });
        mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
          const store: Record<string, unknown> = {
            [childSessionKey]: {
              sessionId: "plugin-subagent-registry-fail-session",
              updatedAt: Date.now(),
            },
          };
          return await updater(store);
        });
        mocks.agentCommand.mockResolvedValue({
          payloads: [{ text: "ok" }],
          meta: { durationMs: 100 },
        });
        const context = makeContext();
        const baseClient = requireValue(backendGatewayClient(), "expected backend client");
        const commandCallCount = mocks.agentCommand.mock.calls.length;

        await invokeAgent(
          {
            message: "background plugin subagent task",
            sessionKey: childSessionKey,
            idempotencyKey: runId,
          },
          {
            context,
            reqId: runId,
            client: {
              connect: baseClient.connect,
              internal: {
                ...baseClient.internal,
                agentRunTracking: "plugin_subagent",
                pluginRuntimeOwnerId: "memory-core",
              },
            },
          },
        );

        expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount + 1);
        await waitForAssertion(() => {
          const task = requireValue(findTaskByRunId(runId), "expected fallback cli task");
          expectRecordFields(task, {
            runtime: "cli",
            childSessionKey,
            status: "succeeded",
            terminalSummary: "completed",
          });
        });
        expect(context.logGateway.warn).toHaveBeenCalledWith(
          expect.stringContaining("falling back to cli task tracking"),
        );
      },
    );
  });

  it("terminalizes failed async gateway agent runs in the shared task registry", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-error-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();
      mocks.agentCommand.mockRejectedValueOnce(new Error("agent unavailable"));

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-run-error",
        },
        { reqId: "task-registry-agent-run-error" },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-error"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "failed",
          error: "Error: agent unavailable",
        });
      });
    });
  });

  it("preserves aborted async gateway agent runs as timed out", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-aborted-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();
      mocks.agentCommand.mockResolvedValueOnce({
        payloads: [],
        meta: { durationMs: 100, aborted: true },
      });
      const context = makeContext();

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-run-aborted",
        },
        { context, reqId: "task-registry-agent-run-aborted" },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-aborted"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "timed_out",
          terminalSummary: "aborted",
        });
        expectRecordFields(context.dedupe.get("agent:task-registry-agent-run-aborted")?.payload, {
          runId: "task-registry-agent-run-aborted",
          status: "timeout",
          summary: "aborted",
        });
      });
    });
  });

  it("classifies aborted async gateway agent rejections as timed out", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-abort-error-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();
      const abortError = new Error("This operation was aborted");
      abortError.name = "AbortError";
      const context = makeContext();
      const runId = "task-registry-agent-run-abort-error";
      mocks.agentCommand.mockImplementationOnce(() => {
        context.chatAbortControllers.get(runId)?.controller.abort();
        return Promise.reject(abortError);
      });

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-abort-error"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "timed_out",
          error: "AbortError: This operation was aborted",
        });
        expectRecordFields(
          context.dedupe.get("agent:task-registry-agent-run-abort-error")?.payload,
          {
            runId: "task-registry-agent-run-abort-error",
            status: "timeout",
            summary: "aborted",
            stopReason: "rpc",
          },
        );
      });
    });
  });

  it("preserves restart ownership for aborted async gateway agent rejections", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-restart-abort-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();
      const abortError = createAgentRunRestartAbortError();
      const wrappedError = new Error("ACP turn failed before completion", {
        cause: abortError,
      });
      wrappedError.name = "AcpRuntimeError";
      const context = makeContext();
      const runId = "task-registry-agent-run-restart-abort";
      mocks.agentCommand.mockImplementationOnce(() => {
        context.chatAbortControllers.get(runId)?.controller.abort(abortError);
        return Promise.reject(wrappedError);
      });

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );

      await waitForAssertion(() => {
        expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
          runId,
          status: "timeout",
          summary: "aborted",
          stopReason: "restart",
        });
      });
    });
  });

  it("classifies timeout async gateway agent rejections as timed out", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-timeout-error-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();
      const timeoutError = new Error("chat run timed out");
      timeoutError.name = "TimeoutError";
      const context = makeContext();
      const runId = "task-registry-agent-run-timeout-error";
      mocks.agentCommand.mockImplementationOnce(() => {
        context.chatAbortControllers.get(runId)?.controller.abort(timeoutError);
        return Promise.reject(timeoutError);
      });

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-timeout-error"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "timed_out",
          error: "TimeoutError: chat run timed out",
        });
        expectRecordFields(
          context.dedupe.get("agent:task-registry-agent-run-timeout-error")?.payload,
          {
            runId: "task-registry-agent-run-timeout-error",
            status: "timeout",
            summary: "aborted",
            stopReason: "timeout",
          },
        );
      });
    });
  });

  it("classifies wrapped rejections after gateway timeout as timed out", async () => {
    await withTempDir(
      { prefix: "openclaw-gateway-agent-task-wrapped-timeout-error-" },
      async (root) => {
        useTestStateDir(root);
        resetTaskRegistryForTests();
        primeMainAgentRun();
        const timeoutReason = new Error("chat run timed out");
        timeoutReason.name = "TimeoutError";
        const wrappedError = new Error("fallback result classified terminal abort");
        wrappedError.name = "FailoverError";
        const context = makeContext();
        const runId = "task-registry-agent-run-wrapped-timeout-error";
        mocks.agentCommand.mockImplementationOnce(() => {
          context.chatAbortControllers.get(runId)?.controller.abort(timeoutReason);
          return Promise.reject(wrappedError);
        });

        await invokeAgent(
          {
            message: "background cli task",
            sessionKey: "agent:main:main",
            idempotencyKey: runId,
          },
          { context, reqId: runId },
        );

        await waitForAssertion(() => {
          expectRecordFields(findTaskByRunId("task-registry-agent-run-wrapped-timeout-error"), {
            runtime: "cli",
            childSessionKey: "agent:main:main",
            status: "timed_out",
            error: "FailoverError: fallback result classified terminal abort",
          });
          expectRecordFields(
            context.dedupe.get("agent:task-registry-agent-run-wrapped-timeout-error")?.payload,
            {
              runId: "task-registry-agent-run-wrapped-timeout-error",
              status: "timeout",
              summary: "aborted",
              stopReason: "timeout",
            },
          );
          expect(
            context.dedupe.get("agent:task-registry-agent-run-wrapped-timeout-error")?.ok,
          ).toBe(true);
        });
      },
    );
  });

  it("does not hide provider timeout async gateway agent rejections", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-provider-timeout-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();
      const providerError = new Error("provider request timed out");
      providerError.name = "TimeoutError";
      mocks.agentCommand.mockRejectedValueOnce(providerError);
      const context = makeContext();

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-run-provider-timeout",
        },
        { context, reqId: "task-registry-agent-run-provider-timeout" },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-provider-timeout"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "timed_out",
          error: "TimeoutError: provider request timed out",
        });
        expectRecordFields(
          context.dedupe.get("agent:task-registry-agent-run-provider-timeout")?.payload,
          {
            runId: "task-registry-agent-run-provider-timeout",
            status: "error",
            summary: "TimeoutError: provider request timed out",
          },
        );
        expect(context.dedupe.get("agent:task-registry-agent-run-provider-timeout")?.ok).toBe(
          false,
        );
      });
    });
  });

  it("does not overwrite operator-cancelled async gateway agent tasks after late completion", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-cancelled-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();
      let resolveRun: (value: {
        payloads: Array<{ text: string }>;
        meta: { durationMs: number };
      }) => void;
      const pending = new Promise<{
        payloads: Array<{ text: string }>;
        meta: { durationMs: number };
      }>((resolve) => {
        resolveRun = resolve;
      });
      mocks.agentCommand.mockReturnValueOnce(pending);

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-run-cancelled",
        },
        { reqId: "task-registry-agent-run-cancelled" },
      );

      const task = requireValue(
        findTaskByRunId("task-registry-agent-run-cancelled"),
        "task missing",
      );
      expectRecordFields(task, { status: "running" });
      const cancelledAt = (task?.startedAt ?? Date.now()) + 1;
      markTaskTerminalById({
        taskId: task.taskId,
        status: "cancelled",
        endedAt: cancelledAt,
        lastEventAt: cancelledAt,
        terminalSummary: "Cancelled by operator.",
      });

      resolveRun!({ payloads: [{ text: "ok" }], meta: { durationMs: 100 } });

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-cancelled"), {
          status: "cancelled",
          endedAt: cancelledAt,
          terminalSummary: "Cancelled by operator.",
        });
      });
    });
  });

  it("does not let --agent force the agent main session when --session-id is provided", async () => {
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
    mockMainSessionEntry({ sessionId: "resume-whatsapp-session" });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "resume channel session",
        agentId: "main",
        sessionId: "resume-whatsapp-session",
        idempotencyKey: "session-id-agent-resume",
      },
      { reqId: "session-id-agent-resume" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("main");
    expect(call.sessionId).toBe("resume-whatsapp-session");
    expect(call.sessionKey).toBeUndefined();
  });

  it("treats whitespace sessionId as absent before resolving the agent session key", async () => {
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
    mockMainSessionEntry({ sessionId: "existing-session-id" });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "resume main",
        agentId: "main",
        sessionId: "   ",
        idempotencyKey: "blank-session-id-agent-resume",
      },
      { reqId: "blank-session-id-agent-resume" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("main");
    expect(call.sessionId).toBe("existing-session-id");
    expect(call.sessionKey).toBe("agent:main:main");
  });

  it("uses an agent-scoped to value as the gateway session selector", async () => {
    const sessionKey = "agent:main:openclaw-weixin:direct:o9cq802hhmfc@im.wechat";
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
    mocks.loadSessionEntry.mockImplementation((key: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: key === sessionKey ? "wechat-session-id" : "main-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: key,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, Record<string, unknown>> = {
        "agent:main:main": { sessionId: "main-session-id", updatedAt: Date.now() },
        [sessionKey]: { sessionId: "wechat-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "callback result",
        to: sessionKey,
        idempotencyKey: "wechat-session-key-to",
      },
      { reqId: "wechat-session-key-to" },
    );

    const call = await waitForAgentCommandCall<{
      sessionId?: string;
      sessionKey?: string;
      to?: string;
    }>();
    expect(call.sessionId).toBe("wechat-session-id");
    expect(call.sessionKey).toBe(sessionKey);
    expect(call.to).toBeUndefined();
  });

  it("rolls stale gateway agent sessions even when updatedAt was recently touched", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "stale-session-id",
          updatedAt: now,
          sessionStartedAt: now - 25 * 60 * 60_000,
          lastInteractionAt: now - 25 * 60 * 60_000,
        },
        {
          session: {
            reset: {
              mode: "daily",
              atHour: 4,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      const broadcastToConnIds = vi.fn();
      await invokeAgent(
        {
          message: "daily rollover",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "daily-rollover-agent-session",
        },
        {
          reqId: "daily-rollover-agent-session",
          context: {
            ...makeContext(),
            broadcastToConnIds,
            getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
          },
        },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).not.toBe("stale-session-id");
      expect(capturedEntry?.sessionStartedAt).toBe(now);
      expect(capturedEntry?.lastInteractionAt).toBe(now);
      expect(mocks.emitGatewaySessionEndPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionEndPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: "stale-session-id",
          reason: "daily",
          storePath: "/tmp/sessions.json",
          nextSessionId: call.sessionId,
          nextSessionKey: "agent:main:main",
        },
      );
      expect(mocks.emitGatewaySessionStartPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionStartPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: call.sessionId,
          resumedFrom: "stale-session-id",
          storePath: "/tmp/sessions.json",
        },
      );
      expect(broadcastToConnIds.mock.calls.map((callValue) => callValue[1]?.reason)).toEqual([
        "create",
        "send",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a provider-owned CLI session across the daily default boundary on the gateway path", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry({
        sessionId: "provider-owned-session-id",
        updatedAt: now,
        sessionStartedAt: now - 25 * 60 * 60_000,
        lastInteractionAt: now - 25 * 60 * 60_000,
        modelProvider: "claude-cli",
        cliSessionBindings: { "claude-cli": { sessionId: "claude-cli-conversation-123" } },
      });
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent(
        {
          message: "provider-owned daily boundary",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "provider-owned-daily-boundary",
        },
        { reqId: "provider-owned-daily-boundary" },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).toBe("provider-owned-session-id");
      expect(capturedEntry?.sessionStartedAt).toBe(now - 25 * 60 * 60_000);
      expect(capturedEntry?.cliSessionBindings).toMatchObject({
        "claude-cli": { sessionId: "claude-cli-conversation-123" },
      });
      expect(mocks.emitGatewaySessionEndPluginHook).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a model-locked session across configured gateway expiry", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "model-locked-session-id",
          updatedAt: now,
          sessionStartedAt: now - 25 * 60 * 60_000,
          lastInteractionAt: now - 25 * 60 * 60_000,
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        },
        {
          session: {
            reset: {
              mode: "daily",
              atHour: 4,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent(
        {
          message: "model-locked daily boundary",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "model-locked-daily-boundary",
        },
        { reqId: "model-locked-daily-boundary" },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).toBe("model-locked-session-id");
      expect(capturedEntry?.sessionStartedAt).toBe(now - 25 * 60 * 60_000);
      expect(capturedEntry?.modelSelectionLocked).toBe(true);
      expect(mocks.emitGatewaySessionEndPluginHook).not.toHaveBeenCalled();
      expect(mocks.emitGatewaySessionStartPluginHook).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits idle lifecycle reason when inactivity rotates a gateway agent session", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "idle-session-id",
          updatedAt: now,
          sessionStartedAt: now,
          lastInteractionAt: now - 60 * 60_000,
        },
        {
          session: {
            reset: {
              mode: "idle",
              idleMinutes: 5,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        return updater(store);
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent(
        {
          message: "idle rollover",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "idle-rollover-agent-session",
        },
        { reqId: "idle-rollover-agent-session" },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).not.toBe("idle-session-id");
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionEndPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: "idle-session-id",
          reason: "idle",
          nextSessionId: call.sessionId,
          nextSessionKey: "agent:main:main",
        },
      );
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionStartPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: call.sessionId,
          resumedFrom: "idle-session-id",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits lifecycle hooks when a committed rotation later fails delivery validation", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "stale-before-validation-id",
          updatedAt: now,
          sessionStartedAt: now - 25 * 60 * 60_000,
          lastInteractionAt: now - 25 * 60 * 60_000,
        },
        {
          session: {
            reset: {
              mode: "daily",
              atHour: 4,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        return updater(store);
      });
      mocks.agentCommand.mockClear();
      const respond = vi.fn();

      await invokeAgent(
        {
          message: "strict missing delivery target after rollover",
          agentId: "main",
          sessionKey: "agent:main:main",
          deliver: true,
          replyChannel: "telegram",
          bestEffortDeliver: false,
          idempotencyKey: "lifecycle-before-delivery-validation",
        },
        {
          reqId: "lifecycle-before-delivery-validation",
          respond,
          flushDispatch: false,
        },
      );

      expect(mocks.agentCommand).not.toHaveBeenCalled();
      const error = expectRespondError(respond, {});
      expectStringFieldContains(error, "message", "requires target");
      expect(mocks.emitGatewaySessionEndPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionEndPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: "stale-before-validation-id",
          reason: "daily",
        },
      );
      expect(mocks.emitGatewaySessionStartPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionStartPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          resumedFrom: "stale-before-validation-id",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits lifecycle hooks and sessions.changed when an explicit sessionId replaces a fresh session", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mockMainSessionEntry({
        sessionId: "current-session-id",
        updatedAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now,
      });
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      const broadcastToConnIds = vi.fn();
      await invokeAgent(
        {
          message: "explicit replacement",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "caller-selected-session-id",
          idempotencyKey: "explicit-replacement-agent-session",
        },
        {
          reqId: "explicit-replacement-agent-session",
          context: {
            ...makeContext(),
            broadcastToConnIds,
            getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
          },
        },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).toBe("caller-selected-session-id");
      expect(capturedEntry?.sessionId).toBe("caller-selected-session-id");
      expect(capturedEntry?.sessionStartedAt).toBe(now);
      expect(mocks.emitGatewaySessionEndPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionEndPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: "current-session-id",
          reason: "new",
          storePath: "/tmp/sessions.json",
          nextSessionId: "caller-selected-session-id",
          nextSessionKey: "agent:main:main",
        },
      );
      expect(mocks.emitGatewaySessionStartPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionStartPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: "caller-selected-session-id",
          resumedFrom: "current-session-id",
          storePath: "/tmp/sessions.json",
        },
      );
      expect(broadcastToConnIds.mock.calls.map((callLocal) => callLocal[1]?.reason)).toEqual([
        "create",
        "send",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let explicit sessionId bypass stale gateway session freshness", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "stale-session-id",
          updatedAt: now,
          sessionStartedAt: now - 25 * 60 * 60_000,
          lastInteractionAt: now - 25 * 60 * 60_000,
        },
        {
          session: {
            reset: {
              mode: "daily",
              atHour: 4,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent(
        {
          message: "daily rollover",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "stale-session-id",
          idempotencyKey: "daily-rollover-agent-session-id",
        },
        { reqId: "daily-rollover-agent-session-id" },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).not.toBe("stale-session-id");
      expect(capturedEntry?.sessionStartedAt).toBe(now);
      expect(capturedEntry?.lastInteractionAt).toBe(now);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins a backend continuation to its expected stale session", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "expected-stale-session-id",
          updatedAt: now,
          sessionStartedAt: now - 25 * 60 * 60_000,
          lastInteractionAt: now - 25 * 60 * 60_000,
        },
        {
          session: {
            reset: {
              mode: "daily",
              atHour: 4,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent(
        {
          message: "resume exact stale session",
          agentId: "main",
          sessionKey: "agent:main:main",
          expectedExistingSessionId: "expected-stale-session-id",
          idempotencyKey: "expected-stale-agent-session",
        },
        {
          reqId: "expected-stale-agent-session",
          client: backendGatewayClient(),
        },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).toBe("expected-stale-session-id");
      expect(capturedEntry?.sessionId).toBe("expected-stale-session-id");
      expect(mocks.emitGatewaySessionEndPluginHook).not.toHaveBeenCalled();
      expect(mocks.emitGatewaySessionStartPluginHook).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards the selected agent id with canonical global session keys", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:ops:main");
    mocks.loadSessionEntry.mockReturnValue({
      cfg: { session: { scope: "global" } },
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "global session",
        agentId: "ops",
        idempotencyKey: "global-session-agent-id",
      },
      { reqId: "global-session-agent-id" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("ops");
    expect(call.sessionKey).toBe("global");
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("agent:ops:main", {
      agentId: "ops",
      clone: false,
    });
  });

  it("accepts an explicit global session key with a selected agent id", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: { session: { scope: "global" } },
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-work-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "global session",
        sessionKey: "global",
        agentId: "work",
        idempotencyKey: "explicit-global-session-agent-id",
      },
      { reqId: "explicit-global-session-agent-id", respond },
    );

    expect(respond).not.toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST }),
    );
    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("work");
    expect(call.sessionKey).toBe("global");
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("global", {
      agentId: "work",
      clone: false,
    });
  });

  it("routes bare global session keys to the configured default agent", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main" }, { id: "ops", default: true }] },
      session: { scope: "global" },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-ops-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-ops-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "bare global session",
        sessionKey: "global",
        idempotencyKey: "bare-global-default-agent-id",
      },
      { reqId: "bare-global-default-agent-id" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("ops");
    expect(call.sessionKey).toBe("global");
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("global", {
      clone: false,
    });
  });

  it("infers selected-global agent id from agent-prefixed session aliases", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-work-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "global alias session",
        sessionKey: "agent:work:main",
        idempotencyKey: "alias-global-session-agent-id",
      },
      { reqId: "alias-global-session-agent-id" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("work");
    expect(call.sessionKey).toBe("global");
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("agent:work:main", {
      agentId: "work",
      clone: false,
    });
  });

  it("registers tool event recipients for active selected-global alias runs", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-work-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    const context = makeContext();
    const registerToolEventRecipient = vi.fn();
    context.registerToolEventRecipient = registerToolEventRecipient;
    context.chatAbortControllers.set("run-existing", {
      controller: new AbortController(),
      sessionKey: "global",
      agentId: "work",
      clientRunId: "run-existing",
    } as never);

    await invokeAgent(
      {
        message: "global alias session",
        sessionKey: "agent:work:main",
        idempotencyKey: "alias-global-tool-events",
      },
      {
        reqId: "alias-global-tool-events",
        context,
        client: {
          connId: "conn-1",
          connect: { caps: ["tool-events"] },
        } as never,
      },
    );

    expect(registerToolEventRecipient).toHaveBeenCalledWith("alias-global-tool-events", "conn-1");
    expect(registerToolEventRecipient).toHaveBeenCalledWith("run-existing", "conn-1");
  });

  it("updates tracked agent session identity after compaction rotation", async () => {
    primeMainAgentRun();
    const context = makeContext();
    let trackedSessionId: string | undefined;
    mocks.agentCommand.mockImplementation(async (call: AgentCommandCall) => {
      const onSessionIdChanged = call.onSessionIdChanged;
      if (typeof onSessionIdChanged !== "function") {
        throw new Error("expected session id change callback");
      }
      onSessionIdChanged("rotated-session-id");
      trackedSessionId = context.chatAbortControllers.get("agent-session-rotation")?.sessionId;
      return {
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      };
    });

    await invokeAgent(
      {
        message: "rotate session",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "agent-session-rotation",
      },
      {
        reqId: "agent-session-rotation",
        context,
      },
    );

    expect(trackedSessionId).toBe("rotated-session-id");
  });

  it("honors selected-global agent id when the request uses the main alias", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-work-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "global main alias",
        agentId: "work",
        sessionKey: "main",
        idempotencyKey: "selected-global-main-alias-agent-id",
      },
      { reqId: "selected-global-main-alias-agent-id" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("work");
    expect(call.sessionKey).toBe("global");
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("main", {
      agentId: "work",
      clone: false,
    });
  });

  it("preserves selected-global agent id on cached accepted responses", async () => {
    const context = makeContext();
    mocks.agentCommand.mockClear();
    context.dedupe.set("agent:cached-global-work", {
      ts: Date.now(),
      ok: true,
      payload: {
        runId: "cached-global-work",
        sessionKey: "global",
        agentId: "work",
        status: "accepted",
      },
    });
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "global session retry",
        sessionKey: "global",
        agentId: "work",
        idempotencyKey: "cached-global-work",
      },
      { context, respond, reqId: "cached-global-work" },
    );

    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId: "cached-global-work",
      sessionKey: "global",
      agentId: "work",
      status: "in_flight",
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("dispatches async gateway agent task creation through the detached task runtime seam", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-seam-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();

      const defaultRuntime = getDetachedTaskLifecycleRuntime();
      const createRunningTaskRunSpy = vi.fn(
        (...args: Parameters<typeof defaultRuntime.createRunningTaskRun>) =>
          defaultRuntime.createRunningTaskRun(...args),
      );
      const finalizeTaskRunByRunIdSpy = vi.fn(
        (...args: Parameters<NonNullable<typeof defaultRuntime.finalizeTaskRunByRunId>>) =>
          defaultRuntime.finalizeTaskRunByRunId!(...args),
      );

      setDetachedTaskLifecycleRuntime({
        ...defaultRuntime,
        createRunningTaskRun: createRunningTaskRunSpy,
        finalizeTaskRunByRunId: finalizeTaskRunByRunIdSpy,
      });

      await invokeAgent(
        {
          message: "background cli seam task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-seam",
        },
        { reqId: "task-registry-agent-seam" },
      );

      expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
      expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
        runtime: "cli",
        runId: "task-registry-agent-seam",
        childSessionKey: "agent:main:main",
        sourceId: "task-registry-agent-seam",
      });
      expectStringFieldContains(
        mockCallArg(createRunningTaskRunSpy) as Record<string, unknown>,
        "task",
        "background cli seam task",
      );
      await waitForAssertion(() => {
        expect(finalizeTaskRunByRunIdSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(finalizeTaskRunByRunIdSpy), {
          runtime: "cli",
          runId: "task-registry-agent-seam",
          status: "succeeded",
          terminalSummary: "completed",
        });
        expectRecordFields(findTaskByRunId("task-registry-agent-seam"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "succeeded",
          terminalSummary: "completed",
        });
      });
    });
  });

  describe("ACP manual-spawn child turn task tracking", () => {
    function mockAcpChildSessionEntry(childSessionKey: string) {
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: "/tmp/sessions.json",
        entry: { sessionId: "acp-child-session", updatedAt: Date.now() },
        canonicalKey: childSessionKey,
      });
      mocks.updateSessionStore.mockResolvedValue(undefined);
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });
    }

    function spyDetachedCreateRunningTaskRun() {
      const defaultRuntime = getDetachedTaskLifecycleRuntime();
      const createRunningTaskRunSpy = vi.fn(
        (...args: Parameters<typeof defaultRuntime.createRunningTaskRun>) =>
          defaultRuntime.createRunningTaskRun(...args),
      );
      setDetachedTaskLifecycleRuntime({
        ...defaultRuntime,
        createRunningTaskRun: createRunningTaskRunSpy,
      });
      return createRunningTaskRunSpy;
    }

    const confirmedAcpMeta: NonNullable<ReturnType<typeof readAcpSessionMeta>> = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime-1",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    };

    it("suppresses the gateway CLI task row for confirmed ACP manual-spawn child turns", async () => {
      await withTempDir({ prefix: "openclaw-gateway-acp-suppress-" }, async (root) => {
        useTestStateDir(root);
        resetTaskRegistryForTests();
        const childSessionKey = "agent:main:acp:child-confirmed";
        mockAcpChildSessionEntry(childSessionKey);
        mocks.readAcpSessionMeta.mockReturnValue(confirmedAcpMeta);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        await invokeAgent(
          {
            message: "acp manual spawn child turn",
            sessionKey: childSessionKey,
            acpTurnSource: "manual_spawn",
            idempotencyKey: "acp-manual-spawn-confirmed",
          },
          { reqId: "acp-manual-spawn-confirmed", client: backendGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).not.toHaveBeenCalled();
        expect(findTaskByRunId("acp-manual-spawn-confirmed")).toBeUndefined();
      });
    });

    it("keeps CLI tracking when a non-backend operator-write caller sets acpTurnSource", async () => {
      await withTempDir({ prefix: "openclaw-gateway-acp-operator-write-" }, async (root) => {
        useTestStateDir(root);
        resetTaskRegistryForTests();
        const childSessionKey = "agent:main:acp:child-operator-write";
        mockAcpChildSessionEntry(childSessionKey);
        // Persisted ACP metadata is present and the turn looks like a manual
        // spawn, but the caller is an operator-write control-UI client, not the
        // in-process backend ACP spawn path. That caller never creates a
        // replacement `acp` row, so CLI tracking must stay on to avoid losing the
        // run entirely.
        mocks.readAcpSessionMeta.mockReturnValue(confirmedAcpMeta);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        await invokeAgent(
          {
            message: "operator-write acp manual spawn",
            sessionKey: childSessionKey,
            acpTurnSource: "manual_spawn",
            idempotencyKey: "acp-operator-write",
          },
          { reqId: "acp-operator-write", client: operatorWriteGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
          runtime: "cli",
          runId: "acp-operator-write",
          childSessionKey,
        });
        await waitForAssertion(() => {
          expectRecordFields(findTaskByRunId("acp-operator-write"), {
            runtime: "cli",
            childSessionKey,
          });
        });
      });
    });

    it("keeps CLI tracking for ACP-shaped manual-spawn turns without persisted ACP metadata", async () => {
      await withTempDir({ prefix: "openclaw-gateway-acp-no-meta-" }, async (root) => {
        useTestStateDir(root);
        resetTaskRegistryForTests();
        const childSessionKey = "agent:main:acp:child-missing-meta";
        mockAcpChildSessionEntry(childSessionKey);
        mocks.readAcpSessionMeta.mockReturnValue(undefined);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        await invokeAgent(
          {
            message: "acp shaped turn without metadata",
            sessionKey: childSessionKey,
            acpTurnSource: "manual_spawn",
            idempotencyKey: "acp-manual-spawn-no-meta",
          },
          { reqId: "acp-manual-spawn-no-meta", client: backendGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
          runtime: "cli",
          runId: "acp-manual-spawn-no-meta",
          childSessionKey,
        });
        await waitForAssertion(() => {
          expectRecordFields(findTaskByRunId("acp-manual-spawn-no-meta"), {
            runtime: "cli",
            childSessionKey,
          });
        });
      });
    });

    it("keeps dispatch and CLI tracking when ACP metadata read fails", async () => {
      await withTempDir({ prefix: "openclaw-gateway-acp-meta-throw-" }, async (root) => {
        useTestStateDir(root);
        resetTaskRegistryForTests();
        const childSessionKey = "agent:main:acp:child-meta-throw";
        mockAcpChildSessionEntry(childSessionKey);
        const metadataError = new Error("state db unavailable");
        mocks.readAcpSessionMeta.mockImplementation(() => {
          throw metadataError;
        });
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();
        const context = makeContext();

        await invokeAgent(
          {
            message: "acp manual spawn metadata throw",
            sessionKey: childSessionKey,
            acpTurnSource: "manual_spawn",
            idempotencyKey: "acp-manual-spawn-meta-throw",
          },
          { reqId: "acp-manual-spawn-meta-throw", context, client: backendGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
          runtime: "cli",
          runId: "acp-manual-spawn-meta-throw",
          childSessionKey,
        });
        await waitForAssertion(() => {
          expectRecordFields(findTaskByRunId("acp-manual-spawn-meta-throw"), {
            runtime: "cli",
            childSessionKey,
            status: "succeeded",
            terminalSummary: "completed",
          });
        });
        const warnMock = context.logGateway.warn as ReturnType<typeof vi.fn>;
        expect(
          warnMock.mock.calls.some(([message]) => {
            return (
              typeof message === "string" &&
              message.includes("failed to read ACP session metadata") &&
              message.includes("falling back to cli task tracking")
            );
          }),
        ).toBe(true);
      });
    });

    it("keeps CLI tracking for ACP-shaped turns that are not manual spawns", async () => {
      await withTempDir({ prefix: "openclaw-gateway-acp-not-manual-spawn-" }, async (root) => {
        useTestStateDir(root);
        resetTaskRegistryForTests();
        const childSessionKey = "agent:main:acp:child-not-spawn";
        mockAcpChildSessionEntry(childSessionKey);
        // Metadata is present but the turn lacks acpTurnSource, so the spawn
        // control plane does not own this row; CLI tracking must stay on.
        mocks.readAcpSessionMeta.mockReturnValue(confirmedAcpMeta);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        await invokeAgent(
          {
            message: "acp shaped non-spawn turn",
            sessionKey: childSessionKey,
            idempotencyKey: "acp-not-manual-spawn",
          },
          { reqId: "acp-not-manual-spawn", client: backendGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
          runtime: "cli",
          runId: "acp-not-manual-spawn",
          childSessionKey,
        });
      });
    });

    it("does not affect plugin-subagent tracking for confirmed ACP conditions", async () => {
      await withTempDir({ prefix: "openclaw-gateway-acp-plugin-subagent-" }, async (root) => {
        useTestStateDir(root);
        resetTaskRegistryForTests();
        resetSubagentRegistryForTests({ persist: false });
        const childSessionKey = "agent:main:acp:plugin-child";
        const runId = "acp-plugin-subagent-run";
        mockAcpChildSessionEntry(childSessionKey);
        mocks.readAcpSessionMeta.mockReturnValue(confirmedAcpMeta);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        const baseClient = requireValue(backendGatewayClient(), "expected backend client");
        const pluginClient: AgentHandlerArgs["client"] = {
          connect: baseClient.connect,
          internal: {
            ...baseClient.internal,
            agentRunTracking: "plugin_subagent",
            pluginRuntimeOwnerId: "memory-core",
          },
        };

        await invokeAgent(
          {
            message: "plugin subagent over acp child",
            sessionKey: childSessionKey,
            acpTurnSource: "manual_spawn",
            idempotencyKey: runId,
          },
          { reqId: runId, client: pluginClient },
        );
        await waitForAgentCommandCall();

        // plugin_subagent precedence means the run is tracked through the
        // subagent registry as a `subagent` row, never a duplicate `cli` row.
        expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
          runtime: "subagent",
          runId,
        });
        expect(
          listTaskRecords().some((task) => task.runId === runId && task.runtime === "cli"),
        ).toBe(false);
        await waitForAssertion(() => {
          expectRecordFields(getSubagentRunByChildSessionKey(childSessionKey), {
            runId,
            childSessionKey,
            label: "plugin:memory-core",
          });
        });
      });
    });
  });

  it("logs a swallowed finalize error without blocking the background run", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-finalize-throw-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();

      const defaultRuntime = getDetachedTaskLifecycleRuntime();
      const finalizeError = new Error("finalize boom");
      const finalizeTaskRunByRunIdSpy = vi.fn(() => {
        throw finalizeError;
      });
      setDetachedTaskLifecycleRuntime({
        ...defaultRuntime,
        finalizeTaskRunByRunId: finalizeTaskRunByRunIdSpy,
      });

      const context = makeContext();
      const respond = vi.fn();

      await invokeAgent(
        {
          message: "finalize throw seam task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-finalize-throw",
        },
        { context, respond, reqId: "task-registry-finalize-throw" },
      );

      await waitForAssertion(() => {
        // Finalize threw, but the run must still complete (second res frame with ok status).
        expect(finalizeTaskRunByRunIdSpy).toHaveBeenCalledTimes(1);
        const completed = respond.mock.calls.some(([ok, payload]) => {
          return ok === true && (payload as { status?: string } | undefined)?.status === "ok";
        });
        expect(completed).toBe(true);

        // The swallowed finalize error stays observable via a warn log.
        const warnMock = context.logGateway.warn as ReturnType<typeof vi.fn>;
        const loggedFinalizeError = warnMock.mock.calls.some(([message]) => {
          return (
            typeof message === "string" &&
            message.includes("failed to finalize tracked agent task") &&
            message.includes("finalize boom")
          );
        });
        expect(loggedFinalizeError).toBe(true);
      });
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
