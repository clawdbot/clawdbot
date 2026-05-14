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
});
