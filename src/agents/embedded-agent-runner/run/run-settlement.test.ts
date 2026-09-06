import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import type {
  CompactionAccountingFact,
  RunEmbeddedAgentParamsWithSessionFile,
} from "./internal-params.js";

async function createSettlementFixture(state: OpenClawTestState) {
  const { loadSessionEntry, replaceSessionEntry } =
    await import("../../../config/sessions/session-accessor.js");
  const {
    getAdmittedRunDelegatedAuthority,
    prepareSystemAgentRunAdmission,
    resolveAdmittedRunActiveAssertion,
  } = await import("../../admitted-run-context.js");
  const { onSessionIdentityMutation } =
    await import("../../../sessions/session-lifecycle-events.js");
  const { acceptCompactionSuccessor } = await import("../compaction-successor.js");
  const { createEmbeddedRunProgressController } = await import("./progress-controller.js");
  const { claimAgentSessionWriter } = await import("./session-bootstrap.js");
  const { createEmbeddedRunSessionPromptState } = await import("./session-prompt-state.js");
  const { settleEmbeddedRun } = await import("./run-settlement.js");
  const target = {
    agentId: "main",
    sessionId: randomUUID(),
    sessionKey: `agent:main:${randomUUID()}`,
    storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
  };
  await replaceSessionEntry(target, {
    sessionId: target.sessionId,
    lifecycleRevision: randomUUID(),
    updatedAt: 1,
  });
  const runId = randomUUID();
  const admission = prepareSystemAgentRunAdmission({}, runId, target.agentId, "settlement-test");
  const controller = new AbortController();
  const unsubscriptions: Array<() => void> = [];
  const close = () => {
    for (const unsubscribe of unsubscriptions) {
      unsubscribe();
    }
    admission.close();
  };
  try {
    const admittedRunContext = await admission.admit("embedded");
    const authority = getAdmittedRunDelegatedAuthority(admittedRunContext);
    const assertAdmittedActive = resolveAdmittedRunActiveAssertion(admittedRunContext);
    if (!authority || !assertAdmittedActive) {
      throw new Error("settlement fixture requires a live admission");
    }
    const facts: Array<CompactionAccountingFact | undefined> = [];
    const runParams: RunEmbeddedAgentParamsWithSessionFile = {
      ...target,
      sessionFile: target.sessionKey,
      sessionTarget: target,
      runId,
      admittedRunContext,
      abortSignal: controller.signal,
      workspaceDir: state.workspaceDir,
      prompt: "continue",
      timeoutMs: 30_000,
      onCompactionAccounting: (fact) => {
        facts.push(fact);
      },
    };
    const writer = await claimAgentSessionWriter(runParams);
    if (!writer) {
      throw new Error("settlement fixture requires a claimed session writer");
    }
    runParams.sessionTarget = { ...target, ...writer };
    const session = createEmbeddedRunSessionPromptState({
      runParams,
      sessionAgentId: target.agentId,
      resolvedSessionKey: target.sessionKey,
      lifecycleGeneration: authority.lifecycleGeneration,
    });
    const input: Parameters<typeof settleEmbeddedRun>[0] = {
      runInput: {
        runParams,
        progressController: createEmbeddedRunProgressController({
          attempt: runParams,
          noteLaneTaskProgress: () => {},
          startedAtMs: Date.now(),
        }),
      },
      runtime: {
        runAdmission: { preparedRunAdmission: undefined, admittedRunContext },
        stopRuntimeAuthRefreshTimer: () => {},
      },
      compaction: {
        state: { autoCompactionCount: 1, currentContextSnapshot: { tokens: 3_000 } },
        session,
        originalTarget: target,
        durable: true,
        authority,
      },
    };
    return {
      input,
      target,
      session,
      facts,
      writer,
      signal: controller.signal,
      close,
      stop: () => {
        admission.close();
        controller.abort(new Error("caller stopped after successor commit"));
      },
      loadEntry: () => loadSessionEntry(target),
      observeIdentity: (observer: () => void) => {
        unsubscriptions.push(
          onSessionIdentityMutation((mutation) => {
            if (mutation.kind === "replace" && mutation.previous.sessionId === target.sessionId) {
              observer();
            }
          }),
        );
      },
      accept: async (sessionId: string) => {
        const entry = loadSessionEntry(target);
        if (!entry) {
          throw new Error("settlement fixture lost its session row");
        }
        const accepted = await acceptCompactionSuccessor({
          currentTarget: { ...target, sessionId: session.sessionId },
          currentSessionFile: session.sessionFile,
          expectedEntry: {
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            activeWriterRunId: entry.activeWriterRunId,
          },
          assertActive: () => {
            controller.signal.throwIfAborted();
            assertAdmittedActive();
          },
          result: {
            ok: true,
            compacted: true,
            result: {
              summary: "Compacted context",
              tokensBefore: 4_097,
              sessionTarget: { sessionId },
            },
          },
          onCommitted: session.recordCommittedCompactionSuccessor,
        });
        // Unchanged acceptance has no commit callback; the runtime retains its validated row.
        if (!accepted.previousSessionId) {
          session.recordCommittedCompactionSuccessor(accepted);
        }
        return accepted;
      },
      settle: () => settleEmbeddedRun(input),
    };
  } catch (error) {
    close();
    throw error;
  }
}

async function withSettlementFixture(
  body: (fixture: Awaited<ReturnType<typeof createSettlementFixture>>) => Promise<void>,
) {
  await withOpenClawTestState({ label: "run-settlement", scenario: "minimal" }, async (state) => {
    const fixture = await createSettlementFixture(state);
    try {
      await body(fixture);
    } finally {
      fixture.close();
    }
  });
}

describe("settleEmbeddedRun compaction identity", () => {
  it.each(["identity publication", "runtime cleanup"] as const)(
    "publishes the actual committed rotation before cleanup when %s aborts the caller",
    async (abortAt) => {
      await withSettlementFixture(async (fixture) => {
        if (abortAt === "identity publication") {
          fixture.observeIdentity(fixture.stop);
        }
        const accepted = await fixture.accept(randomUUID());
        const cleanupFacts: Array<CompactionAccountingFact | undefined> = [];
        fixture.input.runtime.stopRuntimeAuthRefreshTimer = () => {
          cleanupFacts.push(fixture.facts[0]);
          if (abortAt === "runtime cleanup") {
            fixture.stop();
          }
        };
        fixture.input.ownedContextEngineLease = {
          dispose: async () => {
            cleanupFacts.push(fixture.facts[0]);
          },
        };
        await fixture.settle();
        const expected: CompactionAccountingFact = {
          kind: "durable",
          count: 1,
          currentContextSnapshot: { tokens: 3_000 },
          previousSessionId: fixture.target.sessionId,
          target: {
            ...fixture.target,
            sessionId: accepted.entry.sessionId,
            lifecycleRevision: accepted.entry.lifecycleRevision,
            activeWriterRunId: accepted.entry.activeWriterRunId,
          },
        };
        expect(fixture.facts).toEqual([expected]);
        expect(cleanupFacts).toEqual([expected, expected]);
        expect(fixture.signal.aborted).toBe(true);
        expect(fixture.loadEntry()).toEqual(accepted.entry);
      });
    },
  );

  it("carries original writer custody without inventing a rotation or context observation", async () => {
    await withSettlementFixture(async (fixture) => {
      fixture.input.compaction.state = {
        autoCompactionCount: 0,
        currentContextSnapshot: undefined,
      };
      await fixture.settle();
      expect(fixture.facts).toEqual([
        {
          kind: "durable",
          count: 0,
          currentContextSnapshot: undefined,
          target: {
            ...fixture.target,
            lifecycleRevision: fixture.writer.expectedLifecycleRevision,
            activeWriterRunId: fixture.writer.expectedWriterRunId,
          },
        },
      ]);
    });
  });

  it("keeps a presentation-only successor separate from a committed rotation", async () => {
    await withSettlementFixture(async (fixture) => {
      const sessionId = randomUUID();
      fixture.input.compaction.durable = false;
      fixture.session.capturePreparedCompactionTarget({
        sessionId,
        sessionFile: fixture.target.sessionKey,
        sessionTarget: { ...fixture.target, sessionId },
      });
      await fixture.settle();
      expect(fixture.facts).toEqual([
        { kind: "presentation-only", count: 1, currentContextSnapshot: { tokens: 3_000 } },
      ]);
      expect(fixture.loadEntry()?.sessionId).toBe(fixture.target.sessionId);
    });
  });

  it("does not mark same-session compaction as a rotation", async () => {
    await withSettlementFixture(async (fixture) => {
      const before = fixture.loadEntry();
      const accepted = await fixture.accept(fixture.target.sessionId);
      expect(accepted.previousSessionId).toBeUndefined();
      await fixture.settle();
      expect(fixture.facts).toEqual([
        {
          kind: "durable",
          count: 1,
          currentContextSnapshot: { tokens: 3_000 },
          target: {
            ...fixture.target,
            lifecycleRevision: fixture.writer.expectedLifecycleRevision,
            activeWriterRunId: fixture.writer.expectedWriterRunId,
          },
        },
      ]);
      expect(fixture.loadEntry()).toEqual(before);
    });
  });
});
