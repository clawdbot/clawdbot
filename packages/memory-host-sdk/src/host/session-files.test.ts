// Memory Host SDK tests cover session files behavior.
import fsSync from "node:fs";
import path from "node:path";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  persistSessionTranscriptTurn,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../../../src/config/sessions/session-accessor.js";
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  listSessionTranscriptCorpusEntriesForAgent,
  loadSessionTranscriptClassificationForAgent,
  normalizeSessionTranscriptPathForComparison,
  parseCanonicalSessionSyncTargetFromPath,
  resolveSessionIdentityForTranscriptFile,
  resolveSessionFileForSyncTarget,
  sessionPathForFile,
  statSessionEntrySync,
} from "./session-files.js";
import {
  registerSessionFilesFixture,
  requireSessionEntry,
  upsertTestSessionEntries,
} from "./session-files.test-support.js";

const fixture = registerSessionFilesFixture();

describe("listSessionFilesForAgent", () => {
  it("includes reset and deleted transcripts in session file listing", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(path.join(sessionsDir, "archive"), { recursive: true });

    const included = [
      "active.jsonl.reset.2026-02-16T22-26-33.000Z",
      "active.jsonl.deleted.2026-02-16T22-27-33.000Z",
    ];
    const excluded = [
      "active.jsonl.bak.2026-02-16T22-28-33.000Z",
      "active.trajectory.jsonl.deleted.2026-02-16T22-30-33.000Z",
      "active.trajectory.jsonl.reset.2026-02-16T22-31-33.000Z.zst",
      "active.checkpoint.11111111-1111-4111-8111-111111111111.jsonl.deleted.2026-02-16T22-32-33.000Z",
      "active.checkpoint.11111111-1111-4111-8111-111111111111.jsonl.reset.2026-02-16T22-33-33.000Z.zst",
      "sessions.json",
      "notes.md",
    ];
    excluded.push("active.checkpoint.11111111-1111-4111-8111-111111111111.jsonl");

    for (const fileName of [...included, ...excluded]) {
      fsSync.writeFileSync(path.join(sessionsDir, fileName), "");
    }
    fsSync.writeFileSync(
      path.join(sessionsDir, "archive", "nested.jsonl.deleted.2026-02-16T22-29-33.000Z"),
      "",
    );

    const files = await listSessionFilesForAgent("main");

    expect(files.map((filePath) => path.basename(filePath)).toSorted()).toEqual(
      included.toSorted(),
    );
  });
});

describe("listSessionTranscriptCorpusEntriesForAgent", () => {
  it("surfaces unexpected archive-directory scan failures", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const scanError = Object.assign(new Error("transient session archive scan failure"), {
      code: "EIO",
    });
    const readdirSpy = vi.spyOn(fsSync, "readdirSync").mockImplementation(() => {
      throw scanError;
    });

    try {
      await expect(listSessionTranscriptCorpusEntriesForAgent("main")).rejects.toBe(scanError);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("includes rotated SQLite sessions only when retained history is requested", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    fsSync.mkdirSync(sessionsDir, { recursive: true });

    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId: "retained-old", updatedAt: 10 },
    );
    await appendTranscriptMessage(
      { agentId: "main", sessionId: "retained-old", sessionKey, storePath },
      { message: { role: "assistant", content: "retained transcript" } },
    );
    await resetSessionEntryLifecycle({
      agentId: "main",
      buildNextEntry: () => ({ sessionId: "retained-new", updatedAt: 20 }),
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    await appendTranscriptMessage(
      { agentId: "main", sessionId: "retained-new", sessionKey, storePath },
      { message: { role: "assistant", content: "current transcript" } },
    );

    const currentOnly = await listSessionTranscriptCorpusEntriesForAgent("main");
    expect(currentOnly.map((entry) => entry.sessionId)).toEqual(["retained-new"]);

    const withHistory = await listSessionTranscriptCorpusEntriesForAgent("main", {
      includeRetainedSqlite: true,
    });
    expect(withHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactKind: "active-session",
          sessionId: "retained-new",
          transcriptSource: "sqlite",
        }),
        expect.objectContaining({
          artifactKind: "retained-session",
          sessionId: "retained-old",
          transcriptSource: "sqlite",
        }),
      ]),
    );
    const retained = withHistory.find((entry) => entry.sessionId === "retained-old");
    expect(
      requireSessionEntry(
        await buildSessionEntry(retained?.sessionFile ?? "", {
          ...(retained?.agentId !== undefined ? { agentId: retained.agentId } : {}),
          ...(retained?.sessionId !== undefined ? { sessionId: retained.sessionId } : {}),
          ...(retained?.sessionKey !== undefined ? { sessionKey: retained.sessionKey } : {}),
          ...(retained?.storePath !== undefined ? { storePath: retained.storePath } : {}),
          ...(retained?.updatedAtMs !== undefined ? { updatedAtMs: retained.updatedAtMs } : {}),
        }),
      ).content,
    ).toBe("Assistant: retained transcript");
  });

  it("treats accessor-backed entries as live SQLite transcripts", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(path.join(sessionsDir, "narrative.jsonl"), "");
    await upsertTestSessionEntries(path.join(sessionsDir, "sessions.json"), {
      "agent:main:dreaming-narrative-run-1": {
        sessionFile: "narrative.jsonl",
        sessionId: "narrative",
        updatedAt: 1,
      },
    });

    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toContainEqual(
      expect.objectContaining({
        agentId: "main",
        artifactKind: "active-session",
        sessionFile: "agent:main:dreaming-narrative-run-1",
        sessionId: "narrative",
        transcriptSource: "sqlite",
      }),
    );
  });

  it("keeps archive artifacts in the corpus and inherits active session classification", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const activePath = path.join(sessionsDir, "cron-run.jsonl");
    const archivePath = path.join(sessionsDir, "cron-run.jsonl.deleted.2026-02-16T22-27-33.000Z");
    fsSync.writeFileSync(activePath, "");
    fsSync.writeFileSync(archivePath, "");
    await upsertTestSessionEntries(path.join(sessionsDir, "sessions.json"), {
      "agent:main:cron:job-1:run:run-1": {
        sessionFile: "cron-run.jsonl",
        sessionId: "cron-run",
        updatedAt: 1,
      },
    });

    const classification = loadSessionTranscriptClassificationForAgent("main");

    expect(classification.cronRunTranscriptPaths).toEqual(
      new Set([normalizeSessionTranscriptPathForComparison(archivePath)]),
    );
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toContainEqual({
      agentId: "main",
      artifactKind: "archive-artifact",
      contentRevision: expect.any(String),
      generatedByCronRun: true,
      sessionKind: "cron",
      sessionFile: archivePath,
      sessionId: "cron-run",
    });
  });

  it("reads live SQLite rows by session identity while preserving archived JSONL artifacts", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:chat:sqlite-live:heartbeat";
    const sessionId = "sqlite-live";
    const updatedAt = Date.parse("2026-06-25T12:00:00.000Z");
    fsSync.mkdirSync(sessionsDir, { recursive: true });

    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId, updatedAt },
    );
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        messages: [
          {
            message: {
              role: "user",
              content: "Live SQLite transcript text",
              timestamp: updatedAt,
            },
          },
        ],
        touchSessionEntry: true,
        updateMode: "none",
      },
    );
    const archivePath = path.join(
      sessionsDir,
      `${sessionId}.jsonl.deleted.2026-06-25T12-01-00.000Z`,
    );
    fsSync.writeFileSync(
      archivePath,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Archived JSONL transcript text" },
      }),
    );

    expect(fsSync.existsSync(path.join(sessionsDir, `${sessionId}.jsonl`))).toBe(false);
    const entries = await listSessionTranscriptCorpusEntriesForAgent("main");
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "main",
          artifactKind: "active-session",
          contentRevision: expect.any(String),
          sessionFile: sessionKey,
          sessionId,
          sessionKey,
          transcriptSource: "sqlite",
          updatedAtMs: expect.any(Number),
          sessionKind: "interactive",
        }),
        expect.objectContaining({
          agentId: "main",
          artifactKind: "archive-artifact",
          contentRevision: expect.any(String),
          sessionFile: archivePath,
          sessionId,
        }),
      ]),
    );

    const liveEntry = requireSessionEntry(
      await buildSessionEntry(sessionKey, {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath,
        updatedAtMs: updatedAt,
      }),
    );
    const liveState = statSessionEntrySync(sessionKey, {
      agentId: "main",
      sessionId,
      sessionKey,
      storePath,
      updatedAtMs: updatedAt,
    });
    const archiveEntry = requireSessionEntry(await buildSessionEntry(archivePath));

    expect(liveEntry.path).toBe("sessions/main/sqlite-live.jsonl");
    expect(liveEntry.content).toBe("User: Live SQLite transcript text");
    expect(liveState).toEqual({
      absPath: sessionKey,
      path: liveEntry.path,
      mtimeMs: liveEntry.mtimeMs,
      size: liveEntry.size,
    });
    expect(archiveEntry.path).toBe(
      "sessions/main/sqlite-live.jsonl.deleted.2026-06-25T12-01-00.000Z",
    );
    expect(archiveEntry.content).toBe("User: Archived JSONL transcript text");
  });

  it("exposes content revisions that change with SQLite appends and file replacement", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:chat:revision";
    const sessionId = "revision";
    const archivePath = path.join(
      sessionsDir,
      `${sessionId}.jsonl.deleted.2026-06-25T12-01-00.000Z`,
    );
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId, updatedAt: 1 },
    );
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        messages: [{ message: { role: "user", content: "first" } }],
        touchSessionEntry: true,
        updateMode: "none",
      },
    );
    fsSync.writeFileSync(archivePath, "first");

    const before = await listSessionTranscriptCorpusEntriesForAgent("main");
    const beforeLive = before.find((entry) => entry.transcriptSource === "sqlite");
    const beforeArchive = before.find((entry) => entry.sessionFile === archivePath);
    expect(beforeLive?.contentRevision).toEqual(expect.any(String));
    expect(beforeArchive?.contentRevision).toEqual(expect.any(String));

    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        messages: [{ message: { role: "assistant", content: "second" } }],
        touchSessionEntry: true,
        updateMode: "none",
      },
    );
    const replacement = `${archivePath}.replacement`;
    fsSync.writeFileSync(replacement, "second");
    fsSync.renameSync(replacement, archivePath);

    const after = await listSessionTranscriptCorpusEntriesForAgent("main");
    expect(after.find((entry) => entry.transcriptSource === "sqlite")?.contentRevision).not.toBe(
      beforeLive?.contentRevision,
    );
    expect(after.find((entry) => entry.sessionFile === archivePath)?.contentRevision).not.toBe(
      beforeArchive?.contentRevision,
    );
  });

  it("classifies active entries through cron parentage chains", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const cronPath = path.join(sessionsDir, "cron-run.jsonl");
    const spawnedChildPath = path.join(sessionsDir, "spawned-child.jsonl");
    const keyedChildPath = path.join(sessionsDir, "keyed-child.jsonl");
    const orphanChildPath = path.join(sessionsDir, "orphan-child.jsonl");
    const normalPath = path.join(sessionsDir, "normal-child.jsonl");
    for (const filePath of [
      cronPath,
      spawnedChildPath,
      keyedChildPath,
      orphanChildPath,
      normalPath,
    ]) {
      fsSync.writeFileSync(filePath, "");
    }
    await upsertTestSessionEntries(path.join(sessionsDir, "sessions.json"), {
      "agent:main:cron:job-1:run:run-1": {
        sessionFile: "cron-run.jsonl",
        sessionId: "cron-run",
        updatedAt: 1,
      },
      "agent:main:subagent:spawned-child": {
        sessionFile: "spawned-child.jsonl",
        sessionId: "spawned-child",
        spawnedBy: "agent:main:cron:job-1:run:run-1",
        updatedAt: 1,
      },
      "agent:main:subagent:keyed-child": {
        parentSessionKey: "agent:main:subagent:spawned-child",
        sessionFile: "keyed-child.jsonl",
        sessionId: "keyed-child",
        updatedAt: 1,
      },
      "agent:main:subagent:orphan-child": {
        sessionFile: "orphan-child.jsonl",
        sessionId: "orphan-child",
        spawnedBy: "agent:main:cron:job-1:run:missing",
        updatedAt: 1,
      },
      "agent:main:subagent:normal-child": {
        sessionFile: "normal-child.jsonl",
        sessionId: "normal-child",
        spawnedBy: "agent:main:chat:manual",
        updatedAt: 1,
      },
    });

    const entries = await listSessionTranscriptCorpusEntriesForAgent("main");
    expect(entries.filter((entry) => entry.generatedByCronRun)).toHaveLength(4);
  });

  it("keeps archive classification when the active transcript is missing", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const archivePath = path.join(sessionsDir, "cron-run.jsonl.reset.2026-02-16T22-26-33.000Z");
    fsSync.writeFileSync(archivePath, "");
    await upsertTestSessionEntries(path.join(sessionsDir, "sessions.json"), {
      "agent:main:cron:job-1:run:run-1": {
        sessionFile: "cron-run.jsonl",
        sessionId: "cron-run",
        updatedAt: 1,
      },
    });

    const expectedArchivePath = archivePath;
    const classification = loadSessionTranscriptClassificationForAgent("main");

    expect(classification.cronRunTranscriptPaths).toEqual(
      new Set([normalizeSessionTranscriptPathForComparison(expectedArchivePath)]),
    );
    await expect(listSessionFilesForAgent("main")).resolves.toEqual([expectedArchivePath]);
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "main",
          artifactKind: "archive-artifact",
          contentRevision: expect.any(String),
          generatedByCronRun: true,
          sessionKind: "cron",
          sessionFile: expectedArchivePath,
          sessionId: "cron-run",
        }),
      ]),
    );
  });

  it("omits active session entries whose transcript files are missing", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:chat:missing": {
          sessionFile: "missing.jsonl",
          sessionId: "missing",
        },
      }),
    );

    await expect(listSessionFilesForAgent("main")).resolves.toEqual([]);
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("omits symlinked archive artifacts from the session corpus", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    const targetPath = path.join(fixture.tmpDir, "external.jsonl");
    const symlinkPath = path.join(sessionsDir, "linked.jsonl.deleted.2026-02-16T22-27-33.000Z");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(symlinkPath, "");
    await expect(listSessionFilesForAgent("main")).resolves.toEqual([symlinkPath]);
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toContainEqual(
      expect.objectContaining({
        artifactKind: "archive-artifact",
        sessionFile: symlinkPath,
        sessionId: "linked",
      }),
    );
    fsSync.unlinkSync(symlinkPath);

    if (process.platform === "win32") {
      fsSync.mkdirSync(targetPath);
      fsSync.symlinkSync(targetPath, symlinkPath, "junction");
    } else {
      fsSync.writeFileSync(targetPath, "");
      fsSync.symlinkSync(targetPath, symlinkPath);
    }
    expect(fsSync.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);

    await expect(listSessionFilesForAgent("main")).resolves.toEqual([]);
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("rejects session ids that would escape the sessions directory", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(path.join(fixture.tmpDir, "secret.jsonl"), "");
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:chat:escape": {
          sessionId: "../secret",
        },
      }),
    );

    await expect(listSessionFilesForAgent("main")).resolves.toEqual([]);
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("does not classify a fallback transcript when explicit sessionFile is invalid", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    const sessionFile = path.join(sessionsDir, "active.jsonl");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(sessionFile, "");
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:cron:job-1:run:run-1": {
          sessionFile: "../old.jsonl",
          sessionId: "active",
        },
      }),
    );

    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("rejects relative sessionFile values that escape through nested segments", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    const secretPath = path.join(fixture.tmpDir, "agents", "main", "secret.jsonl");
    fsSync.mkdirSync(path.join(sessionsDir, "sub"), { recursive: true });
    fsSync.writeFileSync(secretPath, "");
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:chat:escape-file": {
          sessionFile: "sub/../../secret.jsonl",
          sessionId: "secret",
        },
      }),
    );

    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("rejects absolute transcript paths owned by another agent", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    const otherSessionsDir = path.join(fixture.tmpDir, "agents", "ops", "sessions");
    const otherSessionFile = path.join(otherSessionsDir, "private.jsonl");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.mkdirSync(otherSessionsDir, { recursive: true });
    fsSync.writeFileSync(otherSessionFile, "");
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:chat:cross-agent": {
          sessionFile: otherSessionFile,
          sessionId: "private",
        },
      }),
    );

    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("omits loose non-archive JSONL transcripts from the corpus", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "active-thread-456.jsonl");
    fsSync.writeFileSync(sessionFile, "");

    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("uses SQLite identity for entries in a custom session store", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "custom-sessions");
    const sessionFile = path.join(sessionsDir, "custom-thread.jsonl");
    const storePath = path.join(sessionsDir, "sessions.json");
    const configPath = path.join(fixture.tmpDir, "openclaw.json");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(sessionFile, "");
    fsSync.writeFileSync(configPath, JSON.stringify({ session: { store: storePath } }));
    Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", configPath);
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await upsertTestSessionEntries(storePath, {
      "agent:main:chat:custom": {
        sessionFile: "custom-thread.jsonl",
        sessionId: "custom-thread",
        updatedAt: 1,
      },
    });

    await expect(listSessionFilesForAgent("main")).resolves.toEqual([]);
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toContainEqual(
      expect.objectContaining({
        sessionFile: "agent:main:chat:custom",
        sessionId: "custom-thread",
        transcriptSource: "sqlite",
      }),
    );
  });

  it("keeps unowned archives from an agent-owned fixed session store", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    const archivePath = path.join(sessionsDir, "retained.jsonl.deleted.2026-02-16T22-27-33.000Z");
    const configPath = path.join(fixture.tmpDir, "openclaw.json");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(archivePath, "");
    fsSync.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}");
    fsSync.writeFileSync(
      configPath,
      JSON.stringify({ session: { store: path.join(sessionsDir, "sessions.json") } }),
    );
    Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", configPath);
    clearRuntimeConfigSnapshot();
    clearConfigCache();

    await expect(listSessionFilesForAgent("main")).resolves.toEqual([archivePath]);
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([
      {
        agentId: "main",
        artifactKind: "archive-artifact",
        contentRevision: expect.any(String),
        sessionFile: archivePath,
        sessionId: "retained",
        sessionKind: "unknown",
      },
    ]);
  });

  it("resolves absolute transcript paths from a fixed custom store", async () => {
    const storeDir = path.join(fixture.tmpDir, "custom-sessions");
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    const sessionFile = path.join(sessionsDir, "absolute-thread.jsonl");
    const archivePath = path.join(
      sessionsDir,
      "absolute-thread.jsonl.deleted.2026-02-16T22-27-33.000Z",
    );
    const storePath = path.join(storeDir, "sessions.json");
    const configPath = path.join(fixture.tmpDir, "openclaw.json");
    fsSync.mkdirSync(storeDir, { recursive: true });
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(sessionFile, "");
    fsSync.writeFileSync(archivePath, "");
    fsSync.writeFileSync(configPath, JSON.stringify({ session: { store: storePath } }));
    Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", configPath);
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await upsertTestSessionEntries(storePath, {
      "agent:main:chat:absolute": {
        sessionFile,
        sessionId: "absolute-thread",
        updatedAt: 1,
      },
    });

    await expect(listSessionFilesForAgent("main")).resolves.toEqual([archivePath]);
  });

  it("keeps legacy session keys in non-main per-agent stores", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "ops", "sessions");
    const sessionFile = path.join(sessionsDir, "legacy-thread.jsonl");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(sessionFile, "");
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "slack:workspace:thread": {
          sessionFile: "legacy-thread.jsonl",
          sessionId: "legacy-thread",
        },
      }),
    );

    await expect(listSessionFilesForAgent("ops")).resolves.toEqual([]);
    await expect(listSessionFilesForAgent("main")).resolves.toEqual([]);
  });

  it("keeps legacy main aliases in a renamed default agent store", async () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "ops", "sessions");
    const sessionFile = path.join(sessionsDir, "legacy-main.jsonl");
    const configPath = path.join(fixture.tmpDir, "openclaw.json");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(sessionFile, "");
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:main": {
          sessionFile: "legacy-main.jsonl",
          sessionId: "legacy-main",
        },
      }),
    );
    fsSync.writeFileSync(
      configPath,
      JSON.stringify({ agents: { entries: { ops: { default: true } } } }),
    );
    Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", configPath);
    clearRuntimeConfigSnapshot();
    clearConfigCache();

    await expect(listSessionFilesForAgent("ops")).resolves.toEqual([]);
  });
});

describe("sessionPathForFile", () => {
  it("includes the owning agent id when the transcript lives under an agent sessions dir", () => {
    const absPath = path.join(
      fixture.tmpDir,
      "agents",
      "main",
      "sessions",
      "deleted-session.jsonl.deleted.2026-02-16T22-27-33.000Z",
    );

    expect(sessionPathForFile(absPath)).toBe(
      "sessions/main/deleted-session.jsonl.deleted.2026-02-16T22-27-33.000Z",
    );
  });

  it("keeps the legacy basename-only path when the agent owner cannot be derived", () => {
    expect(sessionPathForFile(path.join(fixture.tmpDir, "loose-session.jsonl"))).toBe(
      "sessions/loose-session.jsonl",
    );
  });
});

describe("memory session sync targets", () => {
  it("parses deprecated canonical OpenClaw transcript paths into sync identity", () => {
    const sessionFile = path.join(fixture.tmpDir, "agents", "main", "sessions", "active.jsonl");
    fsSync.mkdirSync(path.dirname(sessionFile), { recursive: true });

    expect(parseCanonicalSessionSyncTargetFromPath(sessionFile)).toEqual({
      agentId: "main",
      sessionId: "active",
    });
  });

  it("rejects arbitrary deprecated transcript path hints", () => {
    expect(
      parseCanonicalSessionSyncTargetFromPath(path.join(fixture.tmpDir, "active.jsonl")),
    ).toBeNull();
    expect(
      parseCanonicalSessionSyncTargetFromPath(
        path.join(fixture.tmpDir, "agents", "main", "sessions", "active.trajectory.jsonl"),
      ),
    ).toBeNull();
  });

  it("does not synthesize active transcript paths for identity sync targets", () => {
    expect(resolveSessionFileForSyncTarget({ sessionId: "active" }, "main")).toBeNull();
    expect(resolveSessionFileForSyncTarget({ agentId: "MAIN", sessionId: "active" })).toBeNull();
  });

  it("rejects identity sync targets that would escape the sessions directory", () => {
    expect(resolveSessionFileForSyncTarget({ sessionId: "../outside" }, "main")).toBeNull();
  });

  it("rejects identity sync targets that normalize to another transcript", () => {
    expect(resolveSessionFileForSyncTarget({ sessionId: "foo/../active" }, "main")).toBeNull();
  });

  it("does not read legacy sessions.json for persisted session-key sync targets", () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:chat:thread-456": {
          sessionFile: "active-thread-456.jsonl",
          sessionId: "active",
        },
      }),
    );

    expect(
      resolveSessionFileForSyncTarget({
        agentId: "main",
        sessionId: "active",
        sessionKey: "agent:main:chat:thread-456",
      }),
    ).toBeNull();
  });

  it("resolves transcript file identities through persisted session keys", () => {
    const sessionsDir = path.join(fixture.tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "active-thread-456.jsonl");
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:chat:thread-456": {
          sessionFile: "active-thread-456.jsonl",
          sessionId: "active",
        },
      }),
    );

    expect(resolveSessionIdentityForTranscriptFile(sessionFile)).toEqual({
      agentId: "main",
      sessionId: "active",
      sessionKey: "agent:main:chat:thread-456",
    });
  });
});
