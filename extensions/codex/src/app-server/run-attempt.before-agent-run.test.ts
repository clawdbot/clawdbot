// Codex tests cover the fail-closed before_agent_run gate on native app-server attempts.
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { CodexAppServerRpcError } from "./client.js";
import {
  createAppServerHarness,
  createParams,
  createStartedThreadHarness,
  fastWait,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

const OPENCLAW_META_KEY = "__openclaw";
const DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "disabled",
});

type GateFixture = {
  abortController: AbortController;
  onUserMessagePersisted: ReturnType<typeof vi.fn>;
  params: EmbeddedRunAttemptParams;
  persistBlocked: ReturnType<typeof vi.fn>;
  removeAbortListener: ReturnType<typeof vi.spyOn>;
  runId: string;
};

// Each test owns a distinct runId: the gate memoizes its decision per run, so
// sharing one id across tests would replay an earlier test's admission.
function createGateParams(label: string): GateFixture {
  const runId = `run-${label}`;
  const params = createParams(
    path.join(tempDir, `${label}.jsonl`),
    path.join(tempDir, `workspace-${label}`),
    { runId },
  );
  params.agentAccountId = "account-7";
  params.senderId = "sender-7";
  params.senderIsOwner = true;
  params.messageChannel = "telegram";
  params.currentChannelId = "telegram:chat-42";
  const abortController = new AbortController();
  params.abortSignal = abortController.signal;
  // One logical run owns one opaque gate memo; production allocates it in the
  // outer run loop and copies the reference into every dispatched attempt.
  params.beforeAgentRunAdmission = {};
  const removeAbortListener = vi.spyOn(abortController.signal, "removeEventListener");
  const onUserMessagePersisted = vi.fn();
  params.onUserMessagePersisted = onUserMessagePersisted;
  const persistBlocked = vi.fn(async (message: unknown) => ({ message }));
  params.userTurnTranscriptRecorder = {
    message: undefined,
    resolveMessage: async () => undefined,
    markRuntimePersisted() {},
    getAdmissionReceipt: () => undefined,
    persistBlocked,
  } as unknown as EmbeddedRunAttemptParams["userTurnTranscriptRecorder"];
  return {
    abortController,
    onUserMessagePersisted,
    params,
    persistBlocked,
    removeAbortListener,
    runId,
  };
}

describe("runCodexAppServerAttempt before_agent_run gate", () => {
  it("runs the gate once with the final prompt and trusted identity, then starts the turn", async () => {
    const beforeAgentRun = vi.fn(() => ({ outcome: "pass" }) as const);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );
    const harness = createStartedThreadHarness();
    const { params, runId } = createGateParams("gate-pass");
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(beforeAgentRun).toHaveBeenCalledTimes(1);
    const [event, ctx] = beforeAgentRun.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(event.prompt).toBe("hello");
    expect(event.systemPrompt).toContain("You are a personal agent running inside OpenClaw.");
    expect(event.messages).toEqual([]);
    expect(event.accountId).toBe("account-7");
    expect(event.senderId).toBe("sender-7");
    expect(event.senderIsOwner).toBe(true);
    // Channel identity comes from the host-proven attempt fields, not the prompt.
    expect(event.channelId).toBe("chat-42");
    expect(ctx.runId).toBe(runId);
    expect(ctx.sessionId).toBe("session-1");
    // The gate never turns trusted identity into model input.
    const turnStart = harness.requests.find((entry) => entry.method === "turn/start");
    expect(JSON.stringify(turnStart?.params)).not.toContain("sender-7");
  });

  it("starts no Codex work and fails closed when a plugin blocks the run", async () => {
    const agentEnd = vi.fn();
    const llmInput = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          pluginId: "guardrail",
          hookName: "before_agent_run",
          handler: () => ({ outcome: "block", reason: "secret-policy", message: "not allowed" }),
        },
        { hookName: "agent_end", handler: agentEnd },
        { hookName: "llm_input", handler: llmInput },
      ]),
    );
    const harness = createStartedThreadHarness();
    const { onUserMessagePersisted, params, persistBlocked, removeAbortListener, runId } =
      createGateParams("gate-block");
    const onAgentEvent = vi.fn();
    params.onAgentEvent = onAgentEvent;

    const result = await runCodexAppServerAttempt(params);

    expect(harness.requests.map((entry) => entry.method)).not.toContain("thread/start");
    expect(harness.requests.map((entry) => entry.method)).not.toContain("turn/start");
    expect(llmInput).not.toHaveBeenCalled();
    const terminal = readAttemptTerminal(result);
    expect(terminal.promptErrorSource).toBe("hook:before_agent_run");
    expect((terminal.promptError as Error).message).toBe(
      "Your message could not be sent: not allowed (blocked by guardrail)",
    );
    expect(result.assistantTexts).toEqual([]);
    // Plugin-local reason detail never reaches the operator-visible surface.
    expect(String(terminal.promptError)).not.toContain("secret-policy");

    expect(persistBlocked).toHaveBeenCalledTimes(1);
    const persisted = persistBlocked.mock.calls[0]?.[0] as {
      content: { text: string }[];
      idempotencyKey: string;
    } & Record<string, { beforeAgentRunBlocked?: { blockedBy?: string } }>;
    expect(persisted.content[0]?.text).toBe(
      "Your message could not be sent: not allowed (blocked by guardrail)",
    );
    expect(persisted.idempotencyKey).toBe(`hook-block:before_agent_run:user:${runId}`);
    expect(persisted[OPENCLAW_META_KEY]?.beforeAgentRunBlocked?.blockedBy).toBe("guardrail");
    expect(JSON.stringify(persisted)).not.toContain("secret-policy");

    // Canonical user-turn bookkeeping still notifies the persistence listener.
    expect(onUserMessagePersisted).toHaveBeenCalledTimes(1);
    // The upstream abort listener is released even though startup never ran.
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));

    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1));
    const [agentEndEvent] = agentEnd.mock.calls[0] as unknown as [
      { error?: string; messages?: { content?: { text?: string }[] }[]; success?: boolean },
    ];
    expect(agentEndEvent.success).toBe(false);
    expect(agentEndEvent.error).toBe(
      "Your message could not be sent: not allowed (blocked by guardrail)",
    );
    // agent_end carries the redacted blocked turn, never the plugin-local reason.
    expect(agentEndEvent.messages?.at(-1)?.content?.[0]?.text).toBe(
      "Your message could not be sent: not allowed (blocked by guardrail)",
    );
    expect(JSON.stringify(agentEndEvent)).not.toContain("secret-policy");
    expect(
      onAgentEvent.mock.calls
        .map(([event]) => event as { data?: { phase?: string } })
        .some((event) => event.data?.phase === "before_agent_run_blocked"),
    ).toBe(true);
  });

  it("fails closed without starting Codex when the gate hook throws", async () => {
    const llmInput = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_agent_run",
          handler: () => {
            throw new Error("gate exploded");
          },
        },
        { hookName: "llm_input", handler: llmInput },
      ]),
    );
    const harness = createStartedThreadHarness();
    const { params, persistBlocked } = createGateParams("gate-throw");

    const result = await runCodexAppServerAttempt(params);

    expect(harness.requests.map((entry) => entry.method)).not.toContain("thread/start");
    expect(harness.requests.map((entry) => entry.method)).not.toContain("turn/start");
    expect(llmInput).not.toHaveBeenCalled();
    const terminal = readAttemptTerminal(result);
    expect(terminal.promptErrorSource).toBe("hook:before_agent_run");
    expect((terminal.promptError as Error).message).toBe(
      "Your message could not be sent: blocked by before_agent_run",
    );
    expect(persistBlocked).toHaveBeenCalledTimes(1);
    expect(String(persistBlocked.mock.calls[0]?.[0])).not.toContain("gate exploded");
  });

  it("runs the gate exactly once across an internal turn/start retry", async () => {
    const beforeAgentRun = vi.fn(() => ({ outcome: "pass" }) as const);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );
    const { params } = createGateParams("gate-retry");
    await writeCodexAppServerBinding(params.sessionFile as string, {
      threadId: "thread-existing",
      cwd: params.workspaceDir as string,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      historyCoveredThrough: new Date().toISOString(),
      webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
      dynamicToolsFingerprint: "[]",
    });
    let turnStartCalls = 0;
    const harnessRef: { current?: ReturnType<typeof createAppServerHarness> } = {};
    const harness = createAppServerHarness(async (method) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      if (method === "turn/start") {
        turnStartCalls += 1;
        if (turnStartCalls === 1) {
          queueMicrotask(() => {
            void harnessRef.current?.notify({
              method: "turn/completed",
              params: {
                threadId: "thread-existing",
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
      }
      return {};
    });
    harnessRef.current = harness;

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(
      () =>
        expect(harness.requests.filter((entry) => entry.method === "turn/start")).toHaveLength(2),
      fastWait,
    );
    await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;

    // Two native turn/start attempts, still one admitted OpenClaw turn.
    expect(beforeAgentRun).toHaveBeenCalledTimes(1);
  });

  it("still blocks when no user-turn recorder is attached", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          pluginId: "guardrail",
          hookName: "before_agent_run",
          handler: () => ({ outcome: "block", reason: "secret-policy", message: "not allowed" }),
        },
      ]),
    );
    const harness = createStartedThreadHarness();
    const { params } = createGateParams("gate-no-recorder");
    params.userTurnTranscriptRecorder = undefined;

    const result = await runCodexAppServerAttempt(params);

    expect(harness.requests.map((entry) => entry.method)).not.toContain("turn/start");
    const terminal = readAttemptTerminal(result);
    expect(terminal.promptErrorSource).toBe("hook:before_agent_run");
    expect((terminal.promptError as Error).message).toBe(
      "Your message could not be sent: not allowed (blocked by guardrail)",
    );
  });

  it("runs the gate once across outer attempt re-dispatch for the same run", async () => {
    const beforeAgentRun = vi.fn(() => ({ outcome: "pass" }) as const);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );
    let turnStartCalls = 0;
    const harness = createAppServerHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      // The re-dispatched attempt resumes the thread the failed attempt bound.
      if (method === "thread/resume") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        turnStartCalls += 1;
        if (turnStartCalls === 1) {
          throw new Error("codex app-server transport failed");
        }
        return turnStartResult();
      }
      return {};
    });
    const { params } = createGateParams("gate-redispatch");

    // First dispatch fails after the gate admitted the turn.
    await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
      "codex app-server transport failed",
    );
    expect(beforeAgentRun).toHaveBeenCalledTimes(1);

    // Outer recovery re-dispatches the same admitted run.
    const retryRun = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await retryRun;

    expect(turnStartCalls).toBe(2);
    expect(beforeAgentRun).toHaveBeenCalledTimes(1);
  });

  it("gates each logical run separately when a runId is reused", async () => {
    const beforeAgentRun = vi.fn(() => ({ outcome: "pass" }) as const);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );
    const harness = createStartedThreadHarness();
    const { params } = createGateParams("gate-run-reuse");

    for (let logicalRun = 0; logicalRun < 2; logicalRun += 1) {
      // A later logical run reusing this runId gets its own admission memo and
      // must be gated again; only the shared reference short-circuits.
      params.beforeAgentRunAdmission = {};
      const run = runCodexAppServerAttempt(params);
      await vi.waitFor(
        () =>
          expect(harness.requests.filter((entry) => entry.method === "turn/start")).toHaveLength(
            logicalRun + 1,
          ),
        fastWait,
      );
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    }

    expect(beforeAgentRun).toHaveBeenCalledTimes(2);
  });

  it("leaves the no-hook path untouched", async () => {
    initializeGlobalHookRunner(createMockPluginRegistry([]));
    const harness = createStartedThreadHarness();
    const { params, persistBlocked } = createGateParams("gate-absent");
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    expect(readAttemptTerminal(result).promptErrorSource).toBeNull();
    expect(persistBlocked).not.toHaveBeenCalled();
  });
});
