/** A fresh conversation must not inherit the prior task's progress card. */
import path from "node:path";
import { expect, it } from "vitest";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../../session-cards/progress-card-store.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  loadTranscriptEvents,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

it.each(
  (["single", "batched"] as const).flatMap((writer) =>
    (["clear", "preserve-tail"] as const).flatMap((context) =>
      (["markdown", "plan"] as const).flatMap((content) =>
        (context === "clear" ? [false, true] : [false]).map((rollback) => ({
          writer,
          context,
          content,
          rollback,
        })),
      ),
    ),
  ),
)(
  "$writer $context reset owns the $content card lifetime (rollback=$rollback)",
  async ({ writer, context, content, rollback }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:reset-progress";
      const sessionId = "same-reset-session";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const scope = { agentId: "main", sessionKey, sessionId, storePath };
      const previous = { sessionId, lifecycleRevision: "before", updatedAt: 1 };
      await upsertSessionEntryCore(scope, previous);
      appendTranscriptMessageSync(scope, {
        eventId: "retained-message",
        message: { role: "user", content: "Retain this history" },
      });
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
      });
      const boards = new SqliteBoardStore({
        resolveSession: () => ({ agentId: "main", path: database.path, sessionKey }),
      });
      boards.putWidget({
        sessionKey,
        name: "retained-widget",
        content: { kind: "html", html: "<p>Keep this dashboard</p>" },
      });
      const boardBefore = boards.getSnapshot({ sessionKey });
      const historyBefore = await loadTranscriptEvents(scope);
      const entryBefore = loadSessionEntry(scope);
      const input =
        content === "markdown"
          ? { markdown: "Previous task" }
          : { steps: [{ step: "Previous task", status: "in_progress" as const }] };
      writeSessionProgressCard(database.db, sessionKey, input);
      const before = readSessionProgressCard(database.db, sessionKey);
      const invalidations: Array<{ agentId?: string; sessionKey: string; inTransaction: boolean }> =
        [];
      const unsubscribe = onSessionLifecycleEvent((event) => {
        if (event.reason === "progress-card-reset") {
          invalidations.push({
            agentId: event.agentId,
            sessionKey: event.sessionKey,
            inTransaction: database.db.isTransaction,
          });
        }
      });
      const entry = { ...previous, lifecycleRevision: "after", updatedAt: 2 };
      const resetBoundary = { context, reason: "reset" as const, cwd: state.workspaceDir };
      const reset = async () => {
        if (writer === "single") {
          await resetSessionEntryLifecycle({
            agentId: "main",
            storePath,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
            resetBoundary,
            buildNextEntry: () => entry,
          });
        } else {
          await applySessionEntryLifecycleMutation({
            agentId: "main",
            storePath,
            skipMaintenance: true,
            upserts: [{ sessionKey, entry, resetBoundary }],
          });
        }
      };
      if (rollback) {
        // Fail the entry write after the boundary/card mutation, not its admission guard.
        database.db.exec(`CREATE TEMP TRIGGER reject_reset_entry
          BEFORE UPDATE OF entry_json ON session_nodes
          BEGIN SELECT RAISE(ABORT, 'injected reset entry failure'); END;`);
      }
      try {
        if (rollback) {
          await expect(reset()).rejects.toThrow("injected reset entry failure");
          expect(loadSessionEntry(scope)).toEqual(entryBefore);
          expect(await loadTranscriptEvents(scope)).toEqual(historyBefore);
        } else {
          await reset();
        }
      } finally {
        unsubscribe();
        if (rollback) {
          database.db.exec("DROP TRIGGER reject_reset_entry");
        }
      }
      // A fresh read-only connection proves this is durable state, not client/cache invalidation.
      expect(readSessionProgressCard(database.path, sessionKey)).toEqual(
        context === "clear" && !rollback ? null : before,
      );
      expect(boards.getSnapshot({ sessionKey })).toEqual(boardBefore);
      expect(boards.readWidgetHtml({ sessionKey }, "retained-widget")?.html).toBe(
        "<p>Keep this dashboard</p>",
      );
      if (context === "clear" && !rollback) {
        expect(readSessionProgressCard(database.db, sessionKey)).toBeNull();
        expect(invalidations).toEqual([{ agentId: "main", sessionKey, inTransaction: false }]);
        writeSessionProgressCard(database.db, sessionKey, {
          steps: [{ step: "Fresh task", status: "completed" }],
        });
        expect(readSessionProgressCard(database.db, sessionKey)?.revision).toBe(3);
        writeSessionProgressCard(database.db, sessionKey, { expectedRevision: before!.revision });
        expect(readSessionProgressCard(database.db, sessionKey)?.revision).toBe(3);
      } else {
        expect(readSessionProgressCard(database.db, sessionKey)).toEqual(before);
        expect(invalidations).toEqual([]);
      }
      expect(await loadTranscriptEvents(scope)).toContainEqual(
        expect.objectContaining({ id: "retained-message" }),
      );
    });
  },
);
