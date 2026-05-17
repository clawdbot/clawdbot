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

async function expectNoRetainedBackup(
  file: string,
  result: { backupPath?: string },
): Promise<void> {
  expect(result.backupPath).toBeUndefined();
  const siblings = await fs.readdir(path.dirname(file));
  const leftover = siblings.filter((name) => name.includes(".bak-"));
  expect(leftover).toEqual([]);
}

function requireFirstLogMessage(log: ReturnType<typeof vi.fn>): string {
  const message = log.mock.calls[0]?.[0];
  if (typeof message !== "string") {
    throw new Error("expected first log message");
  }
  return message;
}

afterEach(async () => {
  vi.restoreAllMocks();
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

    const repaired = await fs.readFile(file, "utf-8");
    const repairedLines = repaired
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(repairedLines).toEqual([header, message]);

    await expectNoRetainedBackup(file, result);
  });

  it("does not accumulate backups across repeated repairs of a persistently corrupted file", async () => {
    // Regression for #80960: a stuck session with a writer that keeps
    // appending a malformed line caused every repair invocation to leave a
    // ~1.8 MB `.bak-<pid>-<ts>` snapshot, accumulating 2,180 files / 2.1 GB
    // on a single agent over ~25 hours.
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const malformedTail = '{"type":"message"';

    for (let i = 0; i < 5; i++) {
      const content = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${malformedTail}`;
      await fs.writeFile(file, content, "utf-8");
      const result = await repairSessionFileIfNeeded({ sessionFile: file });
      expect(result.repaired).toBe(true);
      expect(result.droppedLines).toBe(1);
      await expectNoRetainedBackup(file, result);
    }
  });

  it("reports retained backup path when successful repair backup cleanup fails", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const content = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n{"type":"message"`;
    await fs.writeFile(file, content, "utf-8");
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("simulated cleanup failure"));

    const debug = vi.fn();
    const result = await repairSessionFileIfNeeded({ sessionFile: file, debug });

    expect(result.repaired).toBe(true);
    expect(result.backupPath).toMatch(/session\.jsonl\.bak-/);
    expect(debug.mock.calls.some(([message]) => String(message).includes("cleanup failed"))).toBe(
      true,
    );
    const siblings = await fs.readdir(path.dirname(file));
    expect(siblings.filter((name) => name.includes(".bak-"))).toHaveLength(1);
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
    expect(requireFirstLogMessage(warn)).toContain("invalid session header");
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
    await expectNoRetainedBackup(file, result);
    expect(debug).toHaveBeenCalledTimes(1);
    const debugMessage = requireFirstLogMessage(debug);
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
    expect(requireFirstLogMessage(debug)).toContain("rewrote 1 user message(s)");

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
    const debugMessage = requireFirstLogMessage(debug);
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

  it("inserts missing code-mode tool results before replay repair has to synthesize them", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const toolCallAssistant = {
      type: "message",
      id: "msg-asst-process",
      parentId: "msg-1",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-5.5",
        api: "openai-codex-responses",
        content: [
          { type: "text", text: "Process List" },
          {
            type: "toolCall",
            id: "call_process|fc_1",
            name: "process",
            arguments: { action: "poll", sessionId: "wild-wharf", timeout: 30_000 },
          },
        ],
        stopReason: "toolUse",
      },
    };
    const deliveryMirror = {
      type: "message",
      id: "msg-delivery",
      parentId: "msg-asst-process",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        api: "openai-responses",
        content: [{ type: "text", text: "Process: `wild-wharf`" }],
        stopReason: "stop",
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(toolCallAssistant)}\n${JSON.stringify(deliveryMirror)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(true);
    expect(result.insertedToolResults).toBe(1);
    await expectNoRetainedBackup(file, result);

    const lines = (await fs.readFile(file, "utf-8")).trimEnd().split("\n");
    expect(lines).toHaveLength(5);
    const inserted = JSON.parse(lines[3]);
    expect(inserted.type).toBe("message");
    expect(inserted.parentId).toBe("msg-asst-process");
    expect(inserted.message.role).toBe("toolResult");
    expect(inserted.message.toolCallId).toBe("call_process|fc_1");
    expect(inserted.message.toolName).toBe("process");
    expect(inserted.message.isError).toBe(true);
    expect(inserted.message.content[0].text).toBe("aborted");
    expect(JSON.parse(lines[4])).toEqual(deliveryMirror);
  });

  it("does not duplicate code-mode tool results that are already persisted", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const toolCallAssistant = {
      type: "message",
      id: "msg-asst-exec",
      parentId: "msg-1",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-5.5",
        api: "openai-codex-responses",
        content: [{ type: "toolCall", id: "call_exec|fc_1", name: "exec", arguments: {} }],
        stopReason: "toolUse",
      },
    };
    const toolResult = {
      type: "message",
      id: "msg-tool-result",
      parentId: "msg-asst-exec",
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call_exec|fc_1",
        toolName: "exec",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(toolCallAssistant)}\n${JSON.stringify(toolResult)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);
    expect(result.insertedToolResults ?? 0).toBe(0);
    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(original);
  });

  it.each(["error", "aborted"] as const)(
    "does not insert missing code-mode tool results for %s assistant turns",
    async (stopReason) => {
      const { file } = await createTempSessionPath();
      const { header, message } = buildSessionHeaderAndMessage();
      const incompleteAssistant = {
        type: "message",
        id: `msg-asst-${stopReason}`,
        parentId: "msg-1",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5.5",
          api: "openai-codex-responses",
          content: [
            { type: "toolCall", id: `call_${stopReason}|fc_1`, name: "exec", arguments: {} },
          ],
          stopReason,
        },
      };
      const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(incompleteAssistant)}\n`;
      await fs.writeFile(file, original, "utf-8");

      const result = await repairSessionFileIfNeeded({ sessionFile: file });

      expect(result.repaired).toBe(false);
      expect(result.insertedToolResults ?? 0).toBe(0);
      const after = await fs.readFile(file, "utf-8");
      expect(after).toBe(original);
    },
  );

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

  it("drops type:message entries with null role instead of preserving them through repair (#77228)", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();

    const nullRoleEntry = {
      type: "message",
      id: "corrupt-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: null, content: "ignored" },
    };
    const missingRoleEntry = {
      type: "message",
      id: "corrupt-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { content: "no role at all" },
    };
    const emptyRoleEntry = {
      type: "message",
      id: "corrupt-3",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "   ", content: "blank role" },
    };

    const content = [
      JSON.stringify(header),
      JSON.stringify(message),
      JSON.stringify(nullRoleEntry),
      JSON.stringify(missingRoleEntry),
      JSON.stringify(emptyRoleEntry),
    ].join("\n");
    await fs.writeFile(file, `${content}\n`, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(3);
    await expectNoRetainedBackup(file, result);

    const after = await fs.readFile(file, "utf-8");
    const lines = after.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(header);
    expect(JSON.parse(lines[1])).toEqual(message);
    expect(after).not.toContain('"role":null');
  });

  it("drops a type:message entry whose message field is missing or non-object", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();

    const missingMessage = {
      type: "message",
      id: "corrupt-4",
      parentId: null,
      timestamp: new Date().toISOString(),
    };
    const stringMessage = {
      type: "message",
      id: "corrupt-5",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: "not an object",
    };

    const content = [
      JSON.stringify(header),
      JSON.stringify(message),
      JSON.stringify(missingMessage),
      JSON.stringify(stringMessage),
    ].join("\n");
    await fs.writeFile(file, `${content}\n`, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(2);

    const after = await fs.readFile(file, "utf-8");
    const lines = after.trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([header, message]);
  });

  it("preserves non-`message` envelope types (e.g. compactionSummary, custom) without role inspection", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();

    const summary = {
      type: "summary",
      id: "summary-1",
      timestamp: new Date().toISOString(),
      summary: "opaque summary blob",
    };
    const custom = {
      type: "custom",
      id: "custom-1",
      customType: "model-snapshot",
      timestamp: new Date().toISOString(),
      data: { provider: "openai", modelApi: "openai-responses", modelId: "gpt-5" },
    };

    const content = [
      JSON.stringify(header),
      JSON.stringify(message),
      JSON.stringify(summary),
      JSON.stringify(custom),
    ].join("\n");
    await fs.writeFile(file, `${content}\n`, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);
    expect(result.droppedLines).toBe(0);
    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(`${content}\n`);
  });
});
