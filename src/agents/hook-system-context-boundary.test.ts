// Covers attribution boundaries around plugin-injected system context.
import { describe, expect, it } from "vitest";
import { wrapPluginSystemContextSection } from "./hook-system-context-boundary.js";

function wrappedPluginSystemContext(text: string): string {
  // The boundary text makes injected context explicit to the model so plugin
  // instructions are not mistaken for workspace file content.
  return `---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\n${text}\n\n---`;
}

describe("wrapPluginSystemContextSection", () => {
  it("wraps plugin system context with an attribution boundary", () => {
    expect(wrapPluginSystemContextSection("## Custom Rules\n\nFoo bar baz.")).toBe(
      wrappedPluginSystemContext("## Custom Rules\n\nFoo bar baz."),
    );
  });

  it("normalizes whitespace before wrapping", () => {
    expect(wrapPluginSystemContextSection("  prepend line  \r\nsecond line\t\r\n")).toBe(
      wrappedPluginSystemContext("prepend line\nsecond line"),
    );
  });

  it("drops empty plugin system context", () => {
    expect(wrapPluginSystemContextSection(" \n\t ")).toBeUndefined();
    expect(wrapPluginSystemContextSection()).toBeUndefined();
  });
});
