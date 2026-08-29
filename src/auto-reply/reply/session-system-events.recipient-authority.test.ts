import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assignSessionOwner,
  captureSessionRecipientAuthority,
  deleteSessionEntryLifecycle,
  isSessionRecipientAuthorityCurrent,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
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
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { enqueueContinuationReturnDeliveries } from "../continuation/targeting.js";
import { prepareFormattedSystemEvents } from "./session-system-events.js";

const invalidations = [
  "owner reassignment",
  "member access removal",
  "explicit revocation",
] as const;

afterEach(() => {
  resetSystemEventsForTest();
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
});

describe("recipient authority prompt-adoption fence", () => {
  it("settles an owner-revoked return when authority changes at the transcript-read boundary", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", state.env.OPENCLAW_STATE_DIR);
      const sessionKey = "agent:main:prompt-fence-transcript-read";
      const ownerA = { type: "human" as const, id: "owner-a" };
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, {
        sessionId: "recipient-before-revocation",
        updatedAt: 1,
        createdActor: ownerA,
      });
      const recipientAuthority = captureSessionRecipientAuthority(scope);
      const delivery = await enqueueContinuationReturnDeliveries({
        targetSessionKeys: [sessionKey],
        text: "stale delegate result",
        idempotencyKeyBase: "transcript-read-race",
        recipientAuthorities: new Map([[sessionKey, recipientAuthority]]),
        stateDir: state.env.OPENCLAW_STATE_DIR,
      });
      const deliveryId = delivery.deliveryIds[0];
      expect(deliveryId).toBeDefined();
      enqueueSystemEventRaw("unbound sibling event", { sessionKey });

      let reassigned = false;
      queueMicrotask(() => {
        reassigned =
          assignSessionOwner(scope, {
            owner: { type: "human", id: "owner-b" },
            assignedBy: ownerA,
            assignedAt: 3,
          }) !== null;
      });
      const prepared = await prepareFormattedSystemEvents({
        cfg: {},
        agentId: "main",
        sessionKey,
        isMainSession: false,
        isNewSession: false,
      });

      expect(reassigned).toBe(true);
      expect(isSessionRecipientAuthorityCurrent(scope, recipientAuthority)).toBe(false);
      expect(prepared.blocks.map((block) => block.text).join("\n")).not.toContain(
        "stale delegate result",
      );
      expect(prepared.blocks.map((block) => block.text).join("\n")).toContain(
        "unbound sibling event",
      );
      expect(prepared.managedDeliveries.map((entry) => entry.id)).not.toContain(deliveryId);
      expect(
        await loadPendingSessionDelivery(deliveryId!, state.env.OPENCLAW_STATE_DIR),
      ).toBeNull();
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    });
  });

  it.each(invalidations)(
    "drops a stale return after %s before prompt or downstream channel work",
    async (invalidation) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        vi.stubEnv("OPENCLAW_STATE_DIR", state.env.OPENCLAW_STATE_DIR);
        const sessionKey = `agent:main:prompt-fence-${invalidation.replaceAll(" ", "-")}`;
        const ownerA = { type: "human" as const, id: "owner-a" };
        const scope = { agentId: "main", env: state.env, sessionKey };
        await upsertSessionEntryCore(scope, {
          sessionId: "recipient-before-revocation",
          updatedAt: 1,
          createdActor: ownerA,
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
        const recipientAuthority = captureSessionRecipientAuthority(scope);
        enqueueSystemEventRaw("stale delegate result", {
          sessionKey,
          trusted: true,
          recipientAuthority,
        });

        if (invalidation === "owner reassignment") {
          expect(
            assignSessionOwner(scope, {
              owner: { type: "human", id: "owner-b" },
              assignedBy: ownerA,
              assignedAt: 3,
            }),
          ).not.toBeNull();
        } else if (invalidation === "member access removal") {
          expect(removeSessionMember(scope, "member-a")).not.toBeNull();
        } else {
          const deletion = await deleteSessionEntryLifecycle({
            agentId: "main",
            archiveTranscript: false,
            storePath,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          });
          expect(deletion.deleted).toBe(true);
        }

        expect(isSessionRecipientAuthorityCurrent(scope, recipientAuthority)).toBe(false);
        const prepared = await prepareFormattedSystemEvents({
          cfg: {},
          agentId: "main",
          sessionKey,
          isMainSession: false,
          isNewSession: false,
        });

        expect(prepared).toEqual({ blocks: [], managedDeliveries: [] });
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      });
    },
  );
});
