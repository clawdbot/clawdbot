import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  appendTranscriptMessage,
  applySessionEntryLifecycleMutation,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { CURRENT_SESSION_VERSION } from "./version.js";

describe("SQLite reset boundary transcript header", () => {
  let testState: OpenClawTestState;
  let storePath: string;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-reset-header-",
      layout: "state-only",
    });
    const tempDir = testState.sessionsDir();
    fs.mkdirSync(tempDir, { recursive: true });
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await testState.cleanup();
  });

  function readEvents(sessionId: string): { type?: unknown; version?: unknown; cwd?: unknown }[] {
    const target = resolveSqliteTargetFromSessionStorePath(storePath);
    if (!target.path) {
      throw new Error("expected SQLite database path");
    }
    const owner = openOpenClawAgentDatabase({
      agentId: target.agentId ?? "main",
      path: target.path,
    });
    const db = getSessionKysely(owner.db);
    return executeSqliteQuerySync(
      owner.db,
      db
        .selectFrom("transcript_events")
        .select(["seq", "event_json"])
        .where("session_id", "=", sessionId)
        .orderBy("seq", "asc"),
    ).rows.map((row) => JSON.parse(row.event_json));
  }

  // Regression: a session window can exist with a still-empty transcript when a
  // reset arrives (created moments earlier, before its first message). Appending
  // the boundary made seq 0 a reset event; ensureTranscriptHeader only fires on
  // an empty transcript, so the first message append skipped it and the window
  // stayed permanently headerless -- rejected on every later load as a legacy
  // transcript, before any model ran.
  it.each(["empty-window", "next-window"])(
    "keeps an empty reset transcript readable with next session %s",
    async (nextSessionId) => {
      const sessionKey = "agent:main:empty-window-reset";
      await replaceSessionEntry(
        { sessionKey, storePath },
        { sessionId: "empty-window", updatedAt: 10 },
      );

      await resetSessionEntryLifecycle({
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        resetBoundary: { context: "clear", reason: "new", cwd: "/tmp/reset-session-workspace" },
        buildNextEntry: () => ({ sessionId: nextSessionId, updatedAt: 20 }),
      });

      expect(
        SessionManager.open({
          agentId: "main",
          sessionKey,
          sessionId: "empty-window",
          storePath,
        }).getHeader(),
      ).toMatchObject({ version: CURRENT_SESSION_VERSION, cwd: "/tmp/reset-session-workspace" });
      const events = readEvents("empty-window");
      expect(events[0]?.type).toBe("session");
      expect(events[0]?.version).toBe(CURRENT_SESSION_VERSION);
      // The header must record the session workspace, not the service process cwd.
      expect(events[0]?.cwd).toBe("/tmp/reset-session-workspace");
      expect(events[1]?.type).toBe("reset");
    },
  );

  it.each(["projection-window", "next-projection"])(
    "keeps an empty batched reset readable with next session %s",
    async (nextSessionId) => {
      const sessionKey = "agent:main:projection-window-reset";
      await replaceSessionEntry(
        { sessionKey, storePath },
        { sessionId: "projection-window", updatedAt: 10 },
      );

      await applySessionEntryLifecycleMutation({
        storePath,
        upserts: [
          {
            sessionKey,
            entry: { sessionId: nextSessionId, updatedAt: 20 },
            resetBoundary: {
              context: "clear",
              reason: "new",
              cwd: "/tmp/projection-session-workspace",
            },
          },
        ],
        skipMaintenance: true,
      });

      expect(
        SessionManager.open({
          agentId: "main",
          sessionKey,
          sessionId: "projection-window",
          storePath,
        }).getHeader(),
      ).toMatchObject({
        version: CURRENT_SESSION_VERSION,
        cwd: "/tmp/projection-session-workspace",
      });
      const events = readEvents("projection-window");
      expect(events[0]?.type).toBe("session");
      expect(events[0]?.cwd).toBe("/tmp/projection-session-workspace");
      expect(events[1]?.type).toBe("reset");
    },
  );

  // The header is written for the prior row's session, so a custom-workspace
  // session keeps its own cwd even when the reset caller only knows the
  // configured agent workspace. Otherwise later transcript cut/fork paths would
  // carry the wrong workspace forward.
  it("prefers the prior row's spawned cwd over the caller workspace", async () => {
    const sessionKey = "agent:main:custom-workspace-reset";
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "custom-window",
        updatedAt: 10,
        spawnedWorkspaceDir: "/tmp/custom-session-workspace",
        spawnedCwd: "/tmp/custom-session-workspace/task",
      },
    );

    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      resetBoundary: { context: "clear", reason: "new", cwd: "/tmp/agent-default-workspace" },
      buildNextEntry: () => ({ sessionId: "next-custom", updatedAt: 20 }),
    });

    const events = readEvents("custom-window");
    expect(events[0]?.type).toBe("session");
    expect(events[0]?.cwd).toBe("/tmp/custom-session-workspace/task");
    expect(events[1]?.type).toBe("reset");
  });

  it("prefers the prior row's spawned workspace via the batched upsert path too", async () => {
    const sessionKey = "agent:main:custom-projection-reset";
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "custom-projection-window",
        updatedAt: 10,
        spawnedWorkspaceDir: "/tmp/custom-projection-workspace",
      },
    );

    await applySessionEntryLifecycleMutation({
      storePath,
      upserts: [
        {
          sessionKey,
          entry: { sessionId: "next-custom-projection", updatedAt: 20 },
          resetBoundary: { context: "clear", reason: "new", cwd: "/tmp/agent-default-workspace" },
        },
      ],
      skipMaintenance: true,
    });

    const events = readEvents("custom-projection-window");
    expect(events[0]?.type).toBe("session");
    expect(events[0]?.cwd).toBe("/tmp/custom-projection-workspace");
    expect(events[1]?.type).toBe("reset");
  });

  it("still records the boundary after the header on a populated transcript", async () => {
    const sessionKey = "agent:main:populated-window-reset";
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: "populated-window", updatedAt: 10 },
    );
    await appendTranscriptMessage(
      { sessionId: "populated-window", sessionKey, storePath },
      { message: { role: "user", content: "first" } },
    );

    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      resetBoundary: { context: "clear", reason: "new", cwd: "/tmp/reset-session-workspace" },
      buildNextEntry: () => ({ sessionId: "next-populated", updatedAt: 20 }),
    });

    const events = readEvents("populated-window");
    expect(events[0]?.type).toBe("session");
    expect(events.filter((event) => event?.type === "session")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("reset");
  });
});
