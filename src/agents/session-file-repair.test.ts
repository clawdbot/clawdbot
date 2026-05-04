import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BLANK_USER_FALLBACK_TEXT, repairSessionFileIfNeeded } from "./session-file-repair.js";

function buildSessionHeaderAndMessage() {
  const header = {
    type: "session",
    version: 7,
    id: "session-1",
    timestamp: new Date().toISOString(),
    cwd: "/tmp",
  };
  const message = {
    type: "message",
    id: "msg-1",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "hello" },
  };
  return { header, message };
}

const tempDirs: string[] = [];

async function createTempSessionPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-repair-"));
  tempDirs.push(dir);
  return { dir, file: path.join(dir, "session.jsonl") };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("repairSessionFileIfNeeded", () => {
  it("rewrites session files that contain malformed lines", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();

    const content = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n{"type":"message"`;
    await fs.writeFile(file, content, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });
    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(1);
    expect(result.backupPath).toBeTruthy();

    const repaired = await fs.readFile(file, "utf-8");
    expect(repaired.trim().split("\n")).toHaveLength(2);

    if (result.backupPath) {
      const backup = await fs.readFile(result.backupPath, "utf-8");
      expect(backup).toBe(content);
    }
  });

  it("does not drop CRLF-terminated JSONL lines", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const content = `${JSON.stringify(header)}\r\n${JSON.stringify(message)}\r\n`;
    await fs.writeFile(file, content, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });
    expect(result.repaired).toBe(false);
    expect(result.droppedLines).toBe(0);
  });

  it("warns and skips repair when the session header is invalid", async () => {
    const { file } = await createTempSessionPath();
    const badHeader = {
      type: "message",
      id: "msg-1",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "hello" },
    };
    const content = `${JSON.stringify(badHeader)}\n{"type":"message"`;
    await fs.writeFile(file, content, "utf-8");

    const warn = vi.fn();
    const result = await repairSessionFileIfNeeded({ sessionFile: file, warn });

    expect(result.repaired).toBe(false);
    expect(result.reason).toBe("invalid session header");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("invalid session header");
  });

  it("returns a detailed reason when read errors are not ENOENT", async () => {
    const { dir } = await createTempSessionPath();
    const warn = vi.fn();

    const result = await repairSessionFileIfNeeded({ sessionFile: dir, warn });

    expect(result.repaired).toBe(false);
    expect(result.reason).toContain("failed to read session file");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rewrites persisted assistant messages with empty content arrays", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const poisonedAssistantEntry = {
      type: "message",
      id: "msg-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        model: "anthropic.claude-3-haiku-20240307-v1:0",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "error",
        errorMessage: "transient stream failure",
      },
    };
    // Follow-up keeps this case focused on empty error-turn repair.
    const followUp = {
      type: "message",
      id: "msg-3",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "retry" },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(poisonedAssistantEntry)}\n${JSON.stringify(followUp)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const debug = vi.fn();
    const result = await repairSessionFileIfNeeded({ sessionFile: file, debug });

    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(0);
    expect(result.rewrittenAssistantMessages).toBe(1);
    expect(result.backupPath).toBeTruthy();
    expect(debug).toHaveBeenCalledTimes(1);
    const debugMessage = debug.mock.calls[0]?.[0] as string;
    expect(debugMessage).toContain("rewrote 1 assistant message(s)");
    expect(debugMessage).not.toContain("dropped");

    const repaired = await fs.readFile(file, "utf-8");
    const repairedLines = repaired.trim().split("\n");
    expect(repairedLines).toHaveLength(4);
    const repairedEntry: { message: { content: { type: string; text: string }[] } } = JSON.parse(
      repairedLines[2],
    );
    expect(repairedEntry.message.content).toEqual([
      { type: "text", text: "[assistant turn failed before producing content]" },
    ]);
  });

  it("rewrites blank-only user text messages to synthetic placeholder instead of dropping", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const blankUserEntry = {
      type: "message",
      id: "msg-blank",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: "" }],
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(blankUserEntry)}\n${JSON.stringify(message)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const debug = vi.fn();
    const result = await repairSessionFileIfNeeded({ sessionFile: file, debug });

    expect(result.repaired).toBe(true);
    expect(result.rewrittenUserMessages).toBe(1);
    expect(result.droppedBlankUserMessages).toBe(0);
    expect(debug.mock.calls[0]?.[0]).toContain("rewrote 1 user message(s)");

    const repaired = await fs.readFile(file, "utf-8");
    const repairedLines = repaired.trim().split("\n");
    expect(repairedLines).toHaveLength(3);
    const rewrittenEntry = JSON.parse(repairedLines[1]);
    expect(rewrittenEntry.id).toBe("msg-blank");
    expect(rewrittenEntry.message.content).toEqual([
      { type: "text", text: BLANK_USER_FALLBACK_TEXT },
    ]);
  });

  it("rewrites blank string-content user messages to placeholder", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const blankStringUserEntry = {
      type: "message",
      id: "msg-blank-str",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: "   ",
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(blankStringUserEntry)}\n${JSON.stringify(message)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(true);
    expect(result.rewrittenUserMessages).toBe(1);

    const repaired = await fs.readFile(file, "utf-8");
    const repairedLines = repaired.trim().split("\n");
    expect(repairedLines).toHaveLength(3);
    const rewrittenEntry = JSON.parse(repairedLines[1]);
    expect(rewrittenEntry.message.content).toBe(BLANK_USER_FALLBACK_TEXT);
  });

  it("removes blank user text blocks while preserving media blocks", async () => {
    const { file } = await createTempSessionPath();
    const { header } = buildSessionHeaderAndMessage();
    const mediaUserEntry = {
      type: "message",
      id: "msg-media",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [
          { type: "text", text: "   " },
          { type: "image", data: "AA==", mimeType: "image/png" },
        ],
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(mediaUserEntry)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(true);
    expect(result.rewrittenUserMessages).toBe(1);
    const repaired = await fs.readFile(file, "utf-8");
    const repairedEntry = JSON.parse(repaired.trim().split("\n")[1] ?? "{}");
    expect(repairedEntry.message.content).toEqual([
      { type: "image", data: "AA==", mimeType: "image/png" },
    ]);
  });

  it("reports both drops and rewrites in the debug message when both occur", async () => {
    const { file } = await createTempSessionPath();
    const { header } = buildSessionHeaderAndMessage();
    const poisonedAssistantEntry = {
      type: "message",
      id: "msg-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        model: "anthropic.claude-3-haiku-20240307-v1:0",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "error",
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(poisonedAssistantEntry)}\n{"type":"message"`;
    await fs.writeFile(file, original, "utf-8");

    const debug = vi.fn();
    const result = await repairSessionFileIfNeeded({ sessionFile: file, debug });

    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(1);
    expect(result.rewrittenAssistantMessages).toBe(1);
    const debugMessage = debug.mock.calls[0]?.[0] as string;
    expect(debugMessage).toContain("dropped 1 malformed line(s)");
    expect(debugMessage).toContain("rewrote 1 assistant message(s)");
  });

  it("does not rewrite silent-reply turns (stopReason=stop, content=[]) on disk", async () => {
    const { file } = await createTempSessionPath();
    const { header } = buildSessionHeaderAndMessage();
    const silentReplyEntry = {
      type: "message",
      id: "msg-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "ollama",
        model: "glm-5.1:cloud",
        usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100 },
        stopReason: "stop",
      },
    };
    // Follow-up keeps this case focused on silent-reply preservation.
    const followUp = {
      type: "message",
      id: "msg-3",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "follow up" },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(silentReplyEntry)}\n${JSON.stringify(followUp)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);
    expect(result.rewrittenAssistantMessages ?? 0).toBe(0);
    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(original);
  });

  it("preserves delivered trailing assistant messages in the session file", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const assistantEntry = {
      type: "message",
      id: "msg-asst",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "stale answer" }],
        stopReason: "stop",
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(assistantEntry)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);

    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(original);
  });

  it("preserves multiple consecutive delivered trailing assistant messages", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const assistantEntry1 = {
      type: "message",
      id: "msg-asst-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
        stopReason: "stop",
      },
    };
    const assistantEntry2 = {
      type: "message",
      id: "msg-asst-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
        stopReason: "stop",
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(assistantEntry1)}\n${JSON.stringify(assistantEntry2)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);

    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(original);
  });

  it("does not trim non-trailing assistant messages", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const assistantEntry = {
      type: "message",
      id: "msg-asst",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        stopReason: "stop",
      },
    };
    const userFollowUp = {
      type: "message",
      id: "msg-user-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "follow up" },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(assistantEntry)}\n${JSON.stringify(userFollowUp)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);
  });

  it("preserves trailing assistant messages that contain tool calls", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const toolCallAssistant = {
      type: "message",
      id: "msg-asst-tc",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check that." },
          { type: "toolCall", id: "call_1", name: "read", input: { path: "/tmp/test" } },
        ],
        stopReason: "toolUse",
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(toolCallAssistant)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);
    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(original);
  });

  it("preserves adjacent trailing tool-call and text assistant messages", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const toolCallAssistant = {
      type: "message",
      id: "msg-asst-tc",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolUse", id: "call_1", name: "read" }],
        stopReason: "toolUse",
      },
    };
    const plainAssistant = {
      type: "message",
      id: "msg-asst-plain",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "stale" }],
        stopReason: "stop",
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(toolCallAssistant)}\n${JSON.stringify(plainAssistant)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);

    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(original);
  });

  it("preserves final text assistant turn that follows a tool-call/tool-result pair", async () => {
    // Regression: a trailing assistant message with stopReason "stop" that follows a
    // tool-call turn and its matching tool-result must never be trimmed by the repair
    // pass. This is the exact sequence produced by any agent run that calls at least
    // one tool before returning a final text response, and it must survive intact so
    // subsequent user messages are parented to the correct leaf node.
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const toolCallAssistant = {
      type: "message",
      id: "msg-asst-tc",
      parentId: "msg-1",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "get_tasks", input: {} }],
        stopReason: "toolUse",
      },
    };
    const toolResult = {
      type: "message",
      id: "msg-tool-result",
      parentId: "msg-asst-tc",
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "get_tasks",
        content: [{ type: "text", text: "Task A, Task B" }],
        isError: false,
      },
    };
    const finalAssistant = {
      type: "message",
      id: "msg-asst-final",
      parentId: "msg-tool-result",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here are your tasks: Task A, Task B." }],
        stopReason: "stop",
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(toolCallAssistant)}\n${JSON.stringify(toolResult)}\n${JSON.stringify(finalAssistant)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);

    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(original);
  });

  it("preserves assistant-only session history after the header", async () => {
    const { file } = await createTempSessionPath();
    const { header } = buildSessionHeaderAndMessage();
    const assistantEntry = {
      type: "message",
      id: "msg-asst",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "orphan" }],
        stopReason: "stop",
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(assistantEntry)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);

    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(original);
  });

  it("is a no-op on a session that was already repaired", async () => {
    const { file } = await createTempSessionPath();
    const { header } = buildSessionHeaderAndMessage();
    const healedEntry = {
      type: "message",
      id: "msg-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[assistant turn failed before producing content]" }],
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        model: "anthropic.claude-3-haiku-20240307-v1:0",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "error",
      },
    };
    // Follow-up keeps this case focused on idempotent empty error-turn repair.
    const followUp = {
      type: "message",
      id: "msg-3",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "follow up" },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(healedEntry)}\n${JSON.stringify(followUp)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);
    expect(result.rewrittenAssistantMessages ?? 0).toBe(0);
    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(original);
  });
});
