import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  SessionTranscriptProjectionUnavailableError,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
