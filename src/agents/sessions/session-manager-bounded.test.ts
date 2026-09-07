import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  readSessionTranscriptVisibleMessageDeltaCore,
  readSessionTranscriptWatermark,
  readTranscriptRawDelta,
  replaceTranscriptEventsSync,
  SessionTranscriptProjectionUnavailableError,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import { resolveSessionTranscriptDatabasePath } from "../../config/sessions/session-accessor.transcript-target.js";
import {
  SYNC_REBUILD_MAX_BYTES,
  SYNC_REBUILD_MAX_ROWS,
} from "../../config/sessions/session-transcript-index.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
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

function buildAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "messages" as const,
    provider: "anthropic" as const,
    model: "sonnet-4.6" as const,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

afterEach(() => {
  uuidQueue.length = 0;
});

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

it("retries a stale bounded append without parsing transcript rows outside the bounded context", async () => {
  const dir = tempDirs.make("openclaw-session-manager-bounded-stale-append-");
  const scope = {
    agentId: "main",
    sessionId: "bounded-stale-append",
    sessionKey: "agent:main:bounded-stale-append",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "excluded",
    message: { role: "user", content: "excluded" },
  });
  await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "retained",
    parentId: "excluded",
    message: { role: "user", content: "retained" },
  });
  const manager = SessionManager.openBounded(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 1,
  });
  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  database.db
    .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 1")
    .run("{excluded-row-is-not-json", scope.sessionId);
  await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "out-of-band",
    parentId: "retained",
    message: { role: "assistant", content: "late" },
  });

  const appendedId = manager.appendModelChange("openai", "gpt-5.6");

  expect(
    database.db
      .prepare(
        "SELECT parent_id FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
      )
      .get(scope.sessionId, appendedId),
  ).toEqual({ parent_id: "out-of-band" });
  expect(
    database.db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 1")
      .get(scope.sessionId),
  ).toEqual({ event_json: "{excluded-row-is-not-json" });
});

it("accepts a prepared assistant whose parent is the admitted user", async () => {
  const dir = tempDirs.make("openclaw-session-manager-admitted-assistant-");
  const scope = {
    agentId: "main",
    sessionId: "admitted-assistant",
    sessionKey: "agent:main:admitted-assistant",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, dir);
  const admitted = manager.appendMessageWithTranscriptAnchor({
    role: "user",
    content: "current",
    timestamp: 1,
  });
  if (!admitted.anchor) {
    throw new Error("missing admission anchor");
  }

  runWithSessionTranscriptReadFence(
    { ...admitted.anchor, logicalTurnId: "current", role: "user" },
    () => expect(() => manager.appendMessage(buildAssistantMessage("reply"))).not.toThrow(),
  );
});

it("keeps a fenced assistant after rebasing over a concurrent assistant", async () => {
  const dir = tempDirs.make("openclaw-session-manager-fenced-rebase-");
  const scope = {
    agentId: "main",
    sessionId: "fenced-assistant-rebase",
    sessionKey: "agent:main:fenced-assistant-rebase",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const seed = SessionManager.open(scope, dir);
  const admission = seed.appendMessageWithTranscriptAnchor({
    role: "user",
    content: "current",
    timestamp: 1,
  });
  if (!admission.anchor) {
    throw new Error("missing admission anchor");
  }

  runWithSessionTranscriptReadFence(
    { ...admission.anchor, logicalTurnId: "current", role: "user" },
    () => {
      const fenced = SessionManager.open(scope, dir);
      expect(
        appendTranscriptMessageSync(scope, {
          eventId: "concurrent-assistant",
          message: buildAssistantMessage("concurrent"),
          now: 2,
        }).ok,
      ).toBe(true);
      const replyId = fenced.appendMessage(buildAssistantMessage("reply"));
      expect(fenced.getBranch().map((entry) => entry.id)).toEqual([
        admission.entryId,
        "concurrent-assistant",
        replyId,
      ]);
      expect(fenced.buildSessionContext().messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ text: "reply" }],
      });
    },
  );
});

it("adopts a fenced assistant when another append commits before its reload", async () => {
  const dir = tempDirs.make("openclaw-session-manager-post-commit-append-");
  const scope = {
    agentId: "main",
    sessionId: "post-commit-append",
    sessionKey: "agent:main:post-commit-append",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const seed = SessionManager.open(scope, dir);
  const admission = seed.appendMessageWithTranscriptAnchor({
    role: "user",
    content: "current",
    timestamp: 1,
  });
  if (!admission.anchor) {
    throw new Error("missing admission anchor");
  }

  runWithSessionTranscriptReadFence(
    { ...admission.anchor, logicalTurnId: "current", role: "user" },
    () => {
      const fenced = SessionManager.open(scope, dir);
      const corePrototype = Object.getPrototypeOf(
        Object.getPrototypeOf(Object.getPrototypeOf(fenced)),
      ) as { reloadPersistedTranscriptAfterAppend: () => void };
      const originalReload = corePrototype.reloadPersistedTranscriptAfterAppend;
      vi.spyOn(corePrototype, "reloadPersistedTranscriptAfterAppend").mockImplementation(function (
        this: SessionManager,
        ...args: unknown[]
      ) {
        expect(
          appendTranscriptMessageSync(scope, {
            eventId: "post-commit-assistant",
            message: buildAssistantMessage("later"),
            now: 3,
          }).ok,
        ).toBe(true);
        return originalReload.apply(this, args as []);
      });

      const replyId = fenced.appendMessage(buildAssistantMessage("reply"));

      expect(fenced.getBranch().map((entry) => entry.id)).toEqual([
        admission.entryId,
        replyId,
        "post-commit-assistant",
      ]);
      expect(fenced.getEntry(replyId)).toBeDefined();
    },
  );
});

it("appends an assistant without parsing transcript rows outside the bounded context", async () => {
  const dir = tempDirs.make("openclaw-session-manager-bounded-assistant-");
  const scope = {
    agentId: "main",
    sessionId: "bounded-assistant-append",
    sessionKey: "agent:main:bounded-assistant-append",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "excluded",
    message: { role: "user", content: "excluded" },
  });
  await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "retained",
    parentId: "excluded",
    message: { role: "user", content: "retained" },
  });
  const manager = SessionManager.openBounded(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 1,
  });
  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    env: { OPENCLAW_STATE_DIR: dir },
  });
  database.db
    .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 0")
    .run("{", scope.sessionId);

  const assistantId = manager.appendMessage(buildAssistantMessage("bounded reply"));

  expect(manager.getEntry(assistantId)).toMatchObject({ parentId: "retained" });
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
      expect(SessionManager.open(scope, dir).buildSessionContext()).toEqual(
        manager.buildSessionContext(),
      );
      const retargeted = SessionManager.inMemory(dir);
      retargeted.setSessionTarget(scope);
      expect(retargeted.buildSessionContext()).toEqual(manager.buildSessionContext());
    },
  );
  expect(SessionManager.open(scope, dir).getBranch().at(-1)?.id).toBe(appended.entryId);
});

it("rejects a fenced assistant when a later hidden user has advanced the turn", async () => {
  const dir = tempDirs.make("openclaw-session-manager-fenced-assistant-");
  const scope = {
    agentId: "main",
    sessionId: "fenced-assistant",
    sessionKey: "agent:main:fenced-assistant",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, dir);
  manager.appendMessage({ role: "user", content: "previous", timestamp: 1 });
  const admission = manager.appendMessageWithTranscriptAnchor({
    role: "user",
    content: "admitted",
    timestamp: 2,
  });
  manager.appendMessage({ role: "user", content: "newer", timestamp: 3 });
  if (!admission.anchor) {
    throw new Error("missing current-turn anchor");
  }

  runWithSessionTranscriptReadFence(
    { ...admission.anchor, logicalTurnId: "fenced-assistant", role: "user" },
    () => {
      const fenced = SessionManager.openBounded(scope, { cwd: dir, maxBytes: 4096, maxEvents: 8 });
      expect(() => fenced.appendMessage(buildAssistantMessage("stale reply"))).toThrow(
        "SQLite transcript changed while preparing rewrite",
      );
    },
  );
});

it("rejects a fenced tool result when a later hidden user has advanced the turn", async () => {
  const dir = tempDirs.make("openclaw-session-manager-fenced-tool-result-");
  const scope = {
    agentId: "main",
    sessionId: "fenced-tool-result",
    sessionKey: "agent:main:fenced-tool-result",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, dir);
  manager.appendMessage({ role: "user", content: "previous", timestamp: 1 });
  const admission = manager.appendMessageWithTranscriptAnchor({
    role: "user",
    content: "admitted",
    timestamp: 2,
  });
  manager.appendMessage({ role: "user", content: "newer", timestamp: 3 });
  if (!admission.anchor) {
    throw new Error("missing current-turn anchor");
  }

  runWithSessionTranscriptReadFence(
    { ...admission.anchor, logicalTurnId: "fenced-tool-result", role: "user" },
    () => {
      const fenced = SessionManager.openBounded(scope, { cwd: dir, maxBytes: 4096, maxEvents: 8 });
      expect(() =>
        fenced.appendMessage({
          role: "toolResult",
          toolCallId: "stale-tool-call",
          toolName: "test_tool",
          content: [{ type: "text", text: "stale result" }],
          isError: false,
          timestamp: 4,
        }),
      ).toThrow("SQLite transcript changed while preparing rewrite");
    },
  );
});

it("rejects suffix cleanup when the admission fence hides later transcript rows", async () => {
  const dir = tempDirs.make("openclaw-session-manager-fenced-cleanup-");
  const scope = {
    agentId: "main",
    sessionId: "fenced-cleanup",
    sessionKey: "agent:main:fenced-cleanup",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, dir);
  manager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
  const removableId = manager.appendMessage(buildAssistantMessage("temporary"));
  const admission = manager.appendMessageWithTranscriptAnchor({
    role: "user",
    content: "current turn",
    timestamp: 2,
  });
  manager.appendMessage(buildAssistantMessage("hidden response"));
  const raw = await loadTranscriptEvents(scope);
  if (!admission.anchor) {
    throw new Error("missing current-turn anchor");
  }

  runWithSessionTranscriptReadFence(
    { ...admission.anchor, logicalTurnId: "fenced-cleanup", role: "user" },
    () => {
      const fenced = SessionManager.open(scope, dir);
      const entries = fenced.getEntries();
      expect(() => fenced.removeTrailingEntries((entry) => entry.id === removableId)).toThrow(
        /admission hides rows needed for suffix mutation/,
      );
      expect(fenced.getEntries()).toEqual(entries);
    },
  );
  await expect(loadTranscriptEvents(scope)).resolves.toEqual(raw);
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

it("preserves the durable leaf when bounded cleanup removes the whole selected window", async () => {
  const dir = tempDirs.make("openclaw-session-manager-whole-window-");
  const scope = {
    agentId: "main",
    sessionId: "whole-window-session",
    sessionKey: "agent:main:whole-window-session",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const seed = SessionManager.open(scope, dir);
  const durableId = seed.appendMessage({ role: "user", content: "durable", timestamp: 1 });
  const removableId = seed.appendMessage(buildAssistantMessage("temporary"));
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: path.join(dir, "openclaw-agent.sqlite"),
  });

  const bounded = SessionManager.openBounded(scope, { cwd: dir, maxBytes: 4096, maxEvents: 1 });
  expect(bounded.removeTrailingEntries((entry) => entry.id === removableId)).toBe(1);
  const reopened = SessionManager.open(scope, dir);
  expect(reopened.getAppendParentId()).toBe(durableId);
  expect(reopened.buildSessionContext().messages).toMatchObject([{ content: "durable" }]);
  reopened.appendMessage({ role: "user", content: "after cleanup", timestamp: 2 });
  expect(SessionManager.open(scope, dir).buildSessionContext().messages).toMatchObject([
    { content: "durable" },
    { content: "after cleanup" },
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

it("rejects bounded cleanup across opaque hydration-boundary rows", async () => {
  const dir = tempDirs.make("openclaw-session-manager-bounded-opaque-boundary-");
  const scope = {
    agentId: "main",
    sessionId: "bounded-opaque-boundary",
    sessionKey: "agent:main:bounded-opaque-boundary",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const seed = SessionManager.open(scope, dir);
  seed.appendMessage({ role: "user", content: "retained", timestamp: 1 });
  seed.appendMessage({ role: "user", content: "remove", timestamp: 2 });
  await appendTranscriptEvent(scope, {
    type: "future-metadata",
    id: "opaque-boundary",
    parentId: null,
  });
  seed.reloadPersistedTranscript();
  seed.appendMessage({ role: "user", content: "remove", timestamp: 3 });
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  const manager = SessionManager.openBounded(scope, { cwd: dir, maxBytes: 4096, maxEvents: 1 });
  openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  })
    .db.prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 3")
    .run(scope.sessionId);

  expect(() =>
    manager.removeTrailingEntries(
      (entry) =>
        entry.type === "message" &&
        "content" in entry.message &&
        entry.message.content === "remove",
    ),
  ).toThrow("Bounded transcript cleanup cannot cross the hydrated removal window");
});

it("ignores inactive matching rows before the bounded active cleanup window", async () => {
  const dir = tempDirs.make("openclaw-session-manager-bounded-inactive-boundary-");
  const scope = {
    agentId: "main",
    sessionId: "bounded-inactive-boundary",
    sessionKey: "agent:main:bounded-inactive-boundary",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const root = await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "root",
    message: { role: "user", content: "retained" },
  });
  await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "inactive-remove",
    message: { role: "assistant", content: "remove" },
    parentId: root.messageId,
  });
  const branchManager = SessionManager.open(scope, dir);
  branchManager.branch(root.messageId);
  const activeId = branchManager.appendMessage(buildAssistantMessage("remove"));
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });

  const manager = SessionManager.openBounded(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 1,
  });
  expect(manager.removeTrailingEntries((entry) => entry.id === activeId)).toBe(1);
  expect(SessionManager.open(scope, dir).buildSessionContext().messages).toMatchObject([
    { content: "retained" },
  ]);
});

it("keeps the original hydration boundary after a partial bounded trim", async () => {
  const dir = tempDirs.make("openclaw-session-manager-bounded-partial-trim-");
  const scope = {
    agentId: "main",
    sessionId: "bounded-partial-trim",
    sessionKey: "agent:main:bounded-partial-trim",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  for (let index = 0; index < 12; index += 1) {
    await appendTranscriptMessage(scope, {
      eventId: `event-${index}`,
      message: { role: index % 2 === 0 ? "user" : "assistant", content: `message-${index}` },
      now: index + 1,
    });
  }
  const manager = SessionManager.open(scope, dir, { maxBytes: 1024 * 1024, maxEvents: 8 });
  expect(manager.removeTrailingEntries((entry) => entry.id === "event-11")).toBe(1);
  expect(manager.removeTrailingEntries((entry) => entry.id !== "event-3")).toBe(7);
  expect(
    (await loadTranscriptEvents(scope))
      .map((entry) => (entry as { id?: string }).id)
      .filter((id) => id?.startsWith("event-")),
  ).toEqual(["event-0", "event-1", "event-2", "event-3"]);
});

it("keeps an all-preserved bounded window as a no-op", async () => {
  const dir = tempDirs.make("openclaw-session-manager-bounded-preserved-noop-");
  const scope = {
    agentId: "main",
    sessionId: "bounded-preserved-noop",
    sessionKey: "agent:main:bounded-preserved-noop",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  expect(
    replaceTranscriptEventsSync(scope, [
      {
        type: "session",
        version: 3,
        id: scope.sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: dir,
      },
      ...Array.from({ length: 4 }, (_value, index) => ({
        type: "custom" as const,
        id: `preserved-${index}`,
        parentId: index === 0 ? null : `preserved-${index - 1}`,
        timestamp: new Date(index + 1).toISOString(),
        customType: "preserved-metadata",
        data: { index },
      })),
    ]),
  ).toBe(true);
  const manager = SessionManager.openBounded(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 2,
  });

  expect(
    manager.removeTrailingEntries(() => true, {
      preserveTrailing: (entry) => entry.type === "custom",
    }),
  ).toBe(0);
  expect((await loadTranscriptEvents(scope)).map((entry) => (entry as { id?: string }).id)).toEqual(
    [scope.sessionId, "preserved-0", "preserved-1", "preserved-2", "preserved-3"],
  );
});

it.each([
  { corruptSeq: 1, name: "older raw prefix" },
  { corruptSeq: 2, name: "newly exposed bounded row" },
])("removes a bounded tail without parsing a $name", async ({ corruptSeq }) => {
  const dir = tempDirs.make("openclaw-session-manager-unparsed-prefix-");
  const scope = {
    agentId: "main",
    sessionId: `unparsed-prefix-session-${corruptSeq}`,
    sessionKey: `agent:main:unparsed-prefix-session-${corruptSeq}`,
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const seed = SessionManager.open(scope, dir);
  seed.appendMessage({ role: "user", content: "older", timestamp: 1 });
  seed.appendMessage({ role: "user", content: "middle", timestamp: 2 });
  seed.appendMessage({ role: "user", content: "retained", timestamp: 3 });
  const removableId = seed.appendMessage(buildAssistantMessage("temporary"));
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: path.join(dir, "openclaw-agent.sqlite"),
  });
  const manager = SessionManager.openBounded(scope, { cwd: dir, maxBytes: 4096, maxEvents: 2 });

  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  database.db
    .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = ?")
    .run("{excluded-row-is-not-json", scope.sessionId, corruptSeq);

  expect(manager.removeTrailingEntries((entry) => entry.id === removableId)).toBe(1);
  expect(manager.buildSessionContext().messages).toMatchObject([{ content: "retained" }]);
  expect(
    database.db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = ?")
      .get(scope.sessionId, corruptSeq),
  ).toEqual({ event_json: "{excluded-row-is-not-json" });
});

it("invalidates raw and visible cursors while keeping the projection available", async () => {
  const dir = tempDirs.make("openclaw-session-manager-cursor-rewrite-");
  const scope = {
    agentId: "main",
    sessionId: "cursor-rewrite-session",
    sessionKey: "agent:main:cursor-rewrite-session",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, dir);
  manager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
  const removableId = manager.appendMessage(buildAssistantMessage("temporary"));
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: path.join(dir, "openclaw-agent.sqlite"),
  });
  const raw = readTranscriptRawDelta(scope);
  const visible = readSessionTranscriptVisibleMessageDeltaCore(scope);
  if (raw.kind !== "page" || visible.kind !== "page") {
    throw new Error("missing cursor fixture");
  }

  expect(manager.removeTrailingEntries((entry) => entry.id === removableId)).toBe(1);
  manager.appendMessage(buildAssistantMessage("replacement"));

  expect(readTranscriptRawDelta(scope, { cursor: raw.cursor })).toMatchObject({
    kind: "reset",
    reason: "generation_mismatch",
  });
  expect(
    readSessionTranscriptVisibleMessageDeltaCore(scope, { cursor: visible.cursor }),
  ).toMatchObject({ kind: "reset", reason: "generation_mismatch" });
  expect(() =>
    SessionManager.openBounded(scope, { cwd: dir, maxBytes: 4096, maxEvents: 4 }),
  ).not.toThrow();
});

it("keeps a long transcript projection available when removing a trailing entry", async () => {
  const dir = tempDirs.make("openclaw-session-manager-long-suffix-");
  const scope = {
    agentId: "main",
    sessionId: "long-suffix-session",
    sessionKey: "agent:main:long-suffix-session",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const events = [
    {
      type: "session",
      version: 3,
      id: scope.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: dir,
    },
    ...Array.from({ length: SYNC_REBUILD_MAX_ROWS }, (_value, index) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      timestamp: new Date(index + 1).toISOString(),
      message: { role: index % 2 === 0 ? "user" : "assistant", content: `message ${index}` },
    })),
  ];
  expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: path.join(dir, "openclaw-agent.sqlite"),
  });
  const generationBefore = readSessionTranscriptWatermark(scope)?.generation;

  const manager = SessionManager.openBounded(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 4,
  });
  expect(
    manager.removeTrailingEntries((entry) => entry.id === `message-${SYNC_REBUILD_MAX_ROWS - 1}`),
  ).toBe(1);

  expect(readSessionTranscriptWatermark(scope)?.generation).not.toBe(generationBefore);
  expect(() =>
    SessionManager.openBounded(scope, {
      cwd: dir,
      maxBytes: 4096,
      maxEvents: 4,
    }),
  ).not.toThrow();
});

it.each([
  { oversized: "retained prefix", temporaryContent: "temporary" },
  { oversized: "removed suffix", temporaryContent: "x".repeat(SYNC_REBUILD_MAX_BYTES + 1) },
])("removes a trailing entry with an oversized $oversized", async ({ temporaryContent }) => {
  const dir = tempDirs.make("openclaw-session-manager-large-byte-suffix-");
  const scope = {
    agentId: "main",
    sessionId: "large-byte-suffix-session",
    sessionKey: "agent:main:large-byte-suffix-session",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, dir);
  manager.appendMessage({
    role: "user",
    content: temporaryContent === "temporary" ? "x".repeat(SYNC_REBUILD_MAX_BYTES + 1) : "retained",
    timestamp: 1,
  });
  const removableId = manager.appendMessage({
    role: "user",
    content: temporaryContent,
    timestamp: 2,
  });
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: path.join(dir, "openclaw-agent.sqlite"),
  });

  expect(manager.removeTrailingEntries((entry) => entry.id === removableId)).toBe(1);
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: path.join(dir, "openclaw-agent.sqlite"),
  });
  expect(() =>
    SessionManager.openBounded(scope, { cwd: dir, maxBytes: 4096, maxEvents: 4 }),
  ).not.toThrow();
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
  const generationBefore = readSessionTranscriptWatermark(scope).generation;

  expect(manager.buildSessionContext().messages).toMatchObject([
    { content: "root" },
    { content: "active" },
  ]);
  expect(manager.removeTrailingEntries((entry) => entry.id === activeId)).toBe(1);
  expect(readSessionTranscriptWatermark(scope).generation).not.toBe(generationBefore);
  expect(openBounded).not.toThrow();
  await expect(loadTranscriptEvents(scope)).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: inactive.messageId,
        message: { role: "assistant", content: "inactive" },
      }),
    ]),
  );
});
