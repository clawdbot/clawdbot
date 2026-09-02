/** Session compaction checkpoint ownership tests. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../agents/admitted-run-context.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { createFileBackedCompactionCheckpointStore } from "./session-compaction-checkpoints.js";

const tempDirs: string[] = [];
const MAIN_AGENT_ID = "main";
const MAIN_SESSION_KEY = "agent:main:main";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("session-compaction-checkpoints", () => {
  test("preserves the full checkpoint row when its admitted owner closes during snapshot sizing", async () => {
    const dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-owner-")),
    );
    tempDirs.push(dir);
    const storePath = path.join(dir, "openclaw-agent.sqlite");
    const sessionId = "checkpoint-owned-session";
    const sessionKey = MAIN_SESSION_KEY;
    const runId = `checkpoint-${path.basename(dir)}`;
    const scope = { agentId: MAIN_AGENT_ID, sessionId, sessionKey, storePath };
    const cfg = { session: { store: storePath } };
    await upsertSessionEntryCore(scope, {
      sessionId,
      lifecycleRevision: "checkpoint-generation",
      activeWriterRunId: runId,
      updatedAt: 10,
      compactionCount: 3,
      totalTokens: 500,
      totalTokensFresh: true,
      label: "preserve checkpoint owner metadata",
    });
    const before = structuredClone(loadSessionEntry({ ...scope, readConsistency: "latest" }));
    const snapshotFile = path.join(dir, "retained.checkpoint.jsonl");
    // Retained legacy artifacts use the existing asynchronous retention-size read.
    await fs.writeFile(
      snapshotFile,
      [
        JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: sessionId }),
        JSON.stringify({
          type: "message",
          id: "pre-leaf",
          message: { role: "user", content: "before" },
        }),
      ].join("\n") + "\n",
    );
    const admission = prepareSystemAgentRunAdmission(cfg, runId, MAIN_AGENT_ID, "checkpoint-test");
    try {
      const admitted = await admission.admit("embedded");
      const assertActive = resolveAdmittedRunActiveAssertion(admitted);
      if (!assertActive) {
        throw new Error("expected an active admitted checkpoint owner");
      }
      const sizingStarted = createDeferred();
      const releaseSizing = createDeferred();
      const originalStat = fs.stat.bind(fs);
      const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (file, options) => {
        if (file === snapshotFile) {
          sizingStarted.resolve();
          await releaseSizing.promise;
        }
        return originalStat(file, options);
      });
      const pending = withOwnedSessionTranscriptWrites(
        {
          sessionKey,
          sessionTarget: {
            ...scope,
            expectedLifecycleRevision: "checkpoint-generation",
            expectedWriterRunId: runId,
          },
          assertCommitAllowed: assertActive,
          withTranscriptWrite: async (run) => await run(),
        },
        () =>
          createFileBackedCompactionCheckpointStore().persistCheckpoint({
            cfg,
            agentId: MAIN_AGENT_ID,
            sessionKey,
            sessionId,
            reason: "manual",
            snapshot: { sessionId, sessionFile: snapshotFile, leafId: "pre-leaf" },
            postLeafId: "post-leaf",
            tokensBefore: 500,
            tokensAfter: 100,
            createdAt: 20,
          }),
      );
      const persistenceError = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await sizingStarted.promise;
        expect(assertActive).not.toThrow();
        admission.close();
        releaseSizing.resolve();
        const error = await persistenceError;

        expect(loadSessionEntry({ ...scope, readConsistency: "latest" })).toEqual(before);
        expect(error).toMatchObject({ message: "admitted run authority is no longer active" });
      } finally {
        releaseSizing.resolve();
        await persistenceError;
        statSpy.mockRestore();
      }
    } finally {
      admission.close();
    }
  });

  test("persists global checkpoints only in the explicit agent's custom-store partition", async () => {
    const dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-global-owner-")),
    );
    tempDirs.push(dir);
    const storePath = path.join(dir, "shared-sessions.json");
    const sessionKey = "global";
    const agentId = "ops";
    const sessionId = "checkpoint-ops-global";
    const runId = `checkpoint-${path.basename(dir)}`;
    const scope = { agentId, sessionId, sessionKey, storePath };
    const mainScope = { agentId: MAIN_AGENT_ID, sessionKey, storePath };
    const cfg = {
      agents: { list: [{ id: MAIN_AGENT_ID, default: true }, { id: agentId }] },
      session: { scope: "global" as const, store: storePath },
    };
    await upsertSessionEntryCore(mainScope, {
      sessionId: "checkpoint-main-global",
      lifecycleRevision: "main-generation",
      activeWriterRunId: "main-writer",
      updatedAt: 10,
      compactionCount: 7,
      totalTokens: 900,
      totalTokensFresh: true,
      label: "unrelated main global session",
    });
    await upsertSessionEntryCore(scope, {
      sessionId,
      lifecycleRevision: "ops-generation",
      activeWriterRunId: runId,
      updatedAt: 10,
      compactionCount: 3,
      totalTokens: 500,
      totalTokensFresh: true,
      label: "selected ops global session",
    });
    const mainBefore = structuredClone(
      loadSessionEntry({ ...mainScope, readConsistency: "latest" }),
    );
    expect(mainBefore?.sessionId).toBe("checkpoint-main-global");
    expect(loadSessionEntry({ ...scope, readConsistency: "latest" })?.sessionId).toBe(sessionId);

    const admission = prepareSystemAgentRunAdmission(cfg, runId, agentId, "checkpoint-test");
    try {
      const admitted = await admission.admit("embedded");
      const assertActive = resolveAdmittedRunActiveAssertion(admitted);
      if (!assertActive) {
        throw new Error("expected an active admitted checkpoint owner");
      }
      const checkpoint = await withOwnedSessionTranscriptWrites(
        {
          sessionKey,
          sessionTarget: {
            ...scope,
            expectedLifecycleRevision: "ops-generation",
            expectedWriterRunId: runId,
          },
          assertCommitAllowed: assertActive,
          withTranscriptWrite: async (run) => await run(),
        },
        () =>
          createFileBackedCompactionCheckpointStore().persistCheckpoint({
            cfg,
            agentId,
            sessionKey,
            sessionId,
            reason: "manual",
            snapshot: { sessionId, leafId: "pre-leaf" },
            postLeafId: "post-leaf",
            tokensBefore: 500,
            tokensAfter: 100,
            createdAt: 20,
          }),
      );

      expect(assertActive).not.toThrow();
      expect(checkpoint).toMatchObject({ sessionId, sessionKey });
      expect(loadSessionEntry({ ...mainScope, readConsistency: "latest" })).toEqual(mainBefore);
      expect(loadSessionEntry({ ...scope, readConsistency: "latest" })).toMatchObject({
        sessionId,
        lifecycleRevision: "ops-generation",
        activeWriterRunId: runId,
        compactionCount: 3,
        totalTokens: 500,
        totalTokensFresh: true,
        compactionCheckpoints: [checkpoint],
      });
    } finally {
      admission.close();
    }
  });
});
