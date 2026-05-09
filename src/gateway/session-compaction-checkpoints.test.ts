import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureCompactionCheckpointSnapshotAsync,
  cleanupCompactionCheckpointSnapshot,
  forkCompactionCheckpointTranscriptAsync,
  MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES,
  persistSessionCompactionCheckpoint,
  readSessionLeafIdFromTranscriptAsync,
} from "./session-compaction-checkpoints.js";

const tempDirs: string[] = [];

function requireNonEmptyString(value: string | null | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("session-compaction-checkpoints", () => {
  test("async capture stores the copied pre-compaction transcript without sync copy", async () => {
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
      expect(snapshot).toMatchObject({ leafId });
      if (!snapshot) {
        throw new Error("expected checkpoint snapshot");
      }
      expect(snapshot.sessionFile).not.toBe(sessionFile);
      expect(snapshot.sessionFile).toContain(".checkpoint.");
      expect(fsSync.existsSync(snapshot.sessionFile)).toBe(true);
      expect(await fs.readFile(snapshot.sessionFile, "utf-8")).toBe(originalBefore);

      session.appendCompaction("checkpoint summary", leafId, 123, { ok: true });

      expect(await fs.readFile(snapshot.sessionFile, "utf-8")).toBe(originalBefore);
      expect(await fs.readFile(sessionFile, "utf-8")).not.toBe(originalBefore);

      await cleanupCompactionCheckpointSnapshot(snapshot);

      expect(fsSync.existsSync(snapshot.sessionFile)).toBe(false);
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
    let snapshot: Awaited<ReturnType<typeof captureCompactionCheckpointSnapshotAsync>> = null;
    try {
      expect(await readSessionLeafIdFromTranscriptAsync(sessionFile)).toBe(leafId);
      snapshot = await captureCompactionCheckpointSnapshotAsync({
        sessionFile,
      });

      expect(copyFileSyncSpy).not.toHaveBeenCalled();
      expect(sessionManagerOpenSpy).not.toHaveBeenCalled();
      expect(snapshot).toMatchObject({ sessionId, leafId });
      if (!snapshot) {
        throw new Error("expected checkpoint snapshot");
      }
      expect(snapshot.sessionFile).not.toBe(sessionFile);
      expect(snapshot.sessionFile).toContain(".checkpoint.");
    } finally {
      await cleanupCompactionCheckpointSnapshot(snapshot);
      copyFileSyncSpy.mockRestore();
      sessionManagerOpenSpy.mockRestore();
    }
  });

  test("async capture skips oversized pre-compaction transcripts without sync copy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-async-oversized-"));
    tempDirs.push(dir);

    const session = SessionManager.create(dir, dir);
    session.appendMessage({
      role: "user",
      content: "before compaction",
      timestamp: Date.now(),
    });
    const sessionFile = requireNonEmptyString(session.getSessionFile(), "session file missing");
    await fs.appendFile(sessionFile, "x".repeat(128), "utf-8");

    const copyFileSyncSpy = vi.spyOn(fsSync, "copyFileSync");
    try {
      const snapshot = await captureCompactionCheckpointSnapshotAsync({
        sessionManager: session,
        sessionFile,
        maxBytes: 64,
      });

      expect(snapshot).toBeNull();
      expect(copyFileSyncSpy).not.toHaveBeenCalled();
      expect(MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES).toBeGreaterThan(64);
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
    let forked: Awaited<ReturnType<typeof forkCompactionCheckpointTranscriptAsync>> = null;
    try {
      forked = await forkCompactionCheckpointTranscriptAsync({
        sourceFile: sessionFile,
        sessionDir: dir,
      });

      expect(openSpy).not.toHaveBeenCalled();
      expect(forkSpy).not.toHaveBeenCalled();
      expect(forked).toMatchObject({ sessionFile: expect.any(String) });
      if (!forked) {
        throw new Error("expected forked checkpoint transcript");
      }
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

    expect(forkedEntries[0]).toMatchObject({
      type: "session",
      id: forked.sessionId,
      cwd: dir,
      parentSession: sessionFile,
    });
    expect(forkedEntries.slice(1)).toEqual(
      sourceEntries.filter((entry) => entry.type !== "session"),
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

    expect(forked).toMatchObject({ sessionFile: expect.any(String) });
    if (!forked) {
      throw new Error("expected forked checkpoint transcript");
    }
    const forkedEntries = (await fs.readFile(forked.sessionFile, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(forkedEntries[0]).toMatchObject({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: forked.sessionId,
      parentSession: legacySessionFile,
    });
    expect(forkedEntries[1]).toMatchObject({
      type: "message",
      parentId: null,
      message: expect.objectContaining({ content: "legacy first" }),
    });
    expect(forkedEntries[1]?.id).toBeTypeOf("string");
    expect(forkedEntries[1]?.id).not.toBe("");
    expect(forkedEntries[2]).toMatchObject({
      type: "message",
      parentId: forkedEntries[1]?.id,
      message: expect.objectContaining({ content: "legacy second" }),
    });
    expect(forkedEntries[2]?.id).toBeTypeOf("string");
    expect(forkedEntries[2]?.id).not.toBe("");

    const messages = SessionManager.open(forked.sessionFile, dir).buildSessionContext().messages;
    expect(messages.map((message) => (message as { content?: unknown }).content)).toEqual([
      "legacy first",
      "legacy second",
    ]);
  });

  test("persist trims old checkpoint metadata and removes trimmed snapshot files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-trim-"));
    tempDirs.push(dir);

    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sess";
    const sessionKey = "agent:main:main";
    const now = Date.now();
    const existingCheckpoints = Array.from({ length: 26 }, (_, index) => {
      const uuid = `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`;
      const sessionFile = path.join(dir, `sess.checkpoint.${uuid}.jsonl`);
      fsSync.writeFileSync(sessionFile, `checkpoint ${index}`, "utf-8");
      return {
        checkpointId: `old-${index}`,
        sessionKey,
        sessionId,
        createdAt: now + index,
        reason: "manual" as const,
        preCompaction: {
          sessionId,
          sessionFile,
          leafId: `old-leaf-${index}`,
        },
        postCompaction: { sessionId },
      };
    });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId,
            updatedAt: now,
            compactionCheckpoints: existingCheckpoints,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const currentSnapshotFile = path.join(
      dir,
      "sess.checkpoint.99999999-9999-4999-8999-999999999999.jsonl",
    );
    await fs.writeFile(currentSnapshotFile, "current", "utf-8");

    const stored = await persistSessionCompactionCheckpoint({
      cfg: {
        session: { store: storePath },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      sessionKey: "main",
      sessionId,
      reason: "manual",
      snapshot: {
        sessionId,
        sessionFile: currentSnapshotFile,
        leafId: "current-leaf",
      },
      createdAt: now + 100,
    });

    expect(stored?.preCompaction).toMatchObject({
      sessionId,
      sessionFile: currentSnapshotFile,
      leafId: "current-leaf",
    });
    expect(fsSync.existsSync(existingCheckpoints[0].preCompaction.sessionFile)).toBe(false);
    expect(fsSync.existsSync(existingCheckpoints[1].preCompaction.sessionFile)).toBe(false);
    expect(fsSync.existsSync(existingCheckpoints[2].preCompaction.sessionFile)).toBe(true);
    expect(fsSync.existsSync(currentSnapshotFile)).toBe(true);

    const nextStore = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { compactionCheckpoints?: unknown[] }
    >;
    expect(
      Object.values(nextStore).find((entry) => entry.compactionCheckpoints)?.compactionCheckpoints,
    ).toHaveLength(25);
  });
});
