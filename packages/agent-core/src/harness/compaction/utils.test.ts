import type { Message } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../types.js";
import { estimateTokens } from "./compaction.js";
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
  it.each(["user", "toolResult"] as const)(
    "bounds omission markers per %s message without losing mixed text or leaking metadata",
    (role) => {
      const toolText = `${"progress ".repeat(400)}ERROR: terminal failure`;
      const content = [
        { type: "text", text: "start " },
        ...Array.from({ length: 1_000 }, () => ({
          type: "image",
          data: "IMAGE_PAYLOAD_SENTINEL",
          mimeType: "PRIVATE_MIME_SENTINEL",
          text: "IMAGE_TEXT_SENTINEL",
        })),
        ...Array.from({ length: 1_000 }, (_, i) => ({
          type: `other-media-${i}-${"x".repeat(1_000)}`,
          data: "OTHER_PAYLOAD_SENTINEL",
          text: "OTHER_TEXT_SENTINEL",
          content: "OTHER_CONTENT_SENTINEL",
          thinking: "PRIVATE_REASONING_SENTINEL",
        })),
        { type: "text", text: toolText },
      ];
      const serialized = serializeConversation([{ role, content }] as unknown as Message[]);
      const textOnly = serializeConversation([
        { role, content: content.filter((block) => block.type === "text") },
      ] as unknown as Message[]);
      const label = `[${role === "user" ? "User" : "Tool result"}]: `;
      const markers =
        "[image data omitted from summary input]\n" +
        "[non-text data omitted from summary input]\n";

      expect(serialized).toBe(`${label}${markers}${textOnly.slice(label.length)}`);
      expect(serialized.length - textOnly.length).toBe(83);
      expect(estimateTokens({ role, content } as unknown as AgentMessage)).toBe(
        1_000 * 2_000 + Math.ceil((`start ${toolText}`.length + 99) / 4),
      );
      expect(serialized).toContain("start ");
      expect(serialized).toContain("ERROR: terminal failure");
      expect(serialized).not.toMatch(/SENTINEL|other-media-/);
    },
  );

  it.each(["user", "toolResult"] as const)(
    "keeps non-text-only %s messages distinct from empty messages",
    (role) => {
      const message = {
        role,
        content: [{ type: "audio", data: "AUDIO_PAYLOAD_SENTINEL" }],
      } as unknown as Message;
      const empty = { role, content: [{ type: "text", text: "" }] } as Message;
      const expected = `[${role === "user" ? "User" : "Tool result"}]: [non-text data omitted from summary input]`;

      expect(serializeConversation([empty, message, empty, message])).toBe(
        `${expected}\n\n${expected}`,
      );
    },
  );

  it.each(["user", "toolResult"] as const)(
    "caps omission additions across %s messages, including empty-message wrappers",
    (role) => {
      const baseline: Message = { role: "user", content: "existing text", timestamp: 0 };
      const aggregate = "[More image/non-text data omitted from summary input]";
      for (const categories of [["image"], ["audio"], ["image", "audio"]]) {
        for (const caption of ["", "caption 🚀"]) {
          for (const count of [200, 8, 9, 10_000]) {
            const messages = Array.from({ length: count }, () => ({
              role,
              content: [
                { type: "text", text: caption },
                ...categories.map((type) => ({ type, data: "PAYLOAD_SENTINEL" })),
              ],
            })) as unknown as Message[];
            const textOnly = messages.map(() => ({ role, content: caption })) as Message[];
            const serialized = serializeConversation([baseline, ...messages, baseline]);
            const control = serializeConversation([baseline, ...textOnly, baseline]);
            const addedBytes = Buffer.byteLength(serialized) - Buffer.byteLength(control);
            expect(addedBytes).toBeLessThanOrEqual(847);
            const estimatedTokens = messages.reduce(
              (total, message) => total + estimateTokens(message),
              0,
            );
            expect(estimatedTokens).toBeGreaterThanOrEqual(Math.ceil(addedBytes / 4));
            if (role === "toolResult" && !caption && categories.length === 2 && count > 8) {
              expect(addedBytes).toBe(847);
            }
            expect(serialized.split(aggregate)).toHaveLength(count > 8 ? 2 : 1);
            expect(serialized.match(/\[(?:image|non-text) data omitted/g)).toHaveLength(
              Math.min(count, 8) * categories.length,
            );
            expect(serialized.match(/caption 🚀/g)?.length ?? 0).toBe(caption ? count : 0);
            expect(serialized).toContain("[User]: existing text");
            expect(serialized).not.toContain("PAYLOAD_SENTINEL");
          }
        }
      }
      const images = Array.from({ length: 8 }, () => ({
        role,
        content: [{ type: "image", data: "PAYLOAD_SENTINEL" }],
      }));
      const lateOther = { role, content: [{ type: "audio", data: "LATE_PAYLOAD_SENTINEL" }] };
      const serialized = serializeConversation([...images, lateOther] as unknown as Message[]);
      expect(serialized).toContain(aggregate);
      expect(serialized).not.toContain("SENTINEL");
    },
  );

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
