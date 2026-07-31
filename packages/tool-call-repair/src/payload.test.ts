import { describe, expect, it } from "vitest";
import { scanXmlishToolCall } from "./grammar.js";
import { scanPlainTextJsonToolCall, stripPlainTextToolCallBlocks } from "./payload.js";

function trackStringOperations(value: string) {
  let indexedReads = 0;
  let indexOfCalls = 0;
  const source = Object(value) as object;
  const text = new Proxy(source, {
    get(target, property) {
      if (typeof property === "string" && /^(?:0|[1-9]\d*)$/.test(property)) {
        indexedReads += 1;
      }
      if (property === "indexOf") {
        return (searchString: string, position?: number) => {
          indexOfCalls += 1;
          return value.indexOf(searchString, position);
        };
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return {
    get indexedReads() {
      return indexedReads;
    },
    get indexOfCalls() {
      return indexOfCalls;
    },
    text: text as unknown as string,
  };
}

describe("scanPlainTextJsonToolCall", () => {
  it.each([
    ["named", '[read]\n{"path":"/tmp/file"}[/read]visible'],
    ["legacy", '[read]\n{"path":"/tmp/file"}[END_TOOL_REQUEST]visible'],
    ["Harmony", '<|channel|>commentary to=read code<|message|>{"path":"/tmp/file"}<|call|>visible'],
  ])("returns the complete %s call before a visible suffix", (_syntax, raw) => {
    const scan = scanPlainTextJsonToolCall(raw);

    expect(scan.kind).toBe("complete");
    if (scan.kind !== "complete") {
      return;
    }
    expect(raw.slice(scan.end)).toBe("visible");
    expect(raw.slice(scan.name.start, scan.name.end)).toBe("read");
    expect(raw.slice(scan.payload.start, scan.payload.end)).toBe('{"path":"/tmp/file"}');
  });

  it.each([
    ["[", undefined, undefined, undefined],
    ["[tool", undefined, undefined, undefined],
    ["[tool:re", "tool-bracket", "re", false],
    ["[read]", "named-bracket", "read", true],
    ["comment", undefined, undefined, undefined],
    ["commentary to=read co", "harmony", "read", true],
    ['[read]\n{"path":1}[/re', "named-bracket", "read", true],
  ] as const)("classifies the streaming prefix %s", (raw, syntax, name, nameComplete) => {
    const scan = scanPlainTextJsonToolCall(raw);

    expect(scan.kind).toBe("prefix");
    if (scan.kind !== "prefix") {
      return;
    }
    expect(scan.candidate?.syntax).toBe(syntax);
    expect(scan.candidate?.nameComplete).toBe(nameComplete);
    expect(
      scan.candidate?.name
        ? raw.slice(scan.candidate.name.start, scan.candidate.name.end)
        : undefined,
    ).toBe(name);
  });

  it("exposes lexical continuation state for an incomplete JSON object", () => {
    const raw = '[tool:read]{"value":"still open';
    const scan = scanPlainTextJsonToolCall(raw);

    expect(scan.kind).toBe("prefix");
    if (scan.kind !== "prefix") {
      return;
    }
    expect(scan.candidate?.json).toEqual({ depth: 1, escaped: false, inString: true });
    expect(
      scan.candidate?.payload &&
        raw.slice(scan.candidate.payload.start, scan.candidate.payload.end),
    ).toBe('{"value":"still open');
  });

  it("uses a virtual text-part boundary as the named-header line break", () => {
    const raw = '[read]{"path":"/tmp/file"}[/read]';
    const usedLineBreakOffsets = new Set<number>();
    const scan = scanPlainTextJsonToolCall(raw, 0, {
      lineBreakOffsets: new Set(["[read]".length]),
      usedLineBreakOffsets,
    });

    expect(scan.kind).toBe("complete");
    expect([...usedLineBreakOffsets]).toEqual(["[read]".length]);
  });

  it.each([
    (name: string) => `[${name}]\n{}[/${name}]`,
    (name: string) => `[tool:${name}] {}`,
    (name: string) => `analysis to=${name} code {}`,
  ])("accepts 120-character names and rejects the 121st character", (build) => {
    expect(scanPlainTextJsonToolCall(build("x".repeat(120))).kind).toBe("complete");
    const oversized = scanPlainTextJsonToolCall(build("x".repeat(121)));
    expect(oversized.kind).toBe("invalid");
    if (oversized.kind === "invalid") {
      expect(oversized.at).toBeGreaterThan(0);
    }
  });

  it("returns invalid progress without consuming a wrong named closer", () => {
    const raw = '[read]\n{"path":"/tmp/file"}[/write] visible';
    const scan = scanPlainTextJsonToolCall(raw);

    expect(scan.kind).toBe("invalid");
    if (scan.kind !== "invalid") {
      return;
    }
    expect(raw.slice(scan.at)).toBe("[/write] visible");
    expect(
      scan.candidate?.payload &&
        raw.slice(scan.candidate.payload.start, scan.candidate.payload.end),
    ).toBe('{"path":"/tmp/file"}');
  });

  it.each([
    ["tool bracket", '[tool:read]{"path":"/tmp/file"}'],
    ["Harmony", 'analysis to=read code {"path":"/tmp/file"}'],
  ])("buffers every partial optional closer for %s syntax", (_name, call) => {
    for (const marker of ["<|call|>", "[END_TOOL_REQUEST]", "[/read]"]) {
      for (let split = 1; split < marker.length; split += 1) {
        expect(scanPlainTextJsonToolCall(call + marker.slice(0, split)).kind).toBe("prefix");
      }

      const complete = scanPlainTextJsonToolCall(call + marker);
      expect(complete).toMatchObject({ kind: "complete", end: call.length + marker.length });
    }
    const mismatch = scanPlainTextJsonToolCall(`${call}<|cap`);
    expect(mismatch).toMatchObject({ kind: "complete", end: call.length });
  });
});

describe("stripPlainTextToolCallBlocks", () => {
  it("preserves a balanced tool block whose JSON is invalid", () => {
    const raw = '[read]\n{"path":}\n[/read]';

    expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
  });

  it.each([
    ["JSON", "[tool:read] {\n", scanPlainTextJsonToolCall],
    ["XML", "<function=read><parameter=x>x\n", scanXmlishToolCall],
  ] as const)(
    "preserves a long repeated incomplete %s candidate in one scan",
    (_name, line, scan) => {
      const raw = line.repeat(20_000);
      const result = scan(raw);

      expect(result.kind).toBe("prefix");
      if (result.kind !== "prefix") {
        return;
      }
      expect(result.candidate?.payload?.end).toBe(raw.length);
      expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
    },
  );

  it("advances once through a far-invalid XML parameter", () => {
    const repeats = 256;
    const raw = "<function=read><parameter=x>x\n".repeat(repeats) + "</parameter>X";
    const tracked = trackStringOperations(raw);

    expect(stripPlainTextToolCallBlocks(tracked.text)).toBe(raw);
    expect(tracked.indexOfCalls).toBeLessThan(repeats * 8);
  });

  it("advances once through a far-invalid named JSON payload", () => {
    const repeats = 256;
    const raw = "[read]\n{\n".repeat(repeats) + "}".repeat(repeats) + "[/wrong]";
    const tracked = trackStringOperations(raw);

    expect(stripPlainTextToolCallBlocks(tracked.text)).toBe(raw);
    expect(tracked.indexedReads).toBeLessThan(raw.length * 16);
  });
});
