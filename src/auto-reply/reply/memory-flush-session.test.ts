import path from "node:path";
import { expect, it } from "vitest";
import {
  assembleHarnessContextEngine,
  bootstrapHarnessContextEngine,
} from "../../agents/harness/context-engine-lifecycle.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  loadTranscriptEventsSync,
  replaceTranscriptEvents,
  readActiveTranscriptEntryAnchor,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { MAX_VISIBLE_MESSAGE_MAX_MESSAGES } from "../../config/sessions/session-accessor.sqlite-visible-cursor.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { createSessionTranscriptHeader } from "../../config/sessions/transcript-header.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { readPendingUserTurnTranscriptAdmission } from "../../sessions/user-turn-transcript-admission.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareMemoryFlushSession } from "./memory-flush-session.js";

async function withAdmittedInput(
  compacted: boolean,
  run: (fixture: {
    source: SessionManager;
    scope: { agentId: string; sessionId: string; sessionKey: string; storePath: string };
    workspaceDir: string;
    recorder: ReturnType<typeof createUserTurnTranscriptRecorder>;
    admission: NonNullable<ReturnType<typeof readPendingUserTurnTranscriptAdmission>>;
    priorContext: ReturnType<SessionManager["buildSessionContext"]>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "memory-checkpoint" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "foreground-session",
      sessionKey: "agent:main:foreground",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const source = SessionManager.open(scope, state.workspaceDir);
    source.appendMessage({ role: "user", content: "Earlier topic", timestamp: 1 });
    source.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Earlier reply" }],
        stopReason: "stop",
      }),
    );
    const retained = source.appendMessage({
      role: "user",
      content: "Keep the Cedar project receipt.",
      timestamp: 3,
    });
    source.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Cedar receipt is maple-17." }],
        stopReason: "stop",
      }),
    );
    if (compacted) {
      source.appendCompaction("Earlier conversation summary", retained, 500);
      const excluded = {
        role: "user" as const,
        content: "Excluded diagnostic payload",
        timestamp: 4,
        excludeFromContext: true as const,
      };
      source.appendMessage(excluded);
      source.appendCustomEntry("openclaw:bootstrap-context:full", { revision: "fixture" });
    }
    await waitForSessionTranscriptProjection(scope);
    const priorContext = source.buildSessionContext();
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "Unprocessed current question: do not checkpoint this yet.",
        idempotencyKey: "foreground:user",
      },
      target: { ...scope, expectedSessionId: scope.sessionId, sessionEntry: undefined },
    });
    await recorder.persistApproved();
    const admission = readPendingUserTurnTranscriptAdmission(recorder);
    if (!admission) {
      throw new Error("Fixture failed to admit its current user");
    }
    await run({
      source,
      scope,
      workspaceDir: state.workspaceDir,
      recorder,
      admission,
      priorContext,
    });
  });
}

it.each([false, true])(
  "isolates a required checkpoint while preserving admitted input (compacted=%s)",
  async (compacted) => {
    await withAdmittedInput(compacted, async ({ scope, workspaceDir, admission, priorContext }) => {
      const before = loadTranscriptEventsSync(scope);
      const anchor = readActiveTranscriptEntryAnchor(admission);
      const sourceWithForeignAuthority = {
        ...scope,
        expectedWriterRunId: "foreground-writer",
        threadId: "foreground-native-thread",
      };
      const checkpoint = await prepareMemoryFlushSession({
        admission,
        source: sourceWithForeignAuthority,
        runId: "memory-helper",
        workspaceDir,
      });
      expect(checkpoint.sessionManager.getSessionTarget()).toBeUndefined();
      expect(checkpoint.sessionManager.buildSessionContext().messages).toEqual(
        priorContext.messages,
      );
      expect(checkpoint.sessionId).not.toBe(scope.sessionId);
      expect(checkpoint.sessionKey).not.toBe(scope.sessionKey);
      expect(checkpoint.sessionTarget).not.toHaveProperty("expectedWriterRunId");
      expect(checkpoint.sessionTarget).not.toHaveProperty("threadId");
      expect(checkpoint.sessionPersistence).toBe("detached");
      const first = checkpoint.sessionManager.getBranch()[0];
      if (first) {
        checkpoint.sessionManager.branch(first.id);
      }
      checkpoint.sessionManager.appendMessage({
        role: "user",
        content: "Checkpoint instruction",
        timestamp: 5,
      });
      checkpoint.sessionManager.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "NO_REPLY" }],
          stopReason: "stop",
        }),
      );
      expect(loadTranscriptEventsSync(scope)).toEqual(before);
      expect(readActiveTranscriptEntryAnchor(admission)).toEqual(anchor);
      expect(SessionManager.open(scope).getBranch().at(-1)?.id).toBe(admission.entryId);
    });
  },
);

it("does not use an admission after the source transcript changes", async () => {
  await withAdmittedInput(false, async ({ scope, workspaceDir, admission }) => {
    const current = SessionManager.open(scope);
    current.branch(admission.effectiveParentId!);
    current.appendLeafControl({
      targetId: current.getLeafId(),
      appendParentId: current.getAppendParentId(),
    });
    await waitForSessionTranscriptProjection(scope);
    await expect(
      prepareMemoryFlushSession({
        admission,
        source: scope,
        runId: "stale-helper",
        workspaceDir,
      }),
    ).rejects.toThrow(/admission|visible/i);
  });
});

it("keeps custom context-engine bootstrap, rewrite, and assembly inside the checkpoint", async () => {
  await withAdmittedInput(true, async ({ scope, workspaceDir, admission, priorContext }) => {
    const before = loadTranscriptEventsSync(scope);
    const anchor = readActiveTranscriptEntryAnchor(admission);
    const checkpoint = await prepareMemoryFlushSession({
      admission,
      source: scope,
      runId: "plugin-checkpoint",
      workspaceDir,
    });
    const retainedMessage = checkpoint.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "user");
    if (!retainedMessage) {
      throw new Error("Missing processed checkpoint message");
    }
    const replacement = { role: "user" as const, content: "Checkpoint-only rewrite", timestamp: 3 };
    const stages: string[] = [];
    const engine: ContextEngine = {
      info: {
        id: "checkpoint-fixture",
        name: "Checkpoint fixture",
        turnMaintenanceMode: "background",
      },
      async bootstrap(params) {
        expect(params.sessionTarget).toEqual(checkpoint.sessionTarget);
        expect(params.sessionId).toBe(checkpoint.sessionId);
        expect(params.sessionKey).toBe(checkpoint.sessionKey);
        stages.push("bootstrap");
        return { bootstrapped: true };
      },
      async maintain(params) {
        expect(params.sessionId).toBe(checkpoint.sessionId);
        expect(params.sessionTarget).toEqual(checkpoint.sessionTarget);
        expect(params.runtimeContext?.allowDeferredCompactionExecution).toBeUndefined();
        const result = await params.runtimeContext!.rewriteTranscriptEntries!({
          replacements: [{ entryId: retainedMessage.id, message: replacement }],
        });
        expect(result).toMatchObject({ changed: true, rewrittenEntries: 1 });
        stages.push("maintain");
        return result;
      },
      async assemble(params) {
        expect(params.sessionId).toBe(checkpoint.sessionId);
        expect(params.sessionKey).toBe(checkpoint.sessionKey);
        expect(params.messages).toContainEqual(replacement);
        expect(params.messages).not.toEqual(priorContext.messages);
        stages.push("assemble");
        return { messages: params.messages, estimatedTokens: 100 };
      },
      async ingest() {
        return { ingested: false };
      },
      async compact() {
        throw new Error("Unexpected plugin compaction");
      },
    };
    const warnings: string[] = [];
    await bootstrapHarnessContextEngine({
      ...checkpoint,
      hadSessionFile: true,
      contextEngine: engine,
      warn: (message) => warnings.push(message),
    });
    const assembled = await assembleHarnessContextEngine({
      ...checkpoint,
      contextEngine: engine,
      modelId: "checkpoint-model",
      messages: checkpoint.sessionManager.buildSessionContext().messages,
    });
    expect(warnings).toEqual([]);
    expect(stages).toEqual(["bootstrap", "maintain", "assemble"]);
    expect(assembled?.messages).toContainEqual(replacement);
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
    expect(readActiveTranscriptEntryAnchor(admission)).toEqual(anchor);
  });
});

it("does not acquire a checkpoint after caller cancellation", async () => {
  await withAdmittedInput(false, async ({ scope, workspaceDir, admission }) => {
    const before = loadTranscriptEventsSync(scope);
    const reason = new Error("cancel required checkpoint");
    await expect(
      prepareMemoryFlushSession({
        admission,
        source: scope,
        runId: "cancelled-helper",
        workspaceDir,
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
  });
});

it("does not expose a processed recorder as a pending checkpoint admission", async () => {
  await withAdmittedInput(false, async ({ recorder }) => {
    recorder.markSentToProvider?.();
    expect(readPendingUserTurnTranscriptAdmission(recorder)).toBeUndefined();
  });
});

it("includes the completed foreground turn when optional memory has no admission fence", async () => {
  await withAdmittedInput(true, async ({ scope, workspaceDir, recorder }) => {
    recorder.markSentToProvider?.();
    const source = SessionManager.open(scope, workspaceDir);
    source.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "The current question is now answered." }],
        stopReason: "stop",
      }),
    );
    const before = loadTranscriptEventsSync(scope);
    const memory = await prepareMemoryFlushSession({
      source: scope,
      runId: "optional-after-reply",
      workspaceDir,
    });
    const messages = memory.sessionManager.buildSessionContext().messages;
    expect(messages).toEqual(source.buildSessionContext().messages);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "The current question is now answered." }],
    });
    expect(memory.sessionManager.getSessionTarget()).toBeUndefined();
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
  });
});

it("rejects a partial bounded checkpoint instead of silently starting with less history", async () => {
  await withOpenClawTestState({ label: "bounded-memory-checkpoint" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "bounded-checkpoint",
      sessionKey: "agent:main:bounded-checkpoint",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const seed = SessionManager.fromEntries([
      createSessionTranscriptHeader({ cwd: state.workspaceDir, sessionId: scope.sessionId }),
    ]);
    for (let i = 0; i <= MAX_VISIBLE_MESSAGE_MAX_MESSAGES; i += 1) {
      seed.appendMessage({ role: "user", content: `Prior record ${i}`, timestamp: i });
    }
    await replaceTranscriptEvents(scope, [seed.getHeader(), ...seed.getEntries()]);
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...scope, expectedSessionId: scope.sessionId, sessionEntry: undefined },
      input: { text: "Current request", idempotencyKey: "bounded:user" },
    });
    await recorder.persistApproved();
    const admission = readPendingUserTurnTranscriptAdmission(recorder);
    if (!admission) {
      throw new Error("Missing bounded fixture admission");
    }
    const before = loadTranscriptEventsSync(scope);
    await expect(
      prepareMemoryFlushSession({
        admission,
        source: scope,
        runId: "bounded-helper",
        workspaceDir: state.workspaceDir,
      }),
    ).rejects.toThrow("bounded conversation view");
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
  });
});
