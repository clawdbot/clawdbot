import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { splitAnsiSegments } from "../../../packages/terminal-core/src/ansi-sequences.js";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { ToolExecutionComponent } from "./tool-execution.js";

const MAX_COLLAPSED_COMPONENT_LINES = 17;

function renderToolOutput(text: string, width: number) {
  const component = new ToolExecutionComponent("read_file", { path: "example.txt" });
  component.setResult({ content: [{ type: "text", text }] });
  return { component, lines: component.render(width) };
}

describe("ToolExecutionComponent", () => {
  it.each(
    [
      { source: "    # heading\n    command --flag", literal: "# heading" },
      { source: "    > quoted source\n    next line", literal: "> quoted source" },
      { source: "    - source item\n      nested", literal: "- source item" },
    ].flatMap(({ source, literal }) => [
      { source, literal, phase: "partial", complete: false },
      { source, literal, phase: "final", complete: true },
    ]),
  )("preserves indented $literal in $phase tool output", ({ source, literal, complete }) => {
    const component = new ToolExecutionComponent("read_file", { path: "example.txt" });
    const result = { content: [{ type: "text", text: source }] };
    if (complete) {
      component.setResult(result);
    } else {
      component.setPartialResult(result);
    }

    const rendered = component.render(80).map(normalizeTestText).join("\n");
    expect(rendered).toContain("```");
    expect(rendered).toContain(literal);
  });

  it.each([
    { phase: "partial", complete: false },
    { phase: "final", complete: true },
  ])("keeps whitespace-only $phase tool output visually empty", ({ complete }) => {
    const component = new ToolExecutionComponent("read_file", { path: "example.txt" });
    const result = { content: [{ type: "text", text: "   \n  " }] };
    if (complete) {
      component.setResult(result);
    } else {
      component.setPartialResult(result);
    }

    const rendered = component.render(80).map(normalizeTestText).join("\n");
    expect(rendered.includes("...")).toBe(!complete);
  });

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

  it("sanitizes a complete OSC before applying the collapsed preview budget", () => {
    const payload = "T08_OSC52_PREVIEW_SECRET";
    const prefix = `${"x ".repeat(112)}x`;
    const attack = `\x1b]52;c;${payload}\x07`;
    const { lines } = renderToolOutput(`${prefix}${attack} visible tail`, 20);
    const raw = lines.join("\n");

    expect(raw).not.toContain(payload);
    expect(raw).not.toContain("]52;c;");
    expect(raw).not.toContain("\x1b]52");
  });

  it.each([
    { route: "live", complete: false },
    { route: "history", complete: true },
  ])("sanitizes a hostile $route tool title before trusted styling", ({ complete }) => {
    const attack = "\x1b]52;c;T08TOOLCLIPBOARD\x07";
    const toolName = `T08TOOLA${attack}T08TOOLB\r\nمرحبا\tשלום`;
    const component = new ToolExecutionComponent(toolName, {});
    if (complete) {
      component.setResult({ content: [] });
    }

    const raw = component.render(120).join("\n");
    const rendered = normalizeTestText(raw);
    expect(rendered).toContain("T08TOOLAT08TOOLB");
    expect(rendered).toContain("مرحبا שלום");
    expect(raw).toContain("\u2067");
    expect(raw).toContain("\u2069");
    expect(raw).not.toContain(attack);
    expect(raw).not.toContain("\r\nمرحبا\tשלום");
  });

  it("parses sanitized RTL tool Markdown before isolating rendered OSC8 lines", () => {
    const attack = "\x1b]52;c;T08_TOOL_RESULT\x07";
    const url = "https://example.test/tui/tool-result";
    const source = `\u202e# مرحبا\u202c\n\n\u200f> שלום\n\n\u2066- عنصر ${url}\u2069${attack}`;
    const { lines } = renderToolOutput(source, 120);
    const raw = lines.join("\n");
    const normalized = normalizeTestText(raw).replace(/[\u2067\u2069]/gu, "");
    const linkedRtl = lines.find((line) => line.includes("عنصر") && line.includes("\x1b]8;;"));
    const targets = splitAnsiSegments(raw).flatMap((segment) => {
      if (segment.kind !== "ansi" || !segment.value.startsWith("\x1b]8;;")) {
        return [];
      }
      const end = segment.value.endsWith("\x1b\\") ? -2 : -1;
      const target = segment.value.slice("\x1b]8;;".length, end);
      return target ? [target] : [];
    });

    expect(normalized).toContain("مرحبا");
    expect(normalized).not.toContain("# مرحبا");
    expect(normalized).toContain("│ שלום");
    expect(normalized).toContain("- عنصر");
    expect(raw).not.toContain(attack);
    expect(raw).not.toMatch(/[\u200f\u202e\u2066]/u);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((target) => target === url)).toBe(true);
    expect(linkedRtl?.indexOf("\u2067")).toBeLessThan(linkedRtl?.indexOf("\x1b]8;;") ?? -1);
    expect(linkedRtl?.indexOf("\u2069")).toBeGreaterThan(linkedRtl?.lastIndexOf("\x1b]8;;") ?? -1);
  });
});
