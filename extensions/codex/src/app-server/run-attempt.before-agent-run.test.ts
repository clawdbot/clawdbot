// Codex tests cover the before_agent_run gate parity for app-server run attempts.
import path from "node:path";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { CodexAppServerRpcError } from "./client.js";
import {
  assistantMessage,
  createAppServerHarness,
  createParams,
  createStartedThreadHarness,
  fastWait,
  mockCall,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  turnStartResult,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt before_agent_run gate", () => {
  const BLOCKED_TEXT =
    "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)";

  function createBlockedRecorder() {
    return {
      message: undefined,
      getAdmissionReceipt: () => undefined,
      resolveMessage: async () => undefined,
      persistBlocked: vi.fn(async () => undefined),
      persistApproved: vi.fn(async () => undefined),
      hasPersisted: () => false,
      isBlocked: () => false,
      markRuntimePersisted: vi.fn(),
      markRuntimePersistencePending: vi.fn(),
      markSentToProvider: vi.fn(),
      hasRuntimePersistencePending: () => false,
      waitForRuntimePersistence: async () => undefined,
    };
  }

  function createHarnessCompletingTurns() {
    const harnessRef: { current?: ReturnType<typeof createAppServerHarness> } = {};
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        // Pre-fix runs reach turn/start; complete it so the attempt settles
        // and the gate assertions fail instead of hanging.
        queueMicrotask(() => {
          void harnessRef.current?.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        });
      }
      return undefined;
    });
    harnessRef.current = harness;
    return harness;
  }

  it("blocks the run before turn/start when before_agent_run blocks", async () => {
    const beforeAgentRun = vi.fn(async () => ({
      outcome: "block" as const,
      reason: "matched secret prompt",
      message: "The agent cannot read this message.",
    }));
    const llmInput = vi.fn();
    const llmOutput = vi.fn();
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { pluginId: "policy-plugin", hookName: "before_agent_run", handler: beforeAgentRun },
        { hookName: "llm_input", handler: llmInput },
        { hookName: "llm_output", handler: llmOutput },
        { hookName: "agent_end", handler: agentEnd },
      ]),
    );
    const sessionFile = path.join(tempDir, "before-agent-run-block.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-before-agent-run-block");
    const sessionManager = openFileBackedSessionManagerForTest(sessionFile, {
      sessionId: "session-1",
    });
    sessionManager.appendMessage(assistantMessage("earlier context", Date.now()));
    const harness = createHarnessCompletingTurns();
    const recorder = createBlockedRecorder();
    const params = createParams(sessionFile, workspaceDir, { prompt: "secret prompt" });
    params.agentAccountId = "acct-1";
    params.senderId = "user-42";
    params.senderIsOwner = true;
    params.userTurnTranscriptRecorder = recorder as never;

    const result = await runCodexAppServerAttempt(params);

    expect(harness.requests.map((request) => request.method)).not.toContain("turn/start");
    expect(beforeAgentRun).toHaveBeenCalledTimes(1);
    const [event, hookContext] = mockCall(beforeAgentRun, "before_agent_run") as [
      {
        prompt?: string;
        systemPrompt?: string;
        messages?: Array<{ role?: string }>;
        accountId?: string;
        senderId?: string;
        senderIsOwner?: boolean;
      },
      { runId?: string; sessionId?: string; sessionKey?: string },
    ];
    expect(event.prompt).toContain("secret prompt");
    expect(event.systemPrompt).toContain("You are a personal agent running inside OpenClaw.");
    expect(event.messages?.some((message) => message.role === "assistant")).toBe(true);
    expect(event.accountId).toBe("acct-1");
    expect(event.senderId).toBe("user-42");
    expect(event.senderIsOwner).toBe(true);
    expect(hookContext.runId).toBe("run-1");
    expect(hookContext.sessionKey).toBe("agent:main:session-1");

    const terminal = readAttemptTerminal(result);
    expect(terminal.promptErrorSource).toBe("hook:before_agent_run");
    expect(
      String((terminal.promptError as Error | undefined)?.message ?? terminal.promptError),
    ).toBe(BLOCKED_TEXT);
    expect(result.assistantTexts).toEqual([]);
    expect(llmInput).not.toHaveBeenCalled();
    expect(llmOutput).not.toHaveBeenCalled();
    expect(agentEnd).toHaveBeenCalledTimes(1);
    const [agentEndPayload] = mockCall(agentEnd, "agent_end") as [
      { success?: boolean; error?: string; messages?: unknown[] },
    ];
    expect(agentEndPayload.success).toBe(false);
    expect(agentEndPayload.error).toBe(BLOCKED_TEXT);
    expect(JSON.stringify(agentEndPayload.messages)).not.toContain("secret prompt");
    expect(JSON.stringify(agentEndPayload.messages)).toContain(BLOCKED_TEXT);
    expect(recorder.persistBlocked).toHaveBeenCalledTimes(1);
    const [blockedMessage] = recorder.persistBlocked.mock.calls[0] as unknown as [
      { role?: string; idempotencyKey?: string; __openclaw?: { beforeAgentRunBlocked?: unknown } },
    ];
    expect(blockedMessage.role).toBe("user");
    expect(blockedMessage.idempotencyKey).toBe("hook-block:before_agent_run:user:run-1");
    expect(blockedMessage["__openclaw"]?.beforeAgentRunBlocked).toMatchObject({
      blockedBy: "policy-plugin",
    });
  });

  it("fails closed before turn/start when before_agent_run throws", async () => {
    const llmInput = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_agent_run",
          handler: async () => {
            throw new Error("hook exploded");
          },
        },
        { hookName: "llm_input", handler: llmInput },
      ]),
    );
    const sessionFile = path.join(tempDir, "before-agent-run-throw.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-before-agent-run-throw");
    const harness = createHarnessCompletingTurns();

    const result = await runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));

    expect(harness.requests.map((request) => request.method)).not.toContain("turn/start");
    expect(llmInput).not.toHaveBeenCalled();
    const terminal = readAttemptTerminal(result);
    expect(terminal.promptErrorSource).toBe("hook:before_agent_run");
    expect(
      String((terminal.promptError as Error | undefined)?.message ?? terminal.promptError),
    ).toBe("Your message could not be sent: blocked by before_agent_run");
  });

  it("runs before_agent_run once across the active-compact turn/start retry", async () => {
    const turnStartCallsAtHook: number[] = [];
    const harnessRef: { current?: ReturnType<typeof createAppServerHarness> } = {};
    const beforeAgentRun = vi.fn(async () => {
      turnStartCallsAtHook.push(
        harnessRef.current?.requests.filter((request) => request.method === "turn/start").length ??
          -1,
      );
      return undefined;
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );
    const sessionFile = path.join(tempDir, "before-agent-run-retry.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-before-agent-run-retry");
    let turnStartCalls = 0;
    const harness = createStartedThreadHarness(async (method) => {
      if (method !== "turn/start") {
        return undefined;
      }
      turnStartCalls += 1;
      if (turnStartCalls === 1) {
        queueMicrotask(() => {
          void harnessRef.current?.notify({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turnId: "compact-turn",
              turn: { id: "compact-turn", status: "completed" },
            },
          });
        });
        throw new CodexAppServerRpcError(
          {
            message: "cannot steer a compact turn",
            data: {
              message: "cannot steer a compact turn",
              codexErrorInfo: { activeTurnNotSteerable: { turnKind: "compact" } },
              additionalDetails: null,
            },
          },
          "turn/start",
        );
      }
      return turnStartResult("turn-1");
    });
    harnessRef.current = harness;

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await vi.waitFor(
      () =>
        expect(harness.requests.filter((request) => request.method === "turn/start")).toHaveLength(
          2,
        ),
      fastWait,
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(beforeAgentRun).toHaveBeenCalledTimes(1);
    expect(turnStartCallsAtHook).toEqual([0]);
  });
});
