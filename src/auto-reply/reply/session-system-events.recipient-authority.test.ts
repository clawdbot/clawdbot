import { afterEach, describe, expect, it, vi } from "vitest";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { advanceSessionRecipientAuthorityInTransaction } from "../../config/sessions/session-accessor.sqlite-recipient-authority.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import { loadPendingSessionDelivery } from "../../infra/session-delivery-queue-storage.js";
import {
  enqueueSystemEventRaw,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { enqueueContinuationReturnDeliveries } from "../continuation/targeting.js";
import {
  resolveFinalSystemEventAdoption,
  type PreparedFormattedSystemEvents,
} from "./session-system-event-adoption.js";
import { prepareFormattedSystemEvents } from "./session-system-events.js";

const invalidations = [
  "owner reassignment",
  "member access removal",
  "session deletion and recreation",
  "restrictive visibility",
] as const;

type Invalidation = (typeof invalidations)[number];
type AuthorityScope = {
  agentId: string;
  env: NodeJS.ProcessEnv;
  sessionKey: string;
};

const ownerA = { type: "human" as const, id: "owner-a" };

async function applyInvalidation(params: {
  invalidation: Invalidation;
  scope: AuthorityScope;
  storePath: string;
}) {
  if (params.invalidation === "owner reassignment") {
    expect(
      sessionAccessor.assignSessionOwner(params.scope, {
        owner: { type: "human", id: "owner-b" },
        assignedBy: ownerA,
        assignedAt: 3,
      }),
    ).not.toBeNull();
    return;
  }
  if (params.invalidation === "member access removal") {
    expect(removeSessionMember(params.scope, "member-a")).not.toBeNull();
    return;
  }
  if (params.invalidation === "session deletion and recreation") {
    const deletion = await sessionAccessor.deleteSessionEntryLifecycle({
      agentId: "main",
      archiveTranscript: false,
      storePath: params.storePath,
      target: {
        canonicalKey: params.scope.sessionKey,
        storeKeys: [params.scope.sessionKey],
      },
    });
    expect(deletion.deleted).toBe(true);
    await sessionAccessor.upsertSessionEntryCore(params.scope, {
      sessionId: "recipient-after-recreation",
      updatedAt: 4,
      createdActor: ownerA,
      visibility: "shared",
    });
    return;
  }
  await sessionAccessor.patchSessionEntryCore(params.scope, () => ({ visibility: "draft" }), {
    afterPersistInTransaction: (database) =>
      advanceSessionRecipientAuthorityInTransaction(database, params.scope.sessionKey),
  });
}

async function resolveFinalAdoption(...prepared: PreparedFormattedSystemEvents[]) {
  let adoption = resolveFinalSystemEventAdoption({ prepared });
  while (adoption.kind === "settle-stale") {
    await adoption.settle();
    adoption = resolveFinalSystemEventAdoption({ prepared });
  }
  return adoption;
}

afterEach(() => {
  resetSystemEventsForTest();
  closeOpenClawAgentDatabasesForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("recipient authority prompt-adoption fence", () => {
  it.each(invalidations)(
    "settles a return after %s commits during the transcript read",
    async (invalidation) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        vi.stubEnv("OPENCLAW_STATE_DIR", state.env.OPENCLAW_STATE_DIR);
        const sessionKey = `agent:main:transcript-race-${invalidation.replaceAll(" ", "-")}`;
        const scope = { agentId: "main", env: state.env, sessionKey };
        await sessionAccessor.upsertSessionEntryCore(scope, {
          sessionId: "recipient-before-revocation",
          updatedAt: 1,
          createdActor: ownerA,
          visibility: "shared",
        });
        const storePath = openOpenClawAgentDatabase({
          agentId: "main",
          env: state.env,
        }).path;
        if (invalidation === "member access removal") {
          expect(
            addSessionMember(scope, {
              identityId: "member-a",
              addedBy: ownerA.id,
              addedAt: 2,
            }).inserted,
          ).toBe(true);
        }
        const recipientAuthority = sessionAccessor.captureSessionRecipientAuthority(scope);
        const delivery = await enqueueContinuationReturnDeliveries({
          targetSessionKeys: [sessionKey],
          text: "stale delegate result",
          idempotencyKeyBase: `transcript-race-${invalidation}`,
          recipientAuthorities: new Map([[sessionKey, recipientAuthority]]),
          stateDir: state.env.OPENCLAW_STATE_DIR,
        });
        const deliveryId = delivery.deliveryIds[0];
        expect(deliveryId).toBeDefined();
        enqueueSystemEventRaw("unbound sibling event", { sessionKey });

        const transcriptRead = createDeferredCore();
        const resumeTranscriptRead = createDeferredCore();
        const loadTranscriptEvents = sessionAccessor.loadTranscriptEvents;
        vi.spyOn(sessionAccessor, "loadTranscriptEvents").mockImplementationOnce(async (params) => {
          const events = await loadTranscriptEvents(params);
          transcriptRead.resolve();
          await resumeTranscriptRead.promise;
          return events;
        });
        const preparing = prepareFormattedSystemEvents({
          cfg: {},
          agentId: "main",
          sessionKey,
          isMainSession: false,
          isNewSession: false,
        });
        await transcriptRead.promise;
        await applyInvalidation({ invalidation, scope, storePath });
        resumeTranscriptRead.resolve();
        const prepared = await preparing;

        expect(sessionAccessor.isSessionRecipientAuthorityCurrent(scope, recipientAuthority)).toBe(
          false,
        );
        const prompt = prepared.blocks.map((block) => block.text).join("\n");
        expect(prompt).not.toContain("stale delegate result");
        expect(prompt).toContain("unbound sibling event");
        expect(prepared.managedDeliveries.map((entry) => entry.id)).not.toContain(deliveryId);
        expect(
          await loadPendingSessionDelivery(deliveryId!, state.env.OPENCLAW_STATE_DIR),
        ).toBeNull();
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      });
    },
  );

  it.each(invalidations)(
    "drops a return invalidated by %s before preparation",
    async (invalidation) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        vi.stubEnv("OPENCLAW_STATE_DIR", state.env.OPENCLAW_STATE_DIR);
        const sessionKey = `agent:main:early-fence-${invalidation.replaceAll(" ", "-")}`;
        const scope = { agentId: "main", env: state.env, sessionKey };
        await sessionAccessor.upsertSessionEntryCore(scope, {
          sessionId: "recipient-before-revocation",
          updatedAt: 1,
          createdActor: ownerA,
          visibility: "shared",
        });
        const storePath = openOpenClawAgentDatabase({
          agentId: "main",
          env: state.env,
        }).path;
        if (invalidation === "member access removal") {
          expect(
            addSessionMember(scope, {
              identityId: "member-a",
              addedBy: ownerA.id,
              addedAt: 2,
            }).inserted,
          ).toBe(true);
        }
        const recipientAuthority = sessionAccessor.captureSessionRecipientAuthority(scope);
        enqueueSystemEventRaw("stale delegate result", {
          sessionKey,
          trusted: true,
          recipientAuthority,
        });

        await applyInvalidation({ invalidation, scope, storePath });
        const prepared = await prepareFormattedSystemEvents({
          cfg: {},
          agentId: "main",
          sessionKey,
          isMainSession: false,
          isNewSession: false,
        });

        expect(sessionAccessor.isSessionRecipientAuthorityCurrent(scope, recipientAuthority)).toBe(
          false,
        );
        expect(prepared).toEqual({ blocks: [], managedDeliveries: [] });
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      });
    },
  );

  it.each(invalidations)(
    "settles a return invalidated by %s at final adoption",
    async (invalidation) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        vi.stubEnv("OPENCLAW_STATE_DIR", state.env.OPENCLAW_STATE_DIR);
        const sessionKey = `agent:main:final-fence-${invalidation.replaceAll(" ", "-")}`;
        const scope = { agentId: "main", env: state.env, sessionKey };
        await sessionAccessor.upsertSessionEntryCore(scope, {
          sessionId: "recipient-before-revocation",
          updatedAt: 1,
          createdActor: ownerA,
          visibility: "shared",
        });
        const storePath = openOpenClawAgentDatabase({
          agentId: "main",
          env: state.env,
        }).path;
        if (invalidation === "member access removal") {
          expect(
            addSessionMember(scope, {
              identityId: "member-a",
              addedBy: ownerA.id,
              addedAt: 2,
            }).inserted,
          ).toBe(true);
        }
        const recipientAuthority = sessionAccessor.captureSessionRecipientAuthority(scope);
        const delivery = await enqueueContinuationReturnDeliveries({
          targetSessionKeys: [sessionKey],
          text: "stale delegate result",
          idempotencyKeyBase: `final-race-${invalidation}`,
          recipientAuthorities: new Map([[sessionKey, recipientAuthority]]),
          stateDir: state.env.OPENCLAW_STATE_DIR,
        });
        const deliveryId = delivery.deliveryIds[0];
        expect(deliveryId).toBeDefined();
        enqueueSystemEventRaw("unbound sibling event", { sessionKey });
        const prepared = await prepareFormattedSystemEvents({
          cfg: {},
          agentId: "main",
          sessionKey,
          isMainSession: false,
          isNewSession: false,
        });

        await applyInvalidation({ invalidation, scope, storePath });
        const adoption = await resolveFinalAdoption(prepared);

        expect(sessionAccessor.isSessionRecipientAuthorityCurrent(scope, recipientAuthority)).toBe(
          false,
        );
        const prompt = adoption.blocks.map((block) => block.text).join("\n");
        expect(prompt).not.toContain("stale delegate result");
        expect(prompt).toContain("unbound sibling event");
        expect([...adoption.managedDeliveries.keys()]).not.toContain(deliveryId);
        expect(
          await loadPendingSessionDelivery(deliveryId!, state.env.OPENCLAW_STATE_DIR),
        ).toBeNull();
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      });
    },
  );

  it("keeps route and current-session authority scoped to their own prepared batches", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", state.env.OPENCLAW_STATE_DIR);
      const prepareBatch = async (agentId: string, sessionKey: string) => {
        const scope = { agentId, env: state.env, sessionKey };
        await sessionAccessor.upsertSessionEntryCore(scope, {
          sessionId: `${agentId}-session`,
          updatedAt: 1,
          createdActor: ownerA,
        });
        const authority = sessionAccessor.captureSessionRecipientAuthority(scope);
        const delivery = await enqueueContinuationReturnDeliveries({
          targetSessionKeys: [sessionKey],
          text: `${agentId} delegate result`,
          idempotencyKeyBase: `multi-batch-${agentId}`,
          recipientAuthorities: new Map([[sessionKey, authority]]),
          stateDir: state.env.OPENCLAW_STATE_DIR,
        });
        const deliveryId = delivery.deliveryIds[0];
        expect(deliveryId).toBeDefined();
        const prepared = await prepareFormattedSystemEvents({
          cfg: {},
          agentId: "main",
          sessionKey,
          isMainSession: false,
          isNewSession: false,
        });
        return { authority, deliveryId: deliveryId!, prepared, scope };
      };
      const route = await prepareBatch("ops", "agent:ops:routed-events");
      const current = await prepareBatch("main", "agent:main:current-events");

      expect(
        sessionAccessor.assignSessionOwner(route.scope, {
          owner: { type: "human", id: "owner-b" },
          assignedBy: ownerA,
          assignedAt: 2,
        }),
      ).not.toBeNull();
      const adoption = await resolveFinalAdoption(route.prepared, current.prepared);

      expect(sessionAccessor.isSessionRecipientAuthorityCurrent(route.scope, route.authority)).toBe(
        false,
      );
      expect(
        sessionAccessor.isSessionRecipientAuthorityCurrent(current.scope, current.authority),
      ).toBe(true);
      const prompt = adoption.blocks.map((block) => block.text).join("\n");
      expect(prompt).not.toContain("ops delegate result");
      expect(prompt).toContain("main delegate result");
      expect([...adoption.managedDeliveries.keys()]).toEqual([current.deliveryId]);
      expect(
        await loadPendingSessionDelivery(route.deliveryId, state.env.OPENCLAW_STATE_DIR),
      ).toBeNull();
      expect(
        await loadPendingSessionDelivery(current.deliveryId, state.env.OPENCLAW_STATE_DIR),
      ).not.toBeNull();

      await adoption.managedDeliveries.get(current.deliveryId)?.acknowledge();
      expect(
        await loadPendingSessionDelivery(current.deliveryId, state.env.OPENCLAW_STATE_DIR),
      ).toBeNull();
    });
  });
});
