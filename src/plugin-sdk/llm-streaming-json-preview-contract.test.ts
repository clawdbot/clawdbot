import { describe, expect, it } from "vitest";
import { createStreamingJsonPreview, type StreamingJsonPreview } from "./llm.js";

/**
 * Contract coverage for the streaming-preview seam as an *external provider
 * plugin* sees it: only `createStreamingJsonPreview` plus the push/finalize
 * pair documented in docs/plugins/sdk-provider-plugins.md. Everything the host
 * uses to make this cheap (the mutable state struct, the structural tracker,
 * the reparse budget) is deliberately not reachable from here, so these tests
 * pin the behavior plugins are allowed to rely on rather than the internals.
 */
function streamFragments(preview: StreamingJsonPreview, fragments: readonly string[]) {
  return fragments.map((fragment) => preview.push(fragment));
}

function splitIntoChars(text: string): string[] {
  return text.split("");
}

function asStringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

describe("plugin SDK streaming JSON preview contract", () => {
  it("exposes only the documented surface", () => {
    const preview = createStreamingJsonPreview();

    expect(typeof preview.push).toBe("function");
    expect(typeof preview.finalize).toBe("function");
    expect(Object.keys(preview).toSorted()).toEqual(["finalize", "push"]);
  });

  it("returns the arguments as they stand after each fragment", () => {
    const preview = createStreamingJsonPreview();

    const seen = streamFragments(preview, ['{"path"', ':"a.ts"', ',"body":"he', 'llo"', "}"]);

    expect(seen.at(-1)).toEqual({ path: "a.ts", body: "hello" });
    expect(preview.finalize()).toEqual({ path: "a.ts", body: "hello" });
  });

  it("resolves the complete value from finalize regardless of fragmentation", () => {
    const args = { path: "src/index.ts", body: 'line one\nline two\ttabbed "quoted"' };
    const serialized = JSON.stringify(args);

    const wholeAtOnce = createStreamingJsonPreview();
    wholeAtOnce.push(serialized);

    const charByChar = createStreamingJsonPreview();
    streamFragments(charByChar, splitIntoChars(serialized));

    expect(wholeAtOnce.finalize()).toEqual(args);
    expect(charByChar.finalize()).toEqual(args);
  });

  it("keeps every fragment of a string member visible while it streams", () => {
    const preview = createStreamingJsonPreview();
    const body = "abcdefghij";

    preview.push('{"body":"');
    const lengths = splitIntoChars(body).map((char) => {
      const value = preview.push(char);
      return asStringArg(value.body).length;
    });

    // No staleness window: every delta moves the exposed value forward by one.
    expect(lengths).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("returns a fresh object each call so callers cannot corrupt later values", () => {
    const preview = createStreamingJsonPreview();

    const first = preview.push('{"body":"one');
    (first as Record<string, unknown>).injected = "mutation";
    (first as Record<string, unknown>).body = "clobbered";
    const second = preview.push('"}');

    expect(second).not.toBe(first);
    expect(second).toEqual({ body: "one" });
    expect(second).not.toHaveProperty("injected");
    expect(preview.finalize()).toEqual({ body: "one" });
  });

  it("previews incomplete JSON instead of throwing", () => {
    const preview = createStreamingJsonPreview();

    expect(() => preview.push('{"path":"a.ts","nested":{"deep":[1,2')).not.toThrow();
    expect(preview.push("")).toMatchObject({ path: "a.ts" });
  });

  it("preserves non-string members through finalize", () => {
    const preview = createStreamingJsonPreview();
    const args = { count: 42, enabled: true, missing: null, tags: ["a", "b"], name: "mixed" };

    streamFragments(preview, splitIntoChars(JSON.stringify(args)));

    expect(preview.finalize()).toEqual(args);
  });

  it("isolates previews from one another", () => {
    const first = createStreamingJsonPreview();
    const second = createStreamingJsonPreview();

    first.push('{"body":"first"}');
    second.push('{"body":"second"}');

    expect(first.finalize()).toEqual({ body: "first" });
    expect(second.finalize()).toEqual({ body: "second" });
  });

  it("stays responsive when a single argument streams at document size", () => {
    const preview = createStreamingJsonPreview();
    const chunk = "x".repeat(512);
    const chunkCount = 400;

    preview.push('{"body":"');
    const started = performance.now();
    for (let i = 0; i < chunkCount; i += 1) {
      preview.push(chunk);
    }
    const elapsedMs = performance.now() - started;
    preview.push('"}');

    const body = asStringArg(preview.finalize().body);
    expect(body).toHaveLength(chunk.length * chunkCount);
    // Quadratic accumulation over a ~200KB body needs far longer than this;
    // the bound is loose enough to stay stable on a loaded CI runner.
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
