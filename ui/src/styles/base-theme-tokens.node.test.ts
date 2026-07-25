import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const undefinedTokenMappings = {
  "bg-subtle": "bg-muted",
  "border-subtle": "border",
  fg: "text",
  foreground: "text",
  surface: "panel",
  "text-muted": "muted",
} as const;

function collectCssFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectCssFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".css") ? [entryPath] : [];
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
    const violations = collectCssFiles(stylesDir).flatMap((filePath) =>
      fs
        .readFileSync(filePath, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          referencePattern.test(line)
            ? [`${path.relative(stylesDir, filePath)}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );

    expect(violations).toEqual([]);
  });
});
