import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  replaceTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  SessionTranscriptProjectionUnavailableError,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import {
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { rewriteTranscriptEntriesInSessionManager } from "../embedded-agent-runner/transcript-rewrite.js";
import { SessionManager } from "./session-manager.js";

const { uuidQueue } = vi.hoisted(() => ({ uuidQueue: [] as string[] }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () =>
      (uuidQueue.shift() ??
        actual.randomUUID()) as `${string}-${string}-${string}-${string}-${string}`,
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  uuidQueue.length = 0;
});

it("publishes the rewritten view before commit observers append", async () => {
  const dir = tempDirs.make("openclaw-rewrite-observer-");
  const scope = {
    agentId: "main",
    sessionId: "rewrite-observer",
    sessionKey: "agent:main:rewrite-observer",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, dir);
  const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  manager.appendMessage({ role: "user", content: "tail", timestamp: 2 });
  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  database.db.function("queue_observer_append", () => {
    expect(
      deferOpenClawAgentPostCommitPublication(database, () => {
        manager.appendMessage({ role: "user", content: "observer", timestamp: 3 });
      }),
    ).toBe(true);
    return 0;
  });
  database.db.exec(
    "CREATE TRIGGER append_from_observer AFTER INSERT ON transcript_events WHEN json_extract(NEW.event_json, '$.message.content') = 'replacement' BEGIN SELECT queue_observer_append(); END;",
  );
  rewriteTranscriptEntriesInSessionManager({
    sessionManager: manager,
    replacements: [
      { entryId: first, message: { role: "user", content: "replacement", timestamp: 1 } },
    ],
  });
  const expected = [
    { message: { content: "replacement" } },
    { message: { content: "tail" } },
    { message: { content: "observer" } },
  ];
  expect(manager.getBranch()).toMatchObject(expected);
  expect(SessionManager.open(scope).getBranch()).toEqual(manager.getBranch());
});

it("does not certify stale navigation with a post-commit replacement version", async () => {
  const dir = tempDirs.make("openclaw-postcommit-rewrite-race-");
  const scope = {
    agentId: "main",
    sessionId: "postcommit-race",
    sessionKey: "agent:main:postcommit-race",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, dir);
  const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  const second = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
  const control = manager.appendLeafControl({
    targetId: first,
    appendParentId: second,
    appendMode: "side",
  });
  const kept = manager.appendMessage({ role: "user", content: "kept-after-trim", timestamp: 3 });
  manager.appendMessage({ role: "user", content: "remove-tail", timestamp: 4 });
  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  let queued = false;
  database.db.function("queue_navigation_replacement", () => {
    if (!queued) {
      queued = true;
      expect(
        deferOpenClawAgentPostCommitPublication(database, () => {
          const events = loadTranscriptEventsSync(scope);
          for (const event of events) {
            if (isRecord(event) && event.id === control.id) {
              event.targetId = second;
            }
          }
          replaceTranscriptEventsSync(scope, events);
        }),
      ).toBe(true);
    }
    return 0;
  });
  database.db.exec(
    "CREATE TRIGGER replace_after_commit AFTER INSERT ON transcript_events WHEN json_extract(NEW.event_json, '$.message.content') = 'kept-after-trim' BEGIN SELECT queue_navigation_replacement(); END;",
  );
  expect(
    manager.removeTrailingEntries(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        entry.message.content === "remove-tail",
    ),
  ).toBe(1);
  expect(queued).toBe(true);
  const committed = loadTranscriptEventsSync(scope);
  const rewrite = () =>
    rewriteTranscriptEntriesInSessionManager({
      sessionManager: manager,
      replacements: [
        { entryId: kept, message: { role: "user", content: "replacement", timestamp: 3 } },
      ],
    });
  expect(rewrite).toThrow("Session transcript changed");
  expect(loadTranscriptEventsSync(scope)).toEqual(committed);
  manager.reloadPersistedTranscript();
  expect(rewrite().changed).toBe(true);
  expect(SessionManager.open(scope).getBranch()).toMatchObject([
    { message: { content: "first" } },
    { message: { content: "second" } },
    { message: { content: "replacement" } },
  ]);
});

it.each(["compaction", "reset"] as const)(
  "adopts canonical boundary counts and navigation after replaying %s",
  async (kind) => {
    const dir = tempDirs.make("openclaw-bounded-rewrite-boundary-");
    const scope = {
      agentId: "main",
      sessionId: "rewrite-boundary",
      sessionKey: "agent:main:rewrite-boundary",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const full = SessionManager.open(scope, dir);
    const first = full.appendMessage({ role: "user", content: "first", timestamp: 1 });
    full.appendMessage({ role: "user", content: "second", timestamp: 2 });
    if (kind === "reset") {
      full.appendResetBoundary("reset", first);
    } else {
      full.appendCompaction("summary", first, 100);
    }
    full.appendMessage({ role: "user", content: "last", timestamp: 3 });
    const manager = SessionManager.openBounded(scope, { maxEvents: 10, maxBytes: 16384 });
    expect(manager.getBoundaryCount()).toBe(1);
    rewriteTranscriptEntriesInSessionManager({
      sessionManager: manager,
      replacements: [
        { entryId: first, message: { role: "user", content: "rewritten", timestamp: 1 } },
      ],
    });
    const reopened = SessionManager.open(scope, dir);
    // Existing reset navigation fences pre-reset branches; preserve that canonical policy.
    expect(reopened.getBoundaryCount()).toBe(kind === "reset" ? 2 : 1);
    expect(manager.getBoundaryCount()).toBe(reopened.getBoundaryCount());
    expect(manager.getBranch()).toEqual(reopened.getBranch());
    expect(manager.buildSessionContext()).toEqual(reopened.buildSessionContext());
  },
);

it("keeps generated entry ids unique outside a bounded transcript tail", async () => {
  const dir = tempDirs.make("openclaw-session-manager-bounded-id-");
  const scope = {
    agentId: "main",
    sessionId: "bounded-id-session",
    sessionKey: "agent:main:bounded-id-session",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "deadbeef",
    message: { role: "user", content: "omitted" },
  });
  await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "tail",
    parentId: "deadbeef",
    message: { role: "user", content: "retained" },
  });

  const manager = SessionManager.openBounded(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 1,
  });
  expect(manager.getEntry("deadbeef")).toBeUndefined();

  const messageId = "deadbeef-0000-4000-8000-000000000000";
  const thinkingId = "deadbeef-0000-4000-8000-000000000001";
  uuidQueue.push(messageId);
  const appended = manager.appendMessageWithTranscriptAnchor({
    role: "user",
    content: "persisted",
    timestamp: 2,
  });

  expect(appended).toMatchObject({ entryId: messageId, anchor: { effectiveParentId: "tail" } });
  uuidQueue.push(thinkingId);
  expect(manager.appendThinkingLevelChange("high")).toBe(thinkingId);
  await expect(loadTranscriptEvents(scope)).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: messageId, parentId: "tail" }),
      expect.objectContaining({ id: thinkingId, parentId: messageId }),
    ]),
  );
});

it("excludes interleaved display payloads without inventing events or losing fenced append ancestry", async () => {
  const dir = tempDirs.make("openclaw-bounded-display-");
  const scope = {
    agentId: "main",
    sessionId: "display",
    sessionKey: "agent:main:display",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, dir);
  const userId = manager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
  const display = () =>
    manager.appendMessage({
      role: "custom",
      customType: "display-test",
      content: "x".repeat(20_000),
      display: true,
      excludeFromContext: true,
      timestamp: 1,
    });
  display();
  manager.appendMessage({ role: "user", content: "also retained", timestamp: 1 });
  manager.appendCompaction("summary", userId, 100);
  const tailId = display();
  const limits = { maxEvents: 3, maxBytes: 4096 };
  const read = () => readSessionTranscriptBoundedActiveContextCore(scope, limits);
  const context = read();
  expect(context.events).toHaveLength(4); // Header plus the three real context events.
  expect(context.serializedBytes).toBe(
    context.events.reduce<number>(
      (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)) + 1,
      0,
    ),
  );
  expect(context.serializedBytes).toBeLessThan(limits.maxBytes);
  expect(context.activeLeafEntryId).toBe(tailId);
  const bounded = SessionManager.openBounded(scope, limits);
  expect(bounded.getAppendParentId()).toBe(tailId);
  expect(bounded.buildSessionContext()).toEqual(manager.buildSessionContext());
  const appended = bounded.appendMessageWithTranscriptAnchor({
    role: "user",
    content: "current",
    timestamp: 2,
  });
  expect(appended.anchor?.effectiveParentId).toBe(tailId);
  if (!appended.anchor) {
    throw new Error("missing admission anchor");
  }
  runWithSessionTranscriptReadFence(
    { ...appended.anchor, logicalTurnId: "display-turn", role: "user" },
    () => {
      expect(read().events).toEqual(context.events);
      const fenced = SessionManager.openBounded(scope, limits);
      expect(fenced.getAppendParentId()).toBe(tailId);
      expect(fenced.buildSessionContext()).toEqual(manager.buildSessionContext());
    },
  );
  expect(SessionManager.open(scope, dir).getBranch().at(-1)?.id).toBe(appended.entryId);
});

it.each([1, 2])("retains the forward cut after %i excluded first-kept entries", async (count) => {
  const dir = tempDirs.make("openclaw-bounded-excluded-cut-");
  const scope = {
    agentId: "main",
    sessionId: "excluded-cut",
    sessionKey: "agent:main:excluded-cut",
    storePath: path.join(dir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, dir);
  manager.appendMessage({ role: "user", content: "summarized away", timestamp: 1 });
  const excluded = Array.from({ length: count }, () =>
    manager.appendMessage({
      role: "custom",
      customType: "display-test",
      content: "display only",
      display: true,
      excludeFromContext: true,
      timestamp: 2,
    }),
  );
  const firstKept = excluded.at(0);
  if (!firstKept) {
    throw new Error("missing first-kept fixture");
  }
  manager.appendMessage({ role: "user", content: "retained", timestamp: 3 });
  manager.appendCompaction("summary", firstKept, 100);
  const expected = manager.buildSessionContext();
  expect(expected.messages).toMatchObject([
    { role: "compactionSummary", summary: "summary" },
    { role: "user", content: "retained" },
  ]);
  const bounded = SessionManager.openBounded(scope, { maxEvents: 4, maxBytes: 4096 });
  expect(bounded.buildSessionContext()).toEqual(expected);
  bounded.appendMessage({ role: "user", content: "after reopen", timestamp: 4 });
  expect(SessionManager.open(scope, dir).buildSessionContext().messages).toMatchObject([
    ...expected.messages,
    { role: "user", content: "after reopen" },
  ]);
});

it("bounds runtime hydration while preserving older durable transcript rows on rewrites", async () => {
  const dir = tempDirs.make("openclaw-session-manager-bounded-");
  const storePath = path.join(dir, "sessions.json");
  const scope = {
    agentId: "main",
    sessionId: "bounded-runtime-session",
    sessionKey: "agent:main:bounded-runtime-session",
    storePath,
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  for (const content of ["oldest", "middle", "latest"]) {
    await appendTranscriptMessage(scope, { cwd: dir, message: { role: "user", content } });
  }

  const manager = SessionManager.openBounded(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 2,
  });

  expect(manager.buildSessionContext().messages).toMatchObject([
    { content: "middle" },
    { content: "latest" },
  ]);
  expect(manager.getEntries()).toHaveLength(2);
  expect(
    manager.removeTrailingEntries(
      (entry) =>
        entry.type === "message" &&
        "content" in entry.message &&
        entry.message.content === "latest",
    ),
  ).toBe(1);
  await expect(loadTranscriptEvents(scope)).resolves.toMatchObject([
    { type: "session" },
    { message: { content: "oldest" } },
    { message: { content: "middle" } },
  ]);
});

it("preserves inactive siblings when the bounded active branch fits its limits", async () => {
  const dir = tempDirs.make("openclaw-session-manager-bounded-branch-");
  const scope = {
    agentId: "main",
    sessionId: "bounded-branch-session",
    sessionKey: "agent:main:bounded-branch-session",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const root = await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "root",
    message: { role: "user", content: "root" },
  });
  const inactive = await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "inactive",
    message: { role: "assistant", content: "inactive" },
    parentId: root.messageId,
  });
  const branchManager = SessionManager.open(scope, dir);
  branchManager.branch(root.messageId);
  const activeId = branchManager.appendMessage({ role: "user", content: "active", timestamp: 3 });

  const openBounded = () =>
    SessionManager.openBounded(scope, {
      cwd: dir,
      maxBytes: 4096,
      maxEvents: 3,
    });
  expect(openBounded).toThrow(SessionTranscriptProjectionUnavailableError);
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: path.join(dir, "openclaw-agent.sqlite"),
  });
  const manager = openBounded();

  expect(manager.buildSessionContext().messages).toMatchObject([
    { content: "root" },
    { content: "active" },
  ]);
  expect(manager.removeTrailingEntries((entry) => entry.id === activeId)).toBe(1);
  await expect(loadTranscriptEvents(scope)).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: inactive.messageId,
        message: { role: "assistant", content: "inactive" },
      }),
    ]),
  );
});

it("preserves explicit reset retention of excluded user input in a bounded reopen", async () => {
  const dir = tempDirs.make("openclaw-bounded-reset-excluded-");
  const scope = {
    agentId: "main",
    sessionId: "reset-excluded",
    sessionKey: "agent:main:reset-excluded",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, dir);
  manager.appendMessage({ role: "user", content: "discarded", timestamp: 1 });
  const retained = manager.appendMessage({
    role: "user",
    content: "explicitly retained",
    timestamp: 2,
    display: false,
    excludeFromContext: true,
  } as Parameters<SessionManager["appendMessage"]>[0]);
  manager.appendResetBoundary("new", retained);
  const current = manager.appendMessageWithTranscriptAnchor({
    role: "user",
    content: "fresh",
    timestamp: 3,
  });
  const raw = await loadTranscriptEvents(scope);
  expect(manager.buildSessionContext().messages).toMatchObject([
    { content: "explicitly retained" },
    { content: "fresh" },
  ]);
  expect(
    SessionManager.openBounded(scope, { maxEvents: 8, maxBytes: 4096 }).buildSessionContext(),
  ).toEqual(manager.buildSessionContext());
  expect(await loadTranscriptEvents(scope)).toEqual(raw);
  manager.appendResetBoundary("new");
  expect(
    SessionManager.openBounded(scope, { maxEvents: 8, maxBytes: 4096 }).buildSessionContext()
      .messages,
  ).toEqual([]);
  if (!current.anchor) {
    throw new Error("Missing current-turn anchor");
  }
  runWithSessionTranscriptReadFence(
    { ...current.anchor, logicalTurnId: "current", role: "user" },
    () => {
      expect(
        SessionManager.openBounded(scope, { maxEvents: 8, maxBytes: 4096 }).buildSessionContext()
          .messages,
      ).toMatchObject([{ content: "explicitly retained" }]);
    },
  );
});
