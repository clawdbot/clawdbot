import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  closeOpenClawAgentDatabaseByPath,
  disposeOpenClawAgentDatabaseByPath,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import * as profileAliases from "../../state/user-profile-list.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
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
      const observation = {
        label,
        rows,
        aliasRootProbes,
        otherRootProbes: allRootProbes - aliasRootProbes,
        allRootProbes,
      };
      console.log(JSON.stringify(observation));
      return observation;
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
  count = 100,
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
      const keys = Array.from({ length: count }, (_, i) => `agent:main:prepared-${i}`);
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

function eventClients(profileId: string) {
  return ["first", "second"].map((connId) => {
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
    };
    const client = { ...identifiedClient(profileId), connId, socket } as unknown as GatewayWsClient;
    return { client, socket };
  });
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
        expect(observer.finish("storage-free-comparisons", 0).allRootProbes).toBe(0);
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
      const beforeCount = before.finish("list-foreign").aliasRootProbes;
      expect(foreign.sessions).toHaveLength(100);
      expect(foreign.sessions.every((row) => row.sharingRole === "viewer")).toBe(true);
      expect(beforeCount).toBeGreaterThan(0);
      expect.soft(beforeCount).toBeLessThanOrEqual(3);
      linkEmail("creator@preparation.test", callerId);
      profileAliases.readUserProfileAliases(callerId);
      const after = observeAliasRootProbes(stateDir);
      const owned = await list();
      const afterCount = after.finish("list-merged").aliasRootProbes;
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
      const probes = observer.finish("event-merged-suggestion-stress");
      expect(probes.aliasRootProbes).toBe(1);
      expect(probes.otherRootProbes).toBeLessThanOrEqual(7);
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

  it.each([
    { shape: "single", count: 1 },
    { shape: "aliases", count: 1 },
    { shape: "stress", count: 100 },
  ])("bounds cold and warm broadcaster lookup work for $shape keys", async ({ shape, count }) => {
    await withCreatorRows(async ({ stateDir, callerId, keys }) => {
      linkEmail("creator@preparation.test", callerId);
      profileAliases.readUserProfileAliases(callerId);
      const sessionKeys = shape === "aliases" ? ["prepared-0", keys[0]!].toSorted() : keys;
      const recipients = eventClients(callerId);
      let phase = "cold";
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry(recipients.map(({ client }) => client)),
        canReceiveSessionEvent: (client, eventKeys, agentId, event, payload) => {
          const observer = observeAliasRootProbes(stateDir);
          const allowed = canReceiveSessionEvent({
            cfg: {},
            client,
            sessionKeys: eventKeys,
            agentId,
            event,
            payload,
          });
          const probes = observer.finish(
            `broadcast-${shape}-${phase}-${client.connId}`,
            eventKeys.length,
          );
          expect.soft(probes.aliasRootProbes).toBe(1);
          expect.soft(probes.otherRootProbes).toBeLessThanOrEqual(7);
          return allowed;
        },
      });
      for (phase of ["cold", "warm", "repeat"]) {
        broadcast(
          "session.suggestion",
          { suggestion: { author: { id: "someone-else" } } },
          { sessionKeys, agentId: "main" },
        );
      }
      for (const { socket } of recipients) {
        expect(socket.send).toHaveBeenCalledTimes(3);
        expect(socket.send.mock.calls.map(([frame]) => JSON.parse(String(frame)).seq)).toEqual([
          1, 2, 3,
        ]);
      }
    }, count);
  });

  it("reuses cold draft lookup work for typing roles and keeps warm visible events storage-free", async () => {
    await withCreatorRows(async ({ stateDir, callerId, keys }) => {
      const sessionKey = keys[0]!;
      await upsertSessionEntryCore({ agentId: "main", sessionKey }, { visibility: "draft" });
      profileAliases.readUserProfileAliases(callerId);
      const recipients = eventClients(callerId);
      const subscribers = createSessionMessageSubscriberRegistry();
      for (const { client } of recipients) {
        subscribers.subscribe(client.connId, sessionKey);
      }
      let visible = false;
      let phase = "cold-draft";
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry(recipients.map(({ client }) => client)),
        sessionMessageSubscribers: subscribers,
        canReceiveSessionEvent: (client, sessionKeys, agentId, event, payload) => {
          const observer = observeAliasRootProbes(stateDir);
          const allowed = canReceiveSessionEvent({
            cfg: {},
            client,
            sessionKeys,
            agentId,
            event,
            payload,
          });
          const probes = observer.finish(`typing-${phase}-${client.connId}`, sessionKeys.length);
          // Membership stays live and adds three probes for non-creators; only target work is reused.
          expect.soft(probes.otherRootProbes).toBeLessThanOrEqual(visible ? 0 : 10);
          expect(allowed).toBe(visible);
          return allowed;
        },
      });
      const emit = () => broadcast("session.typing", { sessionKey, agentId: "main", typing: true });
      emit();
      phase = "warm-draft";
      emit();
      await upsertSessionEntryCore({ agentId: "main", sessionKey }, { visibility: "shared" });
      invalidateSessionSharingSnapshot(sessionKey);
      canReceiveSessionEvent({ cfg: {}, client: recipients[0]!.client, sessionKeys: keys });
      visible = true;
      phase = "warm-shared";
      emit();
      for (const { socket } of recipients) {
        expect(socket.send).toHaveBeenCalledOnce();
      }
    }, 1);
  });

  it("reselects stores on send-hook reentry and reevaluates membership after an allowed event", async () => {
    await withCreatorRows(async ({ stateDir, callerId, keys }) => {
      const sessionKey = keys[0]!;
      const scope = { agentId: "main", sessionKey };
      const alternateStore = path.join(
        stateDir,
        "alternate",
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      await upsertSessionEntryCore(
        { ...scope, storePath: alternateStore },
        {
          sessionId: "alternate",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: "other-creator" },
        },
      );
      addSessionMember(scope, { identityId: callerId, addedBy: "fixture" });
      const recipients = eventClients(callerId);
      let cfg: OpenClawConfig = {};
      const decisions: Array<[string, boolean]> = [];
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry(recipients.map(({ client }) => client)),
        canReceiveSessionEvent: (client, sessionKeys, agentId, event, payload) => {
          const allowed = canReceiveSessionEvent({
            cfg,
            client,
            sessionKeys,
            agentId,
            event,
            payload,
          });
          decisions.push([client.connId, allowed]);
          return allowed;
        },
      });
      const emit = () =>
        broadcast("session.suggestion", {
          suggestion: { sessionKey, agentId: "main", author: { id: "someone-else" } },
        });
      // Adversarial synchronous callback reentry, not ordinary network completion.
      recipients[0]!.socket.send.mockImplementationOnce(() => {
        cfg = { session: { store: alternateStore } };
        emit();
      });
      emit();
      expect(decisions).toEqual([
        ["first", true],
        ["first", false],
        ["second", false],
        ["second", false],
      ]);
      expect(recipients[0]!.socket.send).toHaveBeenCalledOnce();
      expect(recipients[1]!.socket.send).not.toHaveBeenCalled();
      cfg = {};
      emit();
      expect(recipients.map(({ socket }) => socket.send.mock.calls.length)).toEqual([2, 1]);
      removeSessionMember(scope, callerId);
      emit();
      closeOpenClawAgentDatabaseByPath(
        path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      );
      emit();
      expect(recipients.map(({ socket }) => socket.send.mock.calls.length)).toEqual([2, 1]);
      addSessionMember(scope, { identityId: callerId, addedBy: "fixture" });
      emit();
      expect(recipients.map(({ socket }) => socket.send.mock.calls.length)).toEqual([3, 2]);
    }, 1);
  });

  it("reselects the current default root after legacy discovery and a new default appears", async () => {
    await withCreatorRows(async ({ stateDir, creatorId, keys }) => {
      const sessionKey = keys[0]!;
      const client = eventClients(creatorId)[0]!.client;
      const receive = () =>
        canReceiveSessionEvent({
          cfg: {},
          client,
          sessionKeys: keys,
          event: "session.suggestion",
          payload: { suggestion: { author: { id: "someone-else" } } },
        });
      expect(receive()).toBe(true);
      // This fixture moves/recreates the file, so release path validation as well as the handle.
      disposeOpenClawAgentDatabaseByPath(
        path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      );
      closeOpenClawStateDatabaseByPath(path.join(stateDir, "state", "openclaw.sqlite"));
      const legacyRoot = path.join(path.dirname(stateDir), ".clawdbot");
      fs.renameSync(stateDir, legacyRoot);
      expect(receive()).toBe(true);
      fs.mkdirSync(stateDir);
      // Keep the visibility snapshot warm: suggestion roles must still select the new store.
      expect(receive()).toBe(false);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "current-root",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: creatorId },
        },
      );
      expect(receive()).toBe(true);
    }, 1);
  });

  it("keeps configured, retired and agent-scoped sentinel stores distinct", async () => {
    await withCreatorRows(async ({ callerId, creatorId, keys }) => {
      const cfg: OpenClawConfig = { agents: { list: [{ id: "work", default: true }] } };
      const workKey = "agent:work:prepared-work";
      const client = eventClients(creatorId)[0]!.client;
      const receive = (sessionKeys: string[], agentId?: string) =>
        canReceiveSessionEvent({
          cfg,
          client,
          sessionKeys,
          agentId,
          event: "session.suggestion",
          payload: { suggestion: { author: { id: "someone-else" } } },
        });
      const write = async (agentId: string, sessionKey: string, owner: string) => {
        await upsertSessionEntryCore(
          { agentId, sessionKey },
          {
            sessionId: `${agentId}-${sessionKey}`,
            updatedAt: 1,
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: owner },
          },
        );
        invalidateSessionSharingSnapshot(sessionKey);
      };
      try {
        await write("work", workKey, callerId);
        const workScope = { agentId: "work", sessionKey: workKey };
        addSessionMember(workScope, { identityId: creatorId, addedBy: callerId });
        expect(receive([...keys, workKey])).toBe(true);
        removeSessionMember(workScope, creatorId);
        expect(receive([...keys, workKey])).toBe(false);
        expect(receive(keys)).toBe(true);
        await write("main", "global", creatorId);
        await write("work", "global", callerId);
        for (let pass = 0; pass < 2; pass++) {
          expect(receive(["global"], "main")).toBe(true);
          expect(receive(["global"], "work")).toBe(false);
        }
      } finally {
        invalidateSessionSharingSnapshot(workKey);
        invalidateSessionSharingSnapshot("global");
      }
    }, 1);
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
      const probes = observer.finish("catalog-publications").aliasRootProbes;
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
