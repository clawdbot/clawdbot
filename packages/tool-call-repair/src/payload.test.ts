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

describe("stripPlainTextToolCallBlocks: degraded invoke dialect (#97750)", () => {
  // Build tags by concatenation so the source carries no literal invoke markup.
  const LT = "<";
  const tags = (ns: string) => ({
    open: `${LT}${ns}invoke name="get_weather">`,
    paramOpen: `${LT}${ns}parameter name="city">`,
    paramClose: `${LT}/${ns}parameter>`,
    close: `${LT}/${ns}invoke>`,
  });
  const block = (ns: string) => {
    const t = tags(ns);
    return [t.open, `${t.paramOpen}Paris${t.paramClose}`, t.close].join("\n");
  };

  it.each([
    ["antml namespace", "antml:"],
    ["mm namespace", "mm:"],
  ])("scrubs a standalone %s invoke block", (_label, ns) => {
    expect(stripPlainTextToolCallBlocks(`Here you go.\n${block(ns)}`)).toBe("Here you go.\n");
  });

  it("scrubs a function_calls-wrapped bare invoke block", () => {
    const raw = `Done.\n${LT}function_calls>\n${block("")}\n${LT}/function_calls>`;
    expect(stripPlainTextToolCallBlocks(raw)).toBe("Done.\n");
  });

  it("scrubs a self-closing zero-argument namespaced invoke block", () => {
    expect(stripPlainTextToolCallBlocks(`Done.\n${LT}antml:invoke name="ping"/>`)).toBe("Done.\n");
  });

  it("scrubs a zero-parameter namespaced invoke block", () => {
    const raw = `Done.\n${LT}antml:invoke name="ping">\n${LT}/antml:invoke>`;
    expect(stripPlainTextToolCallBlocks(raw)).toBe("Done.\n");
  });

  it.each([
    ["multi-parameter", block("")],
    ["self-closing", `${LT}invoke name="ping"/>`],
    ["zero-parameter", `${LT}invoke name="ping">\n${LT}/invoke>`],
  ])("preserves a standalone bare %s invoke block (#97750)", (_label, form) => {
    // A bare `<invoke>` with no `antml:`/`mm:` namespace and no `<function_calls>`
    // wrapper is legitimate content (a documentation example), not a leaked call.
    const raw = `Here you go.\n${form}`;
    expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
  });

  it("preserves a bare invoke block even under the strict predicate (#97750)", () => {
    // Strict mode scrubs qualified leaks inside code fences; a bare block is never a
    // leaked call, so the strict predicate must not turn it into one.
    const raw = `Here you go.\n${block("")}`;
    expect(stripPlainTextToolCallBlocks(raw, () => false)).toBe(raw);
  });

  it("preserves a fenced namespaced invoke example by default (code-aware)", () => {
    const raw = `See:\n\`\`\`xml\n${block("antml:")}\n\`\`\`\nDone.`;
    expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
  });

  it("preserves an inline namespaced invoke example by default", () => {
    const raw = `Use the \`${tags("antml:").open}\` opener.`;
    expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
  });

  it("scrubs a fenced namespaced invoke when the predicate never preserves (strict)", () => {
    const raw = `See:\n\`\`\`xml\n${block("antml:")}\n\`\`\`\nDone.`;
    const stripped = stripPlainTextToolCallBlocks(raw, () => false);
    expect(stripped).not.toContain("invoke");
  });

  it("preserves a namespaced invoke block flagged by a custom code-region predicate", () => {
    const prefix = "Here you go.\n";
    const raw = `${prefix}${block("antml:")}`;
    const stripped = stripPlainTextToolCallBlocks(raw, (offset) => offset >= prefix.length);
    expect(stripped).toBe(raw);
  });

  it("defers an unterminated namespaced invoke open (no close)", () => {
    const raw = `Working.\n${tags("antml:").open}\n${tags("antml:").paramOpen}Paris`;
    expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
  });

  it("stays linear on many unterminated invoke opens (no quadratic rescan)", () => {
    // Each line opens a namespaced invoke + parameter that never closes. A per-line
    // rescan of the unclosed tail would be O(n^2); the incomplete-block bail keeps
    // it linear. The namespace arms the scrub pass so the scan loop is exercised
    // (a bare open short-circuits the trigger guard). Linear finishes in well under a
    // millisecond here; a reintroduced quadratic scan takes ~1s, so the bound is safe.
    const line = `${tags("antml:").open}${tags("antml:").paramOpen}payload`;
    const raw = Array.from({ length: 16000 }, () => line).join("\n");
    const startedAt = performance.now();
    expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
    expect(performance.now() - startedAt).toBeLessThan(300);
  });
});
