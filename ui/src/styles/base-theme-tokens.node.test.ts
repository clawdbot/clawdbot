// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const uiSrcDir = path.dirname(stylesDir);
// Every alias name this bug class has produced so far, mapped to the canonical
// token. Undefined names silently drop declarations (or invalidate color-mix),
// so new aliases must be added to base.css, never invented at use sites.
const undefinedTokenMappings = {
  "bg-subtle": "bg-muted",
  "border-subtle": "border",
  fg: "text",
  // Font aliases arrive from surfaces that publish their own token names
  // (canvas widgets, the MCP Apps spec keys in mcp-app-theme.ts); inside
  // Control UI only --mono and --font-body exist.
  "font-mono": "mono",
  "font-sans": "font-body",
  foreground: "text",
  "panel-2": "panel-strong",
  success: "ok",
  surface: "panel",
  "text-muted": "muted",
  warning: "warn",
  "warning-subtle": "warn-subtle",
} as const;

function collectFiles(directory: string, extensions: readonly string[]): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : collectFiles(entryPath, extensions);
    }
    return entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))
      ? [entryPath]
      : [];
  });
}

describe("Control UI base theme tokens", () => {
  it("defines every canonical replacement", () => {
    const baseCss = fs.readFileSync(path.join(stylesDir, "base.css"), "utf8");

    for (const token of new Set(Object.values(undefinedTokenMappings))) {
      expect(baseCss, `missing --${token} in base.css`).toMatch(
        new RegExp(`^\\s*--${token}\\s*:`, "mu"),
      );
    }
  });

  it("does not reference undefined theme token names", () => {
    const undefinedTokens = Object.keys(undefinedTokenMappings);
    const referencePattern = new RegExp(
      `var\\(--(?:${undefinedTokens.join("|")})(?:\\s*\\)|\\s*,)`,
      "u",
    );
    // Inline style attributes and Lit css templates hit this class too
    // (var(--panel-2) shipped in a TS template), so scan all of ui/src.
    const violations = collectFiles(uiSrcDir, [".css", ".ts"])
      .filter((filePath) => !filePath.endsWith(".test.ts"))
      .flatMap((filePath) =>
        fs
          .readFileSync(filePath, "utf8")
          .split("\n")
          .flatMap((line, index) =>
            referencePattern.test(line)
              ? [`${path.relative(uiSrcDir, filePath)}:${index + 1}: ${line.trim()}`]
              : [],
          ),
      );

    expect(violations).toEqual([]);
  });
});
