/**
 * Regression coverage for grep/ripgrep exec display summaries.
 * Keeps redirects and `--files` from being mistaken for search targets.
 */
import { describe, expect, it } from "vitest";
import { formatToolDetail, resolveToolDisplay } from "./tool-display.js";

function detailFor(command: string): string {
  return formatToolDetail(
    resolveToolDisplay({ name: "exec", args: { command }, detailMode: "explain" }),
  );
}

describe("exec search display", () => {
  it("does not treat a shell redirect as the search target", () => {
    // `2>/dev/null` is not a positional path. Treating it as one produced summaries
    // like `search "autonomy" in 2>/dev/null`, which read as though the agent had
    // searched a file named `2>/dev/null`.
    for (const [command, expected] of [
      ['rg "foo" src/agents 2>/dev/null', 'search "foo" in src/agents'],
      ['rg "foo" src/agents >/dev/null', 'search "foo" in src/agents'],
      ['rg "foo" src/agents 2>&1', 'search "foo" in src/agents'],
    ]) {
      expect(detailFor(command)).toBe(expected);
    }
  });

  it("treats `rg --files` as a file listing, not a pattern search", () => {
    // With --files ripgrep takes no pattern; every positional is a path. Reading the
    // first positional as a pattern produced `search "autonomy" in 2>/dev/null`.
    for (const [command, expected] of [
      ["rg --files autonomy", "list files in autonomy"],
      ["rg --files autonomy .openclaw 2>/dev/null", "list files in .openclaw"],
      ["rg --files", "list files"],
    ]) {
      expect(detailFor(command)).toBe(expected);
    }
  });

  it("keeps ordinary search summaries unchanged", () => {
    for (const [command, expected] of [
      ['rg "foo|bar" src/agents', 'search "foo|bar" in src/agents'],
      // `-e` supplies the pattern, so `somefile` is the only positional and there is
      // no second one to use as a target.
      ["grep -e pattern somefile", 'search "pattern"'],
    ]) {
      expect(detailFor(command)).toBe(expected);
    }
  });
});
