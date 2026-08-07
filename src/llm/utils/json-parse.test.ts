import {
  createRepairJsonState,
  createStreamingJsonPreviewState,
  finalizeStreamingJsonPreview,
  parseJsonWithRepair,
  parseStreamingJson,
  pushStreamingJsonPreview,
  repairJson,
  repairJsonChunk,
} from "@openclaw/ai/internal/runtime";
// JSON parse tests cover tolerant parsing of partial model JSON output.
import { describe, expect, it } from "vitest";

describe("json-parse repairJson invalid \\u escapes", () => {
  it("repairs a \\u not followed by four hex digits so the result parses", () => {
    // JS string is: {"path":"C:\users"} — a model emitting an unescaped Windows path.
    const broken = '{"path":"C:\\users"}';
    expect(() => JSON.parse(repairJson(broken))).not.toThrow();
    expect(parseJsonWithRepair(broken)).toEqual({ path: "C:\\users" });
  });

  it("preserves valid \\uXXXX escapes", () => {
    expect(parseJsonWithRepair('{"e":"\\u0041"}')).toEqual({ e: "A" });
  });

  it.each([
    ['{"path":"C:\\bin\\app.exe"}', "C:\\bin\\app.exe"],
    ['{"path":"C:\\temp\\x"}', "C:\\temp\\x"],
    ['{"path":"C:\\new\\file"}', "C:\\new\\file"],
    ['{"path":"D:\\reports\\q"}', "D:\\reports\\q"],
    ['{"path":"C:\\users\\bob"}', "C:\\users\\bob"],
  ])("preserves unescaped Windows path control-letter segments: %s", (input, expected) => {
    expect(parseStreamingJson(input)).toEqual({ path: expected });
    expect(parseJsonWithRepair(input)).toEqual({ path: expected });
  });

  it("preserves legitimate JSON control escapes outside Windows paths", () => {
    expect(parseJsonWithRepair('{"message":"line\\nnext\\ttabbed"}')).toEqual({
      message: "line\nnext\ttabbed",
    });
  });

  it("recovers streaming tool-call arguments instead of dropping them to {}", () => {
    // LaTeX-style \u (\underline) is a valid string value the model may emit in args.
    const args = '{"cmd":"\\underline{x}"}';
    expect(parseStreamingJson(args)).toEqual({ cmd: "\\underline{x}" });
  });

  it.each(["null", "[]", '"text"', "1", "true"])(
    "returns an empty object for non-object streaming JSON: %s",
    (input) => {
      expect(parseStreamingJson(input)).toEqual({});
    },
  );
});

// Deterministic PRNG (mulberry32) so failures are reproducible without
// pulling in a fuzzing dependency.
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_STRING_FRAGMENTS = [
  "plain text ",
  "C:\\Users\\bob\\report.docx", // unescaped Windows path - needs repair
  "line\\nbreak", // valid escape as literal source text
  "\\u0041\\u00e9", // valid unicode escapes as literal source text
  "\\q invalid escape", // invalid escape - needs repair
  "emoji \\uD83D\\uDE00 tail", // surrogate pair unicode escapes
  "trailing backslash\\", // dangling backslash at end of fragment
  "\\t\\r\\n\\b\\f", // all control escapes
  'quote\\"inside',
];

function buildFuzzJson(random: () => number): string {
  const fieldCount = 1 + Math.floor(random() * 3);
  const fields: string[] = [];
  for (let f = 0; f < fieldCount; f++) {
    const fragmentCount = 1 + Math.floor(random() * 4);
    let value = "";
    for (let i = 0; i < fragmentCount; i++) {
      value += FUZZ_STRING_FRAGMENTS[Math.floor(random() * FUZZ_STRING_FRAGMENTS.length)];
    }
    fields.push(`"field${f}":"${value}"`);
  }
  return `{${fields.join(",")}}`;
}

function chunkRandomly(input: string, random: () => number): string[] {
  const chunks: string[] = [];
  let index = 0;
  while (index < input.length) {
    // Bias toward small chunks (including 1 char) to stress escape/unicode
    // boundaries landing mid-sequence as often as possible.
    const size = 1 + Math.floor(random() * random() * 6);
    chunks.push(input.slice(index, index + size));
    index += size;
  }
  return chunks;
}

describe("repairJsonChunk incremental/non-incremental equivalence (fuzz)", () => {
  it("matches repairJson(fullString) after feeding random chunk boundaries, across many random inputs", () => {
    const random = mulberry32(0xc0ffee);
    const iterations = 300;
    for (let iteration = 0; iteration < iterations; iteration++) {
      const fullJson = buildFuzzJson(random);
      const chunks = chunkRandomly(fullJson, random);

      const state = createRepairJsonState();
      let incremental = "";
      for (const [i, chunk] of chunks.entries()) {
        const isLastChunk = i === chunks.length - 1;
        incremental += repairJsonChunk(chunk, state, isLastChunk);
      }

      const expected = repairJson(fullJson);
      // This is the only invariant that actually matters: whatever
      // repairJson(fullString) would produce for a given complete buffer,
      // repairJsonChunk must produce byte-for-byte identically regardless of
      // how that buffer was split into deltas. (Note: repairJson operates
      // character-by-character with no structural JSON awareness, so
      // adversarial input - e.g. a fragment ending in a backslash placed
      // immediately before a field-closing quote - can occasionally produce
      // output neither version can parse as valid JSON. That's an existing,
      // pre-existing property of repairJson's heuristic itself and is not
      // what this test is checking.)
      expect(
        incremental,
        `mismatch for input ${JSON.stringify(fullJson)} chunked as ${JSON.stringify(chunks)}`,
      ).toBe(expected);
    }
  });

  it("matches repairJson(fullString) when every chunk is exactly one character", () => {
    const random = mulberry32(0x5eed);
    for (let iteration = 0; iteration < 40; iteration++) {
      const fullJson = buildFuzzJson(random);
      const state = createRepairJsonState();
      let incremental = "";
      for (let i = 0; i < fullJson.length; i++) {
        incremental += repairJsonChunk(fullJson.charAt(i), state, i === fullJson.length - 1);
      }
      expect(incremental).toBe(repairJson(fullJson));
    }
  });

  it("never emits pendingRaw beyond a handful of characters regardless of buffer size", () => {
    const state = createRepairJsonState();
    const large = `{"content":"${"x".repeat(50_000)}`; // still inside an open string
    repairJsonChunk(large, state, false);
    // Ends cleanly (no dangling escape), so nothing should be pending.
    expect(state.pendingRaw.length).toBeLessThanOrEqual(6);
  });
});

describe("streaming JSON preview (incremental repair + time-bounded reparse)", () => {
  it("resolves large multi-chunk arguments correctly via finalizeStreamingJsonPreview", () => {
    const content = "The quarterly value exchange report. ".repeat(1500); // ~57KB
    const expected = { filename: "report.docx", content };
    const fullJson = JSON.stringify(expected);

    const state = createStreamingJsonPreviewState();
    const chunkSize = 40;
    for (let i = 0; i < fullJson.length; i += chunkSize) {
      pushStreamingJsonPreview(state, fullJson.slice(i, i + chunkSize), { now: i });
    }
    const finalValue = finalizeStreamingJsonPreview(state);
    expect(finalValue).toEqual(expected);
  });

  it("keeps the preview live (not frozen) across a large payload even though full reparse is time-capped", () => {
    const content = "The quarterly value exchange report. ".repeat(1500);
    const fullJson = JSON.stringify({ filename: "report.docx", content });

    const state = createStreamingJsonPreviewState();
    const chunkSize = 40;
    const distinctContentLengths = new Set<number>();
    // Advance `now` by 5ms per delta - some calls land inside the same
    // 20ms window (exercising the cap) and some don't, mirroring bursty
    // real-world network delivery.
    let now = 0;
    for (let i = 0; i < fullJson.length; i += chunkSize) {
      const value = pushStreamingJsonPreview(state, fullJson.slice(i, i + chunkSize), { now });
      const previewContent = value.content;
      if (typeof previewContent === "string") {
        distinctContentLengths.add(previewContent.length);
      }
      now += 5;
    }
    // The old size-threshold design froze after 8_000 chars and produced a
    // single stale value for the rest of a ~57KB stream. The time-based cap
    // must keep refreshing throughout, not just near the very start.
    expect(distinctContentLengths.size).toBeGreaterThan(50);
  });

  it("reuses the last value when calls land within the reparse interval, and always refreshes when forced", () => {
    const state = createStreamingJsonPreviewState();
    const first = pushStreamingJsonPreview(state, '{"a":"1', { now: 1000 });
    const second = pushStreamingJsonPreview(state, "2", { now: 1005 }); // within 20ms
    expect(second).toBe(first); // same cached value, no reparse triggered

    const third = pushStreamingJsonPreview(state, '3"}', { now: 1005, force: true });
    expect(third).not.toBe(first);
    expect(third).toEqual({ a: "123" });

    const fourth = pushStreamingJsonPreview(state, "", { now: 1030 }); // past the interval
    expect(fourth).toEqual({ a: "123" });
  });

  it("finalizeStreamingJsonPreview definitively resolves a value ending mid-escape-sequence", () => {
    const state = createStreamingJsonPreviewState();
    pushStreamingJsonPreview(state, '{"path":"C:\\Users\\bob', { now: 0 });
    pushStreamingJsonPreview(state, "\\", { now: 1 }); // dangling backslash at chunk boundary
    pushStreamingJsonPreview(state, 'temp"}', { now: 2 });
    const finalValue = finalizeStreamingJsonPreview(state);
    expect(finalValue).toEqual({ path: "C:\\Users\\bob\\temp" });
  });
});
