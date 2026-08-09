import { performance } from "node:perf_hooks";
import { afterEach, expect, test, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

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

test("sessions.patchMany archives 30 human sessions without transcript hydration", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const targets = Array.from({ length: 30 }, (_, index) => ({
      key: `agent:main:archive-perf-${index}`,
    }));
    const transcriptTails = new Map<string, string>();
    for (const [index, target] of targets.entries()) {
      const sessionId = `session-archive-perf-${index}`;
      await upsertSessionEntry(
        { agentId: "main", sessionKey: target.key },
        { sessionId, updatedAt: index + 1 },
      );
      let parentId: string | undefined;
      for (let messageIndex = 0; messageIndex < 8; messageIndex += 1) {
        const appended = await appendTranscriptMessage(
          { agentId: "main", sessionId, sessionKey: target.key },
          {
            message: {
              role: "user",
              content: `history ${index}:${messageIndex}`,
              timestamp: messageIndex + 1,
            },
            now: messageIndex + 1,
            ...(parentId ? { parentId } : {}),
          },
        );
        parentId = appended.messageId;
      }
      transcriptTails.set(target.key, parentId!);
    }

    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const statements = trackSqliteStatementExecutions(
      database.db,
      ["whole-store-projection", "transcript-full-hydration"] as const,
      (sql) => {
        if (
          sql.includes('select "current_session_id", "entry_json", "session_key", "updated_at"') &&
          sql.includes('from "session_nodes"') &&
          sql.includes('order by "session_key"')
        ) {
          return "whole-store-projection";
        }
        return sql.includes('select "event_json" from "transcript_events"') &&
          sql.includes('order by "seq" asc') &&
          !sql.includes("limit")
          ? "transcript-full-hydration"
          : null;
      },
    );
    await loadTranscriptEvents({
      agentId: "main",
      sessionId: "session-archive-perf-0",
      sessionKey: targets[0]!.key,
    });
    expect(statements.counts["transcript-full-hydration"]).toBe(1);
    statements.counts["transcript-full-hydration"] = 0;
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
      const cronList = vi.fn(async () => []);
      const context = {
        getRuntimeConfig: () => ({}),
        loadGatewayModelCatalog: vi.fn(async () => []),
        broadcastToConnIds: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set(),
        chatAbortControllers: new Map(),
        cron: {
          list: cronList,
          updateWithPrecondition: vi.fn(),
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

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          outcomes: targets.map((target) => ({ ok: true, key: target.key })),
        },
        undefined,
      );
      for (const target of targets) {
        expect(loadSessionEntry({ agentId: "main", sessionKey: target.key })).toHaveProperty(
          "archivedAt",
        );
      }
      expect(statements.counts["whole-store-projection"]).toBe(1);
      expect(statements.counts["transcript-full-hydration"]).toBe(0);
      // One session-store batch plus one parent-linked audit append per target.
      expect(transactionCounts).toEqual({ begin: 31, commit: 31 });
      expect(cronList).toHaveBeenCalledOnce();
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
