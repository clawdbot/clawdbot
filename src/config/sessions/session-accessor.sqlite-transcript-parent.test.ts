import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  replaceTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
  type TranscriptEvent,
} from "./session-accessor.js";
import {
  isTranscriptEntryOnActivePathInTransaction,
  resolveTranscriptMessageAppendParent,
} from "./session-accessor.sqlite-transcript-parent.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createTranscript(events: TranscriptEvent[]) {
  const scope = {
    agentId: "main",
    sessionId: "ancestry",
    sessionKey: "agent:main:ancestry",
    storePath: path.join(tempDirs.make("openclaw-ancestry-"), "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  replaceTranscriptEventsSync(scope, [
    { type: "session", version: 3, id: scope.sessionId },
    ...events,
  ]);
  return {
    scope,
    database: openOpenClawAgentDatabase({
      agentId: scope.agentId,
      path: resolveSessionTranscriptDatabasePath(scope),
    }),
  };
}

function message(id: string, parentId: string | null): TranscriptEvent {
  return { type: "message", id, parentId, message: { role: "user", content: id } };
}

describe("SQLite transcript append ancestry", () => {
  it.each([8, 512])("bounds statement executions across %i ancestors", async (count) => {
    const events = Array.from({ length: count }, (_, index) =>
      message(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`),
    );
    const { database, scope } = await createTranscript(events);
    const executions = trackSqliteStatementExecutions(database.db, ["read"], (sql) =>
      /^(?:select|with)\b/iu.test(sql) ? "read" : null,
    );
    try {
      expect(
        runSqliteImmediateTransactionSync(database.db, () =>
          resolveTranscriptMessageAppendParent(database, scope.sessionId, {
            appendIntent: "active-branch",
            parentId: "entry-0",
          }),
        ),
      ).toBe(`entry-${count - 1}`);
      expect(executions.counts.read).toBeLessThanOrEqual(4);
    } finally {
      executions.restore();
    }
  });

  const linear = [message("root", null), message("tail", "root")];
  const cycle = [message("cycle-a", "cycle-b"), message("cycle-b", "cycle-a")];
  it.each([
    { name: "implicit tail", events: linear, parentId: undefined, expected: "tail" },
    { name: "current tail", events: linear, parentId: "tail", expected: "tail" },
    { name: "root ancestry", events: linear, parentId: null, expected: "tail" },
    { name: "missing parent", events: linear, parentId: "missing", expected: "missing" },
    {
      name: "dangling ancestor",
      events: [message("tail", "missing")],
      parentId: "missing",
      expected: "tail",
    },
    { name: "reachable cycle", events: cycle, parentId: "cycle-a", expected: "cycle-b" },
    { name: "unrelated cycle", events: cycle, parentId: "outside", expected: "outside" },
    { name: "cycle without root", events: cycle, parentId: null, expected: null },
    {
      name: "opaque tail",
      events: [...linear, { type: "future-metadata", id: "opaque", parentId: "tail" }],
      parentId: "root",
      expected: "opaque",
    },
    {
      name: "invalid leaf navigation fallback",
      events: [...linear, { type: "leaf", id: "invalid", parentId: "tail", targetId: "missing" }],
      parentId: "root",
      expected: "tail",
    },
    {
      name: "parentless navigation fallback",
      events: [
        ...linear,
        { type: "message", id: "parentless", message: { role: "user", content: "late" } },
      ],
      parentId: "root",
      expected: "root",
    },
  ])("preserves $name", async ({ events, parentId, expected }) => {
    const { database, scope } = await createTranscript(events);
    expect(
      runSqliteImmediateTransactionSync(database.db, () =>
        resolveTranscriptMessageAppendParent(database, scope.sessionId, {
          appendIntent: "active-branch",
          parentId,
        }),
      ),
    ).toBe(expected);
  });

  it("does not traverse an ancestor from another session", async () => {
    const { database, scope } = await createTranscript([message("tail", "foreign")]);
    const other = { ...scope, sessionId: "other", sessionKey: "agent:main:other" };
    await upsertSessionEntryCore(other, { sessionId: other.sessionId, updatedAt: 1 });
    replaceTranscriptEventsSync(other, [message("foreign", "root")]);
    expect(
      runSqliteImmediateTransactionSync(database.db, () =>
        resolveTranscriptMessageAppendParent(database, scope.sessionId, {
          appendIntent: "active-branch",
          parentId: "root",
        }),
      ),
    ).toBe("root");
  });

  it("checks active ancestry directly without adopting another branch", async () => {
    const { database, scope } = await createTranscript([
      message("active-root", null),
      message("active-tail", "active-root"),
      message("other-root", null),
      {
        type: "leaf",
        id: "select-active",
        parentId: "other-root",
        targetId: "active-tail",
        appendParentId: "active-tail",
      },
    ]);

    expect(
      isTranscriptEntryOnActivePathInTransaction(database, scope.sessionId, "active-root"),
    ).toBe(true);
    expect(
      isTranscriptEntryOnActivePathInTransaction(database, scope.sessionId, "active-tail"),
    ).toBe(true);
    expect(
      isTranscriptEntryOnActivePathInTransaction(database, scope.sessionId, "other-root"),
    ).toBe(false);
    expect(isTranscriptEntryOnActivePathInTransaction(database, scope.sessionId, "missing")).toBe(
      false,
    );
  });

  it("checks selected visible ancestry instead of a disjoint append cursor", async () => {
    const { database, scope } = await createTranscript([
      message("visible", null),
      message("hidden-user", "visible"),
      {
        type: "leaf",
        id: "select-visible",
        parentId: "hidden-user",
        targetId: "visible",
        appendParentId: "hidden-user",
        appendMode: "side",
      },
      message("continued", "hidden-user"),
    ]);

    expect(isTranscriptEntryOnActivePathInTransaction(database, scope.sessionId, "visible")).toBe(
      true,
    );
    expect(
      isTranscriptEntryOnActivePathInTransaction(database, scope.sessionId, "hidden-user"),
    ).toBe(false);
    expect(isTranscriptEntryOnActivePathInTransaction(database, scope.sessionId, "continued")).toBe(
      true,
    );
  });
});
