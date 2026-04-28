import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, UserMessage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureCompactionCheckpointSnapshot,
  cleanupCompactionCheckpointSnapshot,
  MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES,
  persistSessionCompactionCheckpoint,
} from "./session-compaction-checkpoints.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("session-compaction-checkpoints", () => {
  test("capture stores the copied pre-compaction transcript path and cleanup removes only the copy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-"));
    tempDirs.push(dir);

    const session = SessionManager.create(dir, dir);
    const userMessage: UserMessage = {
      role: "user",
      content: "before compaction",
      timestamp: Date.now(),
    };
    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "working on it" }],
      api: "responses",
      provider: "openai",
      model: "gpt-test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    session.appendMessage(userMessage);
    session.appendMessage(assistantMessage);

    const sessionFile = session.getSessionFile();
    const leafId = session.getLeafId();
    expect(sessionFile).toBeTruthy();
    expect(leafId).toBeTruthy();

    const originalBefore = await fs.readFile(sessionFile!, "utf-8");
    const snapshot = captureCompactionCheckpointSnapshot({
      sessionManager: session,
      sessionFile: sessionFile!,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.leafId).toBe(leafId);
    expect(snapshot?.sessionFile).not.toBe(sessionFile);
    expect(snapshot?.sessionFile).toContain(".checkpoint.");
    expect(fsSync.existsSync(snapshot!.sessionFile)).toBe(true);
    expect(await fs.readFile(snapshot!.sessionFile, "utf-8")).toBe(originalBefore);

    session.appendCompaction("checkpoint summary", leafId!, 123, { ok: true });

    expect(await fs.readFile(snapshot!.sessionFile, "utf-8")).toBe(originalBefore);
    expect(await fs.readFile(sessionFile!, "utf-8")).not.toBe(originalBefore);

    await cleanupCompactionCheckpointSnapshot(snapshot);

    expect(fsSync.existsSync(snapshot!.sessionFile)).toBe(false);
    expect(fsSync.existsSync(sessionFile!)).toBe(true);
  });

  test("capture skips oversized pre-compaction transcripts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-oversized-"));
    tempDirs.push(dir);

    const session = SessionManager.create(dir, dir);
    session.appendMessage({
      role: "user",
      content: "before compaction",
      timestamp: Date.now(),
    });
    const sessionFile = session.getSessionFile();
    expect(sessionFile).toBeTruthy();
    await fs.appendFile(sessionFile!, "x".repeat(128), "utf-8");

    const snapshot = captureCompactionCheckpointSnapshot({
      sessionManager: session,
      sessionFile: sessionFile!,
      maxBytes: 64,
    });

    expect(snapshot).toBeNull();
    expect(MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES).toBeGreaterThan(64);
    expect(fsSync.readdirSync(dir).filter((file) => file.includes(".checkpoint."))).toEqual([]);
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

    expect(stored).not.toBeNull();
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
