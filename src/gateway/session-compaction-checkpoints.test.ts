/**
 * Session compaction checkpoint persistence tests.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { CURRENT_SESSION_VERSION, SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SessionCompactionCheckpoint, SessionEntry } from "../config/sessions.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureCompactionCheckpointSnapshotAsync,
  cleanupCompactionCheckpointSnapshot,
  createFileBackedCompactionCheckpointStore,
  forkCompactionCheckpointTranscriptAsync,
  MAX_COMPACTION_CHECKPOINT_LEAF_SCAN_BYTES,
  MAX_COMPACTION_CHECKPOINT_RETAINED_BYTES_PER_SESSION,
  persistSessionCompactionCheckpoint,
  readSessionLeafStateFromTranscriptAsync,
  resolveCompactionCheckpointTranscriptPosition,
} from "./session-compaction-checkpoints.js";

const tempDirs: string[] = [];
const MAIN_AGENT_ID = "main";
const MAIN_SESSION_KEY = "agent:main:main";
const TEST_SESSION_ID = "sess";

type PersistCheckpointInput = Parameters<typeof persistSessionCompactionCheckpoint>[0];

type LegacyCheckpointFixture = {
  checkpointId: string;
  sessionKey: string;
  sessionId: string;
  createdAt: number;
  reason: "manual";
  preCompaction: {
    sessionId: string;
    sessionFile: string;
    leafId: string;
  };
  postCompaction: { sessionId: string };
};

function requireNonEmptyString(value: string | null | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(value: unknown, expected: Record<string, unknown>): void {
  const record = requireRecord(value, "expected record");
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

function expectNonEmptyStringField(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) {
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

async function makeTempSessionStore(prefix: string, sessionId = TEST_SESSION_ID) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return {
    dir,
    storePath: path.join(dir, "sessions.json"),
    sessionId,
    sessionKey: MAIN_SESSION_KEY,
    now: Date.now(),
  };
}

function checkpointConfig(storePath: string): OpenClawConfig {
  return {
    session: { store: storePath },
    agents: { list: [{ id: MAIN_AGENT_ID, default: true }] },
  } as OpenClawConfig;
}

async function writeAccessorSessionEntry(
  storePath: string,
  sessionKey: string,
  entry: Partial<SessionEntry>,
): Promise<void> {
  await upsertSessionEntry({ storePath, sessionKey }, entry);
}

async function readFirstCompactionCheckpoints<T>(storePath: string): Promise<T[] | undefined> {
  return loadSessionEntry({ storePath, sessionKey: MAIN_SESSION_KEY })?.compactionCheckpoints as
    | T[]
    | undefined;
}

async function createLegacyCheckpointFixtures(options: {
  dir: string;
  sessionId: string;
  sessionKey: string;
  now: number;
  count: number;
  initializeFile: (sessionFile: string, index: number) => Promise<void>;
}): Promise<LegacyCheckpointFixture[]> {
  return Promise.all(
    Array.from({ length: options.count }, async (_, index) => {
      const uuid = `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`;
      const sessionFile = path.join(options.dir, `sess.checkpoint.${uuid}.jsonl`);
      await options.initializeFile(sessionFile, index);
      return {
        checkpointId: `old-${index}`,
        sessionKey: options.sessionKey,
        sessionId: options.sessionId,
        createdAt: options.now + index,
        reason: "manual",
        preCompaction: {
          sessionId: options.sessionId,
          sessionFile,
          leafId: `old-leaf-${index}`,
        },
        postCompaction: { sessionId: options.sessionId },
      };
    }),
  );
}

async function persistMainCheckpoint(
  storePath: string,
  options: {
    sessionId: string;
    snapshot: PersistCheckpointInput["snapshot"];
    createdAt: number;
    postSessionFile?: string;
    postLeafId?: string;
  },
) {
  return persistSessionCompactionCheckpoint({
    cfg: checkpointConfig(storePath),
    sessionKey: MAIN_SESSION_KEY,
    sessionId: options.sessionId,
    reason: "manual",
    snapshot: options.snapshot,
    createdAt: options.createdAt,
    ...(options.postSessionFile === undefined ? {} : { postSessionFile: options.postSessionFile }),
    ...(options.postLeafId === undefined ? {} : { postLeafId: options.postLeafId }),
  });
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

  test("async capture stores pre-compaction identity without copying the transcript", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-async-"));
    tempDirs.push(dir);

    const session = SessionManager.create(dir, dir);
    session.appendMessage({
      role: "user",
      content: "before async compaction",
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "async working on it" }],
      api: "responses",
      provider: "openai",
      model: "gpt-test",
      timestamp: Date.now(),
    } as AssistantMessage);

    const sessionFile = requireNonEmptyString(session.getSessionFile(), "session file missing");
    const leafId = requireNonEmptyString(session.getLeafId(), "session leaf id missing");

    const originalBefore = await fs.readFile(sessionFile, "utf-8");
    const copyFileSyncSpy = vi.spyOn(fsSync, "copyFileSync");
    const sessionManagerOpenSpy = vi.spyOn(SessionManager, "open");
    try {
      const snapshot = await captureCompactionCheckpointSnapshotAsync({
        sessionManager: session,
        sessionFile,
      });

      expect(copyFileSyncSpy).not.toHaveBeenCalled();
      expect(sessionManagerOpenSpy).not.toHaveBeenCalled();
      if (!snapshot) {
        throw new Error("expected checkpoint snapshot");
      }
      expect(snapshot.leafId).toBe(leafId);
      expect(snapshot.sessionFile).toBeUndefined();
      expect(fsSync.readdirSync(dir).some((file) => file.includes(".checkpoint."))).toBe(false);

      session.appendCompaction("checkpoint summary", leafId, 123, { ok: true });

      expect(await fs.readFile(sessionFile, "utf-8")).not.toBe(originalBefore);

      await cleanupCompactionCheckpointSnapshot(snapshot);

      expect(fsSync.existsSync(sessionFile)).toBe(true);
    } finally {
      copyFileSyncSpy.mockRestore();
      sessionManagerOpenSpy.mockRestore();
    }
  });

  test("async capture reads SQLite marker sessions without active transcript files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-sqlite-"));
    tempDirs.push(dir);
    const storePath = path.join(dir, "openclaw-agent.sqlite");
    const sessionId = "sqlite-checkpoint-session";
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
      message: { role: "user", content: "compact sqlite rows", timestamp: 1 },
      now: Date.parse("2026-06-26T12:00:01.000Z"),
    });
    await appendTranscriptMessage(scope, {
      message: {
        role: "assistant",
        content: "sqlite rows are active",
        timestamp: 2,
      } as unknown as AssistantMessage,
      now: Date.parse("2026-06-26T12:00:02.000Z"),
    });

    const sessionManager = SessionManager.open(marker);
    const leafId = requireNonEmptyString(sessionManager.getLeafId(), "SQLite leaf id missing");
    const snapshot = await captureCompactionCheckpointSnapshotAsync({
      sessionManager,
      sessionFile: marker,
    });

    expect(fsSync.existsSync(marker)).toBe(false);
    expect(fsSync.readdirSync(dir).some((file) => file.endsWith(".jsonl"))).toBe(false);
    expect(snapshot).toMatchObject({
      sessionId,
      leafId,
      entryId: leafId,
    });
    expect(await readSessionLeafStateFromTranscriptAsync(marker)).toEqual({
      entryId: leafId,
      leafId,
    });

    const compactionId = sessionManager.appendCompaction("sqlite checkpoint summary", leafId, 42, {
      manual: true,
    });
    expect(await readSessionLeafStateFromTranscriptAsync(marker)).toEqual({
      entryId: compactionId,
      leafId: compactionId,
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

  test("async capture derives session metadata without synchronous SessionManager.open", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-async-metadata-"));
    tempDirs.push(dir);

    const session = SessionManager.create(dir, dir);
    session.appendMessage({
      role: "user",
      content: "derive checkpoint metadata",
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "assistant",
      content: "metadata derived",
      api: "responses",
      provider: "openai",
      model: "gpt-test",
      timestamp: Date.now(),
    } as unknown as AssistantMessage);

    const sessionFile = requireNonEmptyString(session.getSessionFile(), "session file missing");
    const sessionId = requireNonEmptyString(session.getSessionId(), "session id missing");
    const leafId = requireNonEmptyString(session.getLeafId(), "session leaf id missing");
    await fs.appendFile(sessionFile, "\nnot-json\n", "utf-8");

    const copyFileSyncSpy = vi.spyOn(fsSync, "copyFileSync");
    const sessionManagerOpenSpy = vi.spyOn(SessionManager, "open");
    let snapshot: Awaited<ReturnType<typeof captureCompactionCheckpointSnapshotAsync>> | undefined;
    try {
      expect((await readSessionLeafStateFromTranscriptAsync(sessionFile))?.leafId).toBe(leafId);
      snapshot = await captureCompactionCheckpointSnapshotAsync({
        sessionFile,
      });

      expect(copyFileSyncSpy).not.toHaveBeenCalled();
      expect(sessionManagerOpenSpy).not.toHaveBeenCalled();
      if (!snapshot) {
        throw new Error("expected checkpoint snapshot");
      }
      expect(snapshot.sessionId).toBe(sessionId);
      expect(snapshot.leafId).toBe(leafId);
      expect(snapshot.sessionFile).toBeUndefined();
      expect(fsSync.readdirSync(dir).some((file) => file.includes(".checkpoint."))).toBe(false);
    } finally {
      await cleanupCompactionCheckpointSnapshot(snapshot);
      copyFileSyncSpy.mockRestore();
      sessionManagerOpenSpy.mockRestore();
    }
  });

  test("async capture follows terminal leaf controls instead of their inactive parent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-leaf-control-"));
    tempDirs.push(dir);
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "session-leaf-control",
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
          type: "metadata",
          id: "plugin-metadata",
          parentId: "active-tail",
          payload: { source: "plugin" },
        },
        {
          type: "message",
          id: "inactive-tail",
          parentId: "active-tail",
          timestamp: "2026-06-15T00:00:02.000Z",
          message: { role: "assistant", content: "side delivery" },
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "inactive-tail",
          timestamp: "2026-06-15T00:00:03.000Z",
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
    const snapshot = await captureCompactionCheckpointSnapshotAsync({ sessionFile });
    expect(snapshot?.leafId).toBe("active-tail");
    expect(snapshot?.entryId).toBe("post-leaf-metadata");

    const forked = await forkCompactionCheckpointTranscriptAsync({
      sourceFile: sessionFile,
      sourceLeafId: snapshot?.entryId,
      sessionDir: dir,
    });
    if (!forked) {
      throw new Error("expected forked checkpoint transcript");
    }
    const restored = SessionManager.open(forked.sessionFile, dir);
    restored.appendMessage({
      role: "user",
      content: "continued after restore",
      timestamp: Date.now(),
    });
    const restoredEntries = (await fs.readFile(forked.sessionFile, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(restoredEntries.at(-1)).toMatchObject({
      type: "message",
      parentId: "post-leaf-metadata",
    });
    await cleanupCompactionCheckpointSnapshot(snapshot);
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

  test("async capture scans bounded metadata without copying oversized transcripts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-async-oversized-"));
    tempDirs.push(dir);

    const session = SessionManager.create(dir, dir);
    session.appendMessage({
      role: "user",
      content: "before compaction",
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "assistant",
      content: "large enough to scan",
      api: "responses",
      provider: "openai",
      model: "gpt-test",
      timestamp: Date.now(),
    } as unknown as AssistantMessage);
    const sessionFile = requireNonEmptyString(session.getSessionFile(), "session file missing");
    await fs.appendFile(sessionFile, `\n${"x".repeat(128)}\n`, "utf-8");

    const copyFileSyncSpy = vi.spyOn(fsSync, "copyFileSync");
    try {
      const snapshot = await captureCompactionCheckpointSnapshotAsync({
        sessionManager: session,
        sessionFile,
        maxBytes: 64,
      });

      expect(snapshot?.sessionFile).toBeUndefined();
      expect(snapshot?.sessionId).toBe(session.getSessionId());
      expect(copyFileSyncSpy).not.toHaveBeenCalled();
      expect(MAX_COMPACTION_CHECKPOINT_LEAF_SCAN_BYTES).toBeGreaterThan(64);
      expect(fsSync.readdirSync(dir).some((file) => file.includes(".checkpoint."))).toBe(false);
    } finally {
      copyFileSyncSpy.mockRestore();
    }
  });

  test("bounded capture falls back to a forkable raw tail when the leaf target is older", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-bounded-leaf-"));
    tempDirs.push(dir);
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "session-bounded-leaf",
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: dir,
        },
        {
          type: "message",
          id: "active-root",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "active" },
        },
        {
          type: "metadata",
          id: "large-side-entry",
          parentId: "active-root",
          payload: { padding: "x".repeat(2048) },
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "large-side-entry",
          timestamp: "2026-06-15T00:00:02.000Z",
          targetId: "active-root",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf-8",
    );

    expect(await readSessionLeafStateFromTranscriptAsync(sessionFile, 1024)).toEqual({
      entryId: "active-leaf",
      leafId: "active-leaf",
    });
    const snapshot = await captureCompactionCheckpointSnapshotAsync({
      sessionManager: {
        getLeafId: () => "active-root",
      },
      sessionFile,
      maxBytes: 1024,
    });
    expect(snapshot).toMatchObject({
      sessionId: "session-bounded-leaf",
      entryId: "active-leaf",
      leafId: "active-root",
    });

    const forked = await forkCompactionCheckpointTranscriptAsync({
      sourceFile: sessionFile,
      sourceLeafId: snapshot?.entryId,
      sessionDir: dir,
    });
    if (!forked) {
      throw new Error("expected bounded checkpoint fork");
    }
    expect(SessionManager.open(forked.sessionFile, dir).getLeafId()).toBe("active-root");
  });

  test("async fork creates a checkpoint branch transcript without SessionManager sync reads", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-fork-"));
    tempDirs.push(dir);

    const session = SessionManager.create(dir, dir);
    session.appendMessage({
      role: "user",
      content: "before checkpoint fork",
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "assistant",
      content: "fork me",
      api: "responses",
      provider: "openai",
      model: "gpt-test",
      timestamp: Date.now(),
    } as unknown as AssistantMessage);

    const sessionFile = requireNonEmptyString(session.getSessionFile(), "session file missing");
    await fs.appendFile(sessionFile, "\nnot-json\n", "utf-8");

    const openSpy = vi.spyOn(SessionManager, "open");
    const forkSpy = vi.spyOn(SessionManager, "forkFrom");
    let forked: Awaited<ReturnType<typeof forkCompactionCheckpointTranscriptAsync>>;
    try {
      forked = await forkCompactionCheckpointTranscriptAsync({
        sourceFile: sessionFile,
        sessionDir: dir,
      });

      expect(openSpy).not.toHaveBeenCalled();
      expect(forkSpy).not.toHaveBeenCalled();
      if (!forked) {
        throw new Error("expected forked checkpoint transcript");
      }
      expectNonEmptyStringField(forked.sessionFile, "expected forked session file");
      expect(forked.sessionFile).not.toBe(sessionFile);
      expect(forked.sessionId).toBeTypeOf("string");
      expect(forked.sessionId).not.toBe("");
    } finally {
      openSpy.mockRestore();
      forkSpy.mockRestore();
    }

    const forkedLines = (await fs.readFile(forked.sessionFile, "utf-8")).trim().split(/\r?\n/);
    const forkedEntries = forkedLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const sourceEntries = (await fs.readFile(sessionFile, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });

    expectRecordFields(forkedEntries[0], {
      type: "session",
      id: forked.sessionId,
      cwd: dir,
      parentSession: sessionFile,
    });
    expect(forkedEntries.slice(1)).toEqual(
      sourceEntries.filter((entry) => entry.type !== "session"),
    );
  });

  test("async fork truncates mutable checkpoint sources at the stored leaf", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-fork-leaf-"));
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
    const forked = await forkCompactionCheckpointTranscriptAsync({
      sourceFile: sessionFile,
      sourceLeafId: checkpointLeafId,
      sessionDir: dir,
    });

    if (!forked) {
      throw new Error("expected forked checkpoint transcript");
    }
    const messages = SessionManager.open(forked.sessionFile, dir).buildSessionContext().messages;
    expect(messages.map((message) => (message as { content?: unknown }).content)).toEqual([
      "checkpoint source",
    ]);
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

  test("async fork migrates legacy checkpoint snapshots before writing a current header", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-legacy-fork-"));
    tempDirs.push(dir);

    const legacySessionFile = path.join(dir, "legacy.jsonl");
    const firstMessage = {
      type: "message",
      timestamp: new Date(0).toISOString(),
      message: {
        role: "user",
        content: "legacy first",
        timestamp: 1,
      },
    };
    const secondMessage = {
      type: "message",
      timestamp: new Date(1).toISOString(),
      message: {
        role: "assistant",
        content: "legacy second",
        api: "responses",
        provider: "openai",
        model: "gpt-test",
        timestamp: 2,
      },
    };
    await fs.writeFile(
      legacySessionFile,
      [
        JSON.stringify({
          type: "session",
          id: "legacy-session",
          timestamp: new Date(0).toISOString(),
          cwd: dir,
        }),
        JSON.stringify(firstMessage),
        JSON.stringify(secondMessage),
        "",
      ].join("\n"),
      "utf-8",
    );

    const forked = await forkCompactionCheckpointTranscriptAsync({
      sourceFile: legacySessionFile,
      sessionDir: dir,
    });

    if (!forked) {
      throw new Error("expected forked checkpoint transcript");
    }
    expectNonEmptyStringField(forked.sessionFile, "expected forked session file");
    const forkedEntries = (await fs.readFile(forked.sessionFile, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expectRecordFields(forkedEntries[0], {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: forked.sessionId,
      parentSession: legacySessionFile,
    });
    expectRecordFields(forkedEntries[1], {
      type: "message",
      parentId: null,
    });
    expect(requireRecord(forkedEntries[1]?.message, "first forked message").content).toBe(
      "legacy first",
    );
    expect(forkedEntries[1]?.id).toBeTypeOf("string");
    expect(forkedEntries[1]?.id).not.toBe("");
    expectRecordFields(forkedEntries[2], {
      type: "message",
      parentId: forkedEntries[1]?.id,
    });
    expect(requireRecord(forkedEntries[2]?.message, "second forked message").content).toBe(
      "legacy second",
    );
    expect(forkedEntries[2]?.id).toBeTypeOf("string");
    expect(forkedEntries[2]?.id).not.toBe("");

    const messages = SessionManager.open(forked.sessionFile, dir).buildSessionContext().messages;
    expect(messages.map((message) => (message as { content?: unknown }).content)).toEqual([
      "legacy first",
      [{ type: "text", text: "legacy second" }],
    ]);
  });

  test("async fork skips JSON-valid garbage transcript entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-garbage-fork-"));
    tempDirs.push(dir);

    const sourceFile = path.join(dir, "garbage.jsonl");
    const firstMessage = {
      type: "message",
      id: "first",
      parentId: null,
      message: {
        role: "user",
        content: "first",
        timestamp: 1,
      },
    };
    const secondMessage = {
      type: "message",
      id: "second",
      parentId: "first",
      message: {
        role: "assistant",
        content: "second",
        api: "responses",
        provider: "openai",
        model: "gpt-test",
        timestamp: 2,
      },
    };
    await fs.writeFile(
      sourceFile,
      [
        JSON.stringify({
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: "source-session",
          timestamp: new Date(0).toISOString(),
          cwd: dir,
        }),
        JSON.stringify(firstMessage),
        "null",
        "[]",
        '"garbage"',
        JSON.stringify(secondMessage),
        "{truncated-json",
        "",
      ].join("\n"),
      "utf-8",
    );

    const forked = await forkCompactionCheckpointTranscriptAsync({
      sourceFile,
      sessionDir: dir,
    });

    if (!forked) {
      throw new Error("expected forked checkpoint transcript");
    }
    const forkedEntries = (await fs.readFile(forked.sessionFile, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(forkedEntries.map((entry) => entry.type)).toEqual(["session", "message", "message"]);
    expect(requireRecord(forkedEntries[1]?.message, "first forked message").content).toBe("first");
    expect(requireRecord(forkedEntries[2]?.message, "second forked message").content).toBe(
      "second",
    );
  });

  test("persist stores codex-style checkpoint metadata and trims old legacy snapshot files", async () => {
    const { dir, storePath, sessionId, sessionKey, now } = await makeTempSessionStore(
      "openclaw-checkpoint-trim-",
    );
    const existingCheckpoints = await createLegacyCheckpointFixtures({
      dir,
      sessionId,
      sessionKey,
      now,
      count: 26,
      initializeFile: async (sessionFile, index) => {
        await fs.writeFile(sessionFile, `checkpoint ${index}`, "utf-8");
      },
    });
    await writeAccessorSessionEntry(storePath, sessionKey, {
      sessionId,
      updatedAt: now,
      compactionCheckpoints: existingCheckpoints,
    });

    const stored = await persistMainCheckpoint(storePath, {
      sessionId,
      snapshot: {
        sessionId,
        leafId: "current-leaf",
      },
      postSessionFile: path.join(dir, "sess.compacted.jsonl"),
      postLeafId: "compacted-leaf",
      createdAt: now + 100,
    });

    expectRecordFields(stored?.preCompaction, {
      sessionId,
      leafId: "current-leaf",
    });
    expect(stored?.preCompaction.sessionFile).toBeUndefined();
    expect(stored?.postCompaction.sessionFile).toBe(path.join(dir, "sess.compacted.jsonl"));
    expect(
      fsSync.existsSync(
        expectDefined(existingCheckpoints[0], "existingCheckpoints[0] test invariant").preCompaction
          .sessionFile,
      ),
    ).toBe(false);
    expect(
      fsSync.existsSync(
        expectDefined(existingCheckpoints[1], "existingCheckpoints[1] test invariant").preCompaction
          .sessionFile,
      ),
    ).toBe(false);
    expect(
      fsSync.existsSync(
        expectDefined(existingCheckpoints[2], "existingCheckpoints[2] test invariant").preCompaction
          .sessionFile,
      ),
    ).toBe(true);
    expect(fsSync.readdirSync(dir).some((file) => file.includes("99999999"))).toBe(false);

    expect(await readFirstCompactionCheckpoints(storePath)).toHaveLength(25);
  });

  test("persist skips codex-style checkpoints without a stable post-compaction leaf", async () => {
    const { storePath, sessionId, sessionKey, now } = await makeTempSessionStore(
      "openclaw-checkpoint-no-leaf-",
    );
    await writeAccessorSessionEntry(storePath, sessionKey, {
      sessionId,
      updatedAt: now,
    });

    const stored = await persistMainCheckpoint(storePath, {
      sessionId,
      snapshot: {
        sessionId,
        leafId: "pre-leaf",
      },
      postSessionFile: path.join(path.dirname(storePath), "sess.compacted.jsonl"),
      createdAt: now,
    });

    expect(stored).toBeNull();
    const nextEntry = loadSessionEntry({ storePath, sessionKey: MAIN_SESSION_KEY });
    expect(nextEntry?.compactionCheckpoints).toBeUndefined();
  });

  test("persist skips malformed session rows without synthesizing a session id", async () => {
    const { storePath, sessionId, sessionKey, now } = await makeTempSessionStore(
      "openclaw-checkpoint-malformed-row-",
    );
    await writeAccessorSessionEntry(storePath, sessionKey, {
      sessionId: "",
      updatedAt: now,
    });

    const stored = await persistMainCheckpoint(storePath, {
      sessionId,
      snapshot: {
        sessionId,
        leafId: "pre-leaf",
      },
      postSessionFile: path.join(path.dirname(storePath), "sess.compacted.jsonl"),
      postLeafId: "post-leaf",
      createdAt: now,
    });

    expect(stored).toBeNull();
    const nextEntry = loadSessionEntry({ storePath, sessionKey: MAIN_SESSION_KEY });
    expect(nextEntry).toMatchObject({
      sessionId: "",
    });
    expect(nextEntry?.compactionCheckpoints).toBeUndefined();
  });

  test("persist trims retained checkpoint snapshots by total byte budget", async () => {
    const { dir, storePath, sessionId, sessionKey, now } = await makeTempSessionStore(
      "openclaw-checkpoint-byte-trim-",
    );
    const checkpointSize = Math.floor(MAX_COMPACTION_CHECKPOINT_RETAINED_BYTES_PER_SESSION / 6);
    const existingCheckpoints = await createLegacyCheckpointFixtures({
      dir,
      sessionId,
      sessionKey,
      now,
      count: 8,
      initializeFile: async (sessionFile) => {
        await fs.writeFile(sessionFile, "", "utf-8");
        await fs.truncate(sessionFile, checkpointSize);
      },
    });
    await writeAccessorSessionEntry(storePath, sessionKey, {
      sessionId,
      updatedAt: now,
      compactionCheckpoints: existingCheckpoints,
    });

    const currentSnapshotFile = path.join(
      dir,
      "sess.checkpoint.99999999-9999-4999-8999-999999999999.jsonl",
    );
    await fs.writeFile(currentSnapshotFile, "", "utf-8");
    await fs.truncate(currentSnapshotFile, checkpointSize);

    await persistMainCheckpoint(storePath, {
      sessionId,
      snapshot: {
        sessionId,
        sessionFile: currentSnapshotFile,
        leafId: "current-leaf",
      },
      createdAt: now + 100,
    });

    expect(
      fsSync.existsSync(
        expectDefined(existingCheckpoints[0], "existingCheckpoints[0] test invariant").preCompaction
          .sessionFile,
      ),
    ).toBe(false);
    expect(
      fsSync.existsSync(
        expectDefined(existingCheckpoints[1], "existingCheckpoints[1] test invariant").preCompaction
          .sessionFile,
      ),
    ).toBe(false);
    expect(
      fsSync.existsSync(
        expectDefined(existingCheckpoints[2], "existingCheckpoints[2] test invariant").preCompaction
          .sessionFile,
      ),
    ).toBe(false);
    expect(
      fsSync.existsSync(
        expectDefined(existingCheckpoints[3], "existingCheckpoints[3] test invariant").preCompaction
          .sessionFile,
      ),
    ).toBe(true);
    expect(fsSync.existsSync(currentSnapshotFile)).toBe(true);

    const retained = await readFirstCompactionCheckpoints<{ checkpointId?: string }>(storePath);
    expect(retained?.map((checkpoint) => checkpoint.checkpointId)).toEqual([
      "old-3",
      "old-4",
      "old-5",
      "old-6",
      "old-7",
      expect.any(String),
    ]);
  });
});
