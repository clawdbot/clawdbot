import { performance } from "node:perf_hooks";
import { afterEach, expect, test, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { CronJob } from "../../cron/types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const sqliteTransactionLabels = vi.hoisted(() => [] as string[]);

vi.mock("../../state/openclaw-agent-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-db.js")>();
  const runOpenClawAgentWriteTransaction: typeof actual.runOpenClawAgentWriteTransaction = (
    operation,
    options,
    transactionOptions,
  ) => {
    sqliteTransactionLabels.push(transactionOptions?.operationLabel ?? "agent.write");
    return actual.runOpenClawAgentWriteTransaction(operation, options, transactionOptions);
  };
  return { ...actual, runOpenClawAgentWriteTransaction };
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

function humanClient(): GatewayClient {
  return {
    authenticatedUserId: "perf-reviewer@example.com",
    authenticatedUserProfile: {
      profileId: "perf-reviewer",
      displayName: "Performance Reviewer",
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
    },
  };
}

function isWholeSessionStoreProjection(normalizedSql: string): boolean {
  const source = ' from "session_nodes" order by "session_key"';
  if (!normalizedSql.startsWith("select ") || !normalizedSql.endsWith(source)) {
    return false;
  }
  const selection = normalizedSql.slice("select ".length, -source.length);
  return (
    selection === "*" ||
    ['"current_session_id"', '"entry_json"', '"session_key"', '"updated_at"'].every((column) =>
      selection.includes(column),
    )
  );
}

test("single non-label sessions.patch avoids a whole-store projection", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const targetKey = "agent:main:single-patch-target";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: targetKey },
      { sessionId: "session-single-patch-target", updatedAt: 1 },
    );
    for (let index = 0; index < 20; index += 1) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: `agent:main:single-patch-unrelated-${index}` },
        { sessionId: `session-single-patch-unrelated-${index}`, updatedAt: index + 2 },
      );
    }

    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const statements = trackSqliteStatementExecutions(
      database.db,
      ["whole-store-projection"] as const,
      (sql) => {
        const normalized = sql.toLowerCase().replaceAll(/\s+/g, " ").trim();
        return isWholeSessionStoreProjection(normalized) ? "whole-store-projection" : null;
      },
    );
    const respond = vi.fn();
    try {
      await sessionMutationHandlers["sessions.patch"]!({
        params: { key: targetKey, pinned: true },
        respond,
        context: {
          getRuntimeConfig: () => ({}),
          loadGatewayModelCatalog: vi.fn(async () => []),
          broadcastToConnIds: vi.fn(),
          getSessionEventSubscriberConnIds: () => new Set(),
          chatAbortControllers: new Map(),
          chatQueuedTurns: new Map(),
          dedupe: new Map(),
        } as unknown as GatewayRequestContext,
        client: humanClient(),
      } as never);
    } finally {
      statements.restore();
    }

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(statements.counts["whole-store-projection"]).toBe(0);
    expect(loadSessionEntry({ agentId: "main", sessionKey: targetKey })).toHaveProperty("pinnedAt");
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: "agent:main:single-patch-unrelated-0" }),
    ).not.toHaveProperty("pinnedAt");
  });
});

test("sessions.patchMany archives 30 human sessions without transcript hydration", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const targets = Array.from({ length: 30 }, (_, index) => ({
      key: `agent:main:archive-perf-${index}`,
      expectedSessionId: `session-archive-perf-${index}`,
    }));
    const transcriptRoots = new Map<string, string>();
    const transcriptTails = new Map<string, string>();
    for (const [index, target] of targets.entries()) {
      const sessionId = `session-archive-perf-${index}`;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: target.key },
        { sessionId, updatedAt: index + 1 },
      );
      const root = await appendTranscriptMessage(
        { agentId: "main", sessionId, sessionKey: target.key },
        {
          message: {
            role: "user",
            content: `history root ${index}`,
            timestamp: 1,
          },
          now: 1,
        },
      );
      const tail = await appendTranscriptMessage(
        { agentId: "main", sessionId, sessionKey: target.key },
        {
          message: {
            role: "assistant",
            content: `history tail ${index}`,
            timestamp: 2,
          },
          now: 2,
          parentId: root.messageId,
        },
      );
      transcriptRoots.set(target.key, root.messageId);
      transcriptTails.set(target.key, tail.messageId);
    }

    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const statements = trackSqliteStatementExecutions(
      database.db,
      ["whole-store-projection", "transcript-full-hydration"] as const,
      (sql) => {
        const normalized = sql.toLowerCase().replaceAll(/\s+/g, " ").trim();
        if (isWholeSessionStoreProjection(normalized)) {
          return "whole-store-projection";
        }
        const fromIndex = normalized.indexOf(" from ");
        const selectedColumns = fromIndex > 0 ? normalized.slice("select ".length, fromIndex) : "";
        const readsTranscriptPayload =
          normalized.startsWith("select ") &&
          /\b(?:from|join) "transcript_events"(?: |$)/.test(normalized) &&
          (selectedColumns.includes("event_json") ||
            /(?:^|, )(?:(?:"[^"]+"\.)?\*)/.test(selectedColumns));
        const boundedPayloadLookup =
          normalized.includes(" limit ") ||
          /(?:"[^"]+"\.)?"(?:event_id|seq)" = (?:\?|\$\d+)/.test(normalized);
        return readsTranscriptPayload && !boundedPayloadLookup ? "transcript-full-hydration" : null;
      },
    );
    await loadTranscriptEvents({
      agentId: "main",
      sessionId: "session-archive-perf-0",
      sessionKey: targets[0]!.key,
    });
    expect(statements.counts["transcript-full-hydration"]).toBe(1);
    statements.counts["transcript-full-hydration"] = 0;
    sqliteTransactionLabels.length = 0;
    const originalExec = database.db.exec.bind(database.db);
    const transactionCounts = { begin: 0, commit: 0 };
    const execSpy = vi.spyOn(database.db, "exec").mockImplementation((sql) => {
      const normalized = sql.trim().toUpperCase();
      if (normalized === "BEGIN IMMEDIATE") {
        transactionCounts.begin += 1;
      } else if (normalized === "COMMIT") {
        transactionCounts.commit += 1;
      }
      return originalExec(sql);
    });
    try {
      const respond = vi.fn();
      const job = (partial: Partial<CronJob> & Pick<CronJob, "id">): CronJob =>
        ({ enabled: true, sessionTarget: "isolated", ...partial }) as CronJob;
      const cronJobs = new Map(
        [
          job({
            id: "unrelated",
            sessionTarget: "session:agent:main:not-archived",
          }),
          job({
            id: "bound-first",
            sessionTarget: `session:${targets[0]!.key}`,
          }),
          job({
            id: "bound-shared",
            sessionKey: targets[2]!.key,
            sessionTarget: `session:${targets[1]!.key}`,
          }),
          job({
            id: "bound-last",
            sessionTarget: `session:${targets.at(-1)!.key}`,
          }),
          job({
            enabled: false,
            id: "already-disabled",
            sessionTarget: `session:${targets[3]!.key}`,
          }),
        ].map((cronJob) => [cronJob.id, cronJob] as const),
      );
      const cronList = vi.fn(async () => [...cronJobs.values()]);
      type CronPrecondition = (job: CronJob, nowMs: number) => void | Promise<void>;
      const cronUpdateResults: Array<{ enabled: boolean; id: string }> = [];
      const cronUpdate = vi.fn(
        async (id: string, patch: Partial<CronJob>, precondition: CronPrecondition) => {
          const current = cronJobs.get(id);
          if (!current) {
            throw new Error(`missing cron fixture: ${id}`);
          }
          await precondition(current, 0);
          if (patch.enabled !== undefined) {
            current.enabled = patch.enabled;
          }
          const result = { enabled: current.enabled, id };
          cronUpdateResults.push(result);
          return current;
        },
      );
      const context = {
        getRuntimeConfig: () => ({}),
        loadGatewayModelCatalog: vi.fn(async () => []),
        broadcastToConnIds: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set(),
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
        dedupe: new Map(),
        cron: {
          list: cronList,
          updateWithPrecondition: cronUpdate,
          getDefaultAgentId: () => "main",
        },
      } as unknown as GatewayRequestContext;

      const startedAt = performance.now();
      await sessionMutationHandlers["sessions.patchMany"]!({
        params: { targets, patch: { archived: true } },
        respond,
        context,
        client: humanClient(),
      } as never);
      const elapsedMs = performance.now() - startedAt;
      console.info(`[perf] sessions.patchMany archive-30 ${elapsedMs.toFixed(2)}ms`);
      expect(elapsedMs).toBeLessThan(1_000);

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          outcomes: targets.map((target) => ({ ok: true, key: target.key })),
        },
        undefined,
      );
      expect(statements.counts["whole-store-projection"]).toBe(1);
      expect(statements.counts["transcript-full-hydration"]).toBe(0);
      // One session-store batch plus one parent-linked audit append per target.
      expect(transactionCounts).toEqual({ begin: 31, commit: 31 });
      expect(
        sqliteTransactionLabels.filter((label) => label === "session.entry-replacements"),
      ).toHaveLength(1);
      expect(sqliteTransactionLabels.filter((label) => label === "agent.write")).toHaveLength(30);
      expect(cronList).toHaveBeenCalledOnce();
      expect(cronUpdate.mock.calls.map(([id, patch]) => [id, patch])).toEqual([
        ["bound-first", { enabled: false }],
        ["bound-shared", { enabled: false }],
        ["bound-last", { enabled: false }],
      ]);
      expect(cronUpdateResults).toEqual([
        { enabled: false, id: "bound-first" },
        { enabled: false, id: "bound-shared" },
        { enabled: false, id: "bound-last" },
      ]);
      expect([...cronJobs.values()].map(({ enabled, id }) => ({ enabled, id }))).toEqual([
        { enabled: true, id: "unrelated" },
        { enabled: false, id: "bound-first" },
        { enabled: false, id: "bound-shared" },
        { enabled: false, id: "bound-last" },
        { enabled: false, id: "already-disabled" },
      ]);
    } finally {
      execSpy.mockRestore();
      statements.restore();
    }
    for (const [index, target] of targets.entries()) {
      const sessionId = `session-archive-perf-${index}`;
      expect(loadSessionEntry({ agentId: "main", sessionKey: target.key })).toMatchObject({
        archivedAt: expect.any(Number),
        archivedBy: { type: "human", id: "perf-reviewer", label: "Performance Reviewer" },
      });
      const auditNotes = (
        await loadTranscriptEvents({
          agentId: "main",
          sessionId,
          sessionKey: target.key,
        })
      ).filter((event): event is Record<string, unknown> & { message: Record<string, unknown> } => {
        if (!event || typeof event !== "object" || !("message" in event)) {
          return false;
        }
        const message = event.message;
        return (
          message !== null &&
          typeof message === "object" &&
          "customType" in message &&
          message.customType === "openclaw.system-note"
        );
      });
      expect(auditNotes).toHaveLength(1);
      expect(transcriptTails.get(target.key)).not.toBe(transcriptRoots.get(target.key));
      expect(auditNotes[0]?.parentId).not.toBe(transcriptRoots.get(target.key));
      expect(auditNotes[0]).toMatchObject({
        parentId: transcriptTails.get(target.key),
        message: {
          content: "System note: archived by Performance Reviewer",
          display: true,
        },
      });
    }
  });
});
