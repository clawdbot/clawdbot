import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createChannelIngressDrain } from "../../channels/message/ingress-drain.js";
import {
  createTestIngressQueue,
  withTempState,
} from "../../channels/message/ingress-drain.test-helpers.js";
import {
  awaitIngressProcessing,
  withIngressProcessingPhase,
  withIngressProcessingScope,
} from "../../channels/message/ingress-processing-handoff.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { UserTurnInput } from "../../sessions/user-turn-transcript.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

describe("durable admission after an ingress processing timeout", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(["input", "write"] as const)("rejects late %s without changing state", async (hold) => {
    vi.useFakeTimers();
    await withTempState(async (stateDir) => {
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const resolvingHeldInput = createDeferred();
      const releaseHeldInput = createDeferred();
      const siblingCompleted = createDeferred();
      let heldWriter: Promise<void> | undefined;

      const createAdmission = async (
        sourceId: string,
        resolveInput: () => Promise<UserTurnInput>,
      ) => {
        const sessionId = `${sourceId}-session`;
        const sessionKey = `agent:main:telegram:direct:${sourceId}`;
        let entry: InternalSessionEntry = { sessionId, status: "done", updatedAt: 17 };
        const target = { agentId: "main", sessionId, sessionKey, storePath, sessionEntry: entry };
        await replaceSessionEntry(target, entry);
        const recorder = createUserTurnTranscriptRecorder({
          resolveInput,
          target,
          updateMode: "none",
        });
        const controller = createReplyRestartRecoveryClaimController({
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          getEntry: () => entry,
          getSessionId: () => sessionId,
          isRestartAbort: () => false,
          resolveDeliveryContext: () => ({ channel: "telegram", to: sourceId, accountId: "test" }),
          resolveUserTurnTarget: ({ entry: current }) => ({ ...target, sessionEntry: current }),
          sessionKey,
          setEntry: (next) => {
            entry = next;
          },
          sourceTurnId: sourceId,
          storePath,
        });
        return { target, recorder, controller };
      };

      const held = await createAdmission("held-source", async () => {
        if (hold === "input") {
          resolvingHeldInput.resolve();
          await releaseHeldInput.promise;
        } else {
          await siblingCompleted.promise;
          heldWriter = runExclusiveSqliteSessionWrite(resolveSqliteScope(held.target), async () => {
            resolvingHeldInput.resolve();
            await releaseHeldInput.promise;
          });
        }
        return { text: "late input", idempotencyKey: "held-source", timestamp: 19 };
      });
      const sibling = await createAdmission("sibling-source", async () => ({
        text: "healthy input",
        idempotencyKey: "sibling-source",
        timestamp: 23,
      }));
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("held-source", { text: "late input" }, { laneKey: "held-source" });
      await queue.enqueue(
        "sibling-source",
        { text: "healthy input" },
        { laneKey: "sibling-source" },
      );
      let heldAdmission: ReturnType<typeof held.controller.admitUserTurn> | undefined;
      const drain = createChannelIngressDrain({
        queue,
        adoptionStallTimeoutMs: 100,
        dispatchClaimedEvent: (event, lifecycle) =>
          withIngressProcessingScope(lifecycle.abortSignal, async () => {
            await withIngressProcessingPhase(
              { kind: "compaction", timeoutMs: 500, abortSignal: lifecycle.abortSignal },
              async () => {},
            );
            const source = event.id === "held-source" ? held : sibling;
            await awaitIngressProcessing(() => {
              const admission = source.controller.admitUserTurn(source.recorder);
              if (event.id === "held-source") {
                heldAdmission = admission;
              }
              return admission;
            });
            await lifecycle.onAdopted();
            if (event.id === "sibling-source") {
              siblingCompleted.resolve();
            }
          }),
      });

      try {
        await drain.drainOnce();
        await resolvingHeldInput.promise;
        await siblingCompleted.promise;
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(501);
        await drain.waitForIdle();

        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending()).toMatchObject([
          {
            id: "held-source",
            attempts: 1,
            lastError: expect.stringContaining("Compaction timed out"),
          },
        ]);
        expect(await loadTranscriptEvents(held.target)).toEqual([]);

        if (!heldAdmission) {
          throw new Error("The held source never reached durable admission");
        }
        releaseHeldInput.resolve();
        expect
          .soft(await Promise.allSettled([heldAdmission]))
          .toMatchObject([{ status: "rejected" }]);
        expect.soft(await loadTranscriptEvents(held.target)).toEqual([]);
        const retiredEntry = loadSessionEntry(held.target);
        expect.soft(retiredEntry).toMatchObject({
          sessionId: "held-source-session",
          status: "done",
          updatedAt: 17,
        });
        expect.soft(retiredEntry).not.toHaveProperty("restartRecoveryDeliveryRunId");

        const siblingMessages = (await loadTranscriptEvents(sibling.target))
          .map(readTranscriptEventMessage)
          .filter((message) => message !== undefined);
        expect(siblingMessages).toEqual([
          expect.objectContaining({
            role: "user",
            content: "healthy input",
            idempotencyKey: "sibling-source",
          }),
        ]);
        expect(loadSessionEntry(sibling.target)).toMatchObject({
          status: "running",
          restartRecoveryDeliverySourceRunId: "sibling-source",
        });
        expect((await queue.enqueue("sibling-source", { text: "redelivery" })).kind).toBe(
          "completed",
        );
      } finally {
        releaseHeldInput.resolve();
        await heldWriter;
        if (heldAdmission) {
          await Promise.allSettled([heldAdmission]);
        }
        await drain.waitForIdle();
        drain.dispose();
        closeOpenClawAgentDatabasesForTest(stateDir);
      }
    });
  });
});
