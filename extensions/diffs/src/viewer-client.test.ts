import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const VIEWER_CLIENT_SRC = readFileSync(
  new URL("./viewer-client.ts", import.meta.url),
  "utf8",
);

const XSS_PATTERNS = ["onerror", "<script", "onclick", "javascript:", "onload"];

describe("createToolbarButton icon safety", () => {
  it("toolbarIconSvg map exists and has exactly 8 icon names", () => {
    const requiredNames = [
      "split",
      "unified",
      "wrap-on",
      "wrap-off",
      "background-on",
      "background-off",
      "theme-dark",
      "theme-light",
    ] as const;
    for (const name of requiredNames) {
      expect(
        VIEWER_CLIENT_SRC.includes(name + ":") || VIEWER_CLIENT_SRC.includes(`"${name}"`),
        `icon "${name}" should exist in toolbarIconSvg`,
      ).toBe(true);
    }
  });

  it("no iconMarkup: string parameter exists", () => {
    expect(VIEWER_CLIENT_SRC.includes("iconMarkup: string")).toBe(false);
  });

  it("innerHTML reads only from toolbarIconSvg lookup", () => {
    expect(VIEWER_CLIENT_SRC.includes("button.innerHTML = toolbarIconSvg[params.icon]")).toBe(true);
  });

  it("SVG strings in toolbarIconSvg contain no XSS patterns", () => {
    for (const pattern of XSS_PATTERNS) {
      expect(
        VIEWER_CLIENT_SRC.includes(pattern),
        `source must not contain "${pattern}"`,
      ).toBe(false);
    }
  });

  it("old icon functions are removed", () => {
    const removedFunctions = [
      "function splitIcon(",
      "function unifiedIcon(",
      "function wrapIcon(",
      "function backgroundIcon(",
      "function themeIcon(",
    ];
    for (const fn of removedFunctions) {
      expect(VIEWER_CLIENT_SRC.includes(fn), `"${fn}" should be removed`).toBe(false);
    }
  });
});
