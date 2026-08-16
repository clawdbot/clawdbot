/** Tests compact tool metadata formatting for auto-reply progress output. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { formatToolAggregate, formatToolAggregateParts } from "./tool-meta.js";

// Use path.resolve so inputs match the resolved HOME on every platform.
const home = path.resolve("/Users/test");

function withHome<T>(run: () => T): T {
  return withEnv({ HOME: home }, run);
}

describe("tool meta formatting", () => {
  it("shortens home paths with optional colon suffix", () => {
    withHome(() => {
      expect(formatToolAggregate("fs", [`${home}/a.txt`])).toContain("~/a.txt");
      expect(formatToolAggregate("fs", [`${home}/a.txt:12`])).toContain("~/a.txt:12");
      expect(formatToolAggregate("exec", [`cd ${home}/dir && ls`])).toContain("cd ~/dir && ls");
      expect(formatToolAggregate("fs", [""])).toBe("🧩 Fs");
    });
  });

  it("formats aggregates with grouping and brace-collapse", () => {
    withHome(() => {
      const out = formatToolAggregate("  fs  ", [
        `${home}/dir/a.txt`,
        `${home}/dir/b.txt`,
        "note",
        "a→b",
      ]);
      expect(out).toMatch(/^🧩 Fs/);
      expect(out).toContain("~/dir/{a.txt, b.txt}");
      expect(out).toContain("note");
      expect(out).toContain("a→b");
    });
  });

  it("wraps aggregate meta in backticks when markdown is enabled", () => {
    withHome(() => {
      const out = formatToolAggregate("fs", [`${home}/dir/a.txt`], { markdown: true });
      expect(out).toContain("`~/dir/a.txt`");
    });
  });

  it("uses a longer inline code delimiter when meta contains backticks", () => {
    const out = formatToolAggregate("fs", ["name `with` ticks"], { markdown: true });
    expect(out).toBe("🧩 Fs: ``name `with` ticks``");
  });

  it("keeps exec flags outside markdown and moves them to the front", () => {
    withHome(() => {
      const out = formatToolAggregate("exec", [`cd ${home}/dir && gemini 2>&1 · elevated`], {
        markdown: true,
      });
      expect(out).toBe("🛠️ elevated · `cd ~/dir && gemini 2>&1`");
    });
  });
});

describe("formatToolAggregateParts plain mode", () => {
  it("emits plain sentences without tool chrome", () => {
    const result = formatToolAggregateParts(
      "exec",
      ["I'm checking the current state of the project."],
      { detailMode: "plain" },
    );
    expect(result.text).toBe("I'm checking the current state of the project.");
    expect(result.text).not.toContain("🛠️");
    expect(result.text).not.toContain("Bash");
  });

  it("rejects technical meta and falls back to a generic sentence", () => {
    const result = formatToolAggregateParts(
      "exec",
      ["check git status (repo)", "cd /workspace && npm test"],
      { detailMode: "plain" },
    );
    expect(result.text).toBe("I'm using an internal tool to continue the work.");
    expect(result.text).not.toContain("git");
    expect(result.text).not.toContain("/workspace");
    expect(result.text).not.toContain("(repo)");
  });
});
