import type { Message } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../types.js";
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  formatFileOperations,
  MAX_FILE_OPS_SECTION_CHARS,
  mergeSummaryFileOperations,
  serializeConversation,
} from "./utils.js";

describe("file operation provenance", () => {
  it.each([
    {
      name: "path aliases",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "read",
              arguments: { path: 42, file_path: "src/read.ts" },
            },
            {
              type: "toolCall",
              name: "write",
              arguments: { path: null, file_path: false, filePath: "src/write.ts" },
            },
            {
              type: "toolCall",
              name: "edit",
              arguments: { path: "src/edit.ts", file_path: "ignored.ts" },
            },
          ],
        },
      ],
      expected: {
        readFiles: ["src/read.ts"],
        modifiedFiles: ["src/edit.ts", "src/write.ts"],
      },
    },
    {
      name: "namespaced tool names",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", name: "mcp__files__READ", arguments: { path: "src/read.ts" } },
            { type: "toolCall", name: "files__edit", arguments: { path: "src/edit.ts" } },
          ],
        },
      ],
      expected: { readFiles: ["src/read.ts"], modifiedFiles: ["src/edit.ts"] },
    },
    {
      name: "apply_patch result summary",
      messages: [
        {
          role: "toolResult",
          toolName: "apply_patch",
          details: {
            summary: {
              added: ["src/added.ts"],
              modified: ["src/modified.ts"],
              deleted: ["src/deleted.ts"],
            },
          },
        },
        {
          role: "toolResult",
          toolName: "apply_patch",
          content: [
            {
              type: "toolResult",
              details: {
                summary: { added: [], modified: ["src/nested.ts"], deleted: [] },
              },
            },
          ],
        },
      ],
      expected: {
        readFiles: [],
        modifiedFiles: ["src/added.ts", "src/modified.ts", "src/nested.ts"],
      },
    },
    {
      name: "unknown tools",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", name: "plugin__inspect", arguments: { path: "ignored.ts" } },
          ],
        },
        {
          role: "toolResult",
          toolName: "unknown_patch",
          details: { summary: { added: ["also-ignored.ts"], modified: [], deleted: [] } },
        },
      ],
      expected: { readFiles: [], modifiedFiles: [] },
    },
  ])("extracts $name", ({ messages, expected }) => {
    const fileOps = createFileOps();
    for (const message of messages as unknown as AgentMessage[]) {
      extractFileOpsFromMessage(message, fileOps);
    }
    expect(computeFileLists(fileOps)).toEqual(expected);
  });

  it("merges file identity forward across two compactions", () => {
    const first = createFileOps();
    first.read.add("src/first-read.ts");
    first.written.add("src/first-write.ts");

    const second = createFileOps();
    mergeSummaryFileOperations(second, computeFileLists(first));
    second.edited.add("src/second-edit.ts");

    const third = createFileOps();
    mergeSummaryFileOperations(third, computeFileLists(second));

    expect(computeFileLists(third)).toEqual({
      readFiles: ["src/first-read.ts"],
      modifiedFiles: ["src/first-write.ts", "src/second-edit.ts"],
    });
  });
});

describe("serializeConversation", () => {
  it("omits provider thinking while preserving visible assistant state", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "PRIVATE_REASONING_SENTINEL" },
          { type: "text", text: "Visible answer" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
        ],
        api: "test-api",
        provider: "test-provider",
        model: "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
    ];

    expect(serializeConversation(messages)).toBe(
      '[Assistant]: Visible answer\n\n[Assistant tool calls]: read(path="src/index.ts")',
    );
  });

  it.each([
    {
      name: "Codex nested toolResult text",
      block: {
        type: "toolResult",
        id: "call-1",
        toolUseId: "call-1",
        content: "duplicate fallback",
        text: "codex nested output",
      },
      expected: "codex nested output",
    },
    {
      name: "snake-case nested tool_result content fallback",
      block: {
        type: "tool_result",
        content: "fallback output",
      },
      expected: "fallback output",
    },
  ])("serializes $name", ({ block, expected }) => {
    const messages = [
      {
        role: "toolResult",
        content: [block],
      },
    ] as unknown as Message[];

    expect(serializeConversation(messages)).toBe(`[Tool result]: ${expected}`);
  });

  it("keeps truncated tool results UTF-16 safe and reports the exact omitted count", () => {
    const prefix = "a".repeat(1_999);
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "toolResult", content: `${prefix}🚀tail` }],
      },
    ] as unknown as Message[];

    expect(serializeConversation(messages)).toBe(
      `[Tool result]: ${prefix}\n\n[... 6 more characters truncated]`,
    );
  });

  it("preserves terminal failures when truncating long tool results", () => {
    const output = `command started\n${"progress ".repeat(450)}\nFATAL: missing deployment token`;
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: output }],
      },
    ] as unknown as Message[];

    const serialized = serializeConversation(messages);

    expect(serialized).toContain("command started");
    expect(serialized).toContain("FATAL: missing deployment token");
    expect(serialized).toMatch(/\[\.\.\. \d+ more characters truncated\]/);
    expect(serialized.length).toBeLessThan(2100);
  });

  it("keeps both diagnostic truncation boundaries UTF-16 safe", () => {
    const output = `${"h".repeat(1399)}🚀${"m".repeat(1600)}🚀\nERROR: failed safely`;
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: output }],
      },
    ] as unknown as Message[];

    const serialized = serializeConversation(messages);

    expect(serialized).toContain("ERROR: failed safely");
    expect(serialized).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(serialized).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("retains earlier diagnostics when they are outside the preserved tail", () => {
    const output = `${"h".repeat(1500)}ERROR: earlier failure${"m".repeat(1500)}`;
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: output }],
      },
    ] as unknown as Message[];

    expect(serializeConversation(messages)).toContain("ERROR: earlier failure");
  });

  it.each(["done", "exit code 0", "1 failed"])(
    "does not let routine '%s' output evict an earlier failure",
    (footer) => {
      const output = `${"h".repeat(1500)}ERROR: deployment failed${"m".repeat(1500)}\n${footer}`;
      const messages = [
        {
          role: "toolResult",
          content: [{ type: "text", text: output }],
        },
      ] as unknown as Message[];

      expect(serializeConversation(messages)).toContain("ERROR: deployment failed");
    },
  );

  it("preserves a terminal failure when no earlier diagnostic would be displaced", () => {
    const output = `${"h".repeat(1500)}${"m".repeat(1500)}\nERROR: terminal failure`;
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: output }],
      },
    ] as unknown as Message[];

    expect(serializeConversation(messages)).toContain("ERROR: terminal failure");
  });

  it("retains terminal errors followed by more than 600 characters of stack frames", () => {
    const output = `${"progress ".repeat(300)}\nERROR: terminal failure\n${"  at applicationFrame()\n".repeat(45)}`;
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: output }],
      },
    ] as unknown as Message[];

    const serialized = serializeConversation(messages);

    expect(serialized).toContain("ERROR: terminal failure");
    expect(serialized).toContain("applicationFrame()");
    expect(serialized).toContain("middle/trailing characters truncated");
    expect(serialized.length).toBeLessThan(2100);
  });

  it("does not duplicate early errors into an overlapping diagnostic window", () => {
    const output = `${"h".repeat(600)}ERROR: early failure${"m".repeat(1900)}`;
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: output }],
      },
    ] as unknown as Message[];

    const serialized = serializeConversation(messages);

    expect(serialized.split("ERROR: early failure")).toHaveLength(2);
    expect(serialized).toContain(`[... ${output.length - 2000} more characters truncated]`);
  });
});

describe("formatFileOperations bounds", () => {
  it("caps ratcheting file lists with an overflow line instead of growing unbounded", () => {
    const files = Array.from({ length: 5_000 }, (_, i) => `src/deep/nested/path/file-${i}.ts`);

    const section = formatFileOperations(files, files);

    // File lists ratchet across compactions; the model-visible section must
    // stay bounded no matter how many paths accumulated.
    expect(section.length).toBeLessThanOrEqual(MAX_FILE_OPS_SECTION_CHARS);
    expect(section).toContain("more");
  });

  it("emits full lists untouched when they fit the budget", () => {
    const section = formatFileOperations(["a.ts"], ["b.ts"]);
    expect(section).toBe(
      "\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>",
    );
  });
});
