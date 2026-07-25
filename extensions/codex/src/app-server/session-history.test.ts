// Codex tests cover mirrored session-history branch selection.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function writeSession(records: unknown[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-session-history-"));
  tempDirs.push(dir);
  const sessionFile = path.join(dir, "session.jsonl");
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: "codex-session",
    timestamp: "2026-06-15T00:00:00.000Z",
    cwd: dir,
  };
  await fs.writeFile(
    sessionFile,
    [header, ...records].map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  return sessionFile;
}

// Fixtures keep legacy string content on purpose: session ingest normalizes
// assistant strings into [{ type: "text" }] blocks, so expectations below
// assert the canonical block-array shape for assistant rows.
function messageEntry(params: {
  id: string;
  parentId: string | null;
  role: "user" | "assistant";
  content: string;
}) {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId,
    timestamp: "2026-06-15T00:00:00.000Z",
    message: {
      role: params.role,
      content: params.content,
      timestamp: 1,
    },
  };
}

function mirroredTarget(sessionFile: string) {
  return {
    sessionFile,
    sessionId: "codex-session",
    sessionKey: "codex-session",
  };
}

async function writeSqliteSession(params: { storedSessionFile?: string } = {}): Promise<{
  marker: string;
  sessionKey: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-session-history-sqlite-"));
  tempDirs.push(dir);
  const storePath = path.join(dir, "openclaw-agent.sqlite");
  const sessionId = "codex-sqlite-session";
  const sessionKey = "agent:main:codex-sqlite";
  const marker = `sqlite:main:${sessionId}:${storePath}`;
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath,
  };
  await upsertSessionEntry({
    ...scope,
    entry: {
      sessionFile: params.storedSessionFile ?? marker,
      sessionId,
      updatedAt: 1,
    },
  });
  await appendSessionTranscriptMessageByIdentity({
    ...scope,
    message: { role: "user", content: "sqlite prompt", timestamp: 1 },
  });
  await appendSessionTranscriptMessageByIdentity({
    ...scope,
    message: { role: "assistant", content: "sqlite answer", timestamp: 2 },
  });
  return { marker, sessionKey };
}

describe("readCodexMirroredSessionHistoryMessages", () => {
  it("treats a missing mirrored session file as empty history", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-session-history-"));
    tempDirs.push(dir);
    const sessionFile = path.join(dir, "session.jsonl");

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toEqual([]);
  });

  it("returns [] for transcripts that do not open with a Codex session marker", async () => {
    // A non-Codex-shaped transcript (e.g. a non-Codex model run reusing this
    // hook) is an empty mirror, not a read failure, so callers must not warn.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-session-history-"));
    tempDirs.push(dir);
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(sessionFile, JSON.stringify({ type: "message", id: "orphan" }) + "\n");

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toEqual([]);
  });

  it("returns undefined for a session header without a string id", async () => {
    // A `session` header with corrupt metadata is a Codex transcript gone bad,
    // not a foreign transcript — it must stay on the warn path.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-session-history-"));
    tempDirs.push(dir);
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(sessionFile, JSON.stringify({ type: "session", id: 42 }) + "\n");

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toBeUndefined();
  });

  it("replays SQLite marker history by session identity", async () => {
    const { marker, sessionKey } = await writeSqliteSession();

    await expect(
      readCodexMirroredSessionHistoryMessages({
        agentId: "main",
        sessionFile: marker,
        sessionId: "codex-sqlite-session",
        sessionKey,
      }),
    ).resolves.toMatchObject([
      { role: "user", content: "sqlite prompt" },
      { role: "assistant", content: "sqlite answer" },
    ]);
  });

  it("resolves SQLite marker history when the caller has no session key", async () => {
    const { marker } = await writeSqliteSession();

    await expect(
      readCodexMirroredSessionHistoryMessages({
        agentId: "main",
        sessionFile: marker,
        sessionId: "codex-sqlite-session",
      }),
    ).resolves.toMatchObject([
      { role: "user", content: "sqlite prompt" },
      { role: "assistant", content: "sqlite answer" },
    ]);
  });

  it("resolves synthesized SQLite markers for stale file-backed session metadata", async () => {
    const { marker } = await writeSqliteSession({
      storedSessionFile: "/tmp/legacy-session.jsonl",
    });

    await expect(
      readCodexMirroredSessionHistoryMessages({
        agentId: "main",
        sessionFile: marker,
        sessionId: "codex-sqlite-session",
      }),
    ).resolves.toMatchObject([
      { role: "user", content: "sqlite prompt" },
      { role: "assistant", content: "sqlite answer" },
    ]);
  });

  it("replays only the branch selected by a leaf control", async () => {
    const sessionFile = await writeSession([
      messageEntry({ id: "root", parentId: null, role: "user", content: "root prompt" }),
      messageEntry({
        id: "active",
        parentId: "root",
        role: "assistant",
        content: "active answer",
      }),
      messageEntry({
        id: "inactive",
        parentId: "root",
        role: "assistant",
        content: "inactive answer",
      }),
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive",
        targetId: "active",
      },
    ]);

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toMatchObject([
      { role: "user", content: "root prompt" },
      { role: "assistant", content: [{ type: "text", text: "active answer" }] },
    ]);
  });

  it("honors explicit navigation to an empty branch", async () => {
    const sessionFile = await writeSession([
      messageEntry({ id: "old", parentId: null, role: "user", content: "old prompt" }),
      {
        type: "leaf",
        id: "empty-leaf",
        parentId: "old",
        targetId: null,
        appendParentId: "old",
      },
    ]);

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toEqual([]);
  });

  it("keeps visible history when continuation rows use a disjoint append cursor", async () => {
    const sessionFile = await writeSession([
      messageEntry({ id: "visible", parentId: null, role: "user", content: "visible prompt" }),
      messageEntry({
        id: "inactive",
        parentId: "visible",
        role: "assistant",
        content: "inactive answer",
      }),
      {
        type: "metadata",
        id: "append-metadata",
        parentId: "inactive",
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive",
        targetId: "visible",
        appendParentId: "append-metadata",
      },
      messageEntry({
        id: "continued",
        parentId: "append-metadata",
        role: "assistant",
        content: "continued answer",
      }),
    ]);

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toMatchObject([
      { role: "user", content: "visible prompt" },
      { role: "assistant", content: [{ type: "text", text: "continued answer" }] },
    ]);
  });

  it("keeps visible history when a continuation references the leaf marker", async () => {
    const sessionFile = await writeSession([
      messageEntry({ id: "visible", parentId: null, role: "user", content: "visible prompt" }),
      messageEntry({
        id: "inactive",
        parentId: "visible",
        role: "assistant",
        content: "inactive answer",
      }),
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive",
        targetId: "visible",
      },
      messageEntry({
        id: "continued",
        parentId: "active-leaf",
        role: "assistant",
        content: "continued answer",
      }),
    ]);

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toMatchObject([
      { role: "user", content: "visible prompt" },
      { role: "assistant", content: [{ type: "text", text: "continued answer" }] },
    ]);
  });
});
