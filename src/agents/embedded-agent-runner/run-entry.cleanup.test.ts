import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerContextEngineForOwner } from "../../context-engine/registry.js";
import { captureContextEngineRegistryStateForTests } from "../../context-engine/registry.test-support.js";
import { createAgentCleanupScope } from "../run-cleanup-timeout.js";
import { runEmbeddedAgentEntry } from "./run-entry.js";

const cleanupCases = (["command-rpc", "channel-delivery"] as const).flatMap((kind) =>
  (["success", "failure", "late-success", "late-failure"] as const).map((settlement) => ({
    kind,
    settlement,
  })),
);

it.each(cleanupCases)(
  "settles $kind replies and cleanup ownership for $settlement",
  async ({ kind, settlement }) => {
    const restoreRegistry = captureContextEngineRegistryStateForTests();
    const disposal = createDeferred();
    const disposalStarted = createDeferred();
    const dispose = vi.fn(async () => {
      disposalStarted.resolve();
      await disposal.promise;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS", "25");
    registerContextEngineForOwner(
      "cleanup-probe",
      () => ({
        info: { id: "cleanup-probe", name: "Cleanup probe" },
        ingest: async () => ({ ingested: false }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false }),
        dispose,
      }),
      "test:cleanup-probe",
    );
    const cleanupScope = createAgentCleanupScope();
    let returned = false;
    const entry = cleanupScope
      .run(() =>
        runEmbeddedAgentEntry({
          selection: {
            cfg: { plugins: { slots: { contextEngine: "cleanup-probe" } } },
            provider: "synthetic",
            model: "synthetic-model",
            fallbacksOverride: [],
          },
          identity: { runId: "cleanup-run", agentId: "main", sessionId: "cleanup-session" },
          harness: {
            workspaceDir: process.cwd(),
            preparation: { kind: "direct" },
            resolveRuntimeOverride: () => "openclaw",
          },
          behavior:
            kind === "command-rpc"
              ? { kind, hasCommittedSideEffect: () => false }
              : {
                  kind,
                  readDeliveryEvidence: () => ({
                    hasDirectlySentBlockReply: false,
                    hasBlockReplyPipelineOutput: false,
                  }),
                },
          sessionOverride: { kind: "preserve" },
          runCandidate: async (provider, model) => ({
            payloads: [{ text: "Completed answer" }],
            meta: {
              durationMs: 1,
              aborted: false,
              providerStarted: true,
              stopReason: "completed",
              agentMeta: { sessionId: "cleanup-session", provider, model },
            },
          }),
        }),
      )
      .then((result) => {
        returned = true;
        return result;
      });
    try {
      await disposalStarted.promise;
      if (settlement === "success") {
        disposal.resolve();
      } else if (settlement === "failure") {
        disposal.reject(new Error("Context engine disposal failed"));
      }
      await vi.advanceTimersByTimeAsync(25);
      expect(returned).toBe(true);
      expect((await entry).result.payloads).toEqual([{ text: "Completed answer" }]);
      expect(dispose).toHaveBeenCalledOnce();
      expect(cleanupScope.outcome).toBe(settlement === "success" ? "closed" : "uncertain");
      if (settlement.startsWith("late-")) {
        expect(warn).toHaveBeenCalledWith(
          "agent cleanup timed out: runId=cleanup-run sessionId=cleanup-session step=context-engine-dispose timeoutMs=25",
        );
        if (settlement === "late-failure") {
          disposal.reject(new Error("Context engine disposal failed after timeout"));
        } else {
          disposal.resolve();
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(cleanupScope.outcome).toBe("uncertain");
      }
    } finally {
      disposal.resolve();
      await entry.catch(() => {});
      vi.useRealTimers();
      vi.unstubAllEnvs();
      warn.mockRestore();
      restoreRegistry();
    }
  },
);
