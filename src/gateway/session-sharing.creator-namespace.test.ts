import { describe, expect, it, vi } from "vitest";
import { assignSessionOwner, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail, linkEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { isSessionCreatorProfile } from "./session-creator.js";
import {
  canReceiveSessionEvent,
  createSessionListEntryFilter,
  invalidateSessionSharingSnapshot,
  resolveSessionMutationAuthorization,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
} from "./session-sharing.js";

describe("creator namespace authorization", () => {
  it("reuses caller alias facts across rows and refreshes them after a real merge", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const caller = ensureProfileForEmail("cached-caller@example.test");
      const other = ensureProfileForEmail("cached-other@example.test");
      const actor = { type: "human", source: "profile", id: other.id } as const;
      const db = openOpenClawStateDatabase().db;
      const prepare = vi.spyOn(db, "prepare");
      try {
        expect(isSessionCreatorProfile({ ...actor, source: "channel" }, caller.id)).toBe(false);
        expect(prepare).not.toHaveBeenCalled();
        expect(isSessionCreatorProfile(actor, caller.id)).toBe(false);
        const coldQueries = prepare.mock.calls.length;
        expect(coldQueries).toBeGreaterThan(0);
        for (let row = 0; row < 100; row++) {
          expect(isSessionCreatorProfile(actor, caller.id)).toBe(false);
        }
        expect(prepare).toHaveBeenCalledTimes(coldQueries);
        linkEmail("cached-other@example.test", caller.id);
        expect(isSessionCreatorProfile(actor, caller.id)).toBe(true);
        expect(isSessionCreatorProfile({ ...actor, source: "unknown" }, caller.id)).toBe(false);
      } finally {
        prepare.mockRestore();
      }
    });
  });

  it("never turns matching attribution or responsibility into a profile creator grant", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("creator@example.test");
      const client = {
        connect: { scopes: ["operator.read", "operator.write"] },
        authenticatedUserProfile: { profileId: profile.id },
      } as GatewayClient;
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: {
                sessions: { others: "none" },
                agents: "*",
                scopes: ["operator.read", "operator.write"],
              },
            },
          },
        },
      };
      const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
      const actors = [
        { type: "human", source: "profile" },
        { type: "human", source: "channel" },
        { type: "human", source: "unknown" },
        { type: "agent" },
        { type: "system" },
      ] as const;
      for (const actor of actors) {
        const sessionKey = `agent:main:creator-${actor.type}-${"source" in actor ? actor.source : "native"}`;
        const entry = {
          sessionId: sessionKey,
          updatedAt: 1,
          createdVia: "cron" as const,
          createdActor: { ...actor, id: profile.id },
          visibility: "draft" as const,
        };
        await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
        assignSessionOwner(
          { agentId: "main", sessionKey },
          {
            owner: { type: "human", id: profile.id },
            assignedBy: { type: "human", id: profile.id },
          },
        );
        const target = resolveSessionSharingTarget({ cfg, sessionKey });
        if (!target) {
          throw new Error("missing persisted session");
        }
        const isCreator = actor.type === "human" && actor.source === "profile";
        expect
          .soft(resolveSessionSharingRole({ cfg, client, target, isMember: false }), sessionKey)
          .toBe(isCreator ? "owner" : "viewer");
        expect
          .soft(
            createSessionListEntryFilter({ cfg, client })?.(sessionKey, target.entry),
            sessionKey,
          )
          .toBe(isCreator);
        for (let pass = 0; pass < 2; pass++) {
          expect
            .soft(
              canReceiveSessionEvent({ cfg, client: client as never, sessionKeys: [sessionKey] }),
              sessionKey,
            )
            .toBe(isCreator);
        }
        for (const method of ["sessions.get", "sessions.patch"]) {
          const result = resolveSessionMutationAuthorization({
            client,
            method,
            requestParams: { key: sessionKey },
            context,
          });
          expect.soft(result.error === null, `${sessionKey}: ${method}`).toBe(isCreator);
        }
      }
      invalidateSessionSharingSnapshot();
    });
  });

  it("resolves profile tombstones after warming event snapshots without rewriting creators", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const old = ensureProfileForEmail("old@example.test");
      const current = ensureProfileForEmail("current@example.test");
      const client = {
        connect: { scopes: ["operator.read"] },
        authenticatedUserProfile: { profileId: current.id },
      } as GatewayClient;
      const sessionKey = "agent:main:merged-creator";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "merged-creator",
          updatedAt: 1,
          visibility: "draft",
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: old.id },
        },
      );
      const receive = () =>
        canReceiveSessionEvent({ cfg: {}, client: client as never, sessionKeys: [sessionKey] });
      expect(receive()).toBe(false);
      linkEmail("old@example.test", current.id);
      expect(receive()).toBe(true);
      const target = resolveSessionSharingTarget({ cfg: {}, sessionKey });
      if (!target) {
        throw new Error("missing merged creator session");
      }
      expect(target.entry.createdActor?.id).toBe(old.id);
      expect(resolveSessionSharingRole({ client, target, isMember: false })).toBe("owner");
      expect(createSessionListEntryFilter({ client })?.(sessionKey, target.entry)).toBe(true);
      invalidateSessionSharingSnapshot();
    });
  });
});
