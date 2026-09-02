import { describe, expect, it } from "vitest";
import { formatToolDetail, resolveToolDisplay } from "./tool-display.js";

const cases = [
  ["rg --files autonomy .openclaw 2>/dev/null", "list files in .openclaw"],
  ["rg --files -g '*.ts'", "list files"],
  ["rg --files -t ts src", "list files in src"],
  ["rg --files --glob=*.ts src", "list files in src"],
  ["rg -- --files src", 'search "--files" in src'],
  ["rg -e --files src", 'search "--files" in src'],
  ["rg needle src 2>/dev/null", 'search "needle" in src'],
  ["rg needle src 2> /dev/null", 'search "needle" in src'],
  ["rg needle src>/dev/null", 'search "needle" in src'],
  ["rg needle src 2>&1", 'search "needle" in src'],
  ["rg needle src >|out", 'search "needle" in src'],
  ["rg '2>/dev/null' README.md", 'search "2>/dev/null" in README.md'],
  [String.raw`rg 2\>literal README.md`, 'search "2>literal" in README.md'],
  ["rg -e needle src", 'search "needle" in src'],
  ["rg -ne'needle' src", 'search "needle" in src'],
  ["rg -f patterns src", "search text in src"],
  ["grep -E -e needle src", 'search "needle" in src'],
  ["rg -E utf8 needle src", 'search "needle" in src'],
  ["cat >out <<EOF\nsynthetic body\nEOF", "show output"],
  ["head -n 2 source > out", "show first 2 lines of source"],
  ["cp 2>err source destination", "copy source to destination"],
  ["tail source 2>&1", "show source"],
] as const;

describe("exec search and redirect display", () => {
  it.each(cases)("summarizes %s", (command, expected) => {
    expect(
      formatToolDetail(
        resolveToolDisplay({ name: "exec", args: { command }, detailMode: "explain" }),
      ),
    ).toBe(expected);
  });
  it("preserves the original command in raw detail mode", () => {
    const command = "rg needle src 2> /dev/null";
    const detail = formatToolDetail(
      resolveToolDisplay({ name: "bash", args: { command }, detailMode: "raw" }),
    );
    expect(detail).toContain('search "needle" in src');
    expect(detail).toContain(command);
  });
});
