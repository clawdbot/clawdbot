import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { prepareEmbeddedAttemptTimeout } from "../../agents/embedded-agent-runner/run/attempt-timeout-prepare.js";
import {
  abortAndDrainEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import {
  createReplyOperation,
  isReplyRunEvidenceStale,
} from "../../auto-reply/reply/reply-run-registry.js";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  registerAgentRunDelegatedAuthorityClosedHandler,
  releaseAgentRunDelegatedAuthority,
  rotateAgentRunRegistryLifecycleGeneration,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { recoverStuckDiagnosticSession } from "../../logging/diagnostic-stuck-session-recovery.runtime.js";
import { diagnosticLogger, startDiagnosticHeartbeat } from "../../logging/diagnostic.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import { QuestionManager } from "../question-manager.js";
import { createQuestionHandlers } from "./question.js";
import { createSecretStoreWriteService } from "./secrets.js";
import type { GatewayClient, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const ref = {
  sessionId: "human-wait-session",
  sessionKey: "agent:main:main",
  runId: "human-wait-run",
};
let manager: QuestionManager;
let authority: AgentRunDelegatedAuthority;
let unregister: () => void;
let client: GatewayClient;
let handlers: ReturnType<typeof createQuestionHandlers>;
let admission: PreparedAgentRunAdmission;
let onBroadcast: (event: string) => void;
let requesterActive: boolean;
let validateAuthority: ReturnType<typeof createAgentRuntimeApprovalAuthorityValidator>;
const abort = vi.fn();
let handle: EmbeddedAgentQueueHandle;

beforeEach(async () => {
  handle = {
    runId: ref.runId,
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort,
  };
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-08-20T12:00:00Z"));
  setDiagnosticsEnabledForProcess(true);
  manager = new QuestionManager();
  onBroadcast = () => {};
  requesterActive = true;
  const validateRunAuthority = createAgentRuntimeApprovalAuthorityValidator();
  validateAuthority = (identity) => requesterActive && validateRunAuthority(identity);
  registerAgentRunContext(ref.runId, { sessionKey: ref.sessionKey, agentId: "main" });
  admission = prepareSystemAgentRunAdmission({}, ref.runId, "main", "question-recovery-test");
  const admitted = await admission.admit("embedded");
  authority = getAdmittedRunDelegatedAuthority(admitted)!;
  unregister = registerAgentRunDelegatedAuthorityClosedHandler(() =>
    manager.cancelClosedAuthorities(),
  );
  client = {
    connect: { scopes: ["operator.admin"] },
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: ref.sessionKey,
        operationalRunInstance: authority.operationalRunInstance,
        delegatedAuthority: { kind: "local", ...authority },
      },
    },
  } as GatewayClient;
  handlers = createQuestionHandlers(
    manager,
    createSecretStoreWriteService({ reloadSecrets: async () => ({ warningCount: 0 }) }),
  );
  abort.mockReset().mockImplementation(() => {
    releaseAgentRunDelegatedAuthority(authority);
    clearActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
  });
  await withGatewayToolCallerIdentity(
    createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "main",
      sessionKey: ref.sessionKey,
    }),
    () => setActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey),
  );
});

afterEach(() => {
  resetDiagnosticStateForTest();
  admission.close();
  releaseAgentRunDelegatedAuthority(authority);
  unregister();
  clearAgentRunContext(ref.runId);
  manager.reset();
  embeddedRunTesting.resetActiveEmbeddedRuns();
  resetDiagnosticEventsForTest();
  vi.useRealTimers();
});

async function call(method: string, params: Record<string, unknown>, trusted = true) {
  const responses: Parameters<RespondFn>[] = [];
  await handlers[method]!({
    req: { type: "req", id: "request", method, params },
    params,
    client: trusted ? client : ({ connect: { scopes: ["operator.admin"] } } as GatewayClient),
    respond: (...args) => responses.push(args),
    isWebchatConnect: () => false,
    context: {
      broadcast: (event: string) => onBroadcast(event),
      getRuntimeConfig: () => ({}),
      validateAgentRuntimeApprovalAuthority: validateAuthority,
    } as unknown as GatewayRequestHandlerOptions["context"],
  });
  return responses[0];
}

async function request(
  tool: "secrets" | "ask_user",
  trusted = true,
  timeoutMs = 3_600_000,
  id = "human-question",
) {
  const params = {
    id,
    agentId: "main",
    sessionKey: ref.sessionKey,
    runId: ref.runId,
    timeoutMs,
    questions: [
      {
        questionId: "answer",
        header: "Input",
        question: "Provide the requested input",
        options: [],
        isOther: true,
        ...(tool === "secrets"
          ? {
              isSecret: true,
              secretStore: {
                name: "TEST_API_KEY",
                kind: "secret",
                allowedHosts: ["api.example.test"],
              },
            }
          : {}),
      },
    ],
  };
  expect((await call("question.request", params, trusted))?.[0]).toBe(true);
  expect(manager.get(params.id)).toMatchObject({
    status: "pending",
    expiresAtMs: Date.now() + timeoutMs,
  });
  return params.id;
}

it.each(["secrets", "ask_user"] as const)(
  "keeps an accepted one-hour %s question alive through default diagnostic recovery",
  async (tool) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const recovery = vi.fn(recoverStuckDiagnosticSession);
      startDiagnosticHeartbeat({}, { recoverStuckSession: recovery });
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        ...ref,
        toolName: tool,
        toolCallId: "human-call",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const id = await request(tool);
      await vi.advanceTimersByTimeAsync(920_000);
      expect(recovery).toHaveBeenCalledWith(
        expect.objectContaining({ allowActiveAbort: true, queueDepth: 0 }),
      );
      expect(abort).not.toHaveBeenCalled();
      expect(manager.get(id)?.status).toBe("pending");
      const answer = manager.waitAnswer(id);
      await vi.advanceTimersByTimeAsync(2_500_000);
      expect(abort).not.toHaveBeenCalled();
      expect(
        (
          await call("question.resolve", {
            id,
            answers: { answers: { answer: ["synthetic-human-answer"] } },
          })
        )?.[0],
      ).toBe(true);
      await expect(answer).resolves.toMatchObject({
        status: "answered",
        answers: {
          answers: { answer: [tool === "secrets" ? "stored" : "synthetic-human-answer"] },
        },
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(abort).not.toHaveBeenCalled();
      // Resolution is real progress, but a tool that stays hung is still recovered.
      await vi.advanceTimersByTimeAsync(900_000);
      expect(abort).toHaveBeenCalledTimes(1);
    });
  },
);

function recover() {
  return recoverStuckDiagnosticSession({
    ...ref,
    ageMs: 930_000,
    queueDepth: 0,
    allowActiveAbort: true,
  });
}

it.each(["resumed", "replacement"] as const)(
  "keeps the %s owner alive when a heartbeat expires its pending question",
  async (owner) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const heartbeatAtMs = Date.now() + 900_000;
      const recovery = vi.fn(recoverStuckDiagnosticSession);
      const replacement: EmbeddedAgentQueueHandle = {
        ...handle,
        abort: vi.fn(() => clearActiveEmbeddedRun(ref.sessionId, replacement, ref.sessionKey)),
      };
      if (owner === "replacement") {
        onBroadcast = (event) => {
          if (event === "question.resolved") {
            setActiveEmbeddedRun(ref.sessionId, replacement, ref.sessionKey);
          }
        };
      }
      startDiagnosticHeartbeat(
        {},
        {
          recoverStuckSession: recovery,
          emitMemorySample: () => {
            if (Date.now() === heartbeatAtMs) {
              // Synchronous sampling crosses expiry before its timer can run;
              // this does not depend on equal-deadline timer ordering.
              vi.setSystemTime(heartbeatAtMs + 100);
            }
            return {
              rssBytes: 100,
              heapTotalBytes: 80,
              heapUsedBytes: 40,
              externalBytes: 10,
              arrayBuffersBytes: 5,
            };
          },
          sampleLiveness: () => null,
        },
      );
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        ...ref,
        toolName: "ask_user",
        toolCallId: "heartbeat-expiry-call",
      });
      await vi.advanceTimersByTimeAsync(50);
      const id = await request("ask_user", true, 900_000);
      const answer = manager.waitAnswer(id);

      await vi.advanceTimersByTimeAsync(899_950);
      await Promise.all(recovery.mock.results.map((result) => result.value));

      await expect(answer).resolves.toEqual({ status: "expired" });
      expect(abort).not.toHaveBeenCalled();
      expect(replacement.abort).not.toHaveBeenCalled();
    });
  },
);

it("keeps resumed question work alive when attention logging settles the question", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const recoveryAtMs = Date.now() + 900_000;
    const recovery = vi.fn(recoverStuckDiagnosticSession);
    startDiagnosticHeartbeat({}, { recoverStuckSession: recovery, sampleLiveness: () => null });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      ...ref,
      toolName: "ask_user",
      toolCallId: "logging-settlement-call",
    });
    const id = await request("ask_user");
    const answer = manager.waitAnswer(id);
    const warning = vi.spyOn(diagnosticLogger, "warn").mockImplementation((message) => {
      if (message.startsWith("stalled session:") && Date.now() === recoveryAtMs) {
        manager.cancel(id);
      }
    });
    try {
      await vi.advanceTimersByTimeAsync(900_000);
      await Promise.all(recovery.mock.results.map((result) => result.value));

      await expect(answer).resolves.toEqual({ status: "cancelled" });
      expect(abort).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
});

it.each([900_000, 3_600_000])(
  "releases an expired %ims wait even before its timer callback runs",
  async (timeoutMs) => {
    const id = await request("ask_user", true, timeoutMs);
    const answer = manager.waitAnswer(id);
    vi.setSystemTime(Date.now() + timeoutMs - 1);
    await expect(recover()).resolves.toMatchObject({ reason: "human_input_wait" });
    vi.setSystemTime(Date.now() + 1);
    await expect(recover()).resolves.toMatchObject({ reason: "stale_session_state" });
    await expect(answer).resolves.toEqual({ status: "expired" });
    expect(
      (await call("question.resolve", { id, answers: { answers: { answer: ["late"] } } }))?.[0],
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(900_000);
    await expect(recover()).resolves.toMatchObject({ status: "aborted" });
  },
);

it.each(["cancel", "reset", "authority", "generation"] as const)(
  "releases protection after %s closes the question",
  async (terminal) => {
    const id = await request("ask_user");
    await expect(recover()).resolves.toMatchObject({ reason: "human_input_wait" });
    if (terminal === "cancel") {
      manager.cancel(id);
    }
    if (terminal === "reset") {
      manager.reset();
    }
    if (terminal === "authority") {
      admission.close();
    }
    if (terminal === "generation") {
      rotateAgentRunRegistryLifecycleGeneration();
    }
    await expect(recover()).resolves.toMatchObject({ status: "aborted" });
    expect(manager.get(id)?.status).not.toBe("pending");
  },
);

it("does not let operator questions or public diagnostic text suppress unrelated run recovery", async () => {
  const id = await request("ask_user", false);
  emitTrustedDiagnosticEvent({
    type: "tool.execution.started",
    ...ref,
    toolName: "ask_user",
    toolCallId: id,
  });
  await expect(recover()).resolves.toMatchObject({ status: "aborted" });
  expect(manager.get(id)?.status).toBe("pending");
});

it("keeps explicit user abort authoritative during human input", async () => {
  const id = await request("ask_user");
  await expect(recover()).resolves.toMatchObject({ reason: "human_input_wait" });
  await expect(
    abortAndDrainEmbeddedAgentRun({ ...ref, reason: "user_abort" }),
  ).resolves.toMatchObject({
    aborted: true,
    drained: true,
  });
  expect(manager.get(id)?.status).toBe("cancelled");
});

it("keeps an explicit 600-second attempt budget authoritative over a one-hour question", async () => {
  const id = await request("ask_user");
  const timedOut = vi.fn();
  const runAbortController = new AbortController();
  const deadline = prepareEmbeddedAttemptTimeout({
    attempt: { ...ref, timeoutMs: 600_000 },
    activeSession: { isCompacting: false, isStreaming: false },
    compactionState: { isCompacting: () => false },
    compactionTimeoutMs: 600_000,
    runAbortSignal: runAbortController.signal,
    isProbeSession: true,
    abortRun: (isTimeout, reason) => {
      runAbortController.abort(reason);
      abort(isTimeout, reason);
    },
    markTimedOutByRunBudget: timedOut,
    markTimedOutDuringCompaction: () => {},
  });
  try {
    await expect(recover()).resolves.toMatchObject({ reason: "human_input_wait" });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(timedOut).toHaveBeenCalledOnce();
    expect(manager.get(id)?.status).toBe("cancelled");
  } finally {
    deadline.clearTimers();
  }
});

it.each(["reply admission", "embedded steering"])(
  "accepts late human input through %s instead of treating its owner as stale",
  async (boundary) => {
    const operation = createReplyOperation({
      sessionKey: ref.sessionKey,
      sessionId: ref.sessionId,
      resetTriggered: false,
    });
    operation.attachBackend(Object.assign(handle, { kind: "embedded" as const, cancel: abort }));
    operation.bindToolAuthorityFingerprint("human-wait-surface");
    operation.setPhase("running");
    try {
      await request("ask_user");
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        ...ref,
        toolName: "ask_user",
        toolCallId: "late-answer-call",
      });
      await vi.advanceTimersByTimeAsync(930_000);
      if (boundary === "reply admission") {
        expect(isReplyRunEvidenceStale(operation)).toBe(false);
        await expect(
          admitReplyTurn({
            sessionKey: ref.sessionKey,
            sessionId: ref.sessionId,
            kind: "visible",
            resetTriggered: false,
            waitForActive: false,
          }),
        ).resolves.toMatchObject({
          status: "skipped",
          reason: "active-run",
          activeOperation: operation,
        });
      } else {
        await expect(
          queueEmbeddedAgentMessageWithOutcomeAsync(ref.sessionId, "human answer", {
            isInboundUserMessage: true,
            toolAuthorityFingerprint: "human-wait-surface",
          }),
        ).resolves.toMatchObject({ queued: true });
      }
    } finally {
      operation.complete();
    }
  },
);

it("does not protect an unrelated reply backend that copies the waiting run's IDs", async () => {
  const operation = createReplyOperation({
    sessionKey: ref.sessionKey,
    sessionId: ref.sessionId,
    resetTriggered: false,
  });
  operation.attachBackend({ ...handle, kind: "embedded", cancel: () => {} });
  operation.setPhase("running");
  try {
    await request("ask_user");
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      ...ref,
      toolName: "ask_user",
      toolCallId: "unrelated-call",
    });
    await vi.advanceTimersByTimeAsync(930_000);
    expect(isReplyRunEvidenceStale(operation)).toBe(true);
  } finally {
    operation.complete();
  }
});

it("does not transfer a pending question to a replacement handle with the same run ID", async () => {
  await request("ask_user");
  const replacement = {
    ...handle,
    abort: vi.fn(() => clearActiveEmbeddedRun(ref.sessionId, replacement, ref.sessionKey)),
  };
  setActiveEmbeddedRun(ref.sessionId, replacement, ref.sessionKey);
  await expect(recover()).resolves.toMatchObject({ status: "aborted" });
  expect(replacement.abort).toHaveBeenCalledTimes(1);
  expect(abort).not.toHaveBeenCalled();
});

it("refuses to bind new authority to the old handle when a run ID is reused", async () => {
  await request("ask_user");
  const replacementAuthority = claimAgentRunDelegatedAuthority({
    runId: ref.runId,
    instanceId: "replacement-instance",
  });
  try {
    client = {
      ...client,
      internal: {
        agentRuntimeIdentity: {
          ...client!.internal!.agentRuntimeIdentity!,
          operationalRunInstance: replacementAuthority.operationalRunInstance,
          delegatedAuthority: { kind: "local", ...replacementAuthority },
        },
      },
    } as GatewayClient;
    await request("ask_user", true, 3_600_000, "replacement-question");
    await expect(recover()).resolves.toMatchObject({ status: "aborted" });
  } finally {
    releaseAgentRunDelegatedAuthority(replacementAuthority);
  }
});

it.each(["pending", "answered", "cancelled", "expired", "requester-inactive"] as const)(
  "rechecks a question accepted after recovery was queued (%s)",
  async (terminal) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recovery = vi.fn(async (params: Parameters<typeof recoverStuckDiagnosticSession>[0]) => {
      await gate;
      return recoverStuckDiagnosticSession(params);
    });
    startDiagnosticHeartbeat({}, { recoverStuckSession: recovery });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      ...ref,
      toolName: "ask_user",
      toolCallId: "queued-call",
    });
    await vi.advanceTimersByTimeAsync(930_000);
    expect(recovery).toHaveBeenCalledTimes(1);
    const id = await request("ask_user");
    if (terminal === "cancelled") {
      manager.cancel(id);
    }
    if (terminal === "answered") {
      await call("question.resolve", { id, answers: { answers: { answer: ["human answer"] } } });
    }
    if (terminal === "expired") {
      vi.setSystemTime(Date.now() + 3_600_000);
      expect(manager.get(id)?.status).toBe("expired");
    }
    if (terminal === "requester-inactive") {
      // Worker placement or turn capability can close while the local run claim survives.
      requesterActive = false;
      manager.cancelClosedAuthorities();
    }
    release();
    const outcome = await recovery.mock.results[0]!.value;
    if (terminal === "requester-inactive") {
      expect(outcome).toMatchObject({ status: "aborted" });
      expect(abort).toHaveBeenCalledOnce();
      return;
    }
    expect(outcome).toMatchObject({
      status: "skipped",
      reason: terminal === "pending" ? "human_input_wait" : "stale_session_state",
    });
    expect(abort).not.toHaveBeenCalled();
  },
);

it("keeps the run protected until its last pending human question settles", async () => {
  const first = await request("ask_user");
  const second = await request("ask_user", true, 3_600_000, "second-question");
  manager.cancel(first);
  await expect(recover()).resolves.toMatchObject({ reason: "human_input_wait" });
  manager.cancel(second);
  await expect(recover()).resolves.toMatchObject({ status: "aborted" });
});

it("does not abort a replacement installed synchronously by question expiry", async () => {
  await request("ask_user", true, 900_000);
  const replacement = { ...handle, abort: vi.fn() };
  onBroadcast = (event) => {
    if (event === "question.resolved") {
      setActiveEmbeddedRun(ref.sessionId, replacement, ref.sessionKey);
    }
  };
  vi.setSystemTime(Date.now() + 900_000);
  await expect(recover()).resolves.toMatchObject({
    status: "skipped",
    reason: "stale_session_state",
  });
  expect(abort).not.toHaveBeenCalled();
  expect(replacement.abort).not.toHaveBeenCalled();
});
