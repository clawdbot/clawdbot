import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import {
  SessionTranscriptWriterClaimReboundError,
  runWithoutOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import { getAgentRunLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import { onSessionIdentityMutation } from "../../../sessions/session-lifecycle-events.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { runOpenClawAgentWriteTransaction } from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../../admitted-run-context.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import { preparePersistedCurrentUserTurn } from "./pre-persisted-user-turn.js";
import { claimAgentSessionWriter } from "./session-bootstrap.js";
import { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

const userMessage = { role: "user" as const, content: "First user turn", timestamp: 1 };

type InitialWriterFixture = {
  admission: PreparedAgentRunAdmission;
  controller: AbortController;
  manager: SessionManager;
  openManager: () => SessionManager;
  promptState: ReturnType<typeof createEmbeddedRunSessionPromptState>;
  replaceAdmission: () => Promise<void>;
  runParams: PreparedEmbeddedRunInput["runParams"];
  target: { agentId: string; sessionId: string; sessionKey: string; storePath: string };
};

async function withInitialWriter(
  run: (fixture: InitialWriterFixture) => Promise<void>,
  options: { existing?: boolean } = {},
) {
  await withOpenClawTestState({ label: "initial-session-writer" }, async (state) => {
    const sessionId = randomUUID();
    const runId = randomUUID();
    const target = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
    };
    const controller = new AbortController();
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "initial-writer-test");
    const admissions = [admission];
    let prepared: Awaited<ReturnType<typeof prepareEmbeddedAttemptTranscriptLifecycle>> | undefined;
    try {
      const runParams: PreparedEmbeddedRunInput["runParams"] = {
        admittedRunContext: await admission.admit("embedded"),
        abortSignal: controller.signal,
        agentId: target.agentId,
        sessionId,
        sessionKey: target.sessionKey,
        sessionFile: target.sessionKey,
        sessionTarget: target,
        workspaceDir: state.workspaceDir,
        prompt: "hello",
        timeoutMs: 30_000,
        runId,
      };
      if (options.existing) {
        replaceSessionEntrySync(target, {
          sessionId,
          updatedAt: 1,
          lifecycleRevision: "existing-revision",
        });
        const claim = await claimAgentSessionWriter(runParams);
        expect(claim?.expectedWriterRunId).toBe(runId);
        runParams.sessionTarget = { ...target, ...claim };
      }
      const promptState = createEmbeddedRunSessionPromptState({
        runParams,
        sessionAgentId: target.agentId,
        resolvedSessionKey: target.sessionKey,
        lifecycleGeneration: getAgentRunLifecycleGeneration(),
      });
      const externalAbortController = {
        arm: vi.fn(),
        throwIfFiredAfterPrepCleanup: async () => controller.signal.throwIfAborted(),
      };
      await promptState.withSessionWriterContext(async () => {
        prepared = await prepareEmbeddedAttemptTranscriptLifecycle({
          attempt: runParams,
          externalAbortController,
        });
        const openManager = () =>
          SessionManager.open({ ...target, ...promptState.sessionWriterFence }, state.workspaceDir);
        await prepared.withOwnedTranscriptWrite(() =>
          run({
            admission,
            controller,
            manager: openManager(),
            openManager,
            promptState,
            replaceAdmission: async () => {
              const replacement = prepareSystemAgentRunAdmission(
                {},
                runId,
                "main",
                "replacement-test",
              );
              admissions.push(replacement);
              await replacement.admit("embedded");
            },
            runParams,
            target,
          }),
        );
      });
      expect(externalAbortController.arm).toHaveBeenCalledOnce();
    } finally {
      try {
        await prepared?.transcriptLifecycle.dispose();
      } finally {
        for (const owner of admissions) {
          owner.close();
        }
      }
    }
  });
}

describe("admitted lazy session writer", () => {
  it.each([false, true])(
    "prepares a fresh keyed turn before its first append (existing=%s)",
    async (existing) => {
      await withInitialWriter(
        async ({ manager, runParams, target }) => {
          const message = { ...userMessage, idempotencyKey: `${runParams.runId}:user` };
          const recorder = createUserTurnTranscriptRecorder({
            message,
            target: { ...target, sessionEntry: undefined },
          });
          expect(Boolean(loadSessionEntry(target))).toBe(existing);
          expect(
            preparePersistedCurrentUserTurn({
              sessionManager: manager,
              message,
              recorder,
              runId: runParams.runId,
            }),
          ).toBeUndefined();
          manager.appendMessage(message);
          expect(loadSessionEntry(target)).toMatchObject({
            sessionId: target.sessionId,
            activeWriterRunId: runParams.runId,
          });
          expect(
            SessionManager.open(target)
              .getBranch()
              .filter((entry) => entry.type === "message" && entry.message.role === "user"),
          ).toHaveLength(1);
        },
        { existing },
      );
    },
  );

  it.each([false, true])(
    "retains the exact committed writer for later mutations (existing=%s)",
    async (existing) => {
      await withInitialWriter(
        async ({ manager, promptState, runParams, target }) => {
          expect(Boolean(promptState.sessionWriterFence)).toBe(existing);
          manager.appendMessage(userMessage);
          const entry = loadSessionEntry({ ...target, readConsistency: "latest" });
          expect(entry).toMatchObject({
            sessionId: target.sessionId,
            activeWriterRunId: runParams.runId,
          });
          const expectedFence = {
            expectedLifecycleRevision: existing ? "existing-revision" : undefined,
            expectedWriterRunId: runParams.runId,
          };
          expect(promptState.sessionWriterFence).toEqual(expectedFence);
          expect(manager.getSessionTarget()).toMatchObject(expectedFence);
          manager.appendMessage(userMessage);
          expect(loadTranscriptEventsSync(target)).toHaveLength(3);
          await claimAgentSessionWriter({ ...runParams, runId: "new-writer" });
          const before = loadTranscriptEventsSync(target);
          expect(() =>
            runWithoutOwnedSessionTranscriptWrites(() => manager.appendMessage(userMessage)),
          ).toThrow(SessionTranscriptWriterClaimReboundError);
          expect(loadTranscriptEventsSync(target)).toEqual(before);
          expect(loadSessionEntry(target)).toMatchObject({ activeWriterRunId: "new-writer" });
        },
        { existing },
      );
    },
  );

  it.each(["abort", "closed", "replaced"] as const)(
    "does not create a row when the original owner is %s",
    async (loss) => {
      await withInitialWriter(
        async ({ admission, controller, manager, promptState, replaceAdmission, target }) => {
          const callerError = new Error("caller cancelled before initial persistence");
          if (loss === "abort") {
            controller.abort(callerError);
          }
          if (loss === "closed") {
            admission.close();
          }
          if (loss === "replaced") {
            await replaceAdmission();
          }
          if (loss === "abort") {
            expect(() => manager.appendMessage(userMessage)).toThrow(callerError);
          } else {
            expect(() => manager.appendMessage(userMessage)).toThrow(
              "admitted run authority is no longer active",
            );
          }
          expect(promptState.sessionWriterFence).toBeUndefined();
          expect(loadSessionEntry(target)).toBeUndefined();
          expect(loadTranscriptEventsSync(target)).toEqual([]);
        },
      );
    },
  );

  it.each(["same-session", "copied-writer", "other-session"] as const)(
    "rejects a competing first row without adopting its %s identity",
    async (kind) => {
      await withInitialWriter(async ({ manager, promptState, runParams, target }) => {
        const competing: InternalSessionEntry = {
          sessionId: kind === "other-session" ? "competing-session" : target.sessionId,
          updatedAt: 7,
          ...(kind === "copied-writer" ? { activeWriterRunId: runParams.runId } : {}),
        };
        runWithoutOwnedSessionTranscriptWrites(() => replaceSessionEntrySync(target, competing));
        const before = loadSessionEntry(target);
        expect(() => manager.appendMessage(userMessage)).toThrow(
          SessionTranscriptWriterClaimReboundError,
        );
        expect(promptState.sessionWriterFence).toBeUndefined();
        expect(loadSessionEntry(target)).toEqual(before);
        expect(loadTranscriptEventsSync(target)).toEqual([]);
      });
    },
  );

  it("publishes no initial claim or identity for a rolled-back outer transaction", async () => {
    await withInitialWriter(async ({ manager, openManager, promptState, runParams, target }) => {
      const rollback = new Error("roll back first persistence");
      const identities: unknown[] = [];
      const unsubscribe = onSessionIdentityMutation((event) => {
        if (event.kind === "create" && event.current.sessionId === target.sessionId) {
          identities.push(event);
        }
      });
      try {
        expect(() =>
          runOpenClawAgentWriteTransaction(
            () => {
              manager.appendMessage(userMessage);
              expect(promptState.sessionWriterFence).toBeUndefined();
              throw rollback;
            },
            { agentId: target.agentId, path: target.storePath },
          ),
        ).toThrow(rollback);
        expect(promptState.sessionWriterFence).toBeUndefined();
        expect(loadSessionEntry(target)).toBeUndefined();
        expect(loadTranscriptEventsSync(target)).toEqual([]);
        expect(identities).toEqual([]);

        openManager().appendMessage(userMessage);
        expect(promptState.sessionWriterFence?.expectedWriterRunId).toBe(runParams.runId);
        expect(loadSessionEntry(target)).toMatchObject({ activeWriterRunId: runParams.runId });
        expect(identities).toHaveLength(1);
      } finally {
        unsubscribe();
      }
    });
  });

  it("captures the committed claim before identity-observer cancellation stops the first transcript append", async () => {
    await withInitialWriter(async ({ controller, manager, promptState, runParams, target }) => {
      const callerError = new Error("caller cancelled from committed identity observer");
      let observedFence: typeof promptState.sessionWriterFence;
      const unsubscribe = onSessionIdentityMutation((event) => {
        if (event.kind !== "create" || event.current.sessionId !== target.sessionId) {
          return;
        }
        observedFence = promptState.sessionWriterFence;
        controller.abort(callerError);
      });
      try {
        expect(() => manager.appendMessage(userMessage)).toThrow(callerError);
        expect(observedFence).toEqual({
          expectedLifecycleRevision: undefined,
          expectedWriterRunId: runParams.runId,
        });
        expect(promptState.sessionWriterFence).toEqual(observedFence);
        expect(loadSessionEntry(target)).toMatchObject({
          sessionId: target.sessionId,
          activeWriterRunId: runParams.runId,
        });
        expect(loadTranscriptEventsSync(target)).toEqual([]);
      } finally {
        unsubscribe();
      }
    });
  });

  it("does not let a retained manager write after its initial admission closes", async () => {
    await withInitialWriter(async ({ admission, manager, target }) => {
      manager.appendMessage(userMessage);
      const before = loadTranscriptEventsSync(target);
      admission.close();
      expect(() =>
        runWithoutOwnedSessionTranscriptWrites(() => manager.appendMessage(userMessage)),
      ).toThrow("admitted run authority is no longer active");
      expect(loadTranscriptEventsSync(target)).toEqual(before);
    });
  });
});
