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

  it("keeps mobile PWA composer controls above under-reported safe areas", () => {
    const css = readLayoutCss();

    expect(css).toContain("margin: 0 8px calc(14px + var(--safe-area-bottom));");
    expect(css).toContain("@media (display-mode: standalone) and (max-width: 768px)");
    expect(css).toContain("margin-bottom: calc(14px + max(var(--safe-area-bottom), 34px));");
  });

  it("keeps desktop chat header controls on a compact aligned rhythm", () => {
    const css = readLayoutCss();

    expect(css).toContain("min-height: 36px;");
    expect(css).toContain("height: 36px;");
    expect(css).toContain(".chat-controls .btn--icon {");
    expect(css).toContain("width: 36px;");
    expect(css).toContain(".chat-controls__separator {");
    expect(css).toContain("height: 22px;");
  });

  it("keeps composer controls labeled and large enough without shrinking mobile taps", () => {
    const css = readLayoutCss();

    expect(css).toContain(".agent-chat__control-label");
    expect(css).toContain("min-width: 36px;");
    expect(css).toContain("height: 36px;");
    expect(css).toContain("@media (max-width: 860px)");
    expect(css).toContain("width: 44px;");
  });
});
