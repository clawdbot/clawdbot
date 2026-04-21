import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mirrorCodexAppServerTranscript } from "./transcript-mirror.js";

let tempDir: string;

function assistantMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.4-codex",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

describe("mirrorCodexAppServerTranscript", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-transcript-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("mirrors user and assistant messages into the PI transcript", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "agent:main:session-1",
      messages: [
        { role: "user", content: "hello", timestamp: 1 },
        assistantMessage("Codex plan:\ninspect", 2),
        assistantMessage("hi", 3),
      ],
    });

    const records = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; message?: { role?: string } });
    expect(records[0]?.type).toBe("session");
    expect(records.slice(1).map((record) => record.message?.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
  });

  it("deduplicates app-server turn mirrors by idempotency scope", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const messages = [
      { role: "user" as const, content: "hello", timestamp: 1 },
      assistantMessage("hi", 2),
    ];

    await mirrorCodexAppServerTranscript({
      sessionFile,
      messages,
      idempotencyScope: "codex-app-server:thread-1:turn-1",
    });
    await mirrorCodexAppServerTranscript({
      sessionFile,
      messages,
      idempotencyScope: "codex-app-server:thread-1:turn-1",
    });

    const records = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message?: { role?: string; idempotencyKey?: string } });
    expect(records.slice(1).map((record) => record.message?.role)).toEqual(["user", "assistant"]);
    expect(records.slice(1).map((record) => record.message?.idempotencyKey)).toEqual([
      "codex-app-server:thread-1:turn-1:user:0",
      "codex-app-server:thread-1:turn-1:assistant:1",
    ]);
  });
});
