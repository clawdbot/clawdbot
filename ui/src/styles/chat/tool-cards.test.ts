import { describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";

function readToolCardsCss(): string {
  return readStyleSheet("ui/src/styles/chat/tool-cards.css");
}

describe("chat tool card styles", () => {
  it("keeps collapsed tool summaries readable without premature ellipsis", () => {
    const css = readToolCardsCss();

    expect(css).toContain(".chat-tool-msg-summary {");
    expect(css).toContain("flex-wrap: wrap;");
    expect(css).toContain("font-size: var(--control-ui-text-sm);");
    expect(css).toContain("color: var(--text);");
    expect(css).toMatch(/\.chat-tool-msg-summary__names\s*,/);
    expect(css).toContain(".chat-tool-msg-summary__preview");
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
