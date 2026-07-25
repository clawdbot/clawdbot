/**
 * Session compaction checkpoint persistence tests.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, test } from "vitest";
import type { SessionCompactionCheckpoint, SessionEntry } from "../config/sessions.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import {
  createFileBackedCompactionCheckpointStore,
  readSessionLeafStateFromTranscriptAsync,
  resolveCompactionCheckpointTranscriptPosition,
} from "./session-compaction-checkpoints.js";

const tempDirs: string[] = [];
const MAIN_AGENT_ID = "main";
const MAIN_SESSION_KEY = "agent:main:main";

function requireNonEmptyString(value: string | null | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function isAssistantTextEvent(event: unknown, text: string): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return false;
  }
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const candidate = message as { role?: unknown; content?: unknown };
  return candidate.role === "assistant" && candidate.content === text;
}

async function writeAccessorSessionEntry(
  storePath: string,
  sessionKey: string,
  entry: Partial<SessionEntry>,
): Promise<void> {
  await upsertSessionEntry({ storePath, sessionKey }, entry);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("session-compaction-checkpoints", () => {
  test("keeps logical leaves separate from physical truncation cursors", () => {
    expect(
      resolveCompactionCheckpointTranscriptPosition({
        preferredLeafId: "active-root",
        transcriptState: {
          leafId: "raw-tail",
          entryId: "raw-tail",
        },
      }),
    ).toEqual({
      leafId: "active-root",
      entryId: "raw-tail",
    });
  });

  test("checkpoint store branches and restores SQLite marker checkpoints from rows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-sqlite-branch-"));
    tempDirs.push(dir);
    const storePath = path.join(dir, "openclaw-agent.sqlite");
    const sessionId = "sqlite-checkpoint-branch-source";
    const sessionKey = MAIN_SESSION_KEY;
    const scope = {
      agentId: MAIN_AGENT_ID,
      sessionId,
      sessionKey,
      storePath,
    };
    const marker = formatSqliteSessionFileMarker({
      agentId: MAIN_AGENT_ID,
      sessionId,
      storePath,
    });

    await upsertSessionEntry(scope, {
      sessionId,
      sessionFile: marker,
      updatedAt: Date.now(),
    });
    await appendTranscriptEvent(scope, {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp: "2026-06-26T12:00:00.000Z",
      cwd: dir,
    });
    await appendTranscriptMessage(scope, {
      message: { role: "user", content: "branch from sqlite checkpoint", timestamp: 1 },
      now: Date.parse("2026-06-26T12:00:01.000Z"),
    });
    await appendTranscriptMessage(scope, {
      message: {
        role: "assistant",
        content: "checkpoint branch source",
        timestamp: 2,
      } as unknown as AssistantMessage,
      now: Date.parse("2026-06-26T12:00:02.000Z"),
    });
    const sourceLeafId = requireNonEmptyString(
      SessionManager.open(marker).getLeafId(),
      "SQLite source leaf id missing",
    );
    const checkpoint: SessionCompactionCheckpoint = {
      checkpointId: "sqlite-checkpoint-branch",
      sessionKey,
      sessionId,
      createdAt: Date.now(),
      reason: "manual",
      tokensBefore: 100,
      tokensAfter: 40,
      preCompaction: {
        sessionId,
        leafId: sourceLeafId,
        entryId: sourceLeafId,
      },
      postCompaction: {
        sessionId,
        leafId: sourceLeafId,
        entryId: sourceLeafId,
      },
    };
    await upsertSessionEntry(scope, {
      sessionId,
      sessionFile: marker,
      updatedAt: Date.now(),
      compactionCheckpoints: [checkpoint],
    });

    const store = createFileBackedCompactionCheckpointStore();
    const branchKey = "agent:main:checkpoint-branch";
    const branched = await store.branchCheckpointSession({
      storePath,
      sourceKey: sessionKey,
      nextKey: branchKey,
      checkpointId: checkpoint.checkpointId,
    });
    const restored = await store.restoreCheckpointSession({
      storePath,
      sessionKey,
      checkpointId: checkpoint.checkpointId,
    });

    if (branched.status !== "created" || restored.status !== "created") {
      throw new Error("expected SQLite checkpoint branch and restore");
    }
    expect(branched.entry.sessionFile).toContain("sqlite:main:");
    expect(restored.entry.sessionFile).toContain("sqlite:main:");
    expect(fsSync.readdirSync(dir).some((file) => file.endsWith(".jsonl"))).toBe(false);

    const branchEvents = await loadTranscriptEvents({
      agentId: MAIN_AGENT_ID,
      sessionId: branched.entry.sessionId,
      sessionKey: branchKey,
      storePath,
    });
    const restoredEvents = await loadTranscriptEvents({
      agentId: MAIN_AGENT_ID,
      sessionId: restored.entry.sessionId,
      sessionKey,
      storePath,
    });
    expect(
      branchEvents.some((event) => isAssistantTextEvent(event, "checkpoint branch source")),
    ).toBe(true);
    expect(
      restoredEvents.some((event) => isAssistantTextEvent(event, "checkpoint branch source")),
    ).toBe(true);
  });

  test("checkpoint store branches row-backed checkpoints when entry sessionFile is stale", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-sqlite-stale-"));
    tempDirs.push(dir);
    const storePath = path.join(dir, "openclaw-agent.sqlite");
    const sessionId = "sqlite-checkpoint-stale-source";
    const sessionKey = MAIN_SESSION_KEY;
    const scope = {
      agentId: MAIN_AGENT_ID,
      sessionId,
      sessionKey,
      storePath,
    };
    const marker = formatSqliteSessionFileMarker({
      agentId: MAIN_AGENT_ID,
      sessionId,
      storePath,
    });
    const staleSessionFile = path.join(dir, "stale-transcript.jsonl");

    await upsertSessionEntry(scope, {
      sessionId,
      sessionFile: staleSessionFile,
      updatedAt: Date.now(),
    });
    await appendTranscriptEvent(scope, {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp: "2026-06-26T12:00:00.000Z",
      cwd: dir,
    });
    await appendTranscriptMessage(scope, {
      message: { role: "user", content: "stale entry row-backed checkpoint", timestamp: 1 },
      now: Date.parse("2026-06-26T12:00:01.000Z"),
    });
    const leafBeforeEntryId = requireNonEmptyString(
      SessionManager.open(marker).getLeafId(),
      "SQLite stale-entry pre-entry leaf id missing",
    );
    await appendTranscriptMessage(scope, {
      message: {
        role: "assistant",
        content: "entry id boundary message",
        timestamp: 2,
      } as unknown as AssistantMessage,
      now: Date.parse("2026-06-26T12:00:02.000Z"),
    });
    const sourceEntryId = requireNonEmptyString(
      SessionManager.open(marker).getLeafId(),
      "SQLite stale-entry entry id missing",
    );
    const checkpoint: SessionCompactionCheckpoint = {
      checkpointId: "sqlite-checkpoint-stale",
      sessionKey,
      sessionId,
      createdAt: Date.now(),
      reason: "manual",
      preCompaction: {
        sessionId,
        leafId: leafBeforeEntryId,
        entryId: sourceEntryId,
      },
      postCompaction: {
        sessionId,
        leafId: leafBeforeEntryId,
        entryId: sourceEntryId,
      },
    };
    const markerCheckpoint: SessionCompactionCheckpoint = {
      checkpointId: "sqlite-checkpoint-stale-marker",
      sessionKey,
      sessionId,
      createdAt: Date.now() + 1,
      reason: "manual",
      preCompaction: {
        sessionId,
        leafId: leafBeforeEntryId,
      },
      postCompaction: {
        sessionId,
        sessionFile: marker,
        leafId: sourceEntryId,
      },
    };
    await upsertSessionEntry(scope, {
      sessionId,
      sessionFile: staleSessionFile,
      updatedAt: Date.now(),
      compactionCheckpoints: [checkpoint, markerCheckpoint],
    });

    const branchKey = "agent:main:stale-checkpoint-branch";
    const branched = await createFileBackedCompactionCheckpointStore().branchCheckpointSession({
      storePath,
      sourceKey: sessionKey,
      nextKey: branchKey,
      checkpointId: checkpoint.checkpointId,
    });

    if (branched.status !== "created") {
      throw new Error("expected stale-entry SQLite checkpoint branch");
    }
    expect(branched.entry.sessionFile).toContain("sqlite:main:");
    expect(fsSync.existsSync(staleSessionFile)).toBe(false);
    expect(fsSync.readdirSync(dir).some((file) => file.endsWith(".jsonl"))).toBe(false);
    const branchEvents = await loadTranscriptEvents({
      agentId: MAIN_AGENT_ID,
      sessionId: branched.entry.sessionId,
      sessionKey: branchKey,
      storePath,
    });
    expect(
      branchEvents.some((event) => isAssistantTextEvent(event, "entry id boundary message")),
    ).toBe(true);

    const markerBranched =
      await createFileBackedCompactionCheckpointStore().branchCheckpointSession({
        storePath,
        sourceKey: sessionKey,
        nextKey: "agent:main:stale-marker-checkpoint-branch",
        checkpointId: markerCheckpoint.checkpointId,
      });
    if (markerBranched.status !== "created") {
      throw new Error("expected stale-entry SQLite marker checkpoint branch");
    }
    expect(markerBranched.entry.sessionFile).toContain("sqlite:main:");
  });

  test("checkpoint store does not fork retired legacy snapshots for SQLite marker entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-sqlite-legacy-"));
    tempDirs.push(dir);
    const storePath = path.join(dir, "openclaw-agent.sqlite");
    const sessionId = "sqlite-checkpoint-legacy-source";
    const sessionKey = MAIN_SESSION_KEY;
    const marker = formatSqliteSessionFileMarker({
      agentId: MAIN_AGENT_ID,
      sessionId,
      storePath,
    });
    const legacySnapshotFile = path.join(dir, "legacy.checkpoint.jsonl");
    await fs.writeFile(
      legacySnapshotFile,
      [
        {
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: sessionId,
          timestamp: "2026-06-26T12:00:00.000Z",
          cwd: dir,
        },
        {
          type: "message",
          id: "legacy-leaf",
          parentId: null,
          timestamp: "2026-06-26T12:00:01.000Z",
          message: { role: "assistant", content: "legacy checkpoint source" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf-8",
    );
    await upsertSessionEntry(
      {
        agentId: MAIN_AGENT_ID,
        sessionKey,
        storePath,
      },
      {
        sessionId,
        sessionFile: marker,
        updatedAt: Date.now(),
        compactionCheckpoints: [
          {
            checkpointId: "legacy-file-checkpoint",
            sessionKey,
            sessionId,
            createdAt: Date.now(),
            reason: "manual",
            preCompaction: {
              sessionId,
              sessionFile: legacySnapshotFile,
              leafId: "legacy-leaf",
            },
            postCompaction: { sessionId },
          } satisfies SessionCompactionCheckpoint,
        ],
      },
    );

    const beforeFiles = fsSync.readdirSync(dir).toSorted();

    const branched = await createFileBackedCompactionCheckpointStore().branchCheckpointSession({
      storePath,
      sourceKey: sessionKey,
      nextKey: "agent:main:legacy-checkpoint-branch",
      checkpointId: "legacy-file-checkpoint",
    });

    expect(branched.status).toBe("missing-boundary");
    expect(fsSync.readdirSync(dir).toSorted()).toEqual(beforeFiles);
  });

  test("leaf state follows terminal controls while retaining the append cursor", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-leaf-control-"));
    tempDirs.push(dir);
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        { type: "session", version: 3, id: "session-leaf-control" },
        {
          type: "message",
          id: "active-tail",
          parentId: null,
          message: { role: "assistant", content: "active" },
        },
        {
          type: "metadata",
          id: "plugin-metadata",
          parentId: "active-tail",
          payload: { source: "plugin" },
        },
        {
          type: "message",
          id: "inactive-tail",
          parentId: "active-tail",
          message: { role: "assistant", content: "side delivery" },
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "inactive-tail",
          targetId: "active-tail",
          appendParentId: "plugin-metadata",
        },
        {
          type: "metadata",
          id: "post-leaf-metadata",
          parentId: "plugin-metadata",
          payload: { phase: "after-leaf" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf-8",
    );

    expect(await readSessionLeafStateFromTranscriptAsync(sessionFile)).toEqual({
      entryId: "post-leaf-metadata",
      leafId: "active-tail",
    });
  });

  test("async leaf scans ignore controls with dangling references", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-invalid-leaf-"));
    tempDirs.push(dir);
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "session-invalid-leaf",
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: dir,
        },
        {
          type: "message",
          id: "active-tail",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "active" },
        },
        {
          type: "leaf",
          id: "missing-target",
          parentId: "active-tail",
          timestamp: "2026-06-15T00:00:02.000Z",
          targetId: "missing",
        },
        {
          type: "leaf",
          id: "missing-append",
          parentId: "active-tail",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "active-tail",
          appendParentId: "missing",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf-8",
    );

    expect(await readSessionLeafStateFromTranscriptAsync(sessionFile)).toEqual({
      entryId: "missing-append",
      leafId: "active-tail",
    });
  });

  test("file-backed checkpoint store branches active state and restores source management state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-store-"));
    tempDirs.push(dir);

    const session = SessionManager.create(dir, dir);
    session.appendMessage({
      role: "user",
      content: "checkpoint source",
      timestamp: Date.now(),
    });
    const checkpointLeafId = requireNonEmptyString(
      session.getLeafId(),
      "checkpoint leaf id missing",
    );
    session.appendMessage({
      role: "assistant",
      content: "future turn",
      api: "responses",
      provider: "openai",
      model: "gpt-test",
      timestamp: Date.now(),
    } as unknown as AssistantMessage);

    const sessionFile = requireNonEmptyString(session.getSessionFile(), "session file missing");
    const storePath = path.join(dir, "sessions.json");
    const managedAt = Date.now() - 2;
    await writeAccessorSessionEntry(storePath, MAIN_SESSION_KEY, {
      sessionId: "current-session",
      sessionFile,
      updatedAt: Date.now() - 1,
      archivedAt: managedAt,
      pinnedAt: managedAt,
      icon: "name:spark",
      totalTokens: 200,
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint-1",
          sessionKey: MAIN_SESSION_KEY,
          sessionId: "stored-session",
          createdAt: Date.now(),
          reason: "manual",
          tokensAfter: 45,
          preCompaction: { sessionId: "pre-session", leafId: "pre-leaf" },
          postCompaction: {
            sessionId: "post-session",
            sessionFile,
            leafId: checkpointLeafId,
          },
        },
      ],
    });
    const store = createFileBackedCompactionCheckpointStore();
    const branched = await store.branchCheckpointSession({
      storePath,
      sourceKey: MAIN_SESSION_KEY,
      nextKey: "agent:main:dashboard:checkpoint-branch",
      checkpointId: "checkpoint-1",
    });

    if (branched.status !== "created") {
      throw new Error("expected branched checkpoint transcript");
    }
    expect(branched.entry.archivedAt).toBeUndefined();
    expect(branched.entry.pinnedAt).toBeUndefined();
    expect(branched.entry.icon).toBeUndefined();

    const restored = await store.restoreCheckpointSession({
      storePath,
      sessionKey: MAIN_SESSION_KEY,
      checkpointId: "checkpoint-1",
    });

    if (restored.status !== "created") {
      throw new Error("expected restored checkpoint transcript");
    }
    expect(restored.entry.totalTokens).toBe(45);
    expect(restored.entry.archivedAt).toBe(managedAt);
    expect(restored.entry.pinnedAt).toBe(managedAt);
    expect(restored.entry.icon).toBe("name:spark");
    const restoredSessionFile = requireNonEmptyString(
      restored.entry.sessionFile,
      "restored session file missing",
    );
    const messages = SessionManager.open(restoredSessionFile, dir).buildSessionContext().messages;
    expect(messages.map((message) => (message as { content?: unknown }).content)).toEqual([
      "checkpoint source",
    ]);
    const nextEntry = loadSessionEntry({ storePath, sessionKey: MAIN_SESSION_KEY });
    expect(nextEntry?.sessionFile).toBe(restored.entry.sessionFile);
    expect(nextEntry?.totalTokens).toBe(45);
  });

  test("file-backed checkpoint store rejects identity changes for model-selection-locked sessions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-locked-"));
    tempDirs.push(dir);

    const session = SessionManager.create(dir, dir);
    session.appendMessage({
      role: "user",
      content: "locked checkpoint source",
      timestamp: Date.now(),
    });
    const checkpointLeafId = requireNonEmptyString(
      session.getLeafId(),
      "checkpoint leaf id missing",
    );
    const sessionFile = requireNonEmptyString(session.getSessionFile(), "session file missing");
    const storePath = path.join(dir, "sessions.json");
    await upsertSessionEntry(
      { storePath, sessionKey: MAIN_SESSION_KEY },
      {
        sessionId: "locked-session",
        sessionFile,
        updatedAt: Date.now(),
        modelSelectionLocked: true,
        compactionCheckpoints: [
          {
            checkpointId: "checkpoint-locked",
            sessionKey: MAIN_SESSION_KEY,
            sessionId: "locked-session",
            createdAt: Date.now(),
            reason: "manual",
            preCompaction: { sessionId: "locked-session", leafId: checkpointLeafId },
            postCompaction: {
              sessionId: "locked-session",
              sessionFile,
              leafId: checkpointLeafId,
            },
          },
        ],
      },
    );
    const filesBefore = (await fs.readdir(dir)).toSorted();
    const store = createFileBackedCompactionCheckpointStore();

    await expect(
      store.branchCheckpointSession({
        storePath,
        sourceKey: MAIN_SESSION_KEY,
        nextKey: "agent:main:dashboard:locked-checkpoint-branch",
        checkpointId: "checkpoint-locked",
      }),
    ).resolves.toEqual({ status: "model-selection-locked" });
    await expect(
      store.restoreCheckpointSession({
        storePath,
        sessionKey: MAIN_SESSION_KEY,
        checkpointId: "checkpoint-locked",
      }),
    ).resolves.toEqual({ status: "model-selection-locked" });

    expect((await fs.readdir(dir)).toSorted()).toEqual(filesBefore);
    expect(loadSessionEntry({ storePath, sessionKey: MAIN_SESSION_KEY })).toEqual(
      expect.objectContaining({
        modelSelectionLocked: true,
        sessionId: "locked-session",
      }),
    );
  });
});
