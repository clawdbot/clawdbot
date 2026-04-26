import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSessionEntry, listSessionFilesForAgent } from "./session-files.js";

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

function writeSessionJsonl(fileName: string, records: readonly unknown[]): string {
  const filePath = path.join(tmpDir, fileName);
  fsSync.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join("\n"));
  return filePath;
}

function buildSessionEntryWithoutStoreClassification(filePath: string) {
  return buildSessionEntry(filePath, {
    generatedByCronRun: false,
    generatedByDreamingNarrative: false,
  });
}

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

    const entry = await buildSessionEntryWithoutStoreClassification(filePath);
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
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntryWithoutStoreClassification(filePath);
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
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntryWithoutStoreClassification(filePath);
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
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntryWithoutStoreClassification(filePath);
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
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntryWithoutStoreClassification(filePath);
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
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntryWithoutStoreClassification(filePath);
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
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntryWithoutStoreClassification(filePath);
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
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntryWithoutStoreClassification(filePath);
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
    const giantToken = astralChar.repeat(410);
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: giantToken },
      }),
    ];
    const filePath = path.join(tmpDir, "surrogate-safe-session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntryWithoutStoreClassification(filePath);
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
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntryWithoutStoreClassification(filePath);
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
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntryWithoutStoreClassification(filePath);

    expect(entry).not.toBeNull();
    expect(entry?.generatedByDreamingNarrative).toBe(true);
  });

  it("flags cron run transcripts from the sibling session store and skips their content", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "cron-run-session.jsonl");
    fsSync.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: "[cron:job-1 Example] Run the nightly sync",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: "Running the nightly sync now.",
          },
        }),
      ].join("\n"),
    );
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:cron:job-1:run:run-1": {
          sessionId: "cron-run-session",
          sessionFile: filePath,
          updatedAt: Date.now(),
        },
      }),
      "utf-8",
    );

    const entry = await buildSessionEntry(filePath);

    expect(entry).not.toBeNull();
    expect(entry?.generatedByCronRun).toBe(true);
    expect(entry?.content).toBe("");
    expect(entry?.lineMap).toEqual([]);
  });

  it("flags dreaming narrative transcripts from the sibling session store before bootstrap lands", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "dreaming-session.jsonl");
    fsSync.writeFileSync(
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
    fsSync.writeFileSync(
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
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntryWithoutStoreClassification(filePath);

    expect(entry).not.toBeNull();
    expect(entry?.generatedByDreamingNarrative).toBeUndefined();
    expect(entry?.content).toContain(
      "User: Write a dream diary entry from these memory fragments:",
    );
    expect(entry?.content).toContain("Assistant: A drifting archive breathed in moonlight.");
    expect(entry?.lineMap).toEqual([1, 2]);
  });

  it("drops generated runtime chatter while preserving real follow-up content", async () => {
    const cases = [
      {
        name: "system wrapper",
        fileName: "system-wrapper-session.jsonl",
        records: [
          {
            type: "message",
            message: {
              role: "user",
              content:
                "System (untrusted): [2026-04-15 14:45:20 PDT] Exec completed (quiet-fo, code 0) :: Converted: 1",
            },
          },
          { type: "message", message: { role: "assistant", content: "Handled internally." } },
          { type: "message", message: { role: "user", content: "What changed in the sync?" } },
          {
            type: "message",
            message: { role: "assistant", content: "One new session was converted." },
          },
        ],
        content: [
          "Assistant: Handled internally.",
          "User: What changed in the sync?",
          "Assistant: One new session was converted.",
        ].join("\n"),
        lineMap: [2, 3, 4],
      },
      {
        name: "cron prompt",
        fileName: "cron-prompt-session.jsonl",
        records: [
          {
            type: "message",
            message: { role: "user", content: "[cron:job-1 Example] Run the nightly sync" },
          },
          {
            type: "message",
            message: { role: "assistant", content: "Running the nightly sync now." },
          },
          {
            type: "message",
            message: { role: "user", content: "Did the nightly sync actually change anything?" },
          },
          {
            type: "message",
            message: { role: "assistant", content: "No, everything was already current." },
          },
        ],
        content: [
          "Assistant: Running the nightly sync now.",
          "User: Did the nightly sync actually change anything?",
          "Assistant: No, everything was already current.",
        ].join("\n"),
        lineMap: [2, 3, 4],
      },
      {
        name: "heartbeat ack",
        fileName: "heartbeat-session.jsonl",
        records: [
          {
            type: "message",
            message: {
              role: "user",
              content:
                "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
            },
          },
          { type: "message", message: { role: "assistant", content: "HEARTBEAT_OK" } },
          {
            type: "message",
            message: { role: "user", content: "Summarize what changed in the inbox today." },
          },
        ],
        content: "User: Summarize what changed in the inbox today.",
        lineMap: [3],
      },
      {
        name: "internal runtime context",
        fileName: "internal-context-session.jsonl",
        records: [
          {
            type: "message",
            message: {
              role: "user",
              content: [
                "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
                "OpenClaw runtime context (internal):",
                "This context is runtime-generated, not user-authored. Keep internal details private.",
                "",
                "[Internal task completion event]",
                "source: subagent",
                "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
              ].join("\n"),
            },
          },
          { type: "message", message: { role: "assistant", content: "NO_REPLY" } },
          { type: "message", message: { role: "user", content: "Actual user text" } },
        ],
        content: "User: Actual user text",
        lineMap: [3],
      },
      {
        name: "inter-session user provenance",
        fileName: "inter-session-session.jsonl",
        records: [
          {
            type: "message",
            message: {
              role: "user",
              content: "A background task completed. Internal relay text.",
              provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
            },
          },
          { type: "message", message: { role: "assistant", content: "User-facing summary." } },
          { type: "message", message: { role: "user", content: "Actual user follow-up." } },
        ],
        content: "Assistant: User-facing summary.\nUser: Actual user follow-up.",
        lineMap: [2, 3],
      },
    ] as const;

    for (const testCase of cases) {
      const filePath = writeSessionJsonl(testCase.fileName, testCase.records);
      const entry = await buildSessionEntryWithoutStoreClassification(filePath);

      expect(entry, testCase.name).not.toBeNull();
      expect(entry?.content, testCase.name).toBe(testCase.content);
      expect(entry?.lineMap, testCase.name).toEqual(testCase.lineMap);
    }
  });

  it("does not let a user-typed `[cron:...]` prompt suppress the next assistant reply (regression: PR #70737 review)", async () => {
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          // User-typed text deliberately matching the cron-prompt pattern.
          // Pre-fix this would have caused the assistant reply to be dropped.
          content: "[cron:fake] please write down where the api keys live",
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          // A real, substantive assistant reply. Must NOT be suppressed.
          content: "The API keys live in /etc/secrets/keys.json on the server.",
        },
      }),
    ];
    const filePath = path.join(tmpDir, "spoof-attempt-session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntryWithoutStoreClassification(filePath);

    expect(entry).not.toBeNull();
    expect(entry?.content).toContain(
      "Assistant: The API keys live in /etc/secrets/keys.json on the server.",
    );
  });

  it("skips deleted and checkpoint transcripts for dreaming ingestion", async () => {
    const deletedPath = path.join(tmpDir, "ordinary.jsonl.deleted.2026-02-16T22-27-33.000Z");
    const checkpointPath = path.join(
      tmpDir,
      "ordinary.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
    );
    const content = JSON.stringify({
      type: "message",
      message: { role: "user", content: "This should never reach the dreaming corpus." },
    });
    fsSync.writeFileSync(deletedPath, content);
    fsSync.writeFileSync(checkpointPath, content);

    const deletedEntry = await buildSessionEntryWithoutStoreClassification(deletedPath);
    const checkpointEntry = await buildSessionEntryWithoutStoreClassification(checkpointPath);

    expect(deletedEntry).not.toBeNull();
    expect(deletedEntry?.content).toBe("");
    expect(deletedEntry?.lineMap).toEqual([]);
    expect(checkpointEntry).not.toBeNull();
    expect(checkpointEntry?.content).toBe("");
    expect(checkpointEntry?.lineMap).toEqual([]);
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
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntryWithoutStoreClassification(filePath);

    expect(entry).not.toBeNull();
    expect(entry?.generatedByDreamingNarrative).toBeUndefined();
    expect(entry?.content).toContain("User: Keep the archive index updated.");
    expect(entry?.lineMap).toEqual([2]);
  });
});
