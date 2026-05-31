import { describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";

function readToolCardsCss(): string {
  return readStyleSheet("ui/src/styles/chat/tool-cards.css");
}

describe("chat tool card styles", () => {
  it("keeps collapsed tool summaries readable without premature ellipsis", () => {
    const css = readToolCardsCss();
    const summaryRule = css.match(/\.chat-tool-msg-summary\s*\{[^}]*\}/)?.[0] ?? "";

    expect(css).toContain(".chat-tool-msg-summary {");
    expect(css).toContain("align-items: center;");
    expect(css).toContain("align-content: center;");
    expect(css).toContain(".chat-bubble--tool-shell > .chat-tool-msg-collapse {\n  margin-top: 0;");
    expect(css).toContain("flex-wrap: wrap;");
    expect(css).toContain("gap: 12px;");
    expect(css).toContain("font-size: var(--control-ui-text-sm);");
    expect(css).toContain(
      ".chat-tool-msg-summary svg,\n.chat-tool-msg-summary__icon {\n  flex-shrink: 0;",
    );
    expect(css).toContain(
      ".chat-tool-msg-summary span {\n  display: inline-flex;\n  align-items: center;\n  line-height: var(--control-ui-text-sm);",
    );
    expect(summaryRule).toContain("font-family: inherit;");
    expect(summaryRule).not.toContain("font: inherit;");
    expect(css).toContain("color: var(--text);");
    expect(css).toMatch(/\.chat-tool-msg-summary__names\s*,/);
    expect(css).toContain(".chat-tool-msg-summary__preview");
    expect(css).toContain("font-size: var(--control-ui-text-sm);");
    expect(css).toContain("transform: translateY(0.8px);");
    expect(css).toContain("flex: 0 1 auto;");
    expect(css).toContain("height: 20px;");
    expect(css).toContain("min-height: 20px;");
    expect(css).not.toContain(".chat-tool-msg-summary__names {\n  text-align: center;");
    expect(css).toContain("overflow-wrap: anywhere;");
    expect(css).toContain("text-overflow: clip;");
    expect(css).toContain("white-space: normal;");
    expect(css).not.toContain("max-width: 42%;");
  });

  it("keeps expanded tool cards and actions usable on narrow screens", () => {
    const css = readToolCardsCss();

    expect(css).toContain(".chat-tool-card--expanded {");
    expect(css).toContain("max-height: none;");
    expect(css).toContain("overflow: hidden;");
    expect(css).toContain("white-space: nowrap;");
    expect(css).toContain(".chat-tool-card__block-content code");
  });
});
