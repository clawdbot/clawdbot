import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  SessionTranscriptProjectionUnavailableError,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
