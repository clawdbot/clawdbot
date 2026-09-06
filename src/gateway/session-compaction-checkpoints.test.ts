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
import type { SessionCompactionCheckpoint } from "../config/sessions.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  createFileBackedCompactionCheckpointStore,
  readSessionLeafStateFromTranscriptAsync,
  resolveCompactionCheckpointTranscriptPosition,
} from "./session-compaction-checkpoints.js";

const tempDirs: string[] = [];
const MAIN_AGENT_ID = "main";
const MAIN_SESSION_KEY = "agent:main:main";

function checkpointExpectedState(sessionId: string) {
  return { lifecycleRevision: undefined, sessionId };
}

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

  test("checkpoint store branches and restores checkpoints through resolved store keys", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-sqlite-branch-"));
    tempDirs.push(dir);
    const storePath = path.join(dir, "openclaw-agent.sqlite");
    const sessionId = "sqlite-checkpoint-branch-source";
    const sessionKey = MAIN_SESSION_KEY;
    const sessionStoreKey = "agent:main:legacy-main";
    const scope = {
      agentId: MAIN_AGENT_ID,
      sessionId,
      sessionKey: sessionStoreKey,
      storePath,
    };
    const marker = formatSqliteSessionFileMarker({
      agentId: MAIN_AGENT_ID,
      sessionId,
      storePath,
    });
    const sourceStamp = {
      createdVia: "operator" as const,
      createdActor: {
        type: "human" as const,
        source: "profile" as const,
        id: "checkpoint-source-owner",
      },
      createdAt: 123,
      sandbox: "required" as const,
    };

    await upsertSessionEntryCore(scope, {
      ...sourceStamp,
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
      SessionManager.open(scope).getLeafId(),
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
    await upsertSessionEntryCore(scope, {
      sessionId,
      sessionFile: marker,
      updatedAt: Date.now(),
      compactionCheckpoints: [checkpoint],
    });

    const store = createFileBackedCompactionCheckpointStore();
    const branchKey = "agent:main:checkpoint-branch";
    const branched = await store.branchCheckpointSession({
      expectedState: checkpointExpectedState(sessionId),
      storePath,
      sourceKey: sessionKey,
      sourceStoreKey: sessionStoreKey,
      nextKey: branchKey,
      checkpointId: checkpoint.checkpointId,
      creation: {
        via: "operator",
        actor: { type: "human", source: "profile", id: "checkpoint-branch-owner" },
        sandbox: "required",
      },
    });
    const restored = await store.restoreCheckpointSession({
      expectedState: checkpointExpectedState(sessionId),
      storePath,
      sessionKey,
      sessionStoreKey,
      checkpointId: checkpoint.checkpointId,
    });

    if (branched.status !== "created" || restored.status !== "created") {
      throw new Error("expected SQLite checkpoint branch and restore");
    }
    expect(branched.entry).toMatchObject({
      createdVia: "operator",
      createdActor: { type: "human", source: "profile", id: "checkpoint-branch-owner" },
      sandbox: "required",
    });
    expect(branched.entry.createdAt).not.toBe(sourceStamp.createdAt);
    expect(restored.entry).toMatchObject(sourceStamp);
    expect(branched.entry).not.toHaveProperty("sessionFile");
    expect(restored.entry).not.toHaveProperty("sessionFile");
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

  test.each(["branch", "restore"] as const)(
    "checkpoint %s rejects a lifecycle change queued before its transaction",
    async (mode) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-sqlite-race-"));
      tempDirs.push(dir);
      const storePath = path.join(dir, "openclaw-agent.sqlite");
      const sessionId = `sqlite-checkpoint-${mode}-race`;
      const sessionKey = MAIN_SESSION_KEY;
      const scope = { agentId: MAIN_AGENT_ID, sessionId, sessionKey, storePath };
      const expectedState = {
        lifecycleRevision: "checkpoint-original-revision",
        sessionId,
      };
      await upsertSessionEntryCore(scope, {
        ...expectedState,
        updatedAt: 10,
      });
      await appendTranscriptEvent(scope, {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: sessionId,
        timestamp: "2026-06-26T12:00:00.000Z",
        cwd: dir,
      });
      const sourceMessage = await appendTranscriptMessage(scope, {
        message: { role: "user", content: "checkpoint race source", timestamp: 1 },
        now: Date.parse("2026-06-26T12:00:01.000Z"),
      });
      const checkpoint: SessionCompactionCheckpoint = {
        checkpointId: `sqlite-checkpoint-${mode}-conflict`,
        sessionKey,
        sessionId,
        createdAt: Date.now(),
        reason: "manual",
        preCompaction: {
          sessionId,
          leafId: sourceMessage.messageId,
          entryId: sourceMessage.messageId,
        },
        postCompaction: {
          sessionId,
          leafId: sourceMessage.messageId,
          entryId: sourceMessage.messageId,
        },
      };
      await upsertSessionEntryCore(scope, { compactionCheckpoints: [checkpoint] });

      let releaseOwnerChange = () => {};
      const ownerChangeGate = new Promise<void>((resolve) => {
        releaseOwnerChange = resolve;
      });
      let markOwnerChangeStarted = () => {};
      const ownerChangeStarted = new Promise<void>((resolve) => {
        markOwnerChangeStarted = resolve;
      });
      const ownerChange = updateSessionEntry(scope, async () => {
        markOwnerChangeStarted();
        await ownerChangeGate;
        return { lifecycleRevision: "checkpoint-replacement-revision" };
      });
      await ownerChangeStarted;

      const branchKey = `${sessionKey}:${mode}-conflict`;
      const store = createFileBackedCompactionCheckpointStore();
      const mutation =
        mode === "branch"
          ? store.branchCheckpointSession({
              expectedState,
              storePath,
              sourceKey: sessionKey,
              nextKey: branchKey,
              checkpointId: checkpoint.checkpointId,
            })
          : store.restoreCheckpointSession({
              expectedState,
              storePath,
              sessionKey,
              checkpointId: checkpoint.checkpointId,
            });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      releaseOwnerChange();

      await ownerChange;
      await expect(mutation).resolves.toEqual({ status: "conflict" });
      expect(loadSessionEntry(scope)).toMatchObject({
        lifecycleRevision: "checkpoint-replacement-revision",
        sessionId,
      });
      expect(loadSessionEntry({ agentId: MAIN_AGENT_ID, sessionKey: branchKey, storePath })).toBe(
        undefined,
      );
      await expect(loadTranscriptEvents(scope)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: sourceMessage.messageId })]),
      );
    },
  );

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

    await upsertSessionEntryCore(scope, {
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
      SessionManager.open(scope).getLeafId(),
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
      SessionManager.open(scope).getLeafId(),
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
    await upsertSessionEntryCore(scope, {
      sessionId,
      sessionFile: staleSessionFile,
      updatedAt: Date.now(),
      compactionCheckpoints: [checkpoint, markerCheckpoint],
    });

    const branchKey = "agent:main:stale-checkpoint-branch";
    const branched = await createFileBackedCompactionCheckpointStore().branchCheckpointSession({
      expectedState: checkpointExpectedState(sessionId),
      storePath,
      sourceKey: sessionKey,
      nextKey: branchKey,
      checkpointId: checkpoint.checkpointId,
    });

    if (branched.status !== "created") {
      throw new Error("expected stale-entry SQLite checkpoint branch");
    }
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
        expectedState: checkpointExpectedState(sessionId),
        storePath,
        sourceKey: sessionKey,
        nextKey: "agent:main:stale-marker-checkpoint-branch",
        checkpointId: markerCheckpoint.checkpointId,
      });
    if (markerBranched.status !== "created") {
      throw new Error("expected stale-entry SQLite marker checkpoint branch");
    }
  });

  test("imports a retired legacy checkpoint snapshot into a new SQLite branch", async () => {
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
    await upsertSessionEntryCore(
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

    const branched = await createFileBackedCompactionCheckpointStore().branchCheckpointSession({
      expectedState: checkpointExpectedState(sessionId),
      storePath,
      sourceKey: sessionKey,
      nextKey: "agent:main:legacy-checkpoint-branch",
      checkpointId: "legacy-file-checkpoint",
    });

    if (branched.status !== "created") {
      throw new Error("expected legacy checkpoint snapshot import");
    }
    expect(fsSync.readdirSync(dir).filter((file) => file.endsWith(".jsonl"))).toEqual([
      path.basename(legacySnapshotFile),
    ]);
    const branchEvents = await loadTranscriptEvents({
      agentId: MAIN_AGENT_ID,
      sessionId: branched.entry.sessionId,
      sessionKey: "agent:main:legacy-checkpoint-branch",
      storePath,
    });
    expect(
      branchEvents.some((event) => isAssistantTextEvent(event, "legacy checkpoint source")),
    ).toBe(true);
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

  test("reads leaf state from a structured SQLite transcript target", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-target-leaf-"));
    tempDirs.push(dir);
    const target = {
      agentId: "main",
      sessionId: "structured-leaf-session",
      sessionKey: "agent:main:structured-leaf-session",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    await appendTranscriptEvent(target, {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: target.sessionId,
      timestamp: "2026-06-15T00:00:00.000Z",
      cwd: dir,
    });
    const appended = await appendTranscriptMessage(target, {
      message: {
        role: "assistant",
        content: "active",
        timestamp: 1,
      } as unknown as AssistantMessage,
      now: Date.parse("2026-06-15T00:00:01.000Z"),
    });

    await expect(readSessionLeafStateFromTranscriptAsync(target)).resolves.toEqual({
      entryId: appended.messageId,
      leafId: appended.messageId,
    });
  });
});
