import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
  type MemoryCorpusSearchResult,
  type MemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchMemoryCorpusSupplements } from "./tools.shared.js";

function buildResult(overrides: Partial<MemoryCorpusSearchResult> = {}): MemoryCorpusSearchResult {
  return {
    corpus: "wiki",
    path: "wiki/example.md",
    score: 0.5,
    snippet: "snippet",
    ...overrides,
  };
}

function buildSupplement(handler: MemoryCorpusSupplement["search"]): MemoryCorpusSupplement {
  return {
    search: handler,
    get: async () => null,
  };
}

describe("searchMemoryCorpusSupplements partial-failure tolerance (issue #77897)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearMemoryPluginState();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    clearMemoryPluginState();
    warnSpy.mockRestore();
  });

  it("returns empty array when no supplements registered", async () => {
    const out = await searchMemoryCorpusSupplements({ query: "anything", corpus: "all" });
    expect(out).toEqual([]);
  });

  it("returns surviving results when one supplement rejects", async () => {
    registerMemoryCorpusSupplement(
      "good",
      buildSupplement(async () => [
        buildResult({ corpus: "wiki", path: "wiki/a.md", score: 0.8, snippet: "alpha" }),
      ]),
    );
    registerMemoryCorpusSupplement(
      "bad",
      buildSupplement(async () => {
        throw new Error("supplement exploded");
      }),
    );

    const out = await searchMemoryCorpusSupplements({ query: "alpha", corpus: "all" });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ path: "wiki/a.md", snippet: "alpha" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(message).toContain('memory-core: corpus supplement "bad" search failed');
    expect(message).toContain("supplement exploded");
  });

  it("returns empty array (not rejection) when every supplement rejects", async () => {
    registerMemoryCorpusSupplement(
      "bad-1",
      buildSupplement(async () => {
        throw new Error("e1");
      }),
    );
    registerMemoryCorpusSupplement(
      "bad-2",
      buildSupplement(async () => {
        throw new Error("e2");
      }),
    );

    await expect(
      searchMemoryCorpusSupplements({ query: "anything", corpus: "all" }),
    ).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("merges results from multiple successful supplements and orders by score desc, path asc", async () => {
    registerMemoryCorpusSupplement(
      "wiki",
      buildSupplement(async () => [
        buildResult({ corpus: "wiki", path: "wiki/b.md", score: 0.5 }),
        buildResult({ corpus: "wiki", path: "wiki/a.md", score: 0.5 }),
      ]),
    );
    registerMemoryCorpusSupplement(
      "notes",
      buildSupplement(async () => [
        buildResult({ corpus: "notes", path: "notes/x.md", score: 0.9 }),
      ]),
    );

    const out = await searchMemoryCorpusSupplements({ query: "x", corpus: "all" });

    expect(out.map((r) => r.path)).toEqual(["notes/x.md", "wiki/a.md", "wiki/b.md"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("respects maxResults clamp (≥1) after merging", async () => {
    registerMemoryCorpusSupplement(
      "wiki",
      buildSupplement(async () =>
        Array.from({ length: 25 }, (_, i) =>
          buildResult({
            corpus: "wiki",
            path: `wiki/${String(i).padStart(2, "0")}.md`,
            score: 1 - i / 100,
          }),
        ),
      ),
    );

    const five = await searchMemoryCorpusSupplements({
      query: "x",
      corpus: "all",
      maxResults: 5,
    });
    expect(five).toHaveLength(5);

    const zeroClampedToOne = await searchMemoryCorpusSupplements({
      query: "x",
      corpus: "all",
      maxResults: 0,
    });
    expect(zeroClampedToOne).toHaveLength(1);
  });

  it("never queries supplements when corpus is 'memory' or 'sessions'", async () => {
    const search = vi.fn(async () => [buildResult()]);
    registerMemoryCorpusSupplement("wiki", buildSupplement(search));

    await expect(searchMemoryCorpusSupplements({ query: "x", corpus: "memory" })).resolves.toEqual(
      [],
    );
    await expect(
      searchMemoryCorpusSupplements({ query: "x", corpus: "sessions" }),
    ).resolves.toEqual([]);

    expect(search).not.toHaveBeenCalled();
  });

  it("preserves results when a supplement returns a Promise that rejects with non-Error reason", async () => {
    registerMemoryCorpusSupplement(
      "good",
      buildSupplement(async () => [buildResult({ path: "wiki/a.md" })]),
    );
    registerMemoryCorpusSupplement(
      "string-throw",
      buildSupplement(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "raw string failure";
      }),
    );
    registerMemoryCorpusSupplement(
      "object-throw",
      buildSupplement(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw { code: "ESUPP", detail: "structured failure" };
      }),
    );

    const out = await searchMemoryCorpusSupplements({ query: "x", corpus: "all" });
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe("wiki/a.md");

    const messages = warnSpy.mock.calls.map((c) => String(c[0] ?? ""));
    expect(
      messages.some((m) => m.includes('"string-throw"') && m.includes("raw string failure")),
    ).toBe(true);
    expect(messages.some((m) => m.includes('"object-throw"') && m.includes("ESUPP"))).toBe(true);
  });
});
