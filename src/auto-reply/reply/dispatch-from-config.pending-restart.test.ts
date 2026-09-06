import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  listSessionPendingInputs,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { claimSessionPendingInputDedupeRecovery } from "../../config/sessions/session-accessor.pending-inputs.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createDedupeCache } from "../../infra/dedupe.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import { claimInboundDedupe, commitInboundDedupe, resetInboundDedupe } from "./inbound-dedupe.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

it("dispatches freshly reclaimed pending input despite its pre-restart inbound dedupe receipt", async () => {
  await withOpenClawTestState({ label: "pending-input-in-process-restart" }, async (state) => {
    const cfg = {
      agents: {
        ownership: "explicit" as const,
        entries: { main: {} },
        defaults: { workspace: state.workspaceDir },
      },
      plugins: { enabled: false },
    };
    await state.writeConfig(cfg);
    const sessionKey = "agent:main:pending-restart";
    const sessionId = "pending-restart-session";
    const runId = "pending-restart-input";
    const target = { agentId: "main", sessionKey, sessionId, config: cfg };
    const sessionEntry = { sessionId, updatedAt: Date.now() };
    await replaceSessionEntry(target, sessionEntry);
    const message = "Deliver this exact source after the update";
    const createRecorder = () =>
      createUserTurnTranscriptRecorder({
        target: { ...target, sessionEntry },
        pendingInputRequestFingerprint: "pending-restart-request",
        input: { text: message, timestamp: 100, idempotencyKey: `${runId}:user` },
      });
    const source = createRecorder();
    const ctx = buildTestCtx({
      AgentId: "main",
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "webchat",
      OriginatingTo: sessionKey,
      From: "gateway-owner",
      To: sessionKey,
      SessionKey: sessionKey,
      MessageSid: runId,
      Body: message,
      BodyForAgent: message,
      CommandBody: message,
      CommandSource: undefined,
      CommandAuthorized: true,
    });
    resetInboundDedupe();
    const dispatcher = createReplyDispatcher({ deliver: async () => {} });
    let resumed: ReturnType<typeof createRecorder> | undefined;
    try {
      expect(await source.stageApproved?.({ runId, assertCurrent: () => {} })).toBe(true);
      const original = listSessionPendingInputs(target).items[0];
      expect(original).toBeDefined();
      // Finishing the original queue-admission request commits inbound dedupe,
      // although its source remains pending for the still-starting native run.
      const claim = claimInboundDedupe(ctx);
      if (claim.status !== "claimed") {
        throw new Error("Original input did not acquire inbound dedupe");
      }
      commitInboundDedupe(claim.key);
      source.finishPendingInput?.("interrupted");
      rotateAgentEventLifecycleGeneration();
      resumed = createRecorder();
      expect(await resumed.stageApproved?.({ runId, assertCurrent: () => {} })).toBe(true);
      expect(listSessionPendingInputs(target).items).toEqual([{ ...original, state: "queued" }]);
      expect(claimInboundDedupe(ctx).status).toBe("duplicate");

      const recorder = resumed;
      const replyResolver = vi.fn(async () => {
        expect(claimInboundDedupe(ctx).status).toBe("inflight");
        await recorder.persistApproved();
        return { text: "Input delivered" };
      });
      await recorder.withPendingInput?.(() =>
        dispatchReplyFromConfig({
          ctx,
          cfg,
          dispatcher,
          replyOptions: { userTurnTranscriptRecorder: recorder },
          replyResolver,
        }),
      );

      expect(replyResolver).toHaveBeenCalledOnce();
      expect(listSessionPendingInputs(target).items).toEqual([]);
      const transcript = await loadTranscriptEvents(target);
      const userMessages = transcript.filter((event) => {
        const record = asOptionalRecord(event);
        return record?.type === "message" && asOptionalRecord(record.message)?.role === "user";
      });
      expect(userMessages).toEqual([
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ content: message, idempotencyKey: `${runId}:user` }),
        }),
      ]);
    } finally {
      resumed?.finishPendingInput?.("interrupted");
      source.finishPendingInput?.("interrupted");
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      resetInboundDedupe();
    }
  });
});

it.each(["initial", "inflight", "cache-miss", "consumed", "session", "input", "revoked"] as const)(
  "keeps completed inbound receipts bound to one exact recovered source (%s)",
  async (control) => {
    await withOpenClawTestState({ label: "pending-input-dedupe-controls" }, async () => {
      const target = {
        agentId: "main",
        sessionKey: "agent:main:dedupe",
        sessionId: "dedupe-session",
      };
      const runId = "dedupe-source";
      const sessionEntry = { sessionId: target.sessionId, updatedAt: Date.now() };
      await replaceSessionEntry(target, sessionEntry);
      let current = true;
      const createRecorder = () =>
        createUserTurnTranscriptRecorder({
          target: { ...target, sessionEntry },
          pendingInputRequestFingerprint: "dedupe-source-request",
          input: { text: "Keep this exact input", idempotencyKey: `${runId}:user` },
        });
      const assertCurrent = () => {
        if (!current) {
          throw new Error("source revoked");
        }
      };
      const original = createRecorder();
      let recorder = original;
      const ctx = buildTestCtx({
        Provider: "webchat",
        SessionKey: target.sessionKey,
        MessageSid: runId,
      });
      const cache = createDedupeCache({ ttlMs: 20 * 60_000, maxSize: 10 });
      const inFlight = new Set<string>();
      const options = { cache, inFlight };
      try {
        expect(await original.stageApproved?.({ runId, assertCurrent })).toBe(true);
        const first = claimInboundDedupe(ctx, options);
        if (first.status !== "claimed") {
          throw new Error("Original input did not acquire inbound dedupe");
        }
        commitInboundDedupe(first.key, options);
        if (control !== "initial") {
          original.finishPendingInput?.("interrupted");
          rotateAgentEventLifecycleGeneration();
          recorder = createRecorder();
          expect(await recorder.stageApproved?.({ runId, assertCurrent })).toBe(true);
        }
        const claim = (scope = target, sourceRunId = runId) =>
          claimInboundDedupe(ctx, {
            ...options,
            reclaimPendingInput: () => claimSessionPendingInputDedupeRecovery(scope, sourceRunId),
          });
        if (control === "consumed") {
          await recorder.withPendingInput?.(() => recorder.persistApproved());
        } else if (control === "cache-miss") {
          cache.clear();
        } else if (control === "inflight") {
          inFlight.add(first.key);
        }
        if (control === "revoked") {
          expect(() =>
            recorder.withPendingInput?.(() => {
              current = false;
              return claim();
            }),
          ).toThrow("source revoked");
          current = true;
        } else {
          const result = recorder.withPendingInput?.(() =>
            claim(
              control === "session" ? { ...target, sessionId: "replacement-session" } : target,
              control === "input" ? "another-source" : runId,
            ),
          );
          expect(result?.status).toBe(control === "cache-miss" ? "claimed" : "duplicate");
        }
        if (control === "initial" || control === "consumed") {
          expect(cache.peek(first.key)).toBe(true);
          expect(inFlight.size).toBe(0);
          return;
        }
        if (control === "inflight") {
          inFlight.delete(first.key);
        }
        if (control !== "cache-miss") {
          expect(recorder.withPendingInput?.(() => claim()).status).toBe("claimed");
        }
        commitInboundDedupe(first.key, options);
        expect(recorder.withPendingInput?.(() => claim()).status).toBe("duplicate");
        expect(inFlight.size).toBe(0);
      } finally {
        current = true;
        recorder.finishPendingInput?.("interrupted");
        original.finishPendingInput?.("interrupted");
      }
    });
  },
);
