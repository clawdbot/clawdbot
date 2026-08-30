import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { describe, expect, it, vi } from "vitest";
import {
  filterCurrentSemanticLifecycle,
  shouldApplyCurrentLifecycle,
} from "./semantic-lifecycle.js";

function hit(path: string, score: number, source: "memory" | "sessions" = "memory") {
  return {
    path,
    startLine: 1,
    endLine: 2,
    score,
    snippet: path,
    source,
  } satisfies MemorySearchResult;
}

function frontmatter(status: string): string {
  return `---\nschema_version: openclaw.semantic_memory.v2\nstatus: ${status}\n---\n# Record`;
}

describe("semantic lifecycle filtering", () => {
  it("detects current-state intent unless explicitly disabled", () => {
    expect(shouldApplyCurrentLifecycle({ query: "what is the current gate?" })).toBe(true);
    expect(shouldApplyCurrentLifecycle({ query: "show the history", mode: "current" })).toBe(true);
    expect(shouldApplyCurrentLifecycle({ query: "current gate", mode: "all" })).toBe(false);
  });

  it("ranks active before review states and excludes historical lifecycle states", async () => {
    const hits = [
      hit("superseded.md", 0.99),
      hit("review.md", 0.98),
      hit("active.md", 0.8),
      hit("legacy.md", 0.79),
      hit("sessions/one.jsonl", 0.7, "sessions"),
      hit("historical.md", 0.6),
    ];
    const content = new Map([
      ["superseded.md", frontmatter("superseded")],
      ["review.md", frontmatter("review_due")],
      ["active.md", frontmatter("active")],
      ["legacy.md", "# Legacy"],
      ["historical.md", frontmatter("historical")],
    ]);
    const readFile = vi.fn(async ({ relPath }: { relPath: string }) => ({
      text: content.get(relPath) ?? "",
    }));

    const result = await filterCurrentSemanticLifecycle({
      query: "current state",
      hits,
      readFile,
    });

    expect(result.map((entry) => entry.path)).toEqual([
      "active.md",
      "review.md",
      "legacy.md",
      "sessions/one.jsonl",
    ]);
    expect(readFile).toHaveBeenCalledTimes(5);
  });

  it("preserves original results when current lifecycle filtering is not requested", async () => {
    const hits = [hit("historical.md", 0.9)];
    const readFile = vi.fn();
    await expect(
      filterCurrentSemanticLifecycle({ query: "show history", hits, readFile }),
    ).resolves.toBe(hits);
    expect(readFile).not.toHaveBeenCalled();
  });
});
