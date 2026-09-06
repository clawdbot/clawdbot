import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FailoverReason } from "../failover/signal.js";
import type { ContextEngineTurnAttemptFacts } from "../harness/context-engine-turn-attempt.js";
import type { ModelFallbackRunOptions } from "../model-fallback-attempt.js";
import type { runWithModelFallback } from "../model-fallback-runner.js";
import {
  buildTurnSendLedgerSessionKey,
  commitTurnSend,
  peekTurnSendCount,
  reserveTurnSend,
  resetTurnSendLedgerForTest,
} from "../tools/turn-send-ledger.js";
import type { EmbeddedAgentRunResult } from "./types.js";

type FallbackRunnerParams = Parameters<typeof runWithModelFallback<EmbeddedAgentRunResult>>[0];

function initialAttemptOptions(params: FallbackRunnerParams): ModelFallbackRunOptions {
  return {
    modelRoutingProvenance: {
      requestedProvider: params.provider,
      requestedModel: params.model,
      stage: "initial",
    },
  };
}

function fallbackAttemptOptions(
  params: FallbackRunnerParams,
  fallbackReason: FailoverReason,
): ModelFallbackRunOptions {
  return {
    modelRoutingProvenance: {
      requestedProvider: params.provider,
      requestedModel: params.model,
      stage: "fallback",
      fallbackReason,
    },
  };
}

const state = vi.hoisted(() => ({
  runWithModelFallback: vi.fn(),
  ensureSelectedAgentHarnessPlugin: vi.fn(async (_params: unknown) => undefined),
  selectAgentHarness: vi.fn(({ provider }: { provider: string }) => ({
    id: provider === "fallback-provider" ? "fallback-harness" : "primary-harness",
    contextEngineHostCapabilities: [],
  })),
  discardedAttempts: [] as string[],
  finalizedAttempts: [] as string[],
}));

vi.mock("../harness/context-engine-turn-attempt.js", () => ({
  discardContextEngineTurnAttemptIntent: vi.fn(
    ({ facts }: { facts: ContextEngineTurnAttemptFacts }) => {
      state.discardedAttempts.push(facts.sessionIdUsed);
    },
  ),
  finalizeAcceptedContextEngineTurn: vi.fn(async ({ facts }) => {
    state.finalizedAttempts.push(facts.sessionIdUsed);
  }),
}));

vi.mock("../model-fallback-runner.js", () => ({
  runWithModelFallback: (params: FallbackRunnerParams) => state.runWithModelFallback(params),
}));

vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: (params: unknown) =>
    state.ensureSelectedAgentHarnessPlugin(params),
}));

vi.mock("../harness/selection.js", () => ({
  selectAgentHarness: (params: { provider: string }) => state.selectAgentHarness(params),
}));

function makeResult(params: {
  provider: string;
  model: string;
  classification?: "empty";
  meta?: Partial<EmbeddedAgentRunResult["meta"]>;
}): EmbeddedAgentRunResult {
  return {
    payloads: params.classification ? [] : [{ text: "recovered" }],
    meta: {
      durationMs: 10,
      aborted: false,
      providerStarted: true,
      stopReason: "completed",
      agentHarnessResultClassification: params.classification,
      agentMeta: {
        sessionId: "session-1",
        provider: params.provider,
        model: params.model,
      },
      ...params.meta,
    },
  };
}

describe("runEmbeddedAgentEntry", () => {
  beforeEach(() => {
    state.discardedAttempts.length = 0;
    state.finalizedAttempts.length = 0;
    state.ensureSelectedAgentHarnessPlugin.mockReset().mockResolvedValue(undefined);
    state.selectAgentHarness
      .mockReset()
      .mockImplementation(({ provider }: { provider: string }) => ({
        id: provider === "fallback-provider" ? "fallback-harness" : "primary-harness",
        contextEngineHostCapabilities: [],
      }));
    state.runWithModelFallback
      .mockReset()
      .mockImplementation(async (params: FallbackRunnerParams) => {
        await params.prepareCandidateChain?.([
          {
            provider: params.provider,
            model: params.model,
            routeOrigin: "requested",
            routeResolution: "raw",
          },
          {
            provider: "fallback-provider",
            model: "fallback-model",
            routeOrigin: "configured-fallback",
            routeResolution: "raw",
          },
        ]);
        await params.prepareAgentHarnessRuntime?.({
          provider: params.provider,
          model: params.model,
          agentHarnessRuntimeOverride: params.resolveAgentHarnessRuntimeOverride?.(
            params.provider,
            params.model,
          ),
        });
        const primaryResult = await params.run(params.provider, params.model, {
          ...initialAttemptOptions(params),
          allowTransientCooldownProbe: true,
        });
        const classification = await params.classifyResult?.({
          result: primaryResult,
          provider: params.provider,
          model: params.model,
          attempt: 1,
          total: 2,
        });
        expect(classification).toBeTruthy();
        const fallbackProvider = "fallback-provider";
        const fallbackModel = "fallback-model";
        await params.prepareAgentHarnessRuntime?.({
          provider: fallbackProvider,
          model: fallbackModel,
          agentHarnessRuntimeOverride: params.resolveAgentHarnessRuntimeOverride?.(
            fallbackProvider,
            fallbackModel,
          ),
        });
        const result = await params.run(fallbackProvider, fallbackModel, {
          ...fallbackAttemptOptions(params, "format"),
          isFinalFallbackAttempt: true,
        });
        return {
          outcome: "completed" as const,
          result,
          provider: fallbackProvider,
          model: fallbackModel,
          attempts: [
            {
              provider: params.provider,
              model: params.model,
              error: "empty result",
              reason: "format" as const,
            },
          ],
        };
      });
  });

  describe("per-turn send ledger terminal cleanup", () => {
    // The tools key the ledger by agentSessionKey = sessionKey?.trim() || sessionId
    // (attempt-setup.ts); these runs carry no sessionKey, so the slot is scoped by the
    // sessionId. run-entry's finally must reconstruct that exact slot to clear it.
    const ledgerSessionKey = buildTurnSendLedgerSessionKey("main", "session-1")!;
    const targetKey = "imessage\0default\0+15550001111";

    beforeEach(() => {
      resetTurnSendLedgerForTest();
    });

    // A landed send committed by the message/conversations_send tool during a candidate,
    // keyed exactly as those tools key it for this run.
    function commitLedgerSend(runId: string): number {
      const key = { sessionKey: ledgerSessionKey, runId, targetKey };
      const reserved = reserveTurnSend(key, {});
      if (reserved.status !== "reserved") {
        throw new Error(`expected a reserved send, got "${reserved.status}"`);
      }
      return commitTurnSend(reserved.reservation);
    }

    it("clears the slot only after the full fallback chain, never between candidates", async () => {
      const { runEmbeddedAgentEntry } = await import("./run-entry.js");
      const runId = "ledger-cleanup-success";
      const key = { sessionKey: ledgerSessionKey, runId, targetKey };
      const committedCounts: number[] = [];
      let countSeenByFallbackCandidate: number | undefined;

      // The default runWithModelFallback mock drives two candidates (primary "empty" ->
      // provider fallback) that reuse this runId — a single logical turn.
      await runEmbeddedAgentEntry({
        selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
        identity: { runId, agentId: "main", sessionId: "session-1" },
        harness: {
          workspaceDir: "/tmp/workspace",
          preparation: { kind: "direct" },
          resolveRuntimeOverride: () => undefined,
        },
        behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
        sessionOverride: { kind: "preserve" },
        runCandidate: async (provider, model, options) => {
          if (options.isFinalFallbackAttempt) {
            // The primary candidate's committed send must still be here: the per-candidate
            // run-loop.ts finally must NOT clear the budget between fallback attempts.
            countSeenByFallbackCandidate = peekTurnSendCount(key);
          }
          committedCounts.push(commitLedgerSend(runId));
          return makeResult({
            provider,
            model,
            classification: options.isFinalFallbackAttempt ? undefined : "empty",
          });
        },
      });

      // Budget accumulated across the two candidates (same runId) — proof it survived the
      // fallback boundary rather than resetting between candidates.
      expect(committedCounts).toEqual([1, 2]);
      expect(countSeenByFallbackCandidate).toBe(1);
      // The outer fallback-chain finally cleared the slot after the complete chain.
      expect(peekTurnSendCount(key)).toBe(0);
    });

    it("clears the slot on a terminal failure that throws out of the fallback chain", async () => {
      const failure = new Error("fallback chain exhausted with a throw");
      const runId = "ledger-cleanup-throw";
      const key = { sessionKey: ledgerSessionKey, runId, targetKey };
      state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
        await params.run(params.provider, params.model, initialAttemptOptions(params));
        // The committed send is live when the run terminates by throwing.
        expect(peekTurnSendCount(key)).toBe(1);
        throw failure;
      });
      const { runEmbeddedAgentEntry } = await import("./run-entry.js");

      await expect(
        runEmbeddedAgentEntry({
          selection: { cfg: {}, provider: "provider", model: "model" },
          identity: { runId, agentId: "main", sessionId: "session-1" },
          harness: {
            workspaceDir: "/tmp/workspace",
            preparation: { kind: "direct" },
            resolveRuntimeOverride: () => undefined,
          },
          behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
          sessionOverride: { kind: "preserve" },
          runCandidate: async (provider, model) => {
            commitLedgerSend(runId);
            return makeResult({ provider, model });
          },
        }),
      ).rejects.toBe(failure);

      // The finally runs on the throw path too, so the run's slot is still cleared.
      expect(peekTurnSendCount(key)).toBe(0);
    });
  });
});
