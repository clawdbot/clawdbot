import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function readTerminalCss() {
  // This test is intentionally simple: it guards against regressions where the
  // docs header stops being sticky because sticky elements live inside an
  // overflow-clipped container.
  const path = join(process.cwd(), "docs", "assets", "terminal.css");
  return readFileSync(path, "utf8");
}

describe("docs terminal.css", () => {
  test("keeps the docs header sticky (shell is sticky)", () => {
    const css = readTerminalCss();
    expect(css).toMatch(/\.shell\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*\}/s);
  });

  test("does not rely on making body overflow visible", () => {
    const css = readTerminalCss();
    expect(css).not.toMatch(/body\s*\{[^}]*overflow-x:\s*visible;[^}]*\}/s);
  });

  test("does not make the terminal frame overflow visible (can break layout)", () => {
    const css = readTerminalCss();
    expect(css).not.toMatch(/\.shell__frame\s*\{[^}]*overflow:\s*visible;[^}]*\}/s);
  });
});
