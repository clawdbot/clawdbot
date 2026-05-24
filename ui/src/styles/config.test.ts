import { describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";

function readConfigCss(): string {
  return readStyleSheet("ui/src/styles/config.css");
}

describe("config styles", () => {
  it("keeps touch-primary config text controls large enough to avoid iOS focus zoom", () => {
    const css = readConfigCss();

    expect(css).toMatch(
      /@media \(hover: none\) and \(pointer: coarse\) \{[\s\S]*\.config-search__input,[\s\S]*\.settings-theme-import__input,[\s\S]*\.config-raw-field textarea,[\s\S]*\.cfg-input,[\s\S]*\.cfg-input--sm,[\s\S]*\.cfg-textarea,[\s\S]*\.cfg-textarea--sm,[\s\S]*\.cfg-number__input,[\s\S]*\.cfg-select \{[\s\S]*font-size: 16px;/,
    );
  });

  it("keeps the config chrome padded away from the page edge", () => {
    const css = readConfigCss();

    expect(css).toMatch(/\.config-layout \{[\s\S]*margin: 12px 0 0;/);
    expect(css).toMatch(/\.config-actions \{[\s\S]*padding: 14px 24px;/);
    expect(css).toMatch(/\.config-top-tabs \{[\s\S]*padding: 14px 24px 12px;/);
    expect(css).toMatch(/\.config-top-tabs__tab \{[\s\S]*min-height: 36px;/);
    expect(css).not.toContain("margin: 0 -16px -32px");
    expect(css).not.toContain("margin: 0 -8px -16px");
  });

  it("keeps light-mode config select arrows visible", () => {
    const css = readConfigCss();

    expect(css).toMatch(
      /\.cfg-select \{[\s\S]*background-image: url\("data:image\/svg\+xml,[^"]*stroke='%23888'[^"]*"\);[\s\S]*background-repeat: no-repeat;[\s\S]*background-position: right 10px center;/,
    );
    expect(css).toMatch(
      /:root\[data-theme-mode="light"\] \.cfg-select \{[\s\S]*background-color: white;[\s\S]*border-color: var\(--border\);[\s\S]*background-image: url\("data:image\/svg\+xml,[^"]*stroke='%23444'[^"]*"\);/,
    );
  });
});
