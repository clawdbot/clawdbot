import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  readOpenIncognitoAgentDatabaseGeneration,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail, setUserProfileRole } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { bumpSessionAutomationVersion } from "../session-automation-index.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
  sessionReadHandlers,
} from "./sessions-read-cache.test-support.js";
import type { GatewayRequestContext } from "./types.js";

const loader = vi.hoisted(() => ({
  calls: vi.fn(),
  failNext: false,
  rowCalls: vi.fn(),
  rowGate: undefined as Promise<void> | undefined,
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadCombinedSessionStoreForGatewayCore: (
      ...args: Parameters<typeof actual.loadCombinedSessionStoreForGatewayCore>
    ) => {
      loader.calls(...args);
      if (loader.failNext) {
        loader.failNext = false;
        throw new Error("synthetic store load failure");
      }
      return actual.loadCombinedSessionStoreForGatewayCore(...args);
    },
    listSessionsFromStoreAsync: async (
      ...args: Parameters<typeof actual.listSessionsFromStoreAsync>
    ) => {
      loader.rowCalls(...args);
      await loader.rowGate;
      return await actual.listSessionsFromStoreAsync(...args);
    },
  };
});

const { emitSessionsChanged } = await import("./session-change-event.js");
const { emitSessionTranscriptUpdate } = await import("../../sessions/transcript-events.js");

async function seedSessions(): Promise<OpenClawConfig> {
  const config: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true }, { id: "work" }] },
  };
  for (const [agentId, name, updatedAt, owner, overrides] of [
    ["main", "active", 400, "owner@example.com", {}],
    ["main", "draft", 300, "owner@example.com", { visibility: "draft" }],
    ["main", "archived", 200, "viewer@example.com", { archivedAt: 200 }],
    ["work", "active", 100, "viewer@example.com", {}],
  ] as const) {
    await upsertSessionEntryCore(
      { agentId, sessionKey: `agent:${agentId}:${name}` },
      {
        sessionId: `${agentId}-${name}`,
        updatedAt,
        createdActor: { type: "human", id: owner },
        visibility: "shared",
        ...overrides,
      },
    );
  }
  return config;
}

async function seedSessionsWithActivityTimes() {
  const clock = vi.spyOn(Date, "now").mockReturnValue(400);
  const config = await seedSessions();
  for (const [name, updatedAt] of [
    ["active", 400],
    ["draft", 300],
    ["archived", 200],
  ] as const) {
    const scope = { agentId: "main", sessionKey: `agent:main:${name}` };
    const entry = loadSessionEntry(scope);
    if (!entry) {
      throw new Error(`Missing seeded session ${scope.sessionKey}`);
    }
    await replaceSessionEntry(scope, { ...entry, updatedAt });
    expect(loadSessionEntry(scope)?.updatedAt).toBe(updatedAt);
  }
  return { clock, config };
}

beforeEach(() => {
  resetAgentEventsForTest();
});

afterEach(() => {
  resetAgentEventsForTest();
  vi.restoreAllMocks();
  loader.calls.mockClear();
  loader.failNext = false;
  loader.rowCalls.mockClear();
  loader.rowGate = undefined;
});

describe("sessions.list single-flight", () => {
  it.each([
    { agentId: "main", archived: false as const, limit: 10 },
    { agentId: "main", archived: true as const, limit: 1 },
    { agentId: "work", archived: "all" as const, limit: 10 },
    { archived: "all" as const, limit: 2 },
  ])("preserves output for filters and pagination: %j", async (request) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const config = await seedSessions();
      const client = identifiedClient("owner@example.com");
      const expected = await listSessions({
        client,
        context: requestContext(config),
        request,
      });
      const sharedContext = requestContext(config);

      const collapsed = await Promise.all(
        Array.from({ length: 4 }, () => listSessions({ client, context: sharedContext, request })),
      );

      expect(collapsed).toEqual(Array.from({ length: 4 }, () => expected));
    });
  });

  it("collapses concurrent identical requests to one combined store load", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      loader.calls.mockClear();

      const results = await Promise.all(
        Array.from({ length: 16 }, () =>
          listSessions({ client, context, request: { archived: "all", limit: 100 } }),
        ),
      );

      expect(loader.calls).toHaveBeenCalledTimes(1);
      expect(results.every((result) => result === results[0])).toBe(true);
    });
  });

  it("reuses a completed result until a projection fence advances", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      let diskSpaceVersion = 0;
      const context = {
        ...requestContext(config),
        workerPlacementDiskSpaceReader: {
          read: () => undefined,
          version: () => diskSpaceVersion,
        },
      };
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100 };
      const clock = vi.spyOn(Date, "now").mockReturnValue(60_400);

      const first = await listSessions({ client, context, request });
      clock.mockReturnValue(60_401);
      const cached = await listSessions({ client, context, request });
      expect(cached).toBe(first);
      expect(loader.calls).toHaveBeenCalledTimes(1);

      diskSpaceVersion += 1;
      await listSessions({ client, context, request });
      expect(loader.calls).toHaveBeenCalledTimes(2);

      emitSessionsChanged(context, { reason: "test", sessionKey: "agent:main:active" });
      await listSessions({ client, context, request });
      expect(loader.calls).toHaveBeenCalledTimes(3);
    });
  });

  it("rebuilds cached runner availability after burst inventory transitions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      let runnerAvailable = true;
      let runnerAvailabilityVersion = 0;
      const placement = {
        sessionId: "main-active",
        sessionKey: "agent:main:active",
        agentId: "main",
        executionMode: "worker-turn",
        state: "active",
        generation: 4,
        environmentId: "environment-device",
        activeOwnerEpoch: 2,
        workerBundleHash: "a".repeat(64),
        workspaceBaseManifestRef: "manifest-device",
        remoteWorkspaceDir: "/workspace",
        lastTranscriptAckCursor: null,
        lastLiveEventAckCursor: null,
        recoveryError: null,
        terminalReason: null,
        terminalAtMs: null,
        turnClaim: null,
        createdAtMs: 1,
        updatedAtMs: 2,
        stateChangedAtMs: 2,
      } satisfies WorkerSessionPlacementRecord;
      const context = {
        ...requestContext(config),
        workerSessionPlacementService: {
          getMany: () =>
            new Map<string, WorkerSessionPlacementRecord>([[placement.sessionId, placement]]),
        },
        workerPlacementRunnerAvailabilityReader: {
          read: () => ({
            kind: "device" as const,
            status: runnerAvailable ? ("available" as const) : ("offline" as const),
          }),
          version: () => runnerAvailabilityVersion,
        },
      } as GatewayRequestContext;
      const client = identifiedClient("owner@example.com");
      const request = { agentId: "main", archived: "all" as const, limit: 100 };

      const available = await listSessions({ client, context, request });
      expect(
        available.sessions.find((session) => session.key === placement.sessionKey)?.placement,
      ).toMatchObject({ runner: { kind: "device", status: "available" } });
      expect(await listSessions({ client, context, request })).toBe(available);
      expect(loader.calls).toHaveBeenCalledTimes(1);

      runnerAvailable = false;
      runnerAvailabilityVersion += 3;
      const offline = await listSessions({ client, context, request });
      expect(
        offline.sessions.find((session) => session.key === placement.sessionKey)?.placement,
      ).toMatchObject({ runner: { kind: "device", status: "offline" } });
      expect(loader.calls).toHaveBeenCalledTimes(2);
    });
  });

  it("reprojects a cached list when a completed model catalog replaces startup metadata", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      config.agents = {
        ...config.agents,
        defaults: { model: { primary: "dynamic-router/reasoner" } },
      };
      const startupCatalog: ModelCatalogEntry[] = [
        {
          provider: "dynamic-router",
          id: "reasoner",
          name: "Reasoner",
          reasoning: false,
        },
      ];
      const fullCatalog: ModelCatalogEntry[] = [
        {
          provider: "dynamic-router",
          id: "reasoner",
          name: "Reasoner",
          reasoning: true,
          compat: { supportedReasoningEfforts: ["low", "high", "max"] },
        },
      ];
      let catalog = startupCatalog;
      const context = {
        ...requestContext(config),
        readPreparedGatewayModelCatalog: vi.fn(async () => catalog),
      };
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100 };

      const first = await listSessions({ client, context, request });
      expect(first.sessions.find((session) => session.agentId === "main")?.thinkingOptions).toEqual(
        ["off"],
      );
      expect(await listSessions({ client, context, request })).toBe(first);
      expect(loader.calls).toHaveBeenCalledTimes(1);

      catalog = fullCatalog;
      const refreshed = await listSessions({ client, context, request });
      expect(refreshed).not.toBe(first);
      expect(
        refreshed.sessions.find((session) => session.agentId === "main")?.thinkingOptions,
      ).toEqual(expect.arrayContaining(["off", "low", "high", "max"]));
      expect(loader.calls).toHaveBeenCalledTimes(2);
    });
  });

  it("rebuilds configured targets after registry-only register and unregister", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = await seedSessions();
      const extraStorePath = path.join(state.stateDir, "extra-main-sessions.json");
      const extraDatabasePath = resolveSqliteTargetFromSessionStorePath(extraStorePath, {
        agentId: "main",
      }).path;
      const extraSessionKey = "agent:main:registry-only";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: extraSessionKey, storePath: extraStorePath },
        {
          sessionId: "registry-only",
          updatedAt: 500,
          createdActor: { type: "human", id: "owner@example.com" },
          visibility: "shared",
        },
      );
      closeOpenClawAgentDatabaseByPath(extraDatabasePath);
      unregisterOpenClawAgentDatabase({ agentId: "main", env: state.env, path: extraDatabasePath });

      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, configuredAgentsOnly: true, limit: 100 };
      const first = await listSessions({ client, context, request });
      expect(first.sessions.map((session) => session.key)).not.toContain(extraSessionKey);
      expect(await listSessions({ client, context, request })).toBe(first);
      expect(loader.calls).toHaveBeenCalledTimes(1);

      registerOpenClawAgentDatabase({ agentId: "main", env: state.env, path: extraDatabasePath });
      const registered = await listSessions({ client, context, request });
      expect(registered.sessions.map((session) => session.key)).toContain(extraSessionKey);
      expect(loader.calls).toHaveBeenCalledTimes(2);
      expect(await listSessions({ client, context, request })).toBe(registered);
      expect(loader.calls).toHaveBeenCalledTimes(2);

      unregisterOpenClawAgentDatabase({ agentId: "main", env: state.env, path: extraDatabasePath });
      const unregistered = await listSessions({ client, context, request });
      expect(unregistered.sessions.map((session) => session.key)).not.toContain(extraSessionKey);
      expect(loader.calls).toHaveBeenCalledTimes(3);
    });
  });

  it("fences configured lists when incognito membership opens and closes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      client.connect.scopes = [...(client.connect.scopes ?? []), "operator.admin"];
      const request = { archived: "all" as const, configuredAgentsOnly: true, limit: 100 };
      const childKey = "agent:guest:subagent:incognito-cache-fence";
      const first = await listSessions({ client, context, request });
      expect(first.sessions.map((session) => session.key)).not.toContain(childKey);
      expect(await listSessions({ client, context, request })).toBe(first);
      expect(loader.calls).toHaveBeenCalledTimes(1);

      const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "guest",
        env: state.env,
      });
      const generationBeforeOpen = readOpenIncognitoAgentDatabaseGeneration();
      const database = openOpenClawAgentDatabase({
        agentId: "guest",
        env: state.env,
        path: incognitoPath,
      });
      const openedGeneration = readOpenIncognitoAgentDatabaseGeneration();
      expect(openedGeneration).toBeGreaterThan(generationBeforeOpen);
      expect(
        openOpenClawAgentDatabase({ agentId: "guest", env: state.env, path: incognitoPath }),
      ).toBe(database);
      expect(readOpenIncognitoAgentDatabaseGeneration()).toBe(openedGeneration);
      const entry = {
        sessionId: "incognito-cache-fence",
        updatedAt: 600,
        incognito: true,
        parentSessionKey: "agent:main:active",
      };
      database.db
        .prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, parent_session_key) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          childKey,
          entry.sessionId,
          JSON.stringify(entry),
          entry.updatedAt,
          entry.parentSessionKey,
        );
      database.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(childKey);

      const opened = await listSessions({ client, context, request });
      expect(opened.sessions.map((session) => session.key)).toContain(childKey);
      expect(loader.calls).toHaveBeenCalledTimes(2);

      expect(closeOpenClawAgentDatabaseByPath(incognitoPath)).toBe(true);
      const closed = await listSessions({ client, context, request });
      expect(closed.sessions.map((session) => session.key)).not.toContain(childKey);
      expect(loader.calls).toHaveBeenCalledTimes(3);
    });
  });

  it("invalidates a completed result after terminal lifecycle persistence lands", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100 };
      const clock = vi.spyOn(Date, "now").mockReturnValue(60_400);

      const first = await listSessions({ client, context, request });
      clock.mockReturnValue(60_401);
      expect(await listSessions({ client, context, request })).toBe(first);
      expect(loader.calls).toHaveBeenCalledTimes(1);

      // The terminal entry write (status/endedAt/runtimeMs) commits after the
      // run-index fence bumped at lifecycle end. A list computed in that
      // window cached the pre-terminal row; the persistence fence evicts it.
      await persistGatewaySessionLifecycleEvent({
        sessionKey: "agent:main:active",
        agentId: "main",
        event: {
          ts: 60_500,
          runId: "run-terminal-fence",
          data: { phase: "end", startedAt: 60_000, endedAt: 60_450 },
        },
      });
      await listSessions({ client, context, request });
      expect(loader.calls).toHaveBeenCalledTimes(2);
    });
  });

  it("invalidates a completed result after a committed transcript update", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100 };
      const clock = vi.spyOn(Date, "now").mockReturnValue(60_400);

      const first = await listSessions({ client, context, request });
      clock.mockReturnValue(60_401);

      // A transcript commit changes row previews/derived titles without any
      // session-entry mutation; serving the cached page would hide it forever.
      emitSessionTranscriptUpdate({
        target: { agentId: "main", sessionId: "main-active", sessionKey: "agent:main:active" },
      });
      const refreshed = await listSessions({ client, context, request });
      expect(refreshed).not.toBe(first);
      expect(loader.calls).toHaveBeenCalledTimes(2);
    });
  });

  it("invalidates a completed result when a cron automation binding changes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100 };
      const clock = vi.spyOn(Date, "now").mockReturnValue(60_400);

      const first = await listSessions({ client, context, request });
      clock.mockReturnValue(60_401);
      expect(await listSessions({ client, context, request })).toBe(first);
      expect(loader.calls).toHaveBeenCalledTimes(1);

      // Cron job add/remove/enable changes hasAutomation on projected rows but
      // historically bumped only the automation memo, so cached lists served
      // stale badges forever.
      bumpSessionAutomationVersion();
      await listSessions({ client, context, request });
      expect(loader.calls).toHaveBeenCalledTimes(2);
    });
  });

  it("does not cache title rows degraded during projection rebuild", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = await seedSessions();
      const sessionKey = "agent:main:active";
      const sessionId = "main-active";
      await persistSessionTranscriptTurn(
        { agentId: "main", sessionId, sessionKey },
        {
          messages: [
            { message: { role: "user", content: "active prompt" } },
            { message: { role: "assistant", content: "active reply" } },
          ],
          touchSessionEntry: false,
        },
      );
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      database.db
        .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
        .run(sessionId);
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = {
        agentId: "main",
        archived: "all" as const,
        includeDerivedTitles: true,
        includeLastMessage: true,
        limit: 100,
      };

      const degraded = await listSessions({ client, context, request });
      const degradedRow = degraded.sessions.find((session) => session.key === sessionKey);
      expect(degradedRow?.derivedTitle).not.toBe("active prompt");
      expect(degradedRow?.lastMessagePreview).toBeUndefined();

      await waitForSessionTranscriptIndexReconcile({ agentId: "main", env: state.env });
      const healed = await listSessions({ client, context, request });
      expect(healed.sessions.find((session) => session.key === sessionKey)).toMatchObject({
        derivedTitle: "active prompt",
        lastMessagePreview: "active reply",
      });
      expect(loader.calls).toHaveBeenCalledTimes(2);

      expect(await listSessions({ client, context, request })).toBe(healed);
      expect(loader.calls).toHaveBeenCalledTimes(2);
    });
  });

  it("invalidates a completed result after an external session identity mutation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100 };

      const first = await listSessions({ client, context, request });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:external" },
        {
          sessionId: "main-external",
          updatedAt: 500,
          createdActor: { type: "human", id: "owner@example.com" },
          visibility: "shared",
        },
      );
      const refreshed = await listSessions({ client, context, request });

      expect(refreshed).not.toBe(first);
      expect(loader.calls).toHaveBeenCalledTimes(2);
      expect(refreshed.sessions.map((session) => session.key)).toContain("agent:main:external");
    });
  });

  it("expires completed rows at the earliest projected agent-status deadline", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const config = await seedSessions();
      for (const [name, expiresAt] of [
        ["active", 1_100],
        ["draft", 1_200],
      ] as const) {
        const scope = { agentId: "main", sessionKey: `agent:main:${name}` };
        const entry = loadSessionEntry(scope);
        if (!entry) {
          throw new Error(`Missing seeded session ${scope.sessionKey}`);
        }
        await replaceSessionEntry(scope, {
          ...entry,
          agentStatus: { note: `${name} needs attention`, expiresAt },
        });
      }
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { agentId: "main", archived: "all" as const, limit: 100 };

      const first = await listSessions({ client, context, request });
      expect(
        first.sessions.find((session) => session.key === "agent:main:active")?.agentStatus,
      ).toMatchObject({ expiresAt: 1_100 });
      expect(
        first.sessions.find((session) => session.key === "agent:main:draft")?.agentStatus,
      ).toMatchObject({ expiresAt: 1_200 });

      clock.mockReturnValue(1_099);
      expect(await listSessions({ client, context, request })).toBe(first);
      expect(loader.calls).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(1_100);
      const expired = await Promise.all(
        Array.from({ length: 8 }, () => listSessions({ client, context, request })),
      );
      expect(expired.every((result) => result === expired[0])).toBe(true);
      expect(
        expired[0]?.sessions.find((session) => session.key === "agent:main:active")?.agentStatus,
      ).toBeUndefined();
      expect(
        expired[0]?.sessions.find((session) => session.key === "agent:main:draft")?.agentStatus,
      ).toMatchObject({ expiresAt: 1_200 });
      expect(loader.calls).toHaveBeenCalledTimes(2);

      clock.mockReturnValue(1_199);
      expect(await listSessions({ client, context, request })).toBe(expired[0]);

      clock.mockReturnValue(1_200);
      const allExpired = await listSessions({ client, context, request });
      expect(
        allExpired.sessions.find((session) => session.key === "agent:main:draft")?.agentStatus,
      ).toBeUndefined();
      expect(loader.calls).toHaveBeenCalledTimes(3);
    });
  });

  it("expires retained child links when the child is outside the visible page", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { clock, config } = await seedSessionsWithActivityTimes();
      const parentSessionKey = "agent:main:active";
      const childSessionKey = "agent:main:zzz-child";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: childSessionKey },
        {
          sessionId: "completed-hidden-child",
          endedAt: 400,
          parentSessionKey,
          spawnedBy: parentSessionKey,
          status: "done",
          updatedAt: 400,
          visibility: "shared",
        },
      );
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { agentId: "main", archived: "all" as const, limit: 1 };

      clock.mockReturnValue(1_800_400);
      const retained = await listSessions({ client, context, request });
      expect(retained.sessions.map((session) => session.key)).toEqual([parentSessionKey]);
      expect(retained.sessions[0]?.childSessions).toEqual([childSessionKey]);

      clock.mockReturnValue(1_800_401);
      const expired = await listSessions({ client, context, request });
      expect(expired.sessions.map((session) => session.key)).toEqual([parentSessionKey]);
      expect(expired.sessions[0]?.childSessions).toBeUndefined();
      expect(loader.calls).toHaveBeenCalledTimes(2);
    });
  });

  it("refreshes live subagent runtimes while retaining concurrent single-flight", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const now = 1_800_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const config = await seedSessions();
      const runId = "sessions-list-cache-live-subagent";
      addSubagentRunForTests({
        runId,
        childSessionKey: "agent:main:active",
        controllerSessionKey: "agent:main:draft",
        requesterSessionKey: "agent:main:draft",
        requesterDisplayKey: "main",
        task: "prove session runtime freshness",
        cleanup: "keep",
        createdAt: now - 1_000,
        startedAt: now - 1_000,
      });
      registerAgentRunContext(runId, {
        agentId: "main",
        projectSessionActive: true,
        sessionId: "main-active",
        sessionKey: "agent:main:active",
      });
      try {
        const context = requestContext(config);
        const client = identifiedClient("owner@example.com");
        const request = { agentId: "main", archived: "all" as const, limit: 1 };

        const first = await listSessions({ client, context, request });
        expect(first.sessions[0]).toMatchObject({
          key: "agent:main:active",
          hasActiveSubagentRun: true,
          runtimeMs: 1_000,
        });

        clock.mockReturnValue(now + 250);
        const fresh = await Promise.all(
          Array.from({ length: 8 }, () => listSessions({ client, context, request })),
        );
        expect(fresh.every((result) => result === fresh[0])).toBe(true);
        expect(fresh[0]?.sessions[0]).toMatchObject({
          hasActiveSubagentRun: true,
          runtimeMs: 1_250,
        });
        expect(loader.calls).toHaveBeenCalledTimes(2);
      } finally {
        clearAgentRunContext(runId);
        resetSubagentRegistryForTests({ persist: false });
      }
    });
  });

  it.each([
    {
      description: "the last visible row crosses the inclusive activity cutoff",
      now: 60_400,
      limit: 100,
      before: { keys: ["agent:main:active"], totalCount: 1 },
      after: { keys: [], totalCount: 0 },
    },
    {
      description: "an older row outside the current page expires",
      now: 60_200,
      limit: 1,
      before: { keys: ["agent:main:active"], totalCount: 3 },
      after: { keys: ["agent:main:active"], totalCount: 2 },
    },
  ])("refreshes activity-filtered results when $description", async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { clock, config } = await seedSessionsWithActivityTimes();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      clock.mockReturnValue(scenario.now);
      const request = {
        activeMinutes: 1,
        agentId: "main",
        archived: "all" as const,
        limit: scenario.limit,
      };

      const before = await listSessions({ client, context, request });
      expect(before.sessions.map((session) => session.key)).toEqual(scenario.before.keys);
      expect(before.totalCount).toBe(scenario.before.totalCount);

      clock.mockReturnValue(scenario.now + 1);
      const after = await listSessions({ client, context, request });
      expect(after.sessions.map((session) => session.key)).toEqual(scenario.after.keys);
      expect(after.totalCount).toBe(scenario.after.totalCount);
      expect(loader.calls).toHaveBeenCalledTimes(2);
    });
  });

  it("collapses concurrent activity-filtered requests into one projection", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { clock, config } = await seedSessionsWithActivityTimes();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      clock.mockReturnValue(60_400);
      const request = { activeMinutes: 1, agentId: "main", limit: 100 };

      const results = await Promise.all(
        Array.from({ length: 8 }, () => listSessions({ client, context, request })),
      );

      expect(results[0]?.sessions.map((session) => session.key)).toEqual(["agent:main:active"]);
      expect(results.every((result) => result === results[0])).toBe(true);
      expect(loader.calls).toHaveBeenCalledTimes(1);
    });
  });

  it("expires completed children from parent-filtered listings at the retention boundary", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { clock, config } = await seedSessionsWithActivityTimes();
      const parentSessionKey = "agent:main:active";
      const childSessionKey = "agent:main:child";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: childSessionKey },
        {
          sessionId: "completed-child",
          endedAt: 400,
          parentSessionKey,
          spawnedBy: parentSessionKey,
          status: "done",
          updatedAt: 400,
          visibility: "shared",
        },
      );
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { agentId: "main", limit: 100, spawnedBy: parentSessionKey };

      clock.mockReturnValue(1_800_400);
      const retained = await listSessions({ client, context, request });
      expect(retained.sessions.map((session) => session.key)).toEqual([childSessionKey]);

      clock.mockReturnValue(1_800_401);
      const expired = await listSessions({ client, context, request });
      expect(expired.sessions).toEqual([]);
      expect(loader.calls).toHaveBeenCalledTimes(2);
    });
  });

  it("rejects a zero-minute activity window without loading the session store", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const respond = vi.fn();

      await sessionReadHandlers["sessions.list"]?.({
        params: { activeMinutes: 0 },
        client: identifiedClient("owner@example.com"),
        context: requestContext(config),
        respond,
      } as never);

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(loader.calls).not.toHaveBeenCalled();
    });
  });

  it("rebuilds a completed result when a projected run ends without a store mutation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { agentId: "main", archived: "all" as const, limit: 100 };
      const runId = "sessions-list-cache-active-run";
      registerAgentRunContext(runId, {
        agentId: "main",
        projectSessionActive: true,
        sessionId: "main-active",
        sessionKey: "agent:main:active",
      });

      const active = await listSessions({ client, context, request });
      expect(active.sessions.find((session) => session.key === "agent:main:active")).toMatchObject({
        hasActiveRun: true,
      });
      const activeCached = await listSessions({ client, context, request });
      expect(activeCached).not.toBe(active);
      expect(
        activeCached.sessions.find((session) => session.key === "agent:main:active"),
      ).toMatchObject({ hasActiveRun: true });
      expect(loader.calls).toHaveBeenCalledTimes(2);

      clearAgentRunContext(runId);
      const settled = await listSessions({ client, context, request });
      expect(settled.sessions.find((session) => session.key === "agent:main:active")).toMatchObject(
        {
          hasActiveRun: false,
        },
      );
      expect(loader.calls).toHaveBeenCalledTimes(3);

      const settledCached = await listSessions({ client, context, request });
      expect(settledCached).toBe(settled);
      expect(loader.calls).toHaveBeenCalledTimes(3);
    });
  });

  it("does not cache a reply-owned active projection past turn completion", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { agentId: "main", archived: "all" as const, limit: 100 };
      const operation = createReplyOperation({
        sessionId: "main-active",
        sessionKey: "agent:main:active",
        resetTriggered: false,
      });

      try {
        const active = await listSessions({ client, context, request });
        expect(
          active.sessions.find((session) => session.key === "agent:main:active"),
        ).toMatchObject({ hasActiveRun: true });

        operation.complete();
        const settled = await listSessions({ client, context, request });
        expect(
          settled.sessions.find((session) => session.key === "agent:main:active"),
        ).toMatchObject({ hasActiveRun: false });
        expect(loader.calls).toHaveBeenCalledTimes(2);
      } finally {
        operation.complete();
      }
    });
  });

  it.each(["ownerFirst", "involvingMe"] as const)(
    "keeps administrator %s projections scoped to their authenticated profiles",
    async (projection) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const config: OpenClawConfig = { agents: { list: [{ id: "main", default: true }] } };
        const context = requestContext(config);
        const clients = ["ada@example.com", "bob@example.com"].map((email) => {
          const client = identifiedClient(ensureProfileForEmail(email).id);
          client.connect.scopes = ["operator.admin"];
          return client;
        });
        for (const [index, client] of clients.entries()) {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: `agent:main:profile-${index}` },
            {
              sessionId: `profile-${index}`,
              updatedAt: index + 1,
              createdVia: "operator",
              createdActor: { type: "human", id: client.authenticatedUserProfile!.profileId },
            },
          );
        }
        const request: SessionsListParams = { agentId: "main", limit: 1, [projection]: true };

        const results = await Promise.all(
          clients.map((client) => listSessions({ client, context, request })),
        );

        for (const [index, client] of clients.entries()) {
          expect(results[index]?.sessions[0]?.key).toBe(`agent:main:profile-${index}`);
          expect(await listSessions({ client, context, request })).toBe(results[index]);
        }
        expect(loader.calls).toHaveBeenCalledTimes(2);
      });
    },
  );

  it("fences cached rows across client identities and operator-role changes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);

      const [owner, viewer] = await Promise.all([
        listSessions({
          client: identifiedClient("owner@example.com"),
          context,
          request: { agentId: "main", archived: "all", limit: 100 },
        }),
        listSessions({
          client: identifiedClient("viewer@example.com"),
          context,
          request: { agentId: "main", archived: "all", limit: 100 },
        }),
      ]);

      expect(owner.sessions.map((session) => session.key)).toContain("agent:main:draft");
      expect(viewer.sessions.map((session) => session.key)).not.toContain("agent:main:draft");
      expect(loader.calls).toHaveBeenCalledTimes(2);
      const scopes: Array<"operator.read" | "operator.write"> = ["operator.read", "operator.write"];
      const defineRole = (others: "write" | "none") => ({
        sessions: { others },
        agents: "*" as const,
        scopes,
      });
      config.gateway = {
        roles: {
          default: "maintainer",
          definitions: {
            maintainer: defineRole("write"),
            guest: defineRole("none"),
          },
        },
      };
      const profile = ensureProfileForEmail("cache-role@example.com");
      const request = { agentId: "main", archived: "all" as const, limit: 100 };
      const listProfileSessions = () =>
        listSessions({ client: identifiedClient(profile.id), context, request });
      const privileged = await listProfileSessions();
      expect(privileged.sessions.map((session) => session.key)).toContain("agent:main:active");
      setUserProfileRole(profile.id, "guest");
      invalidateOperatorRolePolicy(profile.id);
      const restricted = await listProfileSessions();
      expect(restricted.sessions.map((session) => session.key)).not.toContain("agent:main:active");
      expect(loader.calls).toHaveBeenCalledTimes(4);
    });
  });

  it("refills a page from the loaded store when a selected row becomes hidden", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      for (const [name, updatedAt] of [
        ["third", 500],
        ["second", 600],
        ["first", 700],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:page-${name}` },
          {
            sessionId: `page-${name}`,
            updatedAt,
            createdActor: { type: "human", id: "owner@example.com" },
            visibility: "shared",
          },
        );
      }
      const context = requestContext(config);
      const client = identifiedClient("viewer@example.com");
      let releaseRows!: () => void;
      loader.rowGate = new Promise<void>((resolve) => {
        releaseRows = resolve;
      });

      const firstPage = listSessions({
        client,
        context,
        request: { agentId: "main", archived: "all", limit: 1 },
      });
      await vi.waitFor(() => expect(loader.rowCalls).toHaveBeenCalledOnce());
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:page-first" },
        { visibility: "draft", updatedAt: 800 },
      );
      emitSessionsChanged(context, {
        reason: "sharing",
        sessionKey: "agent:main:page-first",
      });
      releaseRows();

      const repaired = await firstPage;
      expect(repaired.sessions.map((session) => session.key)).toEqual(["agent:main:page-second"]);
      expect(repaired).toMatchObject({ count: 1, nextOffset: 1 });
      expect(loader.calls).toHaveBeenCalledTimes(1);
      expect(loader.rowCalls).toHaveBeenCalledTimes(2);

      loader.rowGate = undefined;
      const next = await listSessions({
        client,
        context,
        request: { agentId: "main", archived: "all", limit: 1, offset: 1 },
      });
      expect(next.sessions.map((session) => session.key)).toEqual(["agent:main:page-third"]);
    });
  });

  it("rejects followers and retries after an underlying store failure", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100 };
      loader.failNext = true;

      await expect(
        Promise.all(Array.from({ length: 4 }, () => listSessions({ client, context, request }))),
      ).rejects.toThrow("synthetic store load failure");
      await expect(listSessions({ client, context, request })).resolves.toMatchObject({
        sessions: expect.any(Array),
      });

      expect(loader.calls).toHaveBeenCalledTimes(2);
    });
  });

  it("does not share work that started before an intervening session mutation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      let releaseRows!: () => void;
      loader.rowGate = new Promise<void>((resolve) => {
        releaseRows = resolve;
      });
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100 };

      const beforeMutation = listSessions({ client, context, request });
      await vi.waitFor(() => expect(loader.rowCalls).toHaveBeenCalledTimes(1));
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:created-mid-list" },
        { sessionId: "created-mid-list", updatedAt: 500, visibility: "shared" },
      );
      emitSessionsChanged(context, {
        reason: "test",
        sessionKey: "agent:main:created-mid-list",
      });
      const afterMutation = listSessions({ client, context, request });
      await vi.waitFor(() => expect(loader.rowCalls).toHaveBeenCalledTimes(2));
      releaseRows();

      const [stale, fresh] = await Promise.all([beforeMutation, afterMutation]);
      expect(stale.sessions.map((session) => session.key)).not.toContain(
        "agent:main:created-mid-list",
      );
      expect(fresh.sessions.map((session) => session.key)).toContain("agent:main:created-mid-list");
      expect(loader.calls).toHaveBeenCalledTimes(2);
    });
  });
});
