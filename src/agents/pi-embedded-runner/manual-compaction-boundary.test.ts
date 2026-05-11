import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  const textBlocks: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
      textBlocks.push(block.text);
    }
  }
  return textBlocks.join(" ");
}

function requireString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

describe("hardenManualCompactionBoundary", () => {
  it("turns manual compaction into a true checkpoint for rebuilt context", async () => {
    const dir = await makeTmpDir();
    const session = SessionManager.create(dir, dir);

    session.appendMessage({ role: "user", content: "old question", timestamp: 1 });
    session.appendMessage(createAssistantTextMessage("very long old answer", 2));
    const firstKeepId = requireString(session.getBranch().at(-1)?.id, "first keep id");
    session.appendCompaction("old summary", firstKeepId, 100);

    session.appendMessage({ role: "user", content: "new question", timestamp: 3 });
    session.appendMessage(
      createAssistantTextMessage("detailed new answer that should be summarized away", 4),
    );
    const secondKeepId = requireString(session.getBranch().at(-1)?.id, "second keep id");
    const latestCompactionId = session.appendCompaction("fresh summary", secondKeepId, 200);
    const sessionFile = requireString(session.getSessionFile(), "session file");

    const before = SessionManager.open(sessionFile);
    const beforeTexts = before
      .buildSessionContext()
      .messages.map((message) => messageText(message));
    expect(beforeTexts.join("\n")).toContain("detailed new answer");

    const openSpy = vi.spyOn(SessionManager, "open").mockImplementation(() => {
      throw new Error("SessionManager.open should not be used for boundary hardening");
    });
    const hardened = await hardenManualCompactionBoundary({ sessionFile });
    openSpy.mockRestore();
    expect(hardened.applied).toBe(true);
    expect(hardened.firstKeptEntryId).toBe(latestCompactionId);
    expect(hardened.messages.map((message) => message.role)).toEqual(["compactionSummary"]);

    const reopened = SessionManager.open(sessionFile);
    const latest = reopened.getLeafEntry();
    expect(latest?.type).toBe("compaction");
    if (!latest || latest.type !== "compaction") {
      throw new Error("expected latest leaf to be a compaction entry");
    }
    expect(latest.firstKeptEntryId).toBe(latestCompactionId);

    reopened.appendMessage({ role: "user", content: "what was happening?", timestamp: 5 });
    const after = SessionManager.open(sessionFile);
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
    const keepId = requireString(session.getBranch().at(-1)?.id, "keep id");
    const latestCompactionId = session.appendCompaction("fresh summary", keepId, 200);
    const sessionFile = requireString(session.getSessionFile(), "session file");

    const hardened = await hardenManualCompactionBoundary({
      sessionFile,
      preserveRecentTail: true,
    });
    expect(hardened.applied).toBe(false);
    expect(hardened.firstKeptEntryId).toBe(keepId);

    const reopened = SessionManager.open(sessionFile);
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

  it("keeps the recent tail when manual compaction produced an empty summary", async () => {
    const dir = await makeTmpDir();
    const session = SessionManager.create(dir, dir);

    session.appendMessage({ role: "user", content: "old question", timestamp: 1 });
    session.appendMessage(createAssistantTextMessage("old answer", 2));
    session.appendMessage({ role: "user", content: "fresh question", timestamp: 3 });
    const keepId = requireString(session.getBranch().at(-1)?.id, "keep id");
    session.appendMessage(createAssistantTextMessage("fresh answer", 4));
    session.appendCompaction("", keepId, 200);
    const sessionFile = requireString(session.getSessionFile(), "session file");

    const hardened = await hardenManualCompactionBoundary({ sessionFile });
    expect(hardened.applied).toBe(false);
    expect(hardened.firstKeptEntryId).toBe(keepId);
    expect(hardened.messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
    ]);
    expect(hardened.messages.map((message) => messageText(message)).join("\n")).toContain(
      "fresh question",
    );

    const reopened = SessionManager.open(sessionFile);
    const latest = reopened.getLeafEntry();
    expect(latest?.type).toBe("compaction");
    if (!latest || latest.type !== "compaction") {
      throw new Error("expected latest leaf to be a compaction entry");
    }
    expect(latest.firstKeptEntryId).toBe(keepId);
  });

  it("keeps the recent tail when manual compaction had no messages to summarize", async () => {
    const dir = await makeTmpDir();
    const session = SessionManager.create(dir, dir);

    session.appendMessage({ role: "user", content: "fresh question", timestamp: 1 });
    const keepId = requireString(session.getBranch().at(-1)?.id, "keep id");
    session.appendMessage(createAssistantTextMessage("fresh answer", 2));
    session.appendCompaction("No prior history.", keepId, 200);
    const sessionFile = requireString(session.getSessionFile(), "session file");

    const hardened = await hardenManualCompactionBoundary({ sessionFile });
    expect(hardened.applied).toBe(false);
    expect(hardened.firstKeptEntryId).toBe(keepId);
    expect(hardened.messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
    ]);

    const reopened = SessionManager.open(sessionFile);
    const latest = reopened.getLeafEntry();
    expect(latest?.type).toBe("compaction");
    if (!latest || latest.type !== "compaction") {
      throw new Error("expected latest leaf to be a compaction entry");
    }
    expect(latest.firstKeptEntryId).toBe(keepId);
  });

  it("is a no-op when the latest leaf is not a compaction entry", async () => {
    const dir = await makeTmpDir();
    const session = SessionManager.create(dir, dir);
    session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    session.appendMessage(createAssistantTextMessage("hi", 2));
    const sessionFile = requireString(session.getSessionFile(), "session file");

    const result = await hardenManualCompactionBoundary({ sessionFile });
    expect(result.applied).toBe(false);
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});
