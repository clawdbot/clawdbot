import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import * as profileAliases from "../../state/user-profile-list.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { isSessionCreatorProfile, prepareSessionCreatorProfile } from "../session-creator.js";
import { canReceiveSessionEvent, invalidateSessionSharingSnapshot } from "../session-sharing.js";
import * as sessionUtils from "../session-utils.js";
import { sessionCatalogHandlers } from "./session-catalog.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
  sessionReadHandlers,
} from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

// Observe real default-path work, separately from unrelated session-store path resolution.
// Both observers pass through unchanged; neither supplies aliases nor substitutes a state path.
function observeAliasRootProbes(stateDir: string) {
  let inAliasRead = false;
  let aliasRootProbes = 0;
  let allRootProbes = 0;
  const readAliases = profileAliases.readUserProfileAliases;
  const exists = fs.existsSync;
  const aliasSpy = vi
    .spyOn(profileAliases, "readUserProfileAliases")
    .mockImplementation((...args) => {
      inAliasRead = true;
      try {
        return readAliases(...args);
      } finally {
        inAliasRead = false;
      }
    });
  const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
    if (candidate === stateDir) {
      allRootProbes += 1;
      if (inAliasRead) {
        aliasRootProbes += 1;
      }
    }
    return exists(candidate);
  });
  return {
    finish(label: string, rows = 100) {
      existsSpy.mockRestore();
      aliasSpy.mockRestore();
      const observation = { label, rows, aliasRootProbes, allRootProbes };
      console.log(JSON.stringify(observation));
      return aliasRootProbes;
    },
  };
}

async function withCreatorRows(
  run: (fixture: {
    stateDir: string;
    callerId: string;
    creatorId: string;
    keys: string[];
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    {
      scenario: "minimal",
      env: {
        OPENCLAW_STATE_DIR: undefined,
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        VITEST_WORKER_ID: undefined,
        NODE_ENV: "production",
      },
    },
    async (state) => {
      expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
      expect(process.env.VITEST).toBeUndefined();
      expect(process.env.NODE_ENV).toBe("production");
      expect(process.env.HOME).toBe(state.home);
      const caller = ensureProfileForEmail("caller@preparation.test");
      const creator = ensureProfileForEmail("creator@preparation.test");
      ensureProfileForEmail("unrelated@preparation.test");
      const keys = Array.from({ length: 100 }, (_, i) => `agent:main:prepared-${i}`);
      for (const [index, sessionKey] of keys.entries()) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: `prepared-${index}`,
            updatedAt: index + 1,
            visibility: "shared",
            pluginOwnerId: "fixture",
            createdActor: { type: "human", source: "profile", id: creator.id },
          },
        );
      }
      // Direct fixture writes do not run the Gateway's session-change publisher.
      // Each fixture owns these keys and must release their cached event snapshots.
      for (const key of keys) {
        invalidateSessionSharingSnapshot(key);
      }
      try {
        await run({ stateDir: state.stateDir, callerId: caller.id, creatorId: creator.id, keys });
      } finally {
        for (const key of keys) {
          invalidateSessionSharingSnapshot(key);
        }
      }
    },
  );
}

describe("creator preparation at synchronous fan-out boundaries", () => {
  it("keeps exact, non-profile and absent-caller comparisons storage-free", async () => {
    await withOpenClawTestState(
      {
        scenario: "minimal",
        env: {
          OPENCLAW_STATE_DIR: undefined,
          VITEST: undefined,
          VITEST_POOL_ID: undefined,
          VITEST_WORKER_ID: undefined,
          NODE_ENV: "production",
        },
      },
      async (state) => {
        const matches = prepareSessionCreatorProfile("caller");
        const anonymous = prepareSessionCreatorProfile(undefined);
        const observer = observeAliasRootProbes(state.stateDir);
        for (const source of ["profile", "channel", "unknown"] as const) {
          const actor = { type: "human", source, id: "caller" } as const;
          expect(matches(actor)).toBe(source === "profile");
          expect(isSessionCreatorProfile(actor, "caller")).toBe(source === "profile");
          expect(anonymous(actor)).toBe(false);
        }
        expect(matches({ type: "agent", id: "caller" })).toBe(false);
        expect(matches({ type: "system", id: "caller" })).toBe(false);
        expect(matches(undefined)).toBe(false);
        expect(observer.finish("storage-free-comparisons", 0)).toBe(0);
        expect(fs.existsSync(state.statePath("state", "openclaw.sqlite"))).toBe(false);
      },
    );
  });

  it("bounds list selection and sharing-role work and refreshes the next list after merge", async () => {
    await withCreatorRows(async ({ stateDir, callerId, keys }) => {
      const client = identifiedClient(callerId);
      const list = () =>
        listSessions({ client, context: requestContext({}), request: { limit: 100 } });
      profileAliases.readUserProfileAliases(callerId);
      const before = observeAliasRootProbes(stateDir);
      const foreign = await list();
      const beforeCount = before.finish("list-foreign");
      expect(foreign.sessions).toHaveLength(100);
      expect(foreign.sessions.every((row) => row.sharingRole === "viewer")).toBe(true);
      expect(beforeCount).toBeGreaterThan(0);
      expect.soft(beforeCount).toBeLessThanOrEqual(3);
      linkEmail("creator@preparation.test", callerId);
      profileAliases.readUserProfileAliases(callerId);
      const after = observeAliasRootProbes(stateDir);
      const owned = await list();
      const afterCount = after.finish("list-merged");
      expect(new Set(owned.sessions.map((row) => row.key))).toEqual(new Set(keys));
      expect(owned.sessions.every((row) => row.sharingRole === "owner")).toBe(true);
      expect(afterCount).toBeGreaterThan(0);
      expect(afterCount).toBeLessThanOrEqual(3);
    });
  });

  it("shares aliases through event visibility and suggestion roles without retaining them across events", async () => {
    await withCreatorRows(async ({ stateDir, callerId, keys }) => {
      const client = { ...identifiedClient(callerId), connId: "fixture" } as GatewayWsClient;
      const receive = () =>
        canReceiveSessionEvent({
          cfg: {},
          client,
          sessionKeys: keys,
          event: "session.suggestion",
          payload: { suggestion: { author: { id: "someone-else" } } },
        });
      expect(receive()).toBe(false);
      linkEmail("creator@preparation.test", callerId);
      profileAliases.readUserProfileAliases(callerId);
      const observer = observeAliasRootProbes(stateDir);
      expect(receive()).toBe(true);
      expect(observer.finish("event-merged-suggestion")).toBe(1);
    });
  });

  it("reselects alias storage for each event after env changes and database reopening", async () => {
    await withCreatorRows(async ({ stateDir, callerId, creatorId, keys }) => {
      const sessionKey = keys[0]!;
      await upsertSessionEntryCore({ agentId: "main", sessionKey }, { visibility: "draft" });
      linkEmail("creator@preparation.test", callerId);
      const client = { ...identifiedClient(callerId), connId: "fixture" } as GatewayWsClient;
      const receive = () => canReceiveSessionEvent({ cfg: {}, client, sessionKeys: [sessionKey] });
      expect(receive()).toBe(true);
      const alternateRoot = `${stateDir}/absent-state`;
      await withEnvAsync({ OPENCLAW_STATE_DIR: alternateRoot }, async () => {
        expect(receive()).toBe(false);
        expect(fs.existsSync(alternateRoot)).toBe(false);
      });
      expect(receive()).toBe(true);
      const pathname = `${stateDir}/state/openclaw.sqlite`;
      closeOpenClawStateDatabaseByPath(pathname);
      const reopened = openOpenClawStateDatabase({ path: pathname }).db;
      reopened.prepare("DELETE FROM user_profiles WHERE id = ?").run(creatorId);
      expect(receive()).toBe(false);
    });
  });

  it("refreshes sharing roles after asynchronous row building", async () => {
    await withCreatorRows(async ({ callerId }) => {
      const original = sessionUtils.listSessionsFromStoreAsync;
      const rows = vi
        .spyOn(sessionUtils, "listSessionsFromStoreAsync")
        .mockImplementation((params) => {
          const pending = original(params);
          // The real builder has selected rows and yielded after its first ten projections.
          linkEmail("creator@preparation.test", callerId);
          return pending;
        });
      const result = await listSessions({
        client: identifiedClient(callerId),
        context: requestContext({}),
        request: { limit: 100 },
      });
      expect(rows).toHaveBeenCalledOnce();
      expect(result.sessions).toHaveLength(100);
      expect(result.sessions.every((row) => row.sharingRole === "owner")).toBe(true);
    });
  });

  it("does not retain caller aliases in a preview filter across event-loop yields", async () => {
    await withCreatorRows(async ({ callerId, keys }) => {
      const respond = vi.fn();
      const context = requestContext({
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: {
                sessions: { others: "none" },
                agents: "*",
                scopes: ["operator.read"],
              },
            },
          },
        },
      });
      const pending = sessionReadHandlers["sessions.preview"]?.({
        params: { keys: keys.slice(0, 2) },
        client: identifiedClient(callerId),
        context,
        respond,
      } as never);
      // The first key was denied synchronously; the second has not resumed from setImmediate.
      linkEmail("creator@preparation.test", callerId);
      await pending;
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          previews: [
            { key: keys[0], status: "missing", items: [] },
            { key: keys[1], status: "empty", items: [] },
          ],
        }),
        undefined,
      );
    });
  });

  it("uses one alias set per catalog publication and refreshes after provider awaits", async () => {
    await withCreatorRows(async ({ stateDir, callerId, keys }) => {
      const previousRegistry = getActivePluginRegistry() ?? createEmptyPluginRegistry();
      const registry = createEmptyPluginRegistry();
      const host: SessionCatalogHost = {
        hostId: "gateway:local",
        kind: "gateway",
        label: "Fixture",
        connected: true,
        sessions: keys.map((sessionKey, index) => ({
          sessionKey,
          threadId: `prepared-${index}`,
          status: "stored",
          archived: false,
          canContinue: true,
          canArchive: true,
        })),
      };
      registry.sessionCatalogs.push({
        pluginId: "fixture",
        source: import.meta.url,
        provider: {
          id: "fixture",
          label: "Fixture",
          list: async ({ onHost }) => {
            onHost?.(host);
            await Promise.resolve();
            linkEmail("creator@preparation.test", callerId);
            profileAliases.readUserProfileAliases(callerId);
            onHost?.(host);
            await Promise.resolve();
            return [host];
          },
          read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
        },
      });
      setActivePluginRegistry(registry);
      const respond = vi.fn();
      const broadcastToConnIds = vi.fn();
      profileAliases.readUserProfileAliases(callerId);
      const observer = observeAliasRootProbes(stateDir);
      try {
        await sessionCatalogHandlers["sessions.catalog.list"]?.({
          params: { progressId: "preparation" },
          respond,
          client: { ...identifiedClient(callerId), connId: "fixture" },
          context: { getRuntimeConfig: () => ({}), broadcastToConnIds },
        } as never);
      } finally {
        setActivePluginRegistry(previousRegistry);
      }
      const probes = observer.finish("catalog-publications");
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
      expect(broadcastToConnIds.mock.calls[0]?.[1]?.catalog.hosts[0]?.sessions).toEqual([]);
      expect(broadcastToConnIds.mock.calls[1]?.[1]?.catalog.hosts[0]?.sessions).toHaveLength(100);
      expect(respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toHaveLength(100);
      // Cache key, three publications, and the explicit post-merge warm read (three probes cold).
      expect(probes).toBeGreaterThan(0);
      expect(probes).toBeLessThanOrEqual(7);
    });
  });
});
