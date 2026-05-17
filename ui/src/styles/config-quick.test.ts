import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cssPath = [
  resolve(process.cwd(), "ui/src/styles/config-quick.css"),
  resolve(process.cwd(), "..", "ui/src/styles/config-quick.css"),
].find((candidate) => existsSync(candidate));
if (!cssPath) {
  throw new Error(`config-quick.css not found from cwd: ${process.cwd()}`);
}
const css = readFileSync(cssPath, "utf8");

describe("config-quick styles", () => {
  it("includes the local user identity quick-settings styles", () => {
    expect(css).toContain(".qs-identity-grid");
    expect(css).toContain(".qs-identity-card__source");
    expect(css).toContain(".qs-identity-card__issue");
    expect(css).toContain(".qs-identity-card__repair");
    expect(css).toContain(".qs-identity-card__error");
    expect(css).toContain(".qs-assistant-avatar");
    expect(css).toContain(".qs-user-avatar");
    expect(css).toContain(".qs-card--personal");
  });

  it("includes the dashboard quick-settings density layout", () => {
    expect(css).toContain(".qs-card--model");
    expect(css).toContain(".qs-card--automations");
    expect(css).toContain(".qs-side-stack");
    expect(css).toContain("grid-template-rows: auto 1fr;");
    expect(css).toContain(".qs-identity-card__actions");
    expect(css).toContain("grid-template-columns: repeat(12, minmax(0, 1fr));");
    expect(css).toContain("grid-column: 1 / -1;");
    expect(css).toContain("grid-column: span 4;");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
    expect(css).toContain("align-items: stretch;");
    expect(css).toContain("display: contents;");
    expect(css).toContain(".qs-card--appearance {\n    order: 4;");
    expect(css).toContain(".qs-card--appearance");
    expect(css).toContain("order: 4");
    expect(css).toContain(".qs-card--automations");
    expect(css).toContain("order: 6");
  });

  it("includes explicit context profile layout hooks", () => {
    expect(css).toContain(".qs-profiles");
    expect(css).toContain(".qs-profile-state--pending");
    expect(css).toContain(".qs-profile-panel__actions-row");
  });

  it("keeps settings section tabs padded away from scoped page content", () => {
    expect(css).toContain("padding: 24px 16px 16px;");
    expect(css).toContain("padding: 16px 0 12px;");
  });

  it("keeps settings section icons on the current text color", () => {
    expect(css).toMatch(
      /\.settings-section-nav__icon svg \{[\s\S]*stroke: currentColor;[\s\S]*fill: none;/,
    );
    expect(css).toMatch(
      /\.settings-section-nav__icon svg \* \{[\s\S]*stroke: currentColor;[\s\S]*fill: none;/,
    );
  });

  it("avoids transition-all in the quick settings surface", () => {
    expect(css).not.toContain("transition: all");
  });
});
