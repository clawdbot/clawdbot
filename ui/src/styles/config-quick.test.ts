import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./config-quick.css", import.meta.url), "utf8");

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

  it("includes the stacked quick-settings density layout", () => {
    expect(css).toContain(".qs-stack");
    expect(css).toContain(".qs-identity-card__actions");
    expect(css).toContain("grid-template-columns: repeat(3, minmax(0, 1fr));");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
    expect(css).toContain("@media (max-width: 760px)");
  });

  it("includes explicit context profile layout hooks", () => {
    expect(css).toContain(".qs-profiles");
    expect(css).toContain(".qs-profile-state--pending");
    expect(css).toContain(".qs-profile-panel__actions-row");
  });

  it("avoids transition-all in the quick settings surface", () => {
    expect(css).not.toContain("transition: all");
  });
});
