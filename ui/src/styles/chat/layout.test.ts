import { describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";

function readLayoutCss(): string {
  return readStyleSheet("ui/src/styles/chat/layout.css");
}

function readBaseCss(): string {
  return readStyleSheet("ui/src/styles/base.css");
}

describe("chat layout styles", () => {
  it("styles queued-message steering controls and pending indicators", () => {
    const css = readLayoutCss();

    expect(css).toContain(".chat-queue__steer");
    expect(css).toContain(".chat-queue__actions");
    expect(css).toContain(".chat-queue__item--steered");
    expect(css).toContain(".chat-queue__badge");
  });

  it("includes assistant text avatar styles for configured IDENTITY avatars", () => {
    const css = readLayoutCss();

    expect(css).toContain(".agent-chat__avatar--text");
    expect(css).toContain("font-size: 20px;");
    expect(css).toContain("place-items: center;");
  });

  it("keeps composer text scale-driven while preserving mobile input zoom safety", () => {
    const css = readLayoutCss();
    const baseCss = readBaseCss();

    expect(baseCss).toContain(
      "--control-ui-input-text-size: max(16px, calc(14px * var(--control-ui-text-scale)));",
    );
    expect(css).toContain("font-size: var(--control-ui-input-text-size);");
    expect(css).toContain(".agent-chat__composer-combobox > textarea");
    expect(css).toContain(".chat-compose .chat-compose__field textarea");
  });
});
