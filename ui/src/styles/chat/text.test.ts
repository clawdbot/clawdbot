import { describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";

function readTextCss(): string {
  return readStyleSheet("ui/src/styles/chat/text.css");
}

describe("chat text styles", () => {
  it("uses browser-local text scale variables for message text", () => {
    const css = readTextCss();

    expect(css).toContain("font-size: var(--chat-text-size);");
    expect(css).toContain("font-size: var(--control-ui-text-sm);");
  });
});
