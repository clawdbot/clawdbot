import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { hardenManualCompactionBoundary } from "./manual-compaction-boundary.js";

let tmpDir = "";

async function makeTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "manual-compaction-boundary-"));
  return tmpDir;
}

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    tmpDir = "";
  }
});

function createAssistantTextMessage(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "responses",
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp,
  };
}

function messageText(message: AgentMessage): string {
  if (!("content" in message)) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) =>
      block && typeof block === "object" && "text" in block && typeof block.text === "string"
        ? block.text
        : "",
    )
    .filter(Boolean)
    .join(" ");
}

describe("hardenManualCompactionBoundary", () => {
  it("turns manual compaction into a true checkpoint for rebuilt context", async () => {
    const dir = await makeTmpDir();
    const session = SessionManager.create(dir, dir);

    session.appendMessage({ role: "user", content: "old question", timestamp: 1 });
    session.appendMessage(createAssistantTextMessage("very long old answer", 2));
    const firstKeepId = session.getBranch().at(-1)?.id;
    expect(firstKeepId).toBeTruthy();
    session.appendCompaction("old summary", firstKeepId!, 100);

    session.appendMessage({ role: "user", content: "new question", timestamp: 3 });
    session.appendMessage(
      createAssistantTextMessage("detailed new answer that should be summarized away", 4),
    );
    const secondKeepId = session.getBranch().at(-1)?.id;
    expect(secondKeepId).toBeTruthy();
    const latestCompactionId = session.appendCompaction("fresh summary", secondKeepId!, 200);
    const sessionFile = session.getSessionFile();
    expect(sessionFile).toBeTruthy();

    const before = SessionManager.open(sessionFile!);
    const beforeTexts = before
      .buildSessionContext()
      .messages.map((message) => messageText(message));
    expect(beforeTexts.join("\n")).toContain("detailed new answer");

    const hardened = await hardenManualCompactionBoundary({ sessionFile: sessionFile! });
    expect(hardened.applied).toBe(true);
    expect(hardened.firstKeptEntryId).toBe(latestCompactionId);
    expect(hardened.messages.map((message) => message.role)).toEqual(["compactionSummary"]);

    const reopened = SessionManager.open(sessionFile!);
    const latest = reopened.getLeafEntry();
    expect(latest?.type).toBe("compaction");
    if (!latest || latest.type !== "compaction") {
      throw new Error("expected latest leaf to be a compaction entry");
    }
    expect(latest.firstKeptEntryId).toBe(latestCompactionId);

    reopened.appendMessage({ role: "user", content: "what was happening?", timestamp: 5 });
    const after = SessionManager.open(sessionFile!);
    const afterTexts = after.buildSessionContext().messages.map((message) => messageText(message));
    expect(after.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
    ]);
    expect(afterTexts.join("\n")).not.toContain("detailed new answer");
  });

  it("keeps the upstream recent tail when requested", async () => {
    const dir = await makeTmpDir();
    const session = SessionManager.create(dir, dir);

    session.appendMessage({ role: "user", content: "old question", timestamp: 1 });
    session.appendMessage(createAssistantTextMessage("old answer", 2));
    const keepId = session.getBranch().at(-1)?.id;
    expect(keepId).toBeTruthy();
    const latestCompactionId = session.appendCompaction("fresh summary", keepId!, 200);
    const sessionFile = session.getSessionFile();
    expect(sessionFile).toBeTruthy();

    const hardened = await hardenManualCompactionBoundary({
      sessionFile: sessionFile!,
      preserveRecentTail: true,
    });
    expect(hardened.applied).toBe(false);
    expect(hardened.firstKeptEntryId).toBe(keepId);

    const reopened = SessionManager.open(sessionFile!);
    const latest = reopened.getLeafEntry();
    expect(latest?.type).toBe("compaction");
    if (!latest || latest.type !== "compaction") {
      throw new Error("expected latest leaf to be a compaction entry");
    }
    expect(latest.id).toBe(latestCompactionId);
    expect(latest.firstKeptEntryId).toBe(keepId);
    expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "assistant",
    ]);
  });

  it("is a no-op when the latest leaf is not a compaction entry", async () => {
    const dir = await makeTmpDir();
    const session = SessionManager.create(dir, dir);
    session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    session.appendMessage(createAssistantTextMessage("hi", 2));
    const sessionFile = session.getSessionFile();
    expect(sessionFile).toBeTruthy();

    const result = await hardenManualCompactionBoundary({ sessionFile: sessionFile! });
    expect(result.applied).toBe(false);
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});
