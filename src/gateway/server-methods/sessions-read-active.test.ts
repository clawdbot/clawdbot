import { afterEach, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { EmbeddedAgentQueueHandle } from "../../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  createReplyOperation,
  markReplyOperationExecutionStarted,
} from "../../auto-reply/reply/reply-run-registry.js";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { registerAgentRunCapacityWait } from "../../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as sessionUtils from "../session-utils.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
  seedSessions,
  seedSessionsWithActivityTimes,
} from "./sessions-read-cache.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetSubagentRegistryForTests({ persist: false });
  resetAgentEventsForTest();
});

it("selects current work before pagination and represents an isolated cron run once", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
    };
    const context = requestContext(config);
    const client = identifiedClient("viewer@example.test");
    const childKey = "agent:main:subagent:child";
    const cronKey = "agent:main:cron:daily";
    const runKey = `${cronKey}:run:cron-session`;
    for (const [agentId, sessionKey, sessionId, updatedAt] of [
      ["main", "agent:main:local", "local-session", 40],
      ["work", "agent:work:remote", "remote-session", 30],
      ["main", childKey, "child-session", 20],
      ["main", cronKey, "cron-session", 10],
      ["main", runKey, "cron-session", 10],
      ["main", "agent:main:parent", "parent-session", 100],
      ["main", "agent:main:hidden", "hidden-session", 101],
      ["main", "agent:main:settled", "settled-session", 102],
      ["main", "agent:main:stale-status", "stale-session", 103],
    ] as const) {
      const scope = { agentId, sessionKey };
      const entry = await upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt,
        status: "running",
        visibility: "shared",
      });
      await replaceSessionEntry(scope, { ...entry!, updatedAt });
    }
    context.chatAbortControllers.set("local-run", {
      sessionKey: "agent:main:local",
      sessionId: "local-session",
      agentId: "main",
    } as never);
    context.chatAbortControllers.set("hidden-run", {
      sessionKey: "agent:main:hidden",
      controlUiVisible: false,
    } as never);
    context.chatAbortControllers.set("settled-run", {
      sessionKey: "agent:main:settled",
      projectSessionActive: false,
    } as never);
    registerAgentRunContext("remote-run", {
      agentId: "work",
      sessionKey: "agent:work:remote",
      sessionId: "remote-session",
      projectSessionActive: true,
      isControlUiVisible: false,
    });
    registerAgentRunContext("cron-run", {
      agentId: "main",
      sessionKey: runKey,
      sessionId: "cron-session",
      projectSessionActive: true,
    });
    addSubagentRunForTests({
      runId: "child-run",
      childSessionKey: childKey,
      controllerSessionKey: "agent:main:parent",
      requesterSessionKey: "agent:main:parent",
      requesterDisplayKey: "parent",
      task: "Current child task",
      cleanup: "keep",
      createdAt: 1,
      startedAt: 2,
    });
    registerAgentRunContext("child-run", { sessionKey: childKey, agentId: "main" });
    const releaseWait = registerAgentRunCapacityWait("child-run", getAgentRunLifecycleGeneration());
    try {
      const normal = await listSessions({ client, context, request: { limit: 2 } });
      expect(normal.sessions.map((row) => row.key)).toEqual([
        "agent:main:stale-status",
        "agent:main:settled",
      ]);
      const unchanged = await listSessions({
        client,
        context,
        request: { activeOnly: false, limit: 2 },
      });
      expect(unchanged.sessions.map((row) => row.key)).toEqual(
        normal.sessions.map((row) => row.key),
      );

      const request = { activeOnly: true, limit: 2 };
      const first = await listSessions({ client, context, request });
      expect(first).toMatchObject({ count: 2, totalCount: 4, nextOffset: 2 });
      expect(first.sessions).toMatchObject([
        {
          key: "agent:main:local",
          hasActiveRun: true,
          status: "running",
          activeRunIds: ["local-run"],
        },
        { key: "agent:work:remote", hasActiveRun: true, status: "running" },
      ]);
      expect(first.sessions[1]).not.toHaveProperty("activeRunIds");
      const second = await listSessions({ client, context, request: { ...request, offset: 2 } });
      expect(second).toMatchObject({ count: 2, totalCount: 4, nextOffset: null });
      expect(second.sessions).toMatchObject([
        { key: childKey, hasActiveRun: true, status: "queued" },
        { key: cronKey, hasActiveRun: true, status: "running" },
      ]);
    } finally {
      releaseWait?.();
      for (const runId of ["remote-run", "cron-run", "child-run"]) {
        clearAgentRunContext(runId);
      }
    }
  });
});

it.each(["global", "unknown"] as const)(
  "keeps %s activity with its agent when physical stores share a session ID",
  async (sessionKey) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { scope: "global", store: state.statePath("{agentId}.sqlite") },
      };
      const sessionId = `restored-${sessionKey}`;
      const runId = `ops-${sessionKey}-run`;
      for (const agentId of ["main", "ops"]) {
        await upsertSessionEntryCore(
          { agentId, sessionKey, storePath: state.statePath(`${agentId}.sqlite`) },
          { sessionId, updatedAt: 1, visibility: "shared" },
        );
      }
      const context = requestContext(config);
      const client = identifiedClient("viewer@example.test");
      const request = { activeOnly: true, includeGlobal: true, includeUnknown: true, limit: 100 };
      const activeOwners = async () =>
        (await listSessions({ client, context, request })).sessions.map((row) => row.agentId);
      const handle: EmbeddedAgentQueueHandle = {
        runId,
        abort: () => undefined,
        isAborted: () => false,
        isCompacting: () => false,
        isStreaming: () => true,
        queueMessage: async () => undefined,
      };
      let reply: ReturnType<typeof createReplyOperation> | undefined;
      registerAgentRunContext(runId, {
        agentId: "ops",
        sessionId,
        sessionKey,
        projectSessionActive: true,
      });
      try {
        await expect(activeOwners()).resolves.toEqual(["ops"]);
        setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, "ops");
        await expect(activeOwners()).resolves.toEqual(["ops"]);
        clearAgentRunContext(runId);
        await expect(activeOwners()).resolves.toEqual(["ops"]);
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);

        reply = createReplyOperation({
          agentId: "ops",
          sessionId,
          sessionKey,
          resetTriggered: false,
        });
        await expect(activeOwners()).resolves.toEqual(["ops"]);
        markReplyOperationExecutionStarted(reply);
        await expect(activeOwners()).resolves.toEqual(["ops"]);
        reply.complete();
        await expect(activeOwners()).resolves.toEqual([]);
      } finally {
        reply?.complete();
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        clearAgentRunContext(runId);
      }
    });
  },
);

it.each(["global", "unknown"] as const)(
  "keeps active %s owners and their physical transcript, board, and sharing rows distinct",
  async (sentinel) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agents = ["main", "ops", "research", "private"] as const;
      const config: OpenClawConfig = {
        session: { scope: "global", store: state.statePath("{agentId}.sqlite") },
        agents: { list: agents.map((id) => ({ id, ...(id === "main" ? { default: true } : {}) })) },
      };
      const context = requestContext(config);
      const client = identifiedClient("viewer@example.test");
      const storePathFor = (agentId: string) => state.statePath(`${agentId}.sqlite`);
      const boardFace = "chat" as const;
      for (const [index, agentId] of agents.entries()) {
        const sessionId = `${sentinel}-${agentId}`;
        const storePath = storePathFor(agentId);
        openOpenClawAgentDatabase({ agentId, path: storePath });
        const scope = { agentId, storePath, sessionKey: sentinel };
        const entry = await upsertSessionEntryCore(scope, {
          sessionId,
          boardFace,
          updatedAt: 100 - index,
          visibility: agentId === "private" ? "draft" : "shared",
          createdActor: { type: "human", source: "profile", id: "owner@example.test" },
        });
        await replaceSessionEntry(scope, { ...entry!, updatedAt: 100 - index });
        await persistSessionTranscriptTurn(
          { agentId, storePath, sessionKey: sentinel, sessionId },
          {
            messages: [
              { message: { role: "user", content: `${agentId} task` } },
              { message: { role: "assistant", content: `${agentId} progress` } },
            ],
            touchSessionEntry: false,
          },
        );
        if (agentId !== "main") {
          context.chatAbortControllers.set(`sentinel-run-${agentId}`, {
            sessionKey: sentinel,
            sessionId,
            agentId,
          } as never);
        }
      }
      const childKey = `agent:ops:subagent:${sentinel}-child`;
      await upsertSessionEntryCore(
        { agentId: "ops", storePath: storePathFor("ops"), sessionKey: childKey },
        {
          sessionId: "sentinel-child",
          updatedAt: 1,
          parentSessionKey: sentinel,
          spawnedBy: sentinel,
          visibility: "shared",
        },
      );
      addSubagentRunForTests({
        runId: "sentinel-child-run",
        childSessionKey: childKey,
        controllerSessionKey: sentinel,
        requesterSessionKey: sentinel,
        requesterAgentId: "ops",
        requesterDisplayKey: sentinel,
        swarmRequesterSessionKey: sentinel,
        collect: true,
        groupId: "ops-group",
        task: "Current child task",
        cleanup: "keep",
        createdAt: 1,
        startedAt: 2,
      });
      registerAgentRunContext("sentinel-child-run", { sessionKey: childKey, agentId: "ops" });
      const literalKey = `agent:ops:${sentinel}`;
      const literalSessionId = `literal-${sentinel}`;
      const literalScope = {
        agentId: "ops",
        storePath: storePathFor("ops"),
        sessionKey: literalKey,
      };
      const literalEntry = await upsertSessionEntryCore(literalScope, {
        sessionId: literalSessionId,
        boardFace,
        updatedAt: 1,
        visibility: "shared",
      });
      await replaceSessionEntry(literalScope, { ...literalEntry!, updatedAt: 1 });
      context.chatAbortControllers.set("literal-sentinel-run", {
        sessionKey: literalKey,
        sessionId: literalSessionId,
        agentId: "ops",
      } as never);
      new SqliteBoardStore({
        resolveSession: () => ({ agentId: "ops", path: storePathFor("ops"), sessionKey: sentinel }),
      }).applyOps({ sessionKey: sentinel }, [{ kind: "tab_create", tabId: "main", title: "Ops" }]);
      const normal = await listSessions({
        client,
        context,
        request: { boardFace, includeGlobal: true, includeUnknown: true },
      });
      expect(normal.sessions).toMatchObject([
        { key: sentinel, agentId: "main", hasActiveRun: false },
        { key: literalKey, agentId: "ops", kind: "direct", hasActiveRun: true },
      ]);
      expect(normal.count).toBe(2);

      const request = {
        activeOnly: true,
        boardFace,
        includeGlobal: true,
        includeUnknown: true,
        includeDerivedTitles: true,
        includeLastMessage: true,
        archived: "all" as const,
        limit: 10,
      };
      const active = await listSessions({ client, context, request });
      expect(active).toMatchObject({ count: 3, totalCount: 3, nextOffset: null });
      expect(active.sessions).toMatchObject([
        {
          key: sentinel,
          agentId: "ops",
          kind: sentinel,
          boardFace,
          hasActiveRun: true,
          derivedTitle: "ops task",
          lastMessagePreview: "ops progress",
        },
        {
          key: sentinel,
          agentId: "research",
          kind: sentinel,
          boardFace,
          hasActiveRun: true,
          derivedTitle: "research task",
          lastMessagePreview: "research progress",
        },
        {
          key: literalKey,
          agentId: "ops",
          kind: "direct",
          sessionId: literalSessionId,
          hasActiveRun: true,
        },
      ]);
      expect(JSON.stringify(active)).not.toContain(`${sentinel}-private`);
      for (const row of active.sessions.filter((candidate) => candidate.key === sentinel)) {
        expect(row).not.toHaveProperty("childSessions");
        expect(row).not.toHaveProperty("hasActiveSubagentRun");
      }
      expect(active.sessions[0]?.swarm?.groups).toMatchObject([
        { groupId: "ops-group", running: 1 },
      ]);
      expect(active.sessions[1]?.swarm).toBeUndefined();
      const scoped = await listSessions({
        client,
        context,
        request: { ...request, agentId: "ops" },
      });
      expect(scoped.sessions.map((row) => [row.key, row.agentId])).toEqual([
        [sentinel, "ops"],
        [literalKey, "ops"],
      ]);
      const excluded = sentinel === "global" ? { includeGlobal: false } : { includeUnknown: false };
      for (const filter of [{ search: "direct" }, excluded]) {
        const literalOnly = await listSessions({
          client,
          context,
          request: { ...request, ...filter },
        });
        expect(literalOnly.sessions).toMatchObject([
          { key: literalKey, agentId: "ops", kind: "direct", sessionId: literalSessionId },
        ]);
        expect(literalOnly.count).toBe(1);
      }
      for (const hasBoard of [true, false]) {
        const listed = await listSessions({ client, context, request: { ...request, hasBoard } });
        expect(listed.sessions.map((row) => [row.key, row.agentId])).toEqual(
          hasBoard
            ? [[sentinel, "ops"]]
            : [
                [sentinel, "research"],
                [literalKey, "ops"],
              ],
        );
      }

      const project = sessionUtils.listSessionsFromStoreAsync;
      vi.spyOn(sessionUtils, "listSessionsFromStoreAsync").mockImplementationOnce(
        async (params) => {
          const result = await project(params);
          await upsertSessionEntryCore(
            { agentId: "ops", storePath: storePathFor("ops"), sessionKey: sentinel },
            { visibility: "draft" },
          );
          return result;
        },
      );
      const restricted = await listSessions({ client, context, request });
      expect(restricted.sessions.map((row) => [row.key, row.agentId])).toEqual([
        [sentinel, "research"],
        [literalKey, "ops"],
      ]);
      expect(restricted).toMatchObject({ count: 2, totalCount: 2 });
      clearAgentRunContext("sentinel-child-run");
    });
  },
);

it.each([{ activeMinutes: 1 }, { activeOnly: true }])(
  "collapses concurrent filtered requests into one projection: %j",
  async (filter: SessionsListParams) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { clock, config } = await seedSessionsWithActivityTimes();
      const context = requestContext(config);
      const loads = vi.spyOn(sessionUtils, "loadCombinedSessionStoreForGatewayCore");
      context.chatAbortControllers.set("active-run", {
        agentId: "main",
        sessionKey: "agent:main:active",
        sessionId: "main-active",
      } as never);
      const client = identifiedClient("owner@example.com");
      clock.mockReturnValue(60_400);
      const request = { ...filter, agentId: "main", limit: 100 };

      const results = await Promise.all(
        Array.from({ length: 8 }, () => listSessions({ client, context, request })),
      );

      expect(results[0]?.sessions.map((session) => session.key)).toEqual(["agent:main:active"]);
      expect(results.every((result) => result === results[0])).toBe(true);
      expect(loads).toHaveBeenCalledTimes(1);
    });
  },
);

it.each(["settled", "replaced"] as const)(
  "refills active work after the selected run is %s during projection",
  async (transition) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("viewer@example.com");
      for (const agentId of ["main", "work"]) {
        const scope = { agentId, sessionKey: `agent:${agentId}:active` };
        const entry = loadSessionEntry(scope);
        if (!entry) {
          throw new Error("Missing seeded active session");
        }
        await replaceSessionEntry(scope, { ...entry, updatedAt: agentId === "main" ? 400 : 100 });
        context.chatAbortControllers.set(`run-${agentId}`, {
          agentId,
          sessionKey: `agent:${agentId}:active`,
          sessionId: `${agentId}-active`,
        } as never);
      }
      const loads = vi.spyOn(sessionUtils, "loadCombinedSessionStoreForGatewayCore");
      const project = sessionUtils.listSessionsFromStoreAsync;
      const projections = vi
        .spyOn(sessionUtils, "listSessionsFromStoreAsync")
        .mockImplementationOnce(async (params) => {
          const result = await project(params);
          context.chatAbortControllers.delete("run-main");
          if (transition === "replaced") {
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey: "agent:main:active" },
              { sessionId: "replacement-session" },
            );
            context.chatAbortControllers.set("run-replacement", {
              agentId: "main",
              sessionKey: "agent:main:active",
              sessionId: "replacement-session",
            } as never);
          }
          return result;
        });
      const request = { activeOnly: true, limit: 1 };
      const pending = listSessions({ client, context, request });
      const result = await pending;
      expect(result.sessions).toMatchObject([
        { key: "agent:work:active", sessionId: "work-active", hasActiveRun: true },
      ]);
      expect(result).toMatchObject({ count: 1, totalCount: 1, nextOffset: null });
      expect(loads).toHaveBeenCalledOnce();
      expect(projections).toHaveBeenCalledTimes(2);
    });
  },
);
