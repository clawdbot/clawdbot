import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  sessionPathForFile,
} from "./session-files.js";

let fixtureRoot: string;
let tmpDir: string;
let originalStateDir: string | undefined;
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
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

describe("listSessionFilesForAgent", () => {
  it("includes reset and deleted transcripts in session file listing", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(path.join(sessionsDir, "archive"), { recursive: true });

    const included = [
      "active.jsonl",
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

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // The content should have 3 lines (3 message records)
    const contentLines = entry!.content.split("\n");
    expect(contentLines).toHaveLength(3);
    expect(contentLines[0]).toContain("User: Hello world");
    expect(contentLines[1]).toContain("Assistant: Hi there");
    expect(contentLines[2]).toContain("User: Tell me a joke");

    // lineMap should map each content line to its original JSONL line (1-indexed)
    // Content line 0 → JSONL line 4 (the first user message)
    // Content line 1 → JSONL line 6 (the assistant message)
    // Content line 2 → JSONL line 7 (the second user message)
    expect(entry!.lineMap).toBeDefined();
    expect(entry!.lineMap).toEqual([4, 6, 7]);
  });

  it("returns empty lineMap when no messages are found", async () => {
    const jsonlLines = [
      JSON.stringify({ type: "custom", customType: "model-snapshot", data: {} }),
      JSON.stringify({ type: "session-meta", agentId: "test" }),
    ];
    const filePath = path.join(tmpDir, "empty-session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("");
    expect(entry!.lineMap).toEqual([]);
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

    const resetEntry = await buildSessionEntry(resetPath);
    const deletedEntry = await buildSessionEntry(deletedPath);
    const bakEntry = await buildSessionEntry(bakPath);
    const checkpointEntry = await buildSessionEntry(checkpointPath);

    // Usage-counted archives (reset, deleted) must surface real content so
    // post-reset memory_search can recover prior session history.
    expect(resetEntry?.content).toContain("User: Archived hello");
    expect(resetEntry?.lineMap).toEqual([1]);
    expect(deletedEntry?.content).toContain("User: Archived hello");
    expect(deletedEntry?.lineMap).toEqual([1]);

    // .bak and compaction checkpoints remain opaque pre-archive / snapshot
    // artifacts and stay empty so they do not get double-indexed.
    expect(bakEntry).not.toBeNull();
    expect(bakEntry?.content).toBe("");
    expect(bakEntry?.lineMap).toEqual([]);
    expect(checkpointEntry).not.toBeNull();
    expect(checkpointEntry?.content).toBe("");
    expect(checkpointEntry?.lineMap).toEqual([]);
  });

  it("keeps cron-run deleted archives opaque when the live session store entry is gone", async () => {
    const archivePath = path.join(tmpDir, "cron-run.jsonl.deleted.2026-02-16T22-27-33.000Z");
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "[cron:job-1 Codex Sessions Sync] Run internal sync.",
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Internal cron output that must stay out." },
      }),
    ];
    fsSync.writeFileSync(archivePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(archivePath);

    expect(entry).not.toBeNull();
    expect(entry?.content).toBe("");
    expect(entry?.lineMap).toEqual([]);
    expect(entry?.generatedByCronRun).toBe(true);
  });

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

    const entry = await buildSessionEntry(archivePath);

    expect(entry).not.toBeNull();
    expect(entry?.content).toBe("");
    expect(entry?.lineMap).toEqual([]);
    expect(entry?.generatedByCronRun).toBe(true);
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

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.lineMap).toEqual([3, 5]);
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

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("User: Actual user text");
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

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("Assistant: User-facing summary.\nUser: Actual user follow-up.");
    expect(entry!.lineMap).toEqual([2, 3]);
  });
});
