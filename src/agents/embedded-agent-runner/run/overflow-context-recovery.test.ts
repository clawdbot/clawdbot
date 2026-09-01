import { describe, expect, it, vi } from "vitest";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../../context-engine/runtime-settings.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { getAgentRunLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAttemptResult } from "../run.overflow-compaction.fixture.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import { createEmbeddedRunCompactionRuntime } from "./compaction-runtime.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { recoverEmbeddedRunOverflow } from "./overflow-context-recovery.js";
import { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

describe("recoverEmbeddedRunOverflow transcript ownership", () => {
  it("rejects a changed active transcript without losing a known compaction", async () => {
    const promptError = new Error("Context window exceeded for this request");
    const state = createEmbeddedRunContextRecoveryState();
    const adoptCompactionTranscript = vi.fn(async () => undefined);
    const afterHook = vi.fn(async () => {});
    const prepareCurrentTranscriptRetry = vi.fn();
    const sessionManager = SessionManager.inMemory("/tmp/workspace");
    const sessionId = sessionManager.getSessionId();
    const target = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:session-1",
      storePath: "/tmp/unused-in-memory-recovery.sqlite",
    };
    const admission = prepareSystemAgentRunAdmission(
      {},
      "run-owner-change",
      "main",
      "recovery-owner-test",
    );
    try {
      const runParams = {
        admittedRunContext: await admission.admit("embedded"),
        runId: "run-owner-change",
        sessionId,
        sessionKey: target.sessionKey,
        sessionFile: target.sessionKey,
        sessionTarget: target,
        sessionManager,
        config: {},
        workspaceDir: "/tmp/workspace",
        prompt: "continue",
        timeoutMs: 1_000,
      };
      const sessionPromptState = createEmbeddedRunSessionPromptState({
        runParams,
        sessionAgentId: "main",
        resolvedSessionKey: target.sessionKey,
        lifecycleGeneration: getAgentRunLifecycleGeneration(),
      });
      const contextEngine: ContextEngine = {
        info: { id: "fixture", name: "Fixture engine" },
        ingest: async () => ({ ingested: true }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => {
          sessionPromptState.capturePreparedCompactionTarget({
            sessionId: "session-2",
            sessionFile: "agent:main:session-2",
            sessionTarget: { ...target, sessionId: "session-2" },
          });
          return {
            ok: true,
            compacted: true,
            result: { summary: "done", tokensBefore: 200_001, tokensAfter: 80_000 },
          };
        },
      };
      const runtime = createEmbeddedRunCompactionRuntime({
        runParams,
        contextEngine,
        hookRunner: null,
        hookContext: {
          agentId: "main",
          sessionId,
          sessionKey: target.sessionKey,
          workspaceDir: runParams.workspaceDir,
        },
        sessionPromptState,
      });

      await expect(
        recoverEmbeddedRunOverflow({
          ...runtime,
          runParams,
          state,
          usageAccumulator: createUsageAccumulator(),
          prepareRecoverySession: () => {
            throw new Error("unexpected transcript rewrite");
          },
          contextEngine,
          contextTokenBudget: 200_000,
          genericCompactionRecoveryAllowed: true,
          aborted: false,
          signalOwnedInterruption: false,
          promptError,
          attempt: makeAttemptResult({
            promptError,
            promptErrorSource: "precheck",
            replayMetadata: { replaySafe: false, hadPotentialSideEffects: true },
          }),
          toolResultPromptProjectionState: {
            replacements: new Map(),
            frozen: new Set(),
            ambiguousBaseKeys: new Set(),
            sourceTextByKey: new Map(),
          },
          attemptCompactionCount: 0,
          runtimeAuthPlan: undefined,
          resolvedSessionKey: target.sessionKey,
          sessionAgentId: "main",
          agentDir: "/tmp/agent",
          workspaceDir: "/tmp/workspace",
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
          runOwnsCompactionAfterHook: afterHook,
          adoptCompactionTranscript,
          getActiveSession: () => ({
            id: sessionPromptState.sessionId,
            file: sessionPromptState.sessionFile,
            target: sessionPromptState.sessionTarget,
          }),
          prepareCurrentTranscriptRetry,
          prepareCompactedTranscriptRetry: async () => {},
          markOwnedTranscriptRetry: vi.fn(),
          armPostCompactionGuard: vi.fn(),
        }),
      ).rejects.toThrow("active session changed after recovery transcript preparation");

      expect(state).toMatchObject({ autoCompactionCount: 1, lastCompactionTokensAfter: 80_000 });
      expect(adoptCompactionTranscript).not.toHaveBeenCalled();
      expect(afterHook).not.toHaveBeenCalled();
      expect(prepareCurrentTranscriptRetry).not.toHaveBeenCalled();
    } finally {
      admission.close();
    }
  });
});
