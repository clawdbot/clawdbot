// Covers target projection when a newer inbound route wins the final session-store commit race.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  updateSessionLastRoute,
} from "../../config/sessions/session-accessor.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  beginSessionWorkAdmission,
  isSessionLifecycleMutationActive,
} from "../../sessions/session-lifecycle-admission.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "../heartbeat-runner.test-utils.js";
import {
  isSystemEventDeferredDuringHeartbeat,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../system-events.js";
import {
  commitTargetSessionProjection,
  prepareTargetSessionProjection,
} from "./target-session-projection.js";

beforeEach(() => {
  resetSystemEventsForTest();
});

afterEach(() => {
  resetSystemEventsForTest();
});

it("preserves a newer inbound route while committing transcript and awareness", async () => {
  await withTempHeartbeatSandbox(async ({ storePath }) => {
    const sessionKey = "agent:main:whatsapp:direct:route-cas";
    const sessionId = "route-cas-session";
    const idempotencyKey = "heartbeat-route-cas";
    const mirroredText = "Projected heartbeat alert.";
    const awarenessText = "Heartbeat route CAS awareness.";
    const cfg: OpenClawConfig = {
      session: { store: storePath, dmScope: "per-channel-peer" },
    };
    await seedSessionStore(storePath, sessionKey, {
      sessionId,
      lastChannel: "whatsapp",
      lastProvider: "whatsapp",
      lastTo: "whatsapp:old-route",
    });
    const prepared = prepareTargetSessionProjection({
      cfg,
      target: {
        agentId: "main",
        isCurrent: () => true,
        route: {
          sessionKey,
          baseSessionKey: sessionKey,
          recipientSessionExact: true,
          peer: { kind: "direct", id: "route-cas" },
          chatType: "direct",
          from: "whatsapp:route-cas",
          to: "whatsapp:projected-route",
        },
      },
    });
    expect(prepared.observedDelivery).toMatchObject({
      kind: "external",
      context: { channel: "whatsapp", to: "whatsapp:old-route" },
    });

    const activeTurn = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
    });
    const writerStarted = createDeferred();
    const releaseWriter = createDeferred();
    const writerBlocker = patchSessionEntryCore({ storePath, sessionKey }, async () => {
      writerStarted.resolve();
      await releaseWriter.promise;
      return null;
    });
    await writerStarted.promise;

    const projection = commitTargetSessionProjection({
      cfg,
      prepared,
      idempotencyKey,
      routeBinding: { channel: "whatsapp" },
      mirror: { text: mirroredText },
      awarenessText,
    });
    const inboundRoute = updateSessionLastRoute({
      storePath,
      sessionKey,
      channel: "telegram",
      to: "telegram:new-inbound-route",
      accountId: "inbound-account",
      threadId: "inbound-thread",
    });

    try {
      expect(isSessionLifecycleMutationActive(storePath, [sessionKey, sessionId])).toBe(true);
      activeTurn.release();
      // The blocked writer keeps the projection's run-phase snapshot old while
      // its bind queues behind the already-enqueued inbound route update.
      await vi.waitFor(() =>
        expect(
          [...SQLITE_SESSION_WRITER_QUEUES.values()].some(
            (queue) => queue.running && queue.pending.length === 2,
          ),
        ).toBe(true),
      );
      releaseWriter.resolve();

      await expect(writerBlocker).resolves.toMatchObject({ sessionId });
      await expect(inboundRoute).resolves.toMatchObject({
        delivery: {
          kind: "external",
          context: {
            channel: "telegram",
            to: "telegram:new-inbound-route",
            accountId: "inbound-account",
            threadId: "inbound-thread",
          },
        },
      });
      await expect(projection).resolves.toEqual({
        status: "committed",
        warnings: [],
        session: { sessionId },
      });
    } finally {
      activeTurn.release();
      releaseWriter.resolve();
      await Promise.allSettled([writerBlocker, inboundRoute, projection]);
    }

    expect(loadSessionEntry({ storePath, sessionKey })?.delivery).toMatchObject({
      kind: "external",
      context: {
        channel: "telegram",
        to: "telegram:new-inbound-route",
        accountId: "inbound-account",
        threadId: "inbound-thread",
      },
    });
    expect(
      JSON.stringify(
        await loadTranscriptEvents({
          agentId: "main",
          storePath,
          sessionKey,
          sessionId,
        }),
      ),
    ).toContain(mirroredText);
    const awareness = peekSystemEventEntries(sessionKey);
    expect(awareness).toEqual([
      expect.objectContaining({ contextKey: idempotencyKey, text: awarenessText }),
    ]);
    const awarenessEvent = awareness[0];
    expect(awarenessEvent).toBeDefined();
    if (!awarenessEvent) {
      throw new Error("expected target-session awareness");
    }
    expect(isSystemEventDeferredDuringHeartbeat(awarenessEvent)).toBe(true);
  });
});
