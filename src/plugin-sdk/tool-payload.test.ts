import { describe, expect, it } from "vitest";
import {
  extractToolPayload,
  parseStandalonePlainTextToolCallBlocks,
  stripPlainTextToolCallBlocks,
  type ToolPayloadCarrier,
} from "./tool-payload.js";

describe("extractToolPayload", () => {
  it("returns undefined for missing results", () => {
    expect(extractToolPayload(undefined)).toBeUndefined();
    expect(extractToolPayload(null)).toBeUndefined();
  });

  it("prefers explicit details payloads", () => {
    expect(
      extractToolPayload({
        details: { ok: true },
        content: [{ type: "text", text: '{"ignored":true}' }],
      }),
    ).toEqual({ ok: true });
  });

  it("parses JSON text blocks and falls back to raw text, content, or the whole result", () => {
    expect(
      extractToolPayload({
        content: [
          { type: "image", url: "https://example.com/a.png" },
          { type: "text", text: '{"ok":true,"count":2}' },
        ],
      }),
    ).toEqual({ ok: true, count: 2 });

    expect(
      extractToolPayload({
        content: [{ type: "text", text: "not json" }],
      }),
    ).toBe("not json");

    const content = [{ type: "image", url: "https://example.com/a.png" }];
    expect(
      extractToolPayload({
        content,
      }),
    ).toBe(content);

    const result = { status: "ok" } as ToolPayloadCarrier & { status: string };
    expect(extractToolPayload(result)).toBe(result);
  });
});

describe("parseStandalonePlainTextToolCallBlocks", () => {
  it("parses bracketed local-model tool blocks", () => {
    const raw = ["[read]", '{"path":"/tmp/file.txt","line_start":1}', "[END_TOOL_REQUEST]"].join(
      "\n",
    );
    const blocks = parseStandalonePlainTextToolCallBlocks(raw);

    expect(blocks).toEqual([
      {
        name: "read",
        arguments: { path: "/tmp/file.txt", line_start: 1 },
        start: 0,
        end: raw.length,
        raw,
      },
    ]);
  });

  it("parses Harmony commentary tool calls", () => {
    const raw = 'commentary to=read code {"path":"/path/to/file","line_start":1,"line_end":400}';
    const blocks = parseStandalonePlainTextToolCallBlocks(raw);

    expect(blocks).toEqual([
      {
        name: "read",
        arguments: { path: "/path/to/file", line_start: 1, line_end: 400 },
        start: 0,
        end: raw.length,
        raw,
      },
    ]);
  });

  it("parses Harmony marker-wrapped tool calls", () => {
    const raw = '<|channel|>commentary to=read code<|message|>{"path":"/tmp/file.txt"}<|call|>';
    const blocks = parseStandalonePlainTextToolCallBlocks(raw);

    expect(blocks).toEqual([
      {
        name: "read",
        arguments: { path: "/tmp/file.txt" },
        start: 0,
        end: raw.length,
        raw,
      },
    ]);
  });

  it("parses Grok-style bracketed tool calls", () => {
    const firstRaw = '[tool:read] {"path":"/app/skills/meme-maker/SKILL.md"}';
    const secondRaw = '[tool:message] {"action":"send","channel":"channel:123","message":"done"}';
    const raw = [firstRaw, "", secondRaw].join("\n");
    const blocks = parseStandalonePlainTextToolCallBlocks(raw);

    expect(blocks).toEqual([
      {
        name: "read",
        arguments: { path: "/app/skills/meme-maker/SKILL.md" },
        start: 0,
        end: firstRaw.length,
        raw: firstRaw,
      },
      {
        name: "message",
        arguments: { action: "send", channel: "channel:123", message: "done" },
        start: firstRaw.length + 2,
        end: raw.length,
        raw: secondRaw,
      },
    ]);
  });

  it("respects allowed tool names for Harmony calls", () => {
    const blocks = parseStandalonePlainTextToolCallBlocks(
      'commentary to=write code {"path":"/tmp/file.txt","content":"x"}',
      { allowedToolNames: ["read"] },
    );

    expect(blocks).toBeNull();
  });
});

describe("stripPlainTextToolCallBlocks", () => {
  it("strips standalone bracketed local-model blocks", () => {
    expect(
      stripPlainTextToolCallBlocks(
        ["before", "[read]", '{"path":"/tmp/file.txt"}', "[END_TOOL_REQUEST]", "after"].join("\n"),
      ),
    ).toBe("before\nafter");
  });

  it("strips standalone Harmony tool calls", () => {
    expect(
      stripPlainTextToolCallBlocks(
        'before\ncommentary to=read code {"path":"/tmp/file.txt"}\nafter',
      ),
    ).toBe("before\nafter");
  });

  it("strips standalone Grok-style tool calls", () => {
    expect(
      stripPlainTextToolCallBlocks(
        [
          "before",
          '[tool:read] {"path":"/tmp/file.txt"}',
          '[tool:message] {"action":"send","message":"[tool:read] {\\"path\\":\\"/tmp/file.txt\\"}"}',
          "after",
        ].join("\n"),
      ),
    ).toBe("before\nafter");
  });

  it("strips serialized tool calls with parameter XML blocks", () => {
    expect(
      stripPlainTextToolCallBlocks(
        [
          "before",
          "[tool:exec]",
          "<parameter=command>",
          'cat /proc/mounts 2>/dev/null | grep -i "libra|rav|openclaw" | head -20',
          "</parameter>",
          "",
          "<function=exec>",
          "<parameter=command>",
          'find / -maxdepth 4 -type d \\( -name "ravdb" -o -name "librav" \\) 2>/dev/null | head -20',
          "</parameter>",
          "<parameter=timeout_ms>",
          "1000",
          "</parameter>",
          "</function>",
          "after",
        ].join("\n"),
      ),
    ).toBe("before\n\nafter");
  });
});
