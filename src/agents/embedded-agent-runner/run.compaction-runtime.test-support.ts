import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { expect, vi } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";
import type { ToolResultMessage } from "../../llm/types.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { PreparedAgentRunAdmission } from "../admitted-run-context.js";
import type { EmbeddedRunCompactionRecoveryInput } from "./run/compaction-runtime.js";
import type { PreparedEmbeddedRunInput } from "./run/execution-context.js";
import type { ToolResultPromptProjectionState } from "./session-prompt-state.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

type RecoveryKind = "overflow" | "timeout";
type AuthorityLoss = "closed" | "replaced" | "writer-replaced";
type FixtureOptions = { oversized?: boolean; inMemory?: boolean; detached?: boolean };
export type RecoveryFixture = Awaited<ReturnType<typeof createRecoveryFixture>>;

// The engine is synthetic; admission, writer claims, safety timeout, recovery,
// hooks, session state, transcript writes, and reopen reads are composed for real.
async function createRecoveryFixture(state: OpenClawTestState, options: FixtureOptions) {
  const { appendTranscriptMessage, loadTranscriptEvents, loadSessionEntry, replaceSessionEntry } =
    await import("../../config/sessions/session-accessor.js");
  const { resolveSessionTranscriptDatabasePath, resolveSessionTranscriptRuntimeTarget } =
    await import("../../config/sessions/session-accessor.transcript-target.js");
  const { waitForSessionTranscriptIndexReconcile } =
    await import("../../config/sessions/session-transcript-reconcile.js");
  const { closeOpenClawAgentDatabaseByPath } = await import("../../state/openclaw-agent-db.js");
  const { SessionManager } = await import("../sessions/session-manager.js");
  const { makeAgentAssistantMessage, makeAgentUserMessage } =
    await import("../test-helpers/agent-message-fixtures.js");
  const { makeAttemptResult, makeOverflowError } =
    await import("./run.overflow-compaction.fixture.js");
  const { createEmbeddedRunContextRecoveryState } = await import("./run/context-recovery-state.js");
  const { createEmbeddedRunCompactionRuntime } = await import("./run/compaction-runtime.js");
  const { createEmbeddedRunSessionPromptState } = await import("./run/session-prompt-state.js");
  const { claimAgentSessionWriter } = await import("./run/session-bootstrap.js");
  const { prepareSystemAgentRunAdmission, resolveAdmittedRunActiveAssertion } =
    await import("../admitted-run-context.js");
  const { getAgentRunLifecycleGeneration } = await import("../../infra/agent-run-registry.js");
  const { recoverEmbeddedRunOverflow } = await import("./run/overflow-context-recovery.js");
  const { recoverEmbeddedRunTimeout } = await import("./run/timeout-context-recovery.js");
  const { onInternalSessionTranscriptUpdate } = await import("../../sessions/transcript-events.js");
  const { forgetActiveSessionForShutdown } =
    await import("../../gateway/active-sessions-shutdown-tracker.js");
  const { createHookRunnerWithRegistry } = await import("../../plugins/hooks.test-fixtures.js");
  const { buildContextEngineRuntimeSettings } =
    await import("../../context-engine/runtime-settings.js");
  const { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } =
    await import("../../context-engine/host-compat.js");

  const memoryManager = options.inMemory ? SessionManager.inMemory(state.workspaceDir) : undefined;
  const sessionId = memoryManager?.getSessionId() ?? randomUUID();
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
  };
  const toolResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "fixture-call",
    toolName: "read",
    content: [
      {
        type: "text",
        text: options.oversized === false ? "small output" : "fixture output ".repeat(12_000),
      },
    ],
    isError: false,
    timestamp: 5,
  };
  const recentUser = makeAgentUserMessage({ content: "Read the fixture output", timestamp: 3 });
  const messages = [
    makeAgentUserMessage({ content: "Earlier topic", timestamp: 1 }),
    makeAgentAssistantMessage({
      content: [{ type: "text", text: "Earlier answer" }],
      timestamp: 2,
    }),
    recentUser,
    makeAgentAssistantMessage({
      content: [
        { type: "toolCall", id: "fixture-call", name: "read", arguments: { path: "fixture.txt" } },
      ],
      stopReason: "toolUse",
      timestamp: 4,
    }),
    toolResult,
  ];
  if (!memoryManager) {
    await replaceSessionEntry(target, { sessionId, updatedAt: 1 });
  }
  let recentUserId: string | undefined;
  for (const message of messages) {
    const messageId = memoryManager
      ? memoryManager.appendMessage(message)
      : (await appendTranscriptMessage(target, { cwd: state.workspaceDir, message })).messageId;
    if (message === recentUser) {
      recentUserId = messageId;
    }
  }
  if (!recentUserId) {
    throw new Error("Fixture must persist the recent user before compaction");
  }
  const firstKeptEntryId = recentUserId;
  if (!memoryManager) {
    const runtimeTarget = await resolveSessionTranscriptRuntimeTarget({
      ...target,
      sessionFile: target.sessionKey,
    });
    expect(resolveSessionTranscriptDatabasePath(runtimeTarget)).toBe(target.storePath);
    expect(runtimeTarget).toMatchObject({ sessionId, sessionKey: target.sessionKey });
  }

  const controller = new AbortController();
  const callerError = new Error("caller stopped the admitted recovery");
  const runId = randomUUID();
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "compaction-recovery-test");
  const admissions: PreparedAgentRunAdmission[] = [admission];
  const work: Promise<unknown>[] = [];
  let unsubscribe = () => {};
  let forgetCommittedSuccessor = () => {};
  const drain = () =>
    waitForSessionTranscriptIndexReconcile({
      agentId: target.agentId,
      path: target.storePath,
      env: state.env,
    });
  const dispose = async () => {
    for (const ownedAdmission of admissions) {
      ownedAdmission.close();
    }
    controller.abort(callerError);
    await Promise.allSettled(work);
    try {
      await drain();
    } finally {
      unsubscribe();
      forgetActiveSessionForShutdown(target.sessionId);
      forgetCommittedSuccessor();
      closeOpenClawAgentDatabaseByPath(target.storePath);
    }
  };
  try {
    const admittedRunContext = await admission.admit("embedded");
    const assertActive = resolveAdmittedRunActiveAssertion(admittedRunContext, controller.signal);
    if (!assertActive) {
      throw new Error("Fixture must capture a real live admission");
    }
    assertActive();
    const runParams: PreparedEmbeddedRunInput["runParams"] = {
      runId,
      sessionId,
      sessionKey: target.sessionKey,
      sessionFile: target.sessionKey,
      agentId: "main",
      workspaceDir: state.workspaceDir,
      prompt: "continue",
      timeoutMs: 30_000,
      config: { agents: { defaults: { compaction: { timeoutSeconds: 1 } } } },
      abortSignal: controller.signal,
      admittedRunContext,
      sessionPersistence: options.detached ? "detached" : undefined,
      ...(memoryManager
        ? { sessionManager: memoryManager, sessionPersistence: "detached" }
        : { sessionTarget: target }),
    };
    const writerFence = await claimAgentSessionWriter(runParams);
    if (memoryManager || options.detached) {
      expect(writerFence).toBeUndefined();
    } else {
      expect(writerFence?.expectedWriterRunId).toBe(runId);
      runParams.sessionTarget = { ...target, ...writerFence };
    }
    const sessionPromptState = createEmbeddedRunSessionPromptState({
      runParams,
      sessionAgentId: "main",
      resolvedSessionKey: target.sessionKey,
      lifecycleGeneration: getAgentRunLifecycleGeneration(),
    });
    forgetCommittedSuccessor = () => {
      const accepted = sessionPromptState.committedCompactionSuccessor;
      if (accepted) {
        forgetActiveSessionForShutdown(accepted.sessionId);
      }
    };
    const openWriter = () =>
      memoryManager ?? SessionManager.open({ ...target, ...writerFence }, state.workspaceDir);
    const commitCompaction = () => {
      openWriter().appendCompaction("Summary of earlier topic", firstKeptEntryId, 4_097);
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "Summary of earlier topic",
          firstKeptEntryId,
          tokensBefore: 4_097,
          tokensAfter: 3_000,
        },
      };
    };
    const compact = vi.fn<ContextEngine["compact"]>(async () => commitCompaction());
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () => ({
      changed: false,
      rewrittenEntries: 0,
      bytesFreed: 0,
    }));
    const contextEngine: ContextEngine = {
      info: { id: "fixture-engine", name: "Fixture engine", ownsCompaction: true },
      ingest: async () => {
        throw new Error("Unexpected ingest in recovery");
      },
      assemble: async () => {
        throw new Error("Unexpected assemble in recovery");
      },
      compact: (params) => {
        const pending = compact(params);
        work.push(pending);
        return pending;
      },
      maintain: (params) => {
        const pending = maintain(params);
        work.push(pending);
        return pending;
      },
    };
    const beforeHook = vi.fn(async () => {});
    const afterHook = vi.fn(async () => {});
    const { runner: hookRunner } = createHookRunnerWithRegistry([
      { hookName: "before_compaction", handler: beforeHook },
      { hookName: "after_compaction", handler: afterHook },
    ]);
    const onAgentEvent = vi.fn();
    runParams.onAgentEvent = onAgentEvent;
    const runtime = createEmbeddedRunCompactionRuntime({
      runParams,
      contextEngine,
      hookRunner,
      hookContext: {
        agentId: "main",
        sessionId,
        sessionKey: target.sessionKey,
        workspaceDir: state.workspaceDir,
      },
      sessionPromptState,
    });
    const recoveryState = createEmbeddedRunContextRecoveryState();
    const usageAccumulator = createUsageAccumulator();
    const retries = [
      vi.spyOn(sessionPromptState, "prepareCompactedTranscriptRetry"),
      vi.spyOn(sessionPromptState, "continueFromCurrentTranscript"),
      vi.spyOn(sessionPromptState, "markOwnedTranscriptRetry"),
    ];
    const armPostCompactionGuard = vi.fn();
    const updates = vi.fn();
    unsubscribe = onInternalSessionTranscriptUpdate((event) => {
      if (event.sessionKey === target.sessionKey) {
        updates(event);
      }
    });
    const recover = (kind: RecoveryKind, mixedPreflight = false) => {
      const promptError = makeOverflowError();
      const input: EmbeddedRunCompactionRecoveryInput = {
        runParams,
        state: recoveryState,
        usageAccumulator,
        contextEngine,
        contextTokenBudget: 4_096,
        genericCompactionRecoveryAllowed: true,
        attempt: makeAttemptResult({
          ...(kind === "timeout" ? { timedOut: true } : { promptError }),
          sessionIdUsed: sessionId,
          messagesSnapshot: messages,
          ...(mixedPreflight
            ? { preflightRecovery: { route: "compact_then_truncate", source: "mid-turn" } }
            : {}),
        }),
        runtimeAuthPlan: undefined,
        resolvedSessionKey: target.sessionKey,
        sessionAgentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        provider: "fixture-provider",
        modelId: "fixture-model",
        harnessRuntime: "openclaw",
        thinkLevel: "off",
        authProfileIdSource: "auto",
        resolveContextEnginePluginId: () => undefined,
        buildRuntimeSettings: ({ tokenBudget, degradedReason }) =>
          buildContextEngineRuntimeSettings({
            contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
            promptTokenBudget: tokenBudget,
            degradedReason,
          }),
        ...runtime,
        getActiveSession: () => ({
          id: sessionPromptState.sessionId,
          file: sessionPromptState.sessionFile,
          target: sessionPromptState.sessionTarget,
        }),
        prepareCompactedTranscriptRetry: sessionPromptState.prepareCompactedTranscriptRetry,
        armPostCompactionGuard,
      };
      if (kind === "timeout") {
        return recoverEmbeddedRunTimeout({
          ...input,
          timedOut: true,
          signalOwnedInterruption: false,
          timedOutDuringCompaction: false,
          timedOutDuringToolExecution: false,
          timedOutByRunBudget: false,
          lastRunPromptUsage: { input: 3_100, total: 3_100 },
        });
      }
      const projectionState: ToolResultPromptProjectionState = {
        replacements: new Map(),
        frozen: new Set(),
        ambiguousBaseKeys: new Set(),
        sourceTextByKey: new Map(),
      };
      return recoverEmbeddedRunOverflow({
        ...input,
        aborted: false,
        signalOwnedInterruption: false,
        promptError,
        attemptCompactionCount: 0,
        toolResultPromptProjectionState: projectionState,
        prepareCurrentTranscriptRetry: sessionPromptState.continueFromCurrentTranscript,
        markOwnedTranscriptRetry: sessionPromptState.markOwnedTranscriptRetry,
      });
    };
    const snapshot = async () => {
      await drain();
      // Reopen independently: a cached manager can hide a durable append or leaf change.
      closeOpenClawAgentDatabaseByPath(target.storePath);
      const manager = memoryManager ?? SessionManager.open(target, state.workspaceDir);
      const events = memoryManager
        ? memoryManager.getEntries()
        : await loadTranscriptEvents(target);
      return {
        eventDigests: events.map((entry) =>
          createHash("sha256").update(JSON.stringify(entry)).digest("hex"),
        ),
        leafId: manager.getLeafId(),
        compactionIds: manager
          .getEntries()
          .filter((entry) => entry.type === "compaction")
          .map((entry) => entry.id),
        toolResultChars: manager
          .getBranch()
          .flatMap((entry) =>
            entry.type === "message" && entry.message.role === "toolResult"
              ? entry.message.content.flatMap((block) =>
                  block.type === "text" ? [block.text.length] : [],
                )
              : [],
          )
          .reduce((sum, chars) => sum + chars, 0),
      };
    };
    const invalidate = async (loss: AuthorityLoss) => {
      if (loss === "closed") {
        admission.close();
      } else {
        const replacementRunId = loss === "replaced" ? runId : randomUUID();
        const replacement = prepareSystemAgentRunAdmission(
          {},
          replacementRunId,
          "main",
          "replacement-recovery-test",
        );
        admissions.push(replacement);
        const replacementContext = await replacement.admit("embedded");
        if (loss === "writer-replaced") {
          const replacementFence = await claimAgentSessionWriter({
            ...runParams,
            runId: replacementRunId,
            admittedRunContext: replacementContext,
          });
          expect(replacementFence?.expectedWriterRunId).toBe(replacementRunId);
          // No registered runner handle exists here: only the durable writer changes.
          assertActive();
        }
      }
      expect(controller.signal.aborted).toBe(false);
      if (loss !== "writer-replaced") {
        expect(assertActive).toThrow();
      }
    };
    const expectNoContinuation = () => {
      for (const retry of retries) {
        expect(retry).not.toHaveBeenCalled();
      }
      expect(armPostCompactionGuard).not.toHaveBeenCalled();
      expect(onAgentEvent).not.toHaveBeenCalled();
    };
    return {
      compact,
      maintain,
      beforeHook,
      afterHook,
      updates,
      controller,
      callerError,
      recoveryState,
      runId,
      recover,
      snapshot,
      invalidate,
      openWriter,
      expectNoContinuation,
      assertActive,
      dispose,
      stop: () => {
        admission.close();
        controller.abort(callerError);
      },
      loadEntry: () => loadSessionEntry(target),
      getCommittedSuccessor: () => sessionPromptState.committedCompactionSuccessor,
      getSessionTarget: () => sessionPromptState.sessionTarget,
      replacement: {
        entryId: firstKeptEntryId,
        message: makeAgentUserMessage({ content: "Maintenance replacement", timestamp: 3 }),
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function withRecoveryFixture(
  options: FixtureOptions,
  body: (fixture: RecoveryFixture) => Promise<void>,
) {
  await withOpenClawTestState(
    { label: "compaction-recovery", scenario: "minimal" },
    async (state) => {
      const fixture = await createRecoveryFixture(state, options);
      try {
        await body(fixture);
      } finally {
        await fixture.dispose();
      }
    },
  );
}

export async function waitForCompactionAbort(
  signal: AbortSignal | undefined,
  onStarted?: () => void,
): Promise<never> {
  if (!signal) {
    throw new Error("Compaction must receive the real safety-wrapper signal");
  }
  if (signal.aborted) {
    throw toErrorObject(signal.reason, "Compaction aborted");
  }
  let onAbort = () => {};
  const pending = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(toErrorObject(signal.reason, "Compaction aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    onStarted?.();
    return await pending;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
