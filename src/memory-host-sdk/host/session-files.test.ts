import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSessionEntry, listSessionFilesForAgent } from "./session-files.js";

let tmpDir: string;
let originalStateDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-entry-test-"));
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(async () => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("listSessionFilesForAgent", () => {
  it("includes reset and deleted transcripts in session file listing", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    await fs.mkdir(path.join(sessionsDir, "archive"), { recursive: true });

    const included = [
      "active.jsonl",
      "active.jsonl.reset.2026-02-16T22-26-33.000Z",
      "active.jsonl.deleted.2026-02-16T22-27-33.000Z",
    ];
    const excluded = ["active.jsonl.bak.2026-02-16T22-28-33.000Z", "sessions.json", "notes.md"];

    for (const fileName of [...included, ...excluded]) {
      await fs.writeFile(path.join(sessionsDir, fileName), "");
    }
    await fs.writeFile(
      path.join(sessionsDir, "archive", "nested.jsonl.deleted.2026-02-16T22-29-33.000Z"),
      "",
    );

    const files = await listSessionFilesForAgent("main");

    expect(files.map((filePath) => path.basename(filePath)).toSorted()).toEqual(
      included.toSorted(),
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
    await fs.writeFile(filePath, jsonlLines.join("\n"));

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
    expect(entry!.messageTimestampsMs).toEqual([0, 0, 0]);
  });

  it("returns empty lineMap when no messages are found", async () => {
    const jsonlLines = [
      JSON.stringify({ type: "custom", customType: "model-snapshot", data: {} }),
      JSON.stringify({ type: "session-meta", agentId: "test" }),
    ];
    const filePath = path.join(tmpDir, "empty-session.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("");
    expect(entry!.lineMap).toEqual([]);
    expect(entry!.messageTimestampsMs).toEqual([]);
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
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.lineMap).toEqual([3, 5]);
    expect(entry!.messageTimestampsMs).toEqual([0, 0]);
  });

  it("captures message timestamps when present", async () => {
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-05T10:00:00.000Z",
        message: { role: "user", content: "First" },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          timestamp: "2026-04-05T10:01:00.000Z",
          content: "Second",
        },
      }),
    ];
    const filePath = path.join(tmpDir, "timestamps.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.messageTimestampsMs).toEqual([
      Date.parse("2026-04-05T10:00:00.000Z"),
      Date.parse("2026-04-05T10:01:00.000Z"),
    ]);
  });

  it("flags dreaming narrative transcripts from bootstrap metadata", async () => {
    const jsonlLines = [
      JSON.stringify({
        type: "custom",
        customType: "openclaw:bootstrap-context:full",
        data: {
          runId: "dreaming-narrative-light-1775894400455",
          sessionId: "sid-1",
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Write a dream diary entry from these memory fragments" },
      }),
    ];
    const filePath = path.join(tmpDir, "dreaming-session.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);

    expect(entry).not.toBeNull();
    expect(entry?.generatedByDreamingNarrative).toBe(true);
  });

  it("does not flag ordinary transcripts that quote the dream-diary prompt", async () => {
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content:
            "Write a dream diary entry from these memory fragments:\n- Candidate: durable note",
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "A drifting archive breathed in moonlight." },
      }),
    ];
    const filePath = path.join(tmpDir, "dreaming-prompt-session.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);

    expect(entry).not.toBeNull();
    expect(entry?.generatedByDreamingNarrative).toBeUndefined();
    expect(entry?.content).toContain(
      "User: Write a dream diary entry from these memory fragments:",
    );
    expect(entry?.content).toContain("Assistant: A drifting archive breathed in moonlight.");
    expect(entry?.lineMap).toEqual([1, 2]);
  });

  it("does not flag transcripts when dreaming markers only appear mid-string", async () => {
    const jsonlLines = [
      JSON.stringify({
        type: "custom",
        customType: "note",
        data: {
          runId: "user-context-dreaming-narrative-light-1775894400455",
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Keep the archive index updated." },
      }),
    ];
    const filePath = path.join(tmpDir, "substring-marker-session.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);

    expect(entry).not.toBeNull();
    expect(entry?.generatedByDreamingNarrative).toBeUndefined();
    expect(entry?.content).toContain("User: Keep the archive index updated.");
    expect(entry?.lineMap).toEqual([2]);
  });
});
