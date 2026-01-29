import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _testExports } from "./chat.js";

const { findTranscriptLeafId, appendAssistantTranscriptMessage } = _testExports;

describe("appendAssistantTranscriptMessage parentId chain", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("sets parentId to previous message id when appending second message", () => {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    const sessionId = "test-session";

    // Append first message
    const result1 = appendAssistantTranscriptMessage({
      message: "First message",
      sessionId,
      storePath: undefined,
      sessionFile: transcriptPath,
      createIfMissing: true,
    });
    expect(result1.ok).toBe(true);
    if (!result1.ok) throw new Error("First append failed");

    const firstMessageId = result1.messageId;

    // Append second message
    const result2 = appendAssistantTranscriptMessage({
      message: "Second message",
      sessionId,
      storePath: undefined,
      sessionFile: transcriptPath,
    });
    expect(result2.ok).toBe(true);

    // Read and parse the transcript
    const lines = fs
      .readFileSync(transcriptPath, "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l.trim());

    // Should have: header, first message, second message
    expect(lines.length).toBe(3);

    const secondMessageEntry = JSON.parse(lines[2]);
    expect(secondMessageEntry.type).toBe("message");

    // THE KEY ASSERTION: second message's parentId should be first message's id
    // This fails on upstream main (parentId would be undefined/null)
    // This passes on fix branch (parentId equals firstMessageId)
    expect(secondMessageEntry.parentId).toBe(firstMessageId);
  });
});

describe("findTranscriptLeafId", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null for non-existent file", () => {
    const result = findTranscriptLeafId(path.join(tempDir, "missing.jsonl"));
    expect(result).toBeNull();
  });

  it("returns null for file with only header", () => {
    const transcriptPath = path.join(tempDir, "header-only.jsonl");
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "session", id: "test", version: 1 }) + "\n",
    );
    const result = findTranscriptLeafId(transcriptPath);
    expect(result).toBeNull();
  });

  it("returns last message id", () => {
    const transcriptPath = path.join(tempDir, "with-messages.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "test", version: 1 }),
      JSON.stringify({ type: "message", id: "msg-001", message: {} }),
      JSON.stringify({ type: "message", id: "msg-002", message: {} }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n") + "\n");

    const result = findTranscriptLeafId(transcriptPath);
    expect(result).toBe("msg-002");
  });
});
