/** Tests compact tool metadata formatting for auto-reply progress output. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { formatToolAggregate } from "./tool-meta.js";

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

  it("still groups path-shaped metadata by directory", () => {
    expect(formatToolAggregate("fs", ["/tmp/dir/a.txt", "/tmp/dir/b.txt"])).toBe(
      "🧩 Fs: /tmp/dir/{a.txt, b.txt}",
    );
    expect(formatToolAggregate("fs", ["/only"])).toBe("🧩 Fs: /only");
  });

  it("stays responsive on path-shaped metadata that ends in a tab", () => {
    // `(\/[^\s]+)+` split the tail ambiguously and backtracked exponentially
    // once the value ended in whitespace the earlier checks do not reject.
    const meta = `/${"!/".repeat(30)}\t`;
    const started = process.hrtime.bigint();
    const out = formatToolAggregate("fs", [meta]);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(out).toContain(meta);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
