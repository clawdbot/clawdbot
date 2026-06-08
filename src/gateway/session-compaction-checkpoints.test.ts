/**
 * Session compaction checkpoint persistence tests.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  readSessionStoreForTest,
  writeSessionStoreForTestAsync,
} from "../config/sessions/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureCompactionCheckpointSnapshotAsync,
  cleanupCompactionCheckpointSnapshot,
  forkCompactionCheckpointTranscriptAsync,
  MAX_COMPACTION_CHECKPOINT_LEAF_SCAN_BYTES,
  MAX_COMPACTION_CHECKPOINT_RETAINED_BYTES_PER_SESSION,
  persistSessionCompactionCheckpoint,
  readSessionLeafIdFromTranscriptAsync,
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

async function writeSessionStore(
  storePath: string,
  sessionKey: string,
  entry: { sessionId: string; updatedAt: number; compactionCheckpoints?: unknown[] },
): Promise<void> {
  await writeSessionStoreForTestAsync(storePath, { [sessionKey]: entry });
}

async function readSessionStore<T extends object>(storePath: string): Promise<Record<string, T>> {
  return readSessionStoreForTest<T>(storePath);
}

async function readFirstCompactionCheckpoints<T>(storePath: string): Promise<T[] | undefined> {
  const store = await readSessionStore<{ compactionCheckpoints?: T[] }>(storePath);
  return Object.values(store).find((entry) => entry.compactionCheckpoints)?.compactionCheckpoints;
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
    sessionKey: MAIN_AGENT_ID,
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
      expect(await readSessionLeafIdFromTranscriptAsync(sessionFile)).toBe(leafId);
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
      "legacy second",
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
    await writeSessionStore(storePath, sessionKey, {
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
    expect(fsSync.existsSync(existingCheckpoints[0].preCompaction.sessionFile)).toBe(false);
    expect(fsSync.existsSync(existingCheckpoints[1].preCompaction.sessionFile)).toBe(false);
    expect(fsSync.existsSync(existingCheckpoints[2].preCompaction.sessionFile)).toBe(true);
    expect(fsSync.readdirSync(dir).some((file) => file.includes("99999999"))).toBe(false);

    expect(await readFirstCompactionCheckpoints(storePath)).toHaveLength(25);
  });

  test("persist skips codex-style checkpoints without a stable post-compaction leaf", async () => {
    const { storePath, sessionId, sessionKey, now } = await makeTempSessionStore(
      "openclaw-checkpoint-no-leaf-",
    );
    await writeSessionStore(storePath, sessionKey, {
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
    const nextStore = await readSessionStore<{ compactionCheckpoints?: unknown[] }>(storePath);
    expect(nextStore[MAIN_SESSION_KEY]?.compactionCheckpoints).toBeUndefined();
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
    await writeSessionStore(storePath, sessionKey, {
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

    expect(fsSync.existsSync(existingCheckpoints[0].preCompaction.sessionFile)).toBe(false);
    expect(fsSync.existsSync(existingCheckpoints[1].preCompaction.sessionFile)).toBe(false);
    expect(fsSync.existsSync(existingCheckpoints[2].preCompaction.sessionFile)).toBe(false);
    expect(fsSync.existsSync(existingCheckpoints[3].preCompaction.sessionFile)).toBe(true);
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
