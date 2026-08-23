// Control UI tests cover the cursor policy's source-level shape.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));

const APP_LIKE_MODES = ["standalone", "minimal-ui", "window-controls-overlay"] as const;
/** `<html>` markers the native app hosts stamp; they report display-mode browser. */
const NATIVE_HOST_MARKERS = [
  "openclaw-native-macos",
  "openclaw-native-nav",
  "openclaw-native-web-chrome",
] as const;

function collectStyleSources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : collectStyleSources(entryPath);
    }
    if (!entry.isFile() || entry.name.includes(".test.")) {
      return [];
    }
    return entry.name.endsWith(".css") || entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

/** Walks back from a declaration line to the selector list that owns it. */
function selectorFor(lines: readonly string[], declarationIndex: number): string {
  const parts: string[] = [];
  for (let index = declarationIndex - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.endsWith("{")) {
      parts.unshift(line.slice(0, -1).trim());
      for (let above = index - 1; above >= 0 && lines[above]?.trim().endsWith(","); above -= 1) {
        parts.unshift(lines[above]!.trim());
      }
      break;
    }
    if (line === "" || line.endsWith("}")) {
      break;
    }
  }
  return parts.join(" ");
}

const ANCHOR_SELECTOR = /(^|[\s,(>~+])a([.#:[]|\b)/u;

describe("Control UI cursor policy", () => {
  it("selects the cursor token by display mode and leaves fullscreen alone", () => {
    const baseCss = fs.readFileSync(path.join(stylesDir, "base.css"), "utf8");

    expect(baseCss).toMatch(/:root\s*\{[^}]*--cursor-action:\s*pointer;/u);

    const appLikeQuery = baseCss.match(
      /@media\s*\(display-mode:[^{]*\{\s*:root\s*\{\s*--cursor-action:\s*default;/u,
    )?.[0];
    expect(appLikeQuery, "base.css must map app-like display modes to the arrow").toBeDefined();
    for (const mode of APP_LIKE_MODES) {
      expect(appLikeQuery).toContain(`display-mode: ${mode}`);
    }
    // `fullscreen` is a transient presentation state any window can enter; the
    // manifest installs this UI as `standalone`, so it never appears here.
    expect(appLikeQuery).not.toContain("fullscreen");
  });

  it("gives the native app hosts the same arrow as an app-like display mode", () => {
    const baseCss = fs.readFileSync(path.join(stylesDir, "base.css"), "utf8");

    const nativeHostRule = baseCss.match(
      /html:is\([^)]*\)\s*\{\s*--cursor-action:\s*default;/u,
    )?.[0];
    expect(nativeHostRule, "base.css must map the native host markers to the arrow").toBeDefined();
    for (const marker of NATIVE_HOST_MARKERS) {
      expect(nativeHostRule).toContain(`.${marker}`);
    }
  });

  it("repeats the same app-like mode list in the pre-boot mount fallback", () => {
    // The fallback ships its own inline stylesheet because it has to render when
    // the bundle fails to load, so the policy is duplicated there on purpose.
    const indexHtml = fs.readFileSync(path.join(stylesDir, "..", "..", "index.html"), "utf8");

    const fallbackQuery = indexHtml.match(
      /@media\s*\(display-mode:[^{]*\{\s*\.mount-fallback__button\s*\{\s*cursor:\s*default;/u,
    )?.[0];
    expect(fallbackQuery, "ui/index.html must keep the fallback on the policy").toBeDefined();
    for (const mode of APP_LIKE_MODES) {
      expect(fallbackQuery).toContain(`display-mode: ${mode}`);
    }

    const fallbackNativeRule = indexHtml.match(
      /html:is\([^)]*\)\s*\.mount-fallback__button\s*\{\s*cursor:\s*default;/u,
    )?.[0];
    expect(
      fallbackNativeRule,
      "ui/index.html must keep the fallback on the native host policy",
    ).toBeDefined();
    for (const marker of NATIVE_HOST_MARKERS) {
      expect(fallbackNativeRule).toContain(`.${marker}`);
    }
  });

  it("keeps the unconditional pointer hand on link rules only", () => {
    const offenders = collectStyleSources(path.join(stylesDir, ".."))
      .flatMap((filePath) => {
        const lines = fs.readFileSync(filePath, "utf8").split("\n");
        return lines.flatMap((line, index) =>
          /^\s*cursor:\s*pointer;\s*$/u.test(line)
            ? [{ file: path.relative(stylesDir, filePath), selector: selectorFor(lines, index) }]
            : [],
        );
      })
      .filter((hit) => !ANCHOR_SELECTOR.test(hit.selector));

    // Controls consume var(--cursor-action); a hardcoded hand is how the policy
    // drifted apart before (92 declarations by the time it was caught).
    expect(offenders).toEqual([]);
  });
});
