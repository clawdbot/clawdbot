import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSessionEntry, listSessionFilesForAgent } from "./session-files.js";

let fixtureRoot: string;
let tmpDir: string;
let originalStateDir: string | undefined;
let fixtureId = 0;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "session-entry-test-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  tmpDir = path.join(fixtureRoot, `case-${fixtureId++}`);
  await fs.mkdir(tmpDir, { recursive: true });
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

function expectNoUnpairedSurrogates(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      expect(index + 1).toBeLessThan(value.length);
      const next = value.charCodeAt(index + 1);
      expect(next).toBeGreaterThanOrEqual(0xdc00);
      expect(next).toBeLessThanOrEqual(0xdfff);
      index += 1;
      continue;
    }
    expect(code < 0xdc00 || code > 0xdfff).toBe(true);
  }
}

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

  it("strips inbound metadata envelope from user messages before normalization", async () => {
    // Representative inbound envelope: Conversation info + Sender blocks prepended
    // to the actual user text. Without stripping, the JSON envelope dominates
    // the corpus entry and the user's real words get truncated by the
    // SESSION_INGESTION_MAX_SNIPPET_CHARS cap downstream.
    // See: https://github.com/openclaw/openclaw/issues/63921
    const envelopedUserText = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id":"msg-100","chat_id":"-100123","sender":"Chris"}',
      "```",
      "",
      "Sender (untrusted metadata):",
      "```json",
      '{"label":"Chris","name":"Chris","id":"42"}',
      "```",
      "",
      "帮我看看今天的 Oura 数据",
    ].join("\n");

    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: envelopedUserText },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "好的,我来查一下" },
      }),
    ];
    const filePath = path.join(tmpDir, "enveloped-session.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    const contentLines = entry!.content.split("\n");
    expect(contentLines).toHaveLength(2);
    // User line should contain ONLY the real user text, not the JSON envelope.
    expect(contentLines[0]).toBe("User: 帮我看看今天的 Oura 数据");
    expect(contentLines[0]).not.toContain("untrusted metadata");
    expect(contentLines[0]).not.toContain("message_id");
    expect(contentLines[0]).not.toContain("```json");
    expect(contentLines[1]).toBe("Assistant: 好的,我来查一下");
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
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("User: Actual user text");
  });

  it("wraps pathological long messages into multiple exported lines and repeats mappings", async () => {
    const longWordyLine = Array.from({ length: 260 }, (_, idx) => `segment-${idx}`).join(" ");
    const timestamp = Date.parse("2026-04-05T10:00:00.000Z");
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-05T10:00:00.000Z",
        message: { role: "user", content: longWordyLine },
      }),
    ];
    const filePath = path.join(tmpDir, "wrapped-session.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    const contentLines = entry!.content.split("\n");
    expect(contentLines.length).toBeGreaterThan(1);
    expect(contentLines.every((line) => line.startsWith("User: "))).toBe(true);
    expect(contentLines.every((line) => line.length <= 810)).toBe(true);
    expect(entry!.lineMap).toEqual(contentLines.map(() => 1));
    expect(entry!.messageTimestampsMs).toEqual(contentLines.map(() => timestamp));
  });

  it("hard-wraps pathological long tokens without spaces", async () => {
    const giantToken = "x".repeat(1800);
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: giantToken },
      }),
    ];
    const filePath = path.join(tmpDir, "hard-wrapped-session.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    const contentLines = entry!.content.split("\n");
    expect(contentLines.length).toBe(3);
    expect(contentLines.every((line) => line.startsWith("Assistant: "))).toBe(true);
    expect(contentLines[0].length).toBeLessThanOrEqual(811);
    expect(contentLines[1].length).toBeLessThanOrEqual(811);
    expect(entry!.lineMap).toEqual([1, 1, 1]);
    expect(entry!.messageTimestampsMs).toEqual([0, 0, 0]);
  });

  it("does not split surrogate pairs when hard-wrapping astral unicode without spaces", async () => {
    const astralChar = "\u{20000}";
    const giantToken = astralChar.repeat(1200);
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: giantToken },
      }),
    ];
    const filePath = path.join(tmpDir, "surrogate-safe-session.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    const contentLines = entry!.content.split("\n");
    expect(contentLines.length).toBeGreaterThan(1);
    expect(entry!.lineMap).toEqual(contentLines.map(() => 1));
    expect(entry!.messageTimestampsMs).toEqual(contentLines.map(() => 0));
    for (const line of contentLines) {
      expect(line.startsWith("Assistant: ")).toBe(true);
      expectNoUnpairedSurrogates(line);
    }
  });

  it("preserves assistant messages that happen to contain sentinel-like text", async () => {
    // Assistant role must NOT be stripped — only user messages carry inbound
    // envelopes, and assistants may legitimately discuss metadata formats.
    const assistantText =
      "The envelope format uses 'Conversation info (untrusted metadata):' as a sentinel";
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: assistantText },
      }),
    ];
    const filePath = path.join(tmpDir, "assistant-sentinel.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe(`Assistant: ${assistantText}`);
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

  it("flags dreaming narrative transcripts from the sibling session store before bootstrap lands", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "dreaming-session.jsonl");
    await fs.writeFile(
      filePath,
      [
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
          message: {
            role: "assistant",
            content: "A drifting archive breathed in moonlight.",
          },
        }),
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:dreaming-narrative-light-1775894400455": {
          sessionId: "dreaming-session",
          sessionFile: filePath,
          updatedAt: Date.now(),
        },
      }),
      "utf-8",
    );

    const entry = await buildSessionEntry(filePath);

    expect(entry).not.toBeNull();
    expect(entry?.generatedByDreamingNarrative).toBe(true);
    expect(entry?.content).toBe("");
    expect(entry?.lineMap).toEqual([]);
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
