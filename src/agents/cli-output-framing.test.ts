import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { describe, expect, it, vi } from "vitest";
import type { CliToolResultDelta, CliToolUseStartDelta } from "./cli-output-contracts.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

function joinJsonlFrames(...frames: unknown[]) {
  return frames
    .map((frame) => (typeof frame === "string" ? frame : JSON.stringify(frame)))
    .join("\n");
}

function claudeStreamEvent(event: Record<string, unknown>) {
  return { type: "stream_event", event };
}

function claudeBlockStart(contentBlock: Record<string, unknown>, index?: number) {
  return claudeStreamEvent({
    type: "content_block_start",
    ...(index === undefined ? {} : { index }),
    content_block: contentBlock,
  });
}

function claudeBlockStop(index?: number) {
  return claudeStreamEvent({
    type: "content_block_stop",
    ...(index === undefined ? {} : { index }),
  });
}

function claudeInputJsonDelta(partialJson: string, index?: number) {
  return claudeStreamEvent({
    type: "content_block_delta",
    ...(index === undefined ? {} : { index }),
    delta: { type: "input_json_delta", partial_json: partialJson },
  });
}

describe("createCliJsonlStreamingParser framing", () => {
  it("frames coalesced Claude image and PDF lines before omitting retained binary bytes", () => {
    const results: CliToolResultDelta[] = [];
    const pluginLines: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      parseJsonlEvent: (line) => {
        pluginLines.push(line);
        return null;
      },
      onAssistantDelta: () => {},
      onToolResult: (result) => results.push(result),
    });
    const base64 = "a".repeat(4_300_000);
    const rawLines: string[] = [];
    for (const [type, mediaType] of [
      ["image", "image/png"],
      ["document", "application/pdf"],
    ] as const) {
      rawLines.push(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: `read-${type}`,
                is_error: type === "document",
                content: [
                  { type: "text", text: `Read ${type}` },
                  {
                    type,
                    title: `${type} attachment`,
                    source: { type: "base64", media_type: mediaType, data: base64 },
                  },
                  {
                    type: "image",
                    source: { type: "url", url: "https://example.test/keep.png" },
                  },
                  {
                    type: "document",
                    source: { type: "text", media_type: "text/plain", data: "keep text" },
                  },
                ],
              },
            ],
          },
        }),
      );
    }
    const resultLine = JSON.stringify({ type: "result", result: "both attachments read" });
    parser.push(`${[...rawLines, resultLine].join("\n")}\n`);
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("both attachments read");
    expect(results).toHaveLength(2);
    expect(pluginLines).toEqual([...rawLines, resultLine]);
    for (const [index, type, mediaType] of [
      [0, "image", "image/png"],
      [1, "document", "application/pdf"],
    ] as const) {
      expect(results[index]).toEqual({
        toolCallId: `read-${type}`,
        name: "",
        isError: type === "document",
        result: [
          { type: "text", text: `Read ${type}` },
          {
            type,
            title: `${type} attachment`,
            source: { type: "base64", media_type: mediaType },
            omitted: true,
            bytes: 3_225_000,
          },
          { type: "image", source: { type: "url", url: "https://example.test/keep.png" } },
          {
            type: "document",
            source: { type: "text", media_type: "text/plain", data: "keep text" },
          },
        ],
      });
    }
  });

  it.each([
    { name: "echoed media bytes", padded: false },
    { name: "surrounding raw whitespace", padded: true },
  ])("counts $name claimed by Claude plugin parsers before dispatch", ({ padded }) => {
    const pluginLines: string[] = [];
    const assistantDeltas: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      parseJsonlEvent: (line) => {
        pluginLines.push(line);
        return { kind: "text", text: "claimed" };
      },
      onAssistantDelta: (delta) => assistantDeltas.push(delta.delta),
    });
    const semanticLine = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "claimed-image",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: padded ? "YQ==" : "a".repeat(4_300_000),
                },
              },
            ],
          },
        ],
      },
    });
    const rawLine = padded ? `${" ".repeat(4_300_000)}${semanticLine}` : semanticLine;

    parser.push(`${rawLine}\n${rawLine}\n`);

    expect(pluginLines).toEqual([semanticLine, semanticLine]);
    expect(assistantDeltas).toEqual(["claimed"]);
    expect(parser.getErrorText()).toContain("JSONL output exceeded");
  });

  it("counts actual blank Claude frames without invoking hooks or inventing a finish frame", () => {
    const parseJsonlEvent = vi.fn(() => null);
    const createParser = () =>
      createCliJsonlStreamingParser({
        backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
        providerId: "claude-cli",
        parseJsonlEvent,
        onAssistantDelta: () => {},
      });
    const completeParser = createParser();
    completeParser.push("\r\n".repeat(20_000));
    completeParser.finish();

    expect(completeParser.getErrorText()).toBeNull();
    expect(parseJsonlEvent).not.toHaveBeenCalled();

    const overflowParser = createParser();
    overflowParser.push("\n".repeat(20_001));

    expect(overflowParser.getErrorText()).toContain("exceeded 20000 lines");
    expect(parseJsonlEvent).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "whitespace-only records",
      createLine: () => " ".repeat(4_300_000),
    },
    {
      name: "padding around valid JSON",
      createLine: () => `${" ".repeat(4_300_000)}{}`,
    },
    {
      name: "formatting inside a compacted media record",
      createLine: () =>
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "padded-image",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: "YQ==" },
                  },
                ],
              },
            ],
          },
        }).replace('"message":', `"message":${" ".repeat(4_300_000)}`),
    },
  ])("charges $name against the Claude raw-output budget", ({ createLine }) => {
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
    });
    const line = createLine();

    parser.push(`${line}\n${line}\n`);

    expect(parser.getErrorText()).toContain("JSONL output exceeded 8388608 characters");
  });

  it("normalizes empty Claude image data without treating zero omitted bytes as unchanged", () => {
    const results: CliToolResultDelta[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
      onToolResult: (result) => results.push(result),
    });

    parser.push(
      `${JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "empty-image",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "" },
                },
              ],
            },
          ],
        },
      })}\n`,
    );

    expect(results[0]?.result).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png" },
        omitted: true,
        bytes: 0,
      },
    ]);
  });

  it("omits the echoed tool_use_result payload MCP image tools duplicate alongside the message copy", () => {
    const results: CliToolResultDelta[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
      onToolResult: (result) => results.push(result),
    });
    const data = "A".repeat(600_000);
    const screenshotLine = (index: number) =>
      `${JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: `screenshot-${index}`,
              content: [
                { type: "text", text: "Cursor Position: (1, 2)" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/jpeg", data },
                },
              ],
            },
          ],
        },
        // Claude echoes the same payload a second time outside the message.
        tool_use_result: [
          { type: "text", text: "Cursor Position: (1, 2)" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
        ],
      })}\n`;

    for (let index = 0; index < 20; index += 1) {
      parser.push(screenshotLine(index));
    }

    expect(parser.getErrorText()).toBeNull();
    expect(results).toHaveLength(20);
    expect(results[0]?.result).toEqual([
      { type: "text", text: "Cursor Position: (1, 2)" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg" },
        omitted: true,
        bytes: estimateBase64DecodedBytes(data),
      },
    ]);
  });

  it("omits the base64 file payload Claude echoes for built-in image reads", () => {
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
    });
    const base64 = "A".repeat(600_000);
    const readLine = (index: number) =>
      `${JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: `read-${index}`,
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: base64 },
                },
              ],
            },
          ],
        },
        tool_use_result: { type: "image", file: { base64, type: "image/png", originalSize: 1 } },
      })}\n`;

    for (let index = 0; index < 20; index += 1) {
      parser.push(readLine(index));
    }

    expect(parser.getErrorText()).toBeNull();
  });

  it.each([
    {
      name: "image",
      field: "images",
      metadata: { mediaType: "image/png" },
    },
    {
      name: "document",
      field: "documents",
      metadata: {},
    },
  ] as const)(
    "omits Agent SDK REPL $name output from retained accounting",
    ({ field, metadata }) => {
      const parser = createCliJsonlStreamingParser({
        backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
        providerId: "claude-cli",
        onAssistantDelta: () => {},
      });
      const base64 = "A".repeat(600_000);
      const replLine = () =>
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: [] },
          tool_use_result: {
            code: "return await Read({ file_path });",
            result: {},
            stdout: "",
            stderr: "",
            [field]: [{ base64, ...metadata }],
          },
        })}\n`;

      for (let index = 0; index < 20; index += 1) {
        parser.push(replLine());
      }

      expect(parser.getErrorText()).toBeNull();
    },
  );

  it("normalizes a deeply nested record without exhausting the stack", () => {
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
    });
    // Built as text: JSON.stringify is itself recursive and cannot serialize this.
    const depth = 50_000;
    const payload = JSON.stringify({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
    const line = `{"type":"user","message":{"content":[]},"tool_use_result":${
      '{"nested":'.repeat(depth) + payload + "}".repeat(depth)
    }}`;

    expect(() => parser.push(`${line}\n`)).not.toThrow();
    expect(parser.getErrorText()).toBeNull();
  });

  it("still enforces raw Claude line and retained-text limits", () => {
    const createParser = () =>
      createCliJsonlStreamingParser({
        backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
        providerId: "claude-cli",
        onAssistantDelta: () => {},
      });
    const oversizedLineParser = createParser();
    oversizedLineParser.push(
      `${JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "oversized-image",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "a".repeat(8 * 1024 * 1024),
                  },
                },
              ],
            },
          ],
        },
      })}\n`,
    );
    expect(oversizedLineParser.getErrorText()).toContain("JSONL line exceeded");

    const growingPartialLineParser = createParser();
    growingPartialLineParser.push("a".repeat(4_300_000));
    expect(growingPartialLineParser.getErrorText()).toBeNull();
    growingPartialLineParser.push("a".repeat(4_300_000));
    expect(growingPartialLineParser.getErrorText()).toContain("JSONL line exceeded");

    const oversizedTextParser = createParser();
    for (const toolCallId of ["first", "second"]) {
      oversizedTextParser.push(
        `${JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: toolCallId,
                content: [{ type: "text", text: "a".repeat(4_300_000) }],
              },
            ],
          },
        })}\n`,
      );
    }
    expect(oversizedTextParser.getErrorText()).toContain("JSONL output exceeded");

    const excessiveLinesParser = createParser();
    excessiveLinesParser.push("{}\n".repeat(20_001));
    expect(excessiveLinesParser.getErrorText()).toContain("exceeded 20000 lines");
  });

  it.each([
    { providerId: "codex-cli", jsonlDialect: undefined },
    { providerId: "pi-cli", jsonlDialect: undefined },
    { providerId: "google-gemini-cli", jsonlDialect: "gemini-stream-json" as const },
  ])("preserves $providerId binary tool payloads byte-for-byte", ({ providerId, jsonlDialect }) => {
    const observedLines: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: providerId, output: "jsonl", ...(jsonlDialect ? { jsonlDialect } : {}) },
      providerId,
      parseJsonlEvent: (line) => {
        observedLines.push(line);
        return null;
      },
      onAssistantDelta: () => {},
    });
    const rawLine = JSON.stringify({
      type: "user",
      item: {
        type: "mcp_tool_call",
        result: { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
      },
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "keep-binary",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
              },
            ],
          },
        ],
      },
    });
    parser.push(`\n \t\r\n${rawLine}\n`);

    expect(observedLines).toEqual([rawLine]);
  });

  it.each([
    {
      name: "reassembles streamed tool args from input_json_delta chunks",
      frames: [
        claudeBlockStart({ type: "tool_use", id: "toolu_chunked", name: "Bash", input: {} }, 0),
        claudeInputJsonDelta('{"command":', 0),
        claudeInputJsonDelta(' "echo hi"}', 0),
        claudeBlockStop(0),
      ],
      expected: [
        {
          toolCallId: "toolu_chunked",
          name: "Bash",
          kind: "tool_use",
          args: { command: "echo hi" },
        },
      ],
    },
    {
      name: "emits empty args when streamed tool args are malformed",
      frames: [
        claudeBlockStart({ type: "tool_use", id: "toolu_bad", name: "Bash", input: {} }, 0),
        claudeInputJsonDelta('{"command": "ls', 0),
        claudeBlockStop(0),
      ],
      expected: [{ toolCallId: "toolu_bad", name: "Bash", kind: "tool_use", args: {} }],
    },
  ])("$name", ({ frames, expected }) => {
    const starts: CliToolUseStartDelta[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => undefined,
      onToolUseStart: (delta) => starts.push(delta),
    });

    parser.push(joinJsonlFrames(...frames, ""));
    parser.finish();

    expect(starts).toEqual(expected);
  });
});
