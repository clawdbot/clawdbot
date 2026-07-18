// Memory Host SDK tests cover session files behavior.
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntry,
} from "../../../../src/config/sessions/session-accessor.js";
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  listSessionTranscriptCorpusEntriesForAgent,
  loadSessionTranscriptClassificationForAgent,
  parseCanonicalSessionSyncTargetFromPath,
  resolveSessionIdentityForTranscriptFile,
  resolveSessionFileForSyncTarget,
  sessionPathForFile,
  statSessionEntrySync,
  type SessionFileEntry,
} from "./session-files.js";

function captureStateDirEnv() {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  return {
    restore() {
      if (stateDir === undefined) {
        Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
      } else {
        Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
      }
      if (configPath === undefined) {
        Reflect.deleteProperty(process.env, "OPENCLAW_CONFIG_PATH");
      } else {
        Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", configPath);
      }
    },
  };
}

let fixtureRoot: string;
let tmpDir: string;
let envSnapshot: ReturnType<typeof captureStateDirEnv> | undefined;
let fixtureId = 0;

beforeAll(() => {
  fixtureRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "session-entry-test-"));
});

afterAll(() => {
  fsSync.rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  tmpDir = path.join(fixtureRoot, `case-${fixtureId++}`);
  fsSync.mkdirSync(tmpDir, { recursive: true });
  envSnapshot = captureStateDirEnv();
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", tmpDir);
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

afterEach(() => {
  envSnapshot?.restore();
  envSnapshot = undefined;
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

function requireSessionEntry(entry: SessionFileEntry | null): SessionFileEntry {
  if (!entry) {
    throw new Error("expected session entry");
  }
  return entry;
}

async function upsertTestSessionEntries(
  storePath: string,
  entries: Record<string, Parameters<typeof upsertSessionEntry>[1]>,
): Promise<void> {
  fsSync.mkdirSync(path.dirname(storePath), { recursive: true });
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await upsertSessionEntry({ sessionKey, storePath }, entry);
  }
}

describe("listSessionFilesForAgent", () => {
  it("includes reset and deleted transcripts in session file listing", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(path.join(sessionsDir, "archive"), { recursive: true });

    const included = [
      "active.jsonl.reset.2026-02-16T22-26-33.000Z",
      "active.jsonl.deleted.2026-02-16T22-27-33.000Z",
    ];
    const excluded = ["active.jsonl.bak.2026-02-16T22-28-33.000Z", "sessions.json", "notes.md"];
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
  it("omits active JSONL session entries from accessor-backed corpus entries", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(path.join(sessionsDir, "narrative.jsonl"), "");
    await upsertTestSessionEntries(path.join(sessionsDir, "sessions.json"), {
      "agent:main:dreaming-narrative-run-1": {
        sessionFile: "narrative.jsonl",
        sessionId: "narrative",
        updatedAt: 1,
      },
    });

    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("keeps archive artifacts in the corpus and inherits active session classification", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
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

    expect(classification.cronRunTranscriptPaths).toEqual(new Set([path.resolve(archivePath)]));
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toContainEqual({
      agentId: "main",
      artifactKind: "archive-artifact",
      contentRevision: expect.any(String),
      generatedByCronRun: true,
      sessionFile: archivePath,
      sessionId: "cron-run",
    });
  });

  it("reads live SQLite rows by session identity while preserving archived JSONL artifacts", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:chat:sqlite-live";
    const sessionId = "sqlite-live";
    const updatedAt = Date.parse("2026-06-25T12:00:00.000Z");
    fsSync.mkdirSync(sessionsDir, { recursive: true });

    await upsertSessionEntry({ agentId: "main", sessionKey, storePath }, { sessionId, updatedAt });
    const turn = await persistSessionTranscriptTurn(
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
          sessionFile: turn.sessionFile,
          sessionId,
          sessionKey,
          transcriptSource: "sqlite",
          updatedAtMs: expect.any(Number),
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
      await buildSessionEntry(turn.sessionFile, { sessionKey, updatedAtMs: updatedAt }),
    );
    const liveState = statSessionEntrySync(turn.sessionFile, {
      sessionKey,
      updatedAtMs: updatedAt,
    });
    const archiveEntry = requireSessionEntry(await buildSessionEntry(archivePath));

    expect(liveEntry.path).toBe("sessions/main/sqlite-live.jsonl");
    expect(liveEntry.content).toBe("User: Live SQLite transcript text");
    expect(liveState).toEqual({
      absPath: turn.sessionFile,
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
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:chat:revision";
    const sessionId = "revision";
    const archivePath = path.join(
      sessionsDir,
      `${sessionId}.jsonl.deleted.2026-06-25T12-01-00.000Z`,
    );
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    await upsertSessionEntry(
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
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
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

    const classification = loadSessionTranscriptClassificationForAgent("main");

    expect(classification.cronRunTranscriptPaths).toEqual(new Set());
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
    const entries = await listSessionTranscriptCorpusEntriesForAgent("main");
    expect(entries.find((entry) => entry.sessionFile === normalPath)?.generatedByCronRun).toBe(
      undefined,
    );
  });

  it("keeps archive classification when the active transcript is missing", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
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

    expect(classification.cronRunTranscriptPaths).toEqual(new Set([expectedArchivePath]));
    await expect(listSessionFilesForAgent("main")).resolves.toEqual([expectedArchivePath]);
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([
      {
        agentId: "main",
        artifactKind: "archive-artifact",
        contentRevision: expect.any(String),
        generatedByCronRun: true,
        sessionFile: expectedArchivePath,
        sessionId: "cron-run",
      },
    ]);
  });

  it("omits active session entries whose transcript files are missing", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
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

  it("omits active session entries whose transcript path is a symlink", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const targetPath = path.join(tmpDir, "external.jsonl");
    const symlinkPath = path.join(sessionsDir, "linked.jsonl");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(targetPath, "");
    fsSync.symlinkSync(targetPath, symlinkPath);
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:chat:linked": {
          sessionFile: "linked.jsonl",
          sessionId: "linked",
        },
      }),
    );

    await expect(listSessionFilesForAgent("main")).resolves.toEqual([]);
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("rejects session ids that would escape the sessions directory", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(path.join(tmpDir, "secret.jsonl"), "");
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
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
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
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const secretPath = path.join(tmpDir, "agents", "main", "secret.jsonl");
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
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const otherSessionsDir = path.join(tmpDir, "agents", "ops", "sessions");
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
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "active-thread-456.jsonl");
    fsSync.writeFileSync(sessionFile, "");

    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("omits active JSONL transcripts from a custom session store", async () => {
    const sessionsDir = path.join(tmpDir, "custom-sessions");
    const sessionFile = path.join(sessionsDir, "custom-thread.jsonl");
    const storePath = path.join(sessionsDir, "sessions.json");
    const configPath = path.join(tmpDir, "openclaw.json");
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
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("keeps unowned archives from an agent-owned fixed session store", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const archivePath = path.join(sessionsDir, "retained.jsonl.deleted.2026-02-16T22-27-33.000Z");
    const configPath = path.join(tmpDir, "openclaw.json");
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
      },
    ]);
  });

  it("resolves absolute transcript paths from a fixed custom store", async () => {
    const storeDir = path.join(tmpDir, "custom-sessions");
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const sessionFile = path.join(sessionsDir, "absolute-thread.jsonl");
    const archivePath = path.join(
      sessionsDir,
      "absolute-thread.jsonl.deleted.2026-02-16T22-27-33.000Z",
    );
    const storePath = path.join(storeDir, "sessions.json");
    const configPath = path.join(tmpDir, "openclaw.json");
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
    const sessionsDir = path.join(tmpDir, "agents", "ops", "sessions");
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
    const sessionsDir = path.join(tmpDir, "agents", "ops", "sessions");
    const sessionFile = path.join(sessionsDir, "legacy-main.jsonl");
    const configPath = path.join(tmpDir, "openclaw.json");
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
      JSON.stringify({ agents: { list: [{ id: "ops", default: true }] } }),
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
      tmpDir,
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
    expect(sessionPathForFile(path.join(tmpDir, "loose-session.jsonl"))).toBe(
      "sessions/loose-session.jsonl",
    );
  });
});

describe("memory session sync targets", () => {
  it("parses deprecated canonical OpenClaw transcript paths into sync identity", () => {
    const sessionFile = path.join(tmpDir, "agents", "main", "sessions", "active.jsonl");
    fsSync.mkdirSync(path.dirname(sessionFile), { recursive: true });

    expect(parseCanonicalSessionSyncTargetFromPath(sessionFile)).toEqual({
      agentId: "main",
      sessionId: "active",
    });
  });

  it("rejects arbitrary deprecated transcript path hints", () => {
    expect(parseCanonicalSessionSyncTargetFromPath(path.join(tmpDir, "active.jsonl"))).toBeNull();
    expect(
      parseCanonicalSessionSyncTargetFromPath(
        path.join(tmpDir, "agents", "main", "sessions", "active.trajectory.jsonl"),
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
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
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
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
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

describe("buildSessionEntry", () => {
  it("returns lineMap tracking original JSONL line numbers", async () => {
    // Simulate a real session JSONL file with metadata records interspersed
    // Lines 1-3: non-message metadata records
    // Line 4: user message
    // Line 5: metadata
    // Line 6: assistant message
    // Line 7: user message
    const jsonlLines = [
      JSON.stringify({ type: "custom", customType: "model-snapshot", data: {} }),
      JSON.stringify({ type: "custom", customType: "openclaw.cache-ttl", data: {} }),
      JSON.stringify({ type: "session-meta", agentId: "test" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Hello world" } }),
      JSON.stringify({ type: "custom", customType: "tool-result", data: {} }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Hi there, how can I help?" },
      }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Tell me a joke" } }),
    ];
    const filePath = path.join(tmpDir, "session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(filePath));
    expect(entry.content).toBe(
      "User: Hello world\nAssistant: Hi there, how can I help?\nUser: Tell me a joke",
    );

    // lineMap should map each content line to its original JSONL line (1-indexed)
    // Content line 0 → JSONL line 4 (the first user message)
    // Content line 1 → JSONL line 6 (the assistant message)
    // Content line 2 → JSONL line 7 (the second user message)
    expect(entry.lineMap).toStrictEqual([4, 6, 7]);
  });

  it("returns empty lineMap when no messages are found", async () => {
    const jsonlLines = [
      JSON.stringify({ type: "custom", customType: "model-snapshot", data: {} }),
      JSON.stringify({ type: "session-meta", agentId: "test" }),
    ];
    const filePath = path.join(tmpDir, "empty-session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(filePath));
    expect(entry.content).toBe("");
    expect(entry.lineMap).toStrictEqual([]);
  });

  it("indexes usage-counted reset/deleted archives but still skips bak and checkpoint artifacts", async () => {
    const resetPath = path.join(tmpDir, "ordinary.jsonl.reset.2026-02-16T22-26-33.000Z");
    const deletedPath = path.join(tmpDir, "ordinary.jsonl.deleted.2026-02-16T22-27-33.000Z");
    const bakPath = path.join(tmpDir, "ordinary.jsonl.bak.2026-02-16T22-28-33.000Z");
    const checkpointPath = path.join(
      tmpDir,
      "ordinary.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
    );
    const content = JSON.stringify({
      type: "message",
      message: { role: "user", content: "Archived hello" },
    });
    fsSync.writeFileSync(resetPath, content);
    fsSync.writeFileSync(deletedPath, content);
    fsSync.writeFileSync(bakPath, content);
    fsSync.writeFileSync(checkpointPath, content);

    const resetEntry = requireSessionEntry(await buildSessionEntry(resetPath));
    const deletedEntry = requireSessionEntry(await buildSessionEntry(deletedPath));
    const bakEntry = requireSessionEntry(await buildSessionEntry(bakPath));
    const checkpointEntry = requireSessionEntry(await buildSessionEntry(checkpointPath));

    // Usage-counted archives (reset, deleted) must surface real content so
    // post-reset memory_search can recover prior session history.
    expect(resetEntry.content).toBe("User: Archived hello");
    expect(resetEntry.lineMap).toStrictEqual([1]);
    expect(deletedEntry.content).toBe("User: Archived hello");
    expect(deletedEntry.lineMap).toStrictEqual([1]);

    // .bak and compaction checkpoints remain opaque pre-archive / snapshot
    // artifacts and stay empty so they do not get double-indexed.
    expect(bakEntry.content).toBe("");
    expect(bakEntry.lineMap).toStrictEqual([]);
    expect(checkpointEntry.content).toBe("");
    expect(checkpointEntry.lineMap).toStrictEqual([]);
  });

  it.each([
    [
      "as the first message",
      [],
      [
        "Assistant: The digest job failed because the API token expired.",
        "User: Please remember: my preferred vendor is Acme Robotics and budget is 5000 USD.",
        "Assistant: Noted. Acme Robotics, budget 5000 USD.",
      ],
      [2, 3, 4],
    ],
    [
      "after ordinary messages",
      [
        { role: "user", content: "Remember before: project codename is Atlas." },
        { role: "assistant", content: "Saved project codename Atlas." },
      ],
      [
        "User: Remember before: project codename is Atlas.",
        "Assistant: Saved project codename Atlas.",
        "Assistant: The digest job failed because the API token expired.",
        "User: Please remember: my preferred vendor is Acme Robotics and budget is 5000 USD.",
        "Assistant: Noted. Acme Robotics, budget 5000 USD.",
      ],
      [1, 2, 4, 5, 6],
    ],
  ])(
    "does not wipe an archive when a user message starts with [cron: %s (#98241)",
    async (_position, precedingMessages, expectedContent, expectedLineMap) => {
      const archivePath = path.join(tmpDir, "ordinary.jsonl.deleted.2026-02-16T22-27-33.000Z");
      const messages = [
        ...precedingMessages,
        { role: "user", content: "[cron:daily-digest] why did my digest job fail last night?" },
        {
          role: "assistant",
          content: "The digest job failed because the API token expired.",
        },
        {
          role: "user",
          content: "Please remember: my preferred vendor is Acme Robotics and budget is 5000 USD.",
        },
        { role: "assistant", content: "Noted. Acme Robotics, budget 5000 USD." },
      ];
      const jsonlLines = messages.map((message) => JSON.stringify({ type: "message", message }));
      fsSync.writeFileSync(archivePath, jsonlLines.join("\n"));

      const entry = requireSessionEntry(await buildSessionEntry(archivePath));

      expect(entry.generatedByCronRun).toBeFalsy();
      expect(entry.content).toBe(expectedContent.join("\n"));
      expect(entry.lineMap).toStrictEqual(expectedLineMap);
    },
  );

  it("keeps cron-run reset archives opaque when session metadata preserves the cron key", async () => {
    const archivePath = path.join(tmpDir, "cron-run.jsonl.reset.2026-02-16T22-26-33.000Z");
    const jsonlLines = [
      JSON.stringify({
        type: "session-meta",
        data: { sessionKey: "agent:main:cron:job-1:run:run-1" },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Internal cron output that must stay out." },
      }),
    ];
    fsSync.writeFileSync(archivePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(archivePath));

    expect(entry.content).toBe("");
    expect(entry.lineMap).toStrictEqual([]);
    expect(entry.generatedByCronRun).toBe(true);
  });

  it("skips blank lines and invalid JSON without breaking lineMap", async () => {
    const jsonlLines = [
      "",
      "not valid json",
      JSON.stringify({ type: "message", message: { role: "user", content: "First" } }),
      "",
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Second" } }),
    ];
    const filePath = path.join(tmpDir, "gaps.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(filePath));
    expect(entry.lineMap).toStrictEqual([3, 5]);
  });

  it("strips inbound metadata when a user envelope is split across text blocks", async () => {
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Conversation info (untrusted metadata):" },
            { type: "text", text: "```json" },
            { type: "text", text: '{"message_id":"msg-100","chat_id":"-100123"}' },
            { type: "text", text: "```" },
            { type: "text", text: "" },
            { type: "text", text: "Sender (untrusted metadata):" },
            { type: "text", text: "```json" },
            { type: "text", text: '{"label":"Chris","id":"42"}' },
            { type: "text", text: "```" },
            { type: "text", text: "" },
            { type: "text", text: "Actual user text" },
          ],
        },
      }),
    ];
    const filePath = path.join(tmpDir, "enveloped-session-array.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(filePath));
    expect(entry.content).toBe("User: Actual user text");
  });

  it("skips inter-session user messages", async () => {
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "A background task completed. Internal relay text.",
          provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "User-facing summary." },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Actual user follow-up." },
      }),
    ];
    const filePath = path.join(tmpDir, "inter-session-session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(filePath));
    expect(entry.content).toBe("Assistant: User-facing summary.\nUser: Actual user follow-up.");
    expect(entry.lineMap).toStrictEqual([2, 3]);
  });

  it("drops every assistant response in a provenance-marked heartbeat turn", async () => {
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "[OpenClaw heartbeat poll]",
          provenance: { kind: "internal_system", sourceTool: "heartbeat" },
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: "Heartbeat received. Main is active. No pending user request in this cron poll.",
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", content: "Background check complete." },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "One maintenance task was also completed." },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "Internal handoff.",
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Cross-session response." },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "What is the weather today?" },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "The weather is sunny." },
      }),
    ];
    const filePath = path.join(tmpDir, "heartbeat-session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(filePath));
    expect(entry.content).toBe(
      "Assistant: Cross-session response.\nUser: What is the weather today?\nAssistant: The weather is sunny.",
    );
    expect(entry.lineMap).toStrictEqual([6, 7, 8]);
  });

  it("does not couple user-spoofed heartbeat text to the next assistant response", async () => {
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "[OpenClaw heartbeat poll]",
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: "This reply belongs to a real user turn.",
        },
      }),
    ];
    const filePath = path.join(tmpDir, "normal-session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(filePath));
    expect(entry.content).toBe("Assistant: This reply belongs to a real user turn.");
    expect(entry.lineMap).toStrictEqual([2]);
  });

  it("ends a heartbeat turn when the next real user message has no text", async () => {
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "[OpenClaw heartbeat poll]",
          provenance: { kind: "internal_system", sourceTool: "heartbeat" },
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Heartbeat received." },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "image", source: "photo.jpg" }] },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "I can see the photo." },
      }),
    ];
    const filePath = path.join(tmpDir, "heartbeat-before-media-session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(filePath));
    expect(entry.content).toBe("Assistant: I can see the photo.");
    expect(entry.lineMap).toStrictEqual([4]);
  });

  it("drops Date-invalid numeric message timestamps", async () => {
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "Hello",
          timestamp: 8_640_000_000_000_001,
        },
      }),
    ];
    const filePath = path.join(tmpDir, "invalid-timestamp-session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(filePath));
    expect(entry.messageTimestampsMs).toStrictEqual([0]);
  });
});
