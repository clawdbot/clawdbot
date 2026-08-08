import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.test-helpers.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

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
    loadCombinedSessionStoreForGateway: (
      ...args: Parameters<typeof actual.loadCombinedSessionStoreForGateway>
    ) => {
      loader.calls(...args);
      if (loader.failNext) {
        loader.failNext = false;
        throw new Error("synthetic store load failure");
      }
      return actual.loadCombinedSessionStoreForGateway(...args);
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

const { sessionReadHandlers } = await import("./sessions-read.js");
const { emitSessionsChanged } = await import("./session-change-event.js");

function identifiedClient(profileId: string): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
    authenticatedUserProfile: {
      profileId,
      displayName: profileId,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

function requestContext(config: OpenClawConfig): GatewayRequestContext {
  return {
    chatAbortControllers: new Map(),
    getRuntimeConfig: () => config,
    getSessionEventSubscriberConnIds: () => new Set(),
    loadGatewayModelCatalog: async () => [],
    logGateway: { debug: vi.fn() },
  } as unknown as GatewayRequestContext;
}

async function listSessions(params: {
  client: GatewayClient;
  context: GatewayRequestContext;
  request: SessionsListParams;
}) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionReadHandlers["sessions.list"]?.({
    params: params.request,
    client: params.client,
    context: params.context,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  expect(responses).toHaveLength(1);
  expect(responses[0]?.[0]).toBe(true);
  return responses[0]?.[1] as {
    count: number;
    nextOffset: number | null;
    sessions: GatewaySessionRow[];
    totalCount: number;
  };
}

async function seedSessions(): Promise<OpenClawConfig> {
  const config: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true }, { id: "work" }] },
  };
  await upsertSessionEntry(
    { agentId: "main", sessionKey: "agent:main:active" },
    {
      sessionId: "main-active",
      updatedAt: 400,
      createdActor: { type: "human", id: "owner@example.com" },
      visibility: "shared",
    },
  );
  await upsertSessionEntry(
    { agentId: "main", sessionKey: "agent:main:draft" },
    {
      sessionId: "main-draft",
      updatedAt: 300,
      createdActor: { type: "human", id: "owner@example.com" },
      visibility: "draft",
    },
  );
  await upsertSessionEntry(
    { agentId: "main", sessionKey: "agent:main:archived" },
    {
      sessionId: "main-archived",
      updatedAt: 200,
      archivedAt: 200,
      createdActor: { type: "human", id: "viewer@example.com" },
      visibility: "shared",
    },
  );
  await upsertSessionEntry(
    { agentId: "work", sessionKey: "agent:work:active" },
    {
      sessionId: "work-active",
      updatedAt: 100,
      createdActor: { type: "human", id: "viewer@example.com" },
      visibility: "shared",
    },
  );
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

  it("reuses a completed result until the session mutation version advances", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100 };
      const clock = vi.spyOn(Date, "now").mockReturnValue(60_400);

      const first = await listSessions({ client, context, request });
      clock.mockReturnValue(60_401);
      const cached = await listSessions({ client, context, request });
      expect(cached).toBe(first);
      expect(loader.calls).toHaveBeenCalledTimes(1);

      emitSessionsChanged(context, { reason: "test", sessionKey: "agent:main:active" });
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
      await upsertSessionEntry(
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
      await upsertSessionEntry(
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
      await upsertSessionEntry(
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

  it("does not share filtered results across client identities", async () => {
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
        await upsertSessionEntry(
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
      await upsertSessionEntry(
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
      await upsertSessionEntry(
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
