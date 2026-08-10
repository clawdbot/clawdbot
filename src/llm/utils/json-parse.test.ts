import {
  createRepairJsonState,
  createStreamingJsonPreviewState,
  finalizeStreamingJsonPreview,
  parseJsonWithRepair,
  parseStreamingJson,
  pushStreamingJsonPreview,
  repairJson,
  repairJsonChunk,
  STREAMING_JSON_REPARSE_WORK_BUDGET_FACTOR,
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

// Subset of FUZZ_STRING_FRAGMENTS containing only fragments that are already
// *valid* JSON string escape source text (no raw invalid escapes/unescaped
// backslashes that need repair). Used by the ground-truth value-equivalence
// fuzz tests below: `partial-json`'s tolerant parser has its own (separate,
// pre-existing, undocumented) heuristics for handling a raw invalid escape
// sequence mid-stream in a still-open string - e.g. it may truncate the
// value right at the invalid escape rather than deferring to `repairJson`'s
// resolution of it - which is a property of that oracle's fallback chain,
// not a correctness bar for the parser under test here. Repair-correctness
// for those fragments is already covered exhaustively by the
// repairJsonChunk fuzz tests above (byte-for-byte match against
// `repairJson`); this list avoids conflating that with value equivalence.
const VALID_ESCAPE_FUZZ_FRAGMENTS = [
  "plain text ",
  "line\\nbreak",
  "\\u0041\\u00e9",
  "emoji \\uD83D\\uDE00 tail",
  "\\t\\r\\n\\b\\f",
  'quote\\"inside',
  "back\\\\slash",
];

function buildFuzzJson(random: () => number, fragments: string[] = FUZZ_STRING_FRAGMENTS): string {
  const fieldCount = 1 + Math.floor(random() * 3);
  const fields: string[] = [];
  for (let f = 0; f < fieldCount; f++) {
    const fragmentCount = 1 + Math.floor(random() * 4);
    let value = "";
    for (let i = 0; i < fragmentCount; i++) {
      value += fragments[Math.floor(random() * fragments.length)];
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

describe("streaming JSON preview (incremental repair + budgeted reparse)", () => {
  it("resolves large multi-chunk arguments correctly via finalizeStreamingJsonPreview", () => {
    const content = "The quarterly value exchange report. ".repeat(1500); // ~57KB
    const expected = { filename: "report.docx", content };
    const fullJson = JSON.stringify(expected);

    const state = createStreamingJsonPreviewState();
    const chunkSize = 40;
    for (let i = 0; i < fullJson.length; i += chunkSize) {
      pushStreamingJsonPreview(state, fullJson.slice(i, i + chunkSize));
    }
    const finalValue = finalizeStreamingJsonPreview(state);
    expect(finalValue).toEqual(expected);
  });

  it("keeps the preview live (not frozen) across a large payload as it grows", () => {
    const content = "The quarterly value exchange report. ".repeat(1500);
    const fullJson = JSON.stringify({ filename: "report.docx", content });

    const state = createStreamingJsonPreviewState();
    const chunkSize = 40;
    const distinctContentLengths = new Set<number>();
    for (let i = 0; i < fullJson.length; i += chunkSize) {
      const value = pushStreamingJsonPreview(state, fullJson.slice(i, i + chunkSize));
      const previewContent = value.content;
      if (typeof previewContent === "string") {
        distinctContentLengths.add(previewContent.length);
      }
    }
    // The old size-threshold design froze after 8_000 chars and produced a
    // single stale value for the rest of a ~57KB stream; an intermediate
    // growth-gated-only design only refreshed on a logarithmic cadence.
    // Tracking the structure incrementally (see the "genuinely live on every
    // delta" test below) means this now refreshes on essentially every delta
    // once streaming reaches the `content` field, so almost every chunk
    // should produce a distinct length.
    expect(distinctContentLengths.size).toBeGreaterThan(fullJson.length / chunkSize / 2);
  });

  it("keeps the previewed value genuinely live on every single delta once inside a large top-level string field (zero staleness)", () => {
    const content = "The quarterly value exchange report. ".repeat(1500); // ~57KB
    const fullJson = JSON.stringify({ filename: "report.docx", content });

    const state = createStreamingJsonPreviewState();
    const chunkSize = 40;
    let previous = "";
    let sawContentField = false;
    let deltasThatDidNotGrowThePreview = 0;
    for (let i = 0; i < fullJson.length; i += chunkSize) {
      const after = pushStreamingJsonPreview(state, fullJson.slice(i, i + chunkSize)).content;
      if (typeof after !== "string") {
        continue;
      }
      if (sawContentField) {
        // Once inside the `content` field, every delta must extend the
        // exposed preview - never replace, truncate, or repeat it.
        expect(after.startsWith(previous)).toBe(true);
        if (after.length === previous.length) {
          deltasThatDidNotGrowThePreview += 1;
        }
      }
      sawContentField = true;
      previous = after;
    }
    expect(sawContentField).toBe(true);
    // Only the last delta (which carries the closing `"}` rather than more
    // content) may leave the previewed value unchanged; a cached/stale value
    // anywhere else in the stream would show up here.
    expect(deltasThatDidNotGrowThePreview).toBeLessThanOrEqual(1);
    const finalValue = finalizeStreamingJsonPreview(state);
    expect(finalValue).toEqual({ filename: "report.docx", content });
    // The incremental tracker materializes every string member on its own,
    // so the only JSON.parse/partial-json pass in this whole stream is the
    // one `finalizeStreamingJsonPreview` forces.
    expect(state.fullReparseCount).toBe(1);
  });

  it("bounds the number of full reparses regardless of delta granularity (cadence-independent cost)", () => {
    const content = "The quarterly value exchange report. ".repeat(1500); // ~57KB
    const fullJson = JSON.stringify({ filename: "report.docx", content });

    // A per-delta full reparse (the O(n^2) bug this module exists to fix)
    // would scale linearly with the number of deltas: ~1,425 deltas at
    // chunkSize 40, or ~57,000 at chunkSize 1. An earlier, wall-clock-based
    // version of this gate only bounded cost for deltas arriving faster
    // than its interval - deltas spaced further apart (an entirely ordinary
    // network cadence) still triggered a full reparse every time. Neither
    // the structural tracker nor the reparse budget has any time input at
    // all, so cadence can't affect them; the closest analog
    // we can exercise deterministically is delta *granularity* (the same
    // payload split into far more, far smaller deltas), which this must not
    // multiply the reparse count for.
    function countFullReparses(chunkSize: number): number {
      const state = createStreamingJsonPreviewState();
      for (let i = 0; i < fullJson.length; i += chunkSize) {
        pushStreamingJsonPreview(state, fullJson.slice(i, i + chunkSize));
      }
      return state.fullReparseCount;
    }

    const reparsesAtChunk40 = countFullReparses(40);
    const reparsesAtChunk1 = countFullReparses(1);

    // With the tracker materializing this flat object's members directly
    // from the deltas, nothing here needs a whole-buffer pass at all - the
    // count is a small constant, not proportional to payload size or delta
    // count.
    expect(reparsesAtChunk40).toBeLessThan(10);
    expect(reparsesAtChunk1).toBeLessThan(10);
  });

  it("stays linear for a wide object of many short string fields streamed one character at a time", () => {
    // The shape an earlier revision regressed on: it only avoided the
    // whole-buffer re-parse for the interior of a single large string, and
    // re-parsed on every string boundary. Here a boundary is crossed every
    // few characters, so "re-parse on each boundary" is just the original
    // O(n^2) behavior wearing a different hat.
    const expected = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`field${i}`, `value${i}`]),
    );
    const fullJson = JSON.stringify(expected); // ~9KB across 400 fields

    const state = createStreamingJsonPreviewState();
    let raw = "";
    for (let i = 0; i < fullJson.length; i++) {
      raw += fullJson.charAt(i);
      const value = pushStreamingJsonPreview(state, fullJson.charAt(i));
      // Bounding the cost must not cost correctness: the preview still has
      // to match a full re-parse of the raw buffer at every single delta.
      expect(trimTrailingWhitespaceOnStrings(value)).toEqual(
        trimTrailingWhitespaceOnStrings(parseStreamingJson(raw)),
      );
    }
    expect(finalizeStreamingJsonPreview(state)).toEqual(expected);

    // The tracker materializes string members itself, so boundaries cost
    // nothing extra and the only whole-buffer pass is the forced final one.
    expect(state.fullReparseCount).toBe(1);
    expect(state.reparsedCharsTotal).toBe(fullJson.length);
  });

  it("keeps total re-parsed bytes linear even for shapes the tracker cannot model", () => {
    // Nested containers and numeric members are handed to the whole-buffer
    // fallback by design. That fallback is the one thing here with no
    // incremental form, so its *total* cost is what has to stay bounded -
    // and it must hold for the worst cadence (one character per delta).
    const fullJson = JSON.stringify({
      counts: Array.from({ length: 400 }, (_, i) => i),
      meta: { note: "x".repeat(500) },
    });

    const state = createStreamingJsonPreviewState();
    for (let i = 0; i < fullJson.length; i++) {
      pushStreamingJsonPreview(state, fullJson.charAt(i));
    }
    expect(finalizeStreamingJsonPreview(state)).toEqual(JSON.parse(fullJson));

    // Without a bound this would be ~n^2/2 (about 2 million characters for
    // this payload) instead of a small multiple of n. The budget caps the
    // streaming passes at FACTOR * n; the `+ 1` is the final forced parse,
    // which is unconditional by design.
    expect(state.reparsedCharsTotal).toBeLessThanOrEqual(
      (STREAMING_JSON_REPARSE_WORK_BUDGET_FACTOR + 1) * fullJson.length,
    );
  });

  it("keeps the previewed string live incrementally instead of reusing a stale cached value", () => {
    const state = createStreamingJsonPreviewState();
    const first = pushStreamingJsonPreview(state, '{"a":"1');
    expect(first).toEqual({ a: "1" });
    const reparsesAfterFirst = state.fullReparseCount;

    // Even a single extra byte - far below any reparse threshold - must be
    // reflected immediately by the tracker, not silently dropped.
    const second = pushStreamingJsonPreview(state, "2");
    expect(second).toEqual({ a: "12" });
    expect(second).not.toBe(first);
    expect(state.fullReparseCount).toBe(reparsesAfterFirst); // tracked, no extra reparse

    const third = pushStreamingJsonPreview(state, '3"}', { force: true });
    expect(third).toEqual({ a: "123" });

    const fourth = pushStreamingJsonPreview(state, ""); // no new bytes at all
    expect(fourth).toEqual({ a: "123" });
  });

  it("preserves whitespace `partial-json` withheld on an open string once the tracker resumes after a full reparse", () => {
    // Regression for a real bug: a full reparse (forced here for a
    // deterministic repro; an untracked shape reaches the same reparse path
    // for a large real payload) that lands with an open string ending in
    // whitespace used to cache partial-json's *trimmed* view of that value.
    // The next delta then appended its decoded content onto that stale,
    // shortened cache instead of the true accumulated text, silently
    // dropping the whitespace - e.g. "hi " + "x" became "hix" instead of
    // "hi x" in the value exposed via `toolcall_delta.partial.arguments`.
    const state = createStreamingJsonPreviewState();

    const afterForcedReparse = pushStreamingJsonPreview(state, '{"a":"hi ', { force: true });
    // The forced full reparse above goes through partial-json, which would
    // trim the trailing space off this still-open string; the fix
    // overwrites that with the authoritative value derived directly from
    // the repaired buffer, so the space must already be present here too.
    expect(afterForcedReparse).toEqual({ a: "hi " });

    // Pure interior string content for the same still-open field: the
    // tracker must append onto the *true* value above, not a trimmed one,
    // or the space between "hi" and "x" is lost.
    const afterTrackedAppend = pushStreamingJsonPreview(state, "x");
    expect(afterTrackedAppend).toEqual({ a: "hi x" });

    pushStreamingJsonPreview(state, '"}');
    const finalValue = finalizeStreamingJsonPreview(state);
    expect(finalValue).toEqual({ a: "hi x" });
  });

  it("does not duplicate a character when a pending escape sequence resolves right after a full reparse", () => {
    // Regression for a bug introduced while fixing the whitespace-trim
    // issue above: the open-string value used to be read from a buffer that
    // included a *speculative* "as if the stream ended now" resolution of
    // a still-pending, ambiguous escape (state.repairState.pendingRaw) -
    // e.g. a lone trailing "\" that might turn into "\uXXXX" once the next
    // characters arrive. Baking that guess into the tracker's baseline
    // meant the backslash got counted once speculatively and then again
    // for real once repairJsonChunkCore's own carryover resolved the escape
    // properly, producing e.g. "\A" instead of "A" for a "\u0041" split
    // exactly after the backslash.
    const state = createStreamingJsonPreviewState();

    // Force a full reparse landing with field1's value containing exactly
    // one unresolved trailing backslash - the start of a \u escape whose
    // remaining hex digits haven't arrived yet.
    const afterForcedReparse = pushStreamingJsonPreview(state, '{"field0":"x","field1":"\\', {
      force: true,
    });
    expect(afterForcedReparse).toEqual({ field0: "x", field1: "" });

    // The rest of the \u0041 escape arrives as pure interior content for
    // the same still-open field: must resolve to "A" via the pending-raw
    // carryover, not "\A".
    const afterEscapeResolves = pushStreamingJsonPreview(state, "u0041");
    expect(afterEscapeResolves).toEqual({ field0: "x", field1: "A" });

    pushStreamingJsonPreview(state, '"}');
    const finalValue = finalizeStreamingJsonPreview(state);
    expect(finalValue).toEqual({ field0: "x", field1: "A" });
  });

  it("falls back to the whole-buffer reparse for a nested object/array value", () => {
    // Nested containers are explicitly out of scope for the flat-object
    // tracker (see `advanceTopLevelObjectTracker`); this must still resolve
    // correctly via the budgeted full-reparse fallback, just without the
    // same zero-staleness guarantee for the nested field.
    const inner = "x".repeat(2000);
    const expected = { meta: { note: inner } };
    const fullJson = JSON.stringify(expected);

    const state = createStreamingJsonPreviewState();
    for (let i = 0; i < fullJson.length; i += 40) {
      pushStreamingJsonPreview(state, fullJson.slice(i, i + 40));
    }
    const finalValue = finalizeStreamingJsonPreview(state);
    expect(finalValue).toEqual(expected);
  });

  it("falls back safely for a large flat array of many small scalars (tracker does not apply, budget still bounds cost)", () => {
    const numbers = Array.from({ length: 5000 }, (_, i) => i);
    const expected = { numbers };
    const fullJson = JSON.stringify(expected);

    const state = createStreamingJsonPreviewState();
    for (let i = 0; i < fullJson.length; i += 1) {
      pushStreamingJsonPreview(state, fullJson.charAt(i));
    }
    const finalValue = finalizeStreamingJsonPreview(state);
    expect(finalValue).toEqual(expected);
    // Not the point of this test to assert an exact bound (arrays of
    // scalars aren't what the tracker models), just that it stays a small
    // fraction of the delta count rather than scaling with it.
    expect(state.fullReparseCount).toBeLessThan(fullJson.length / 10);
  });

  it("finalizeStreamingJsonPreview definitively resolves a value ending mid-escape-sequence", () => {
    const state = createStreamingJsonPreviewState();
    pushStreamingJsonPreview(state, '{"path":"C:\\Users\\bob');
    pushStreamingJsonPreview(state, "\\"); // dangling backslash at chunk boundary
    pushStreamingJsonPreview(state, 'temp"}');
    const finalValue = finalizeStreamingJsonPreview(state);
    expect(finalValue).toEqual({ path: "C:\\Users\\bob\\temp" });
  });
});

// `partial-json`'s `parse()` trims *trailing* whitespace on a still-open
// (unterminated) string value - e.g. parse('{"a":"hi ') => {a:"hi"}, not
// {a:"hi "} - since it can't know yet whether that whitespace is meaningful
// content or just formatting before the string closes. This is a
// pre-existing property of the `partial-json` fallback these tests use as
// their "ground truth" oracle, not something introduced by the tracker -
// and the tracker is arguably *more* correct here, since it preserves the
// literal bytes seen so far instead of guessing. Trim trailing whitespace
// before comparing so this one known, harmless oracle quirk doesn't produce
// false failures; it does not mask any other divergence.
function trimTrailingWhitespaceOnStrings(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    result[key] = typeof val === "string" ? val.replace(/\s+$/, "") : val;
  }
  return result;
}

describe("streaming JSON preview matches ground truth on every delta (fuzz)", () => {
  it("matches a full parseStreamingJson(raw-so-far) after every single delta, across random chunk boundaries and fragment mixes", () => {
    // This is the direct regression test for the tracker: it must never
    // diverge from what a straightforward (if quadratic) full re-parse of
    // the raw buffer would produce at that exact point in the stream, for
    // any field - not just the one being hot-appended.
    const random = mulberry32(0xfeedface);
    const iterations = 60; // ground truth here is a full O(n) re-parse per delta, so keep this modest
    for (let iteration = 0; iteration < iterations; iteration++) {
      const fullJson = buildFuzzJson(random, VALID_ESCAPE_FUZZ_FRAGMENTS);
      const chunks = chunkRandomly(fullJson, random);

      const state = createStreamingJsonPreviewState();
      let raw = "";
      for (const chunk of chunks) {
        raw += chunk;
        const value = pushStreamingJsonPreview(state, chunk);
        const groundTruth = parseStreamingJson(raw);
        expect(
          trimTrailingWhitespaceOnStrings(value),
          `mismatch for raw so far ${JSON.stringify(raw)} (full json ${JSON.stringify(fullJson)})`,
        ).toEqual(trimTrailingWhitespaceOnStrings(groundTruth));
      }
      const finalValue = finalizeStreamingJsonPreview(state);
      expect(finalValue).toEqual(parseStreamingJson(raw));
    }
  });

  it("matches ground truth when every chunk is exactly one character", () => {
    const random = mulberry32(0x0ddba11);
    for (let iteration = 0; iteration < 20; iteration++) {
      const fullJson = buildFuzzJson(random, VALID_ESCAPE_FUZZ_FRAGMENTS);
      const state = createStreamingJsonPreviewState();
      let raw = "";
      for (let i = 0; i < fullJson.length; i++) {
        const chunk = fullJson.charAt(i);
        raw += chunk;
        const value = pushStreamingJsonPreview(state, chunk);
        expect(
          trimTrailingWhitespaceOnStrings(value),
          `mismatch at index ${i} for ${JSON.stringify(fullJson)}`,
        ).toEqual(trimTrailingWhitespaceOnStrings(parseStreamingJson(raw)));
      }
      expect(finalizeStreamingJsonPreview(state)).toEqual(parseStreamingJson(raw));
    }
  });
});
