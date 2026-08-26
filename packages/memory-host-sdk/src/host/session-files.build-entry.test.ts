import fsSync from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { markInboundContextLabel } from "../../../../src/auto-reply/reply/inbound-context-marker.js";
import { encodeSessionArchiveContent } from "../../../../src/config/sessions/archive-compression.js";
import { buildSessionEntry } from "./session-files.js";
import { registerSessionFilesFixture, requireSessionEntry } from "./session-files.test-support.js";

const fixture = registerSessionFilesFixture();

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
    const filePath = path.join(fixture.tmpDir, "session.jsonl");
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
    const filePath = path.join(fixture.tmpDir, "empty-session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(filePath));
    expect(entry.content).toBe("");
    expect(entry.lineMap).toStrictEqual([]);
  });

  it("indexes usage-counted reset/deleted archives but still skips bak and checkpoint artifacts", async () => {
    const resetPath = path.join(fixture.tmpDir, "ordinary.jsonl.reset.2026-02-16T22-26-33.000Z");
    const deletedPath = path.join(
      fixture.tmpDir,
      "ordinary.jsonl.deleted.2026-02-16T22-27-33.000Z",
    );
    const bakPath = path.join(fixture.tmpDir, "ordinary.jsonl.bak.2026-02-16T22-28-33.000Z");
    const checkpointPath = path.join(
      fixture.tmpDir,
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

  it("indexes compressed session archives through their materialized content", async () => {
    const content = JSON.stringify({
      type: "message",
      message: { role: "user", content: "Compressed archive memory" },
    });
    const encoded = encodeSessionArchiveContent(content);
    const archivePath = path.join(
      fixture.tmpDir,
      `compressed.jsonl.deleted.2026-07-11T00-00-00.000Z${encoded.suffix}`,
    );
    fsSync.writeFileSync(archivePath, encoded.bytes);

    const entry = requireSessionEntry(await buildSessionEntry(archivePath));

    expect(entry.content).toBe("User: Compressed archive memory");
    expect(entry.lineMap).toStrictEqual([1]);
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
      const archivePath = path.join(
        fixture.tmpDir,
        "ordinary.jsonl.deleted.2026-02-16T22-27-33.000Z",
      );
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
    const archivePath = path.join(fixture.tmpDir, "cron-run.jsonl.reset.2026-02-16T22-26-33.000Z");
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
    const filePath = path.join(fixture.tmpDir, "gaps.jsonl");
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
            { type: "text", text: markInboundContextLabel("Conversation info:") },
            { type: "text", text: "```json" },
            { type: "text", text: '{"message_id":"msg-100","chat_id":"-100123"}' },
            { type: "text", text: "```" },
            { type: "text", text: "" },
            { type: "text", text: markInboundContextLabel("Sender:") },
            { type: "text", text: "```json" },
            { type: "text", text: '{"label":"Chris","id":"42"}' },
            { type: "text", text: "```" },
            { type: "text", text: "" },
            { type: "text", text: "Actual user text" },
          ],
        },
      }),
    ];
    const filePath = path.join(fixture.tmpDir, "enveloped-session-array.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(filePath));
    expect(entry.content).toBe("User: Actual user text");
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
    const filePath = path.join(fixture.tmpDir, "invalid-timestamp-session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(filePath));
    expect(entry.messageTimestampsMs).toStrictEqual([0]);
  });
});
