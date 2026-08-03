import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { ToolExecutionComponent } from "./tool-execution.js";

const MAX_COLLAPSED_COMPONENT_LINES = 17;

function renderToolOutput(text: string, width: number) {
  const component = new ToolExecutionComponent("read_file", { path: "example.txt" });
  component.setResult({ content: [{ type: "text", text }] });
  return { component, lines: component.render(width) };
}

describe("ToolExecutionComponent", () => {
  it.each([
    { width: 20, characters: 8_192 },
    { width: 20, characters: 16_384 },
    { width: 80, characters: 8_192 },
    { width: 80, characters: 16_384 },
  ])(
    "bounds a $characters-character single-line preview at terminal width $width",
    ({ characters, width }) => {
      const { lines } = renderToolOutput("x".repeat(characters), width);

      expect(lines.length).toBeLessThanOrEqual(MAX_COLLAPSED_COMPONENT_LINES);
      expect(lines.map(normalizeTestText).join("\n")).toContain("...");
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    },
  );

  it.each([
    { label: "wide CJK", text: "表".repeat(8_192), width: 20 },
    { label: "wide CJK", text: "表".repeat(8_192), width: 80 },
    { label: "ANSI-styled text", text: `\u001b[31m${"x".repeat(8_192)}\u001b[0m`, width: 20 },
    { label: "ANSI-styled text", text: `\u001b[31m${"x".repeat(8_192)}\u001b[0m`, width: 80 },
  ])("keeps $label within a $width-column collapsed preview", ({ text, width }) => {
    const { lines } = renderToolOutput(text, width);

    expect(lines.length).toBeLessThanOrEqual(MAX_COLLAPSED_COMPONENT_LINES);
    expect(lines.map(normalizeTestText).join("\n")).toContain("...");
    expect(lines.join("\n")).not.toContain("\uFFFD");
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("retains the complete result when expanding and recollapsing a preview", () => {
    const text = `START_MARKER ${"x".repeat(16_384)} END_MARKER`;
    const { component, lines: collapsed } = renderToolOutput(text, 80);

    expect(collapsed.length).toBeLessThanOrEqual(MAX_COLLAPSED_COMPONENT_LINES);
    expect(collapsed.map(normalizeTestText).join("\n")).not.toContain("END_MARKER");

    component.setExpanded(true);
    const expanded = component.render(80);

    expect(expanded.length).toBeGreaterThan(MAX_COLLAPSED_COMPONENT_LINES);
    expect(expanded.map(normalizeTestText).join("\n")).toContain("START_MARKER");
    expect(expanded.map(normalizeTestText).join("\n")).toContain("END_MARKER");

    component.setExpanded(false);
    const recollapsed = component.render(80);

    expect(recollapsed.length).toBeLessThanOrEqual(MAX_COLLAPSED_COMPONENT_LINES);
    expect(recollapsed.map(normalizeTestText).join("\n")).toContain("...");
    expect(recollapsed.map(normalizeTestText).join("\n")).not.toContain("END_MARKER");
  });

  it("bounds output with more than twelve explicit source lines", () => {
    const text = Array.from({ length: 30 }, (_, index) => `tool output line ${index + 1}`).join(
      "\n",
    );
    const { component, lines } = renderToolOutput(text, 80);

    expect(lines.length).toBeLessThanOrEqual(MAX_COLLAPSED_COMPONENT_LINES);
    expect(lines.map(normalizeTestText).join("\n")).toContain("...");
    expect(lines.map(normalizeTestText).join("\n")).not.toContain("tool output line 30");

    component.setExpanded(true);

    expect(component.render(80).map(normalizeTestText).join("\n")).toContain("tool output line 30");
  });
});
