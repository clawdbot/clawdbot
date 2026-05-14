import { describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";

function readUsageCss(): string {
  return readStyleSheet("ui/src/styles/usage.css");
}

describe("usage styles", () => {
  it("keeps touch-primary usage text controls large enough to avoid iOS focus zoom", () => {
    const css = readUsageCss();

    expect(css).toMatch(
      /@media \(hover: none\) and \(pointer: coarse\) \{[\s\S]*\.usage-date-input,[\s\S]*\.usage-select,[\s\S]*\.usage-query-input,[\s\S]*\.usage-filters-inline select,[\s\S]*\.usage-filters-inline input\[type="text"\] \{[\s\S]*font-size: 16px;/,
    );
  });
});
