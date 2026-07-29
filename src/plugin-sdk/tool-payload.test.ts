// Tool payload tests cover model tool-call schema conversion and compatibility payloads.
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

  it("parses serialized parameter XML tool calls", () => {
    const firstRaw = [
      "[tool:exec]",
      "<parameter=command>",
      'cat /proc/mounts 2>/dev/null | grep -i "libra|rav|openclaw" | head -20',
      "</parameter>",
      "</function>",
    ].join("\n");
    const secondRaw = [
      "<function=exec>",
      "<parameter=command>",
      'find / -maxdepth 4 -type d \\( -name "ravdb" -o -name "librav" \\) 2>/dev/null | head -20',
      "</parameter>",
      "</function>",
    ].join("\n");
    const raw = [firstRaw, "", secondRaw].join("\n");
    const blocks = parseStandalonePlainTextToolCallBlocks(raw, {
      allowedToolNames: ["exec"],
    });

    expect(blocks).toEqual([
      {
        name: "exec",
        arguments: {
          command: 'cat /proc/mounts 2>/dev/null | grep -i "libra|rav|openclaw" | head -20',
        },
        start: 0,
        end: firstRaw.length,
        raw: firstRaw,
      },
      {
        name: "exec",
        arguments: {
          command:
            'find / -maxdepth 4 -type d \\( -name "ravdb" -o -name "librav" \\) 2>/dev/null | head -20',
        },
        start: firstRaw.length + 2,
        end: raw.length,
        raw: secondRaw,
      },
    ]);
  });

  it("parses zero-argument XML tool calls", () => {
    const raw = ["<function=get_system_info>", "</function>"].join("\n");

    expect(
      parseStandalonePlainTextToolCallBlocks(raw, {
        allowedToolNames: ["get_system_info"],
      }),
    ).toEqual([
      {
        arguments: {},
        end: raw.length,
        name: "get_system_info",
        raw,
        start: 0,
      },
    ]);
  });

  it.each(["[tool:get_system_info]</function>", "[get_system_info]\n</function>"])(
    "keeps bracketed opening %s from becoming a zero-argument XML call",
    (raw) => {
      expect(parseStandalonePlainTextToolCallBlocks(raw)).toBeNull();
    },
  );

  it("counts XML body whitespace against the UTF-8 payload cap", () => {
    const immediate = "<function=get_system_info></function>";
    expect(
      parseStandalonePlainTextToolCallBlocks(immediate, {
        allowedToolNames: ["get_system_info"],
        maxPayloadBytes: 0,
      })?.[0]?.arguments,
    ).toEqual({});

    const oversizedBody = "\u00a0".repeat(129);
    const oversized = `<function=get_system_info>${oversizedBody}</function>`;
    expect(new TextEncoder().encode(oversizedBody).byteLength).toBe(258);
    expect(
      parseStandalonePlainTextToolCallBlocks(oversized, {
        allowedToolNames: ["get_system_info"],
        maxPayloadBytes: 256,
      }),
    ).toBeNull();
    expect(stripPlainTextToolCallBlocks(["before", oversized, "after"].join("\n"))).toBe(
      "before\nafter",
    );

    const parameter = "<parameter=value>x</parameter>";
    const trailingBody = "\u00a0".repeat(2);
    const parameterBytes = new TextEncoder().encode(parameter).byteLength;
    expect(
      parseStandalonePlainTextToolCallBlocks(
        `<function=get_system_info>${parameter}${trailingBody}</function>`,
        {
          allowedToolNames: ["get_system_info"],
          maxPayloadBytes: parameterBytes + 3,
        },
      ),
    ).toBeNull();
  });

  it("preserves whitespace inside serialized XML parameter values", () => {
    const raw = [
      "<function=write>",
      "<parameter=content>",
      "  first line",
      "  second line",
      "",
      "</parameter>",
      "</function>",
    ].join("\n");
    const blocks = parseStandalonePlainTextToolCallBlocks(raw, {
      allowedToolNames: ["write"],
    });

    expect(blocks?.[0]?.arguments).toEqual({
      content: "  first line\n  second line\n",
    });
  });

  it("preserves __proto__ as an own XML argument property", () => {
    const raw = "<function=write><parameter=__proto__>value</parameter></function>";
    const args = parseStandalonePlainTextToolCallBlocks(raw)?.[0]?.arguments;

    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    expect(Object.hasOwn(args ?? {}, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(args ?? {}, "__proto__")?.value).toBe("value");
  });

  it("materializes one-shot tool-name iterables once per parse", () => {
    function* allowedNames() {
      yield "exec";
    }
    const legacy = "[tool:exec]<parameter=command>pwd</parameter>";
    expect(
      parseStandalonePlainTextToolCallBlocks(legacy, { allowedToolNames: allowedNames() }),
    ).toMatchObject([{ name: "exec", arguments: { command: "pwd" } }]);

    const adjacent = "<function=exec></function><function=exec></function>";
    expect(
      parseStandalonePlainTextToolCallBlocks(adjacent, { allowedToolNames: allowedNames() }),
    ).toHaveLength(2);
  });

  it("rejects serialized XML parameter calls without a function close", () => {
    const raw = ["<function=exec>", "<parameter=command>", "pwd", "</parameter>"].join("\n");

    expect(
      parseStandalonePlainTextToolCallBlocks(raw, {
        allowedToolNames: ["exec"],
      }),
    ).toBeNull();
  });

  it("parses legacy tool-prefixed XML parameter calls without a function close", () => {
    const raw = ["[tool:exec]", "<parameter=command>", "pwd", "</parameter>"].join("\n");

    expect(
      parseStandalonePlainTextToolCallBlocks(raw, {
        allowedToolNames: ["exec"],
      }),
    ).toEqual([
      {
        arguments: { command: "pwd" },
        end: raw.length,
        name: "exec",
        raw,
        start: 0,
      },
    ]);
  });

  it("finds XML parameter close tags without lowercased string offsets", () => {
    const dottedCapitalI = "\u0130";
    const raw = [
      "<function=write>",
      "<parameter=content>",
      dottedCapitalI,
      "</parameter>",
      "</function>",
    ].join("\n");
    const blocks = parseStandalonePlainTextToolCallBlocks(raw, {
      allowedToolNames: ["write"],
    });

    expect(blocks?.[0]?.arguments).toEqual({ content: dottedCapitalI });
  });

  it("rejects XML parameter blocks whose cumulative payload exceeds the cap", () => {
    const firstParameter = ["<parameter=first>", "alpha", "</parameter>"].join("\n");
    const secondParameter = ["<parameter=second>", "beta", "</parameter>"].join("\n");
    const raw = ["<function=write>", firstParameter, secondParameter, "</function>"].join("\n");
    const maxPayloadBytes = Math.max(firstParameter.length, secondParameter.length) + 1;

    expect(
      parseStandalonePlainTextToolCallBlocks(raw, {
        allowedToolNames: ["write"],
        maxPayloadBytes,
      }),
    ).toBeNull();
  });

  it("counts serialized XML parameter payload limits in UTF-8 bytes", () => {
    const parameter = ["<parameter=content>", "é".repeat(20), "</parameter>"].join("\n");
    const raw = ["<function=write>", parameter, "</function>"].join("\n");
    expect(parameter.length).toBeLessThan(64);
    expect(new TextEncoder().encode(parameter).byteLength).toBeGreaterThan(64);

    expect(
      parseStandalonePlainTextToolCallBlocks(raw, {
        allowedToolNames: ["write"],
        maxPayloadBytes: 64,
      }),
    ).toBeNull();
  });

  it("counts serialized JSON payload limits in UTF-8 bytes", () => {
    const payload = JSON.stringify({ content: "é".repeat(20) });
    const raw = ["[write]", payload, "[/write]"].join("\n");
    expect(payload.length).toBeLessThan(48);
    expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(48);

    expect(
      parseStandalonePlainTextToolCallBlocks(raw, {
        allowedToolNames: ["write"],
        maxPayloadBytes: 48,
      }),
    ).toBeNull();
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
          "</function>",
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

  it("strips zero-argument XML tool calls", () => {
    expect(
      stripPlainTextToolCallBlocks("before\n<function=get_system_info></function>\nafter"),
    ).toBe("before\nafter");
  });

  it("keeps legacy bracketed XML parameter blocks scrubbed", () => {
    expect(
      stripPlainTextToolCallBlocks(
        [
          "before",
          "[exec]",
          "<parameter=command>",
          "pwd",
          "</parameter>",
          "</function>",
          "after",
        ].join("\n"),
      ),
    ).toBe("before\nafter");
  });

  it("preserves incomplete XML parameter blocks when stripping visible text", () => {
    const text = ["before", "[exec]", "<parameter=command>", "pwd", "</parameter>", "after"].join(
      "\n",
    );

    expect(stripPlainTextToolCallBlocks(text)).toBe(text);
  });

  it("strips legacy tool-prefixed XML parameter blocks without a function close", () => {
    expect(
      stripPlainTextToolCallBlocks(
        ["before", "[tool:exec]", "<parameter=command>", "pwd", "</parameter>", "after"].join("\n"),
      ),
    ).toBe("before\nafter");
  });

  it.each(["<function=read></function>", '[tool:read] {"path":"/tmp"}'])(
    "strips adjacent same-line calls after an initial XML call: %s",
    (second) => {
      const calls = `<function=read></function>${second}`;
      expect(stripPlainTextToolCallBlocks(`before\n${calls}\nafter`)).toBe("before\nafter");
    },
  );

  it.each(["\u00a0", "\u000b", "\u000c"])(
    "strips calls indented with non-linebreak whitespace %#",
    (indent) => {
      expect(
        stripPlainTextToolCallBlocks(`before\n${indent}<function=read></function>\nafter`),
      ).toBe("before\nafter");
    },
  );

  it.each(["x".repeat(256_001), "é".repeat(128_001)])(
    "strips complete JSON payloads over the UTF-8 cap",
    (value) => {
      const call = `[tool:read] ${JSON.stringify({ value })}`;
      expect(stripPlainTextToolCallBlocks(`before\n${call}\nafter`)).toBe("before\nafter");
    },
  );

  it.each(["</func", "<param"])(
    "strips a complete optional-close call before an ambiguous %s prefix",
    (suffix) => {
      const block = ["[tool:exec]", "<parameter=command>", "pwd", "</parameter>"].join("\n");
      expect(stripPlainTextToolCallBlocks(["before", block, suffix].join("\n"))).toBe(
        `before\n${suffix}`,
      );
    },
  );

  it("strips oversized XML parameter tool calls without promoting them", () => {
    const largeValue = "x".repeat(140_000);
    const block = [
      "<function=write>",
      "<parameter=first>",
      largeValue,
      "</parameter>",
      "<parameter=second>",
      largeValue,
      "</parameter>",
      "</function>",
    ].join("\n");

    expect(
      parseStandalonePlainTextToolCallBlocks(block, {
        allowedToolNames: ["write"],
      }),
    ).toBeNull();
    expect(stripPlainTextToolCallBlocks(["before", block, "after"].join("\n"))).toBe(
      "before\nafter",
    );
  });
});
