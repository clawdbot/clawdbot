import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("config-quick personal identity styles", () => {
  it("includes the local user identity quick-settings styles", () => {
    const css = readFileSync(new URL("./config-quick.css", import.meta.url), "utf8");

    expect(css).toContain(".qs-personal-preview");
    expect(css).toContain(".qs-user-avatar");
    expect(css).toContain(".qs-personal-actions");
  });

  it("includes the stacked quick-settings density layout", () => {
    const css = readFileSync(new URL("./config-quick.css", import.meta.url), "utf8");

    expect(css).toContain(".qs-stack");
    expect(css).toContain("grid-template-columns: repeat(4, minmax(0, 1fr));");
    expect(css).toContain("@media (max-width: 1380px)");
  });
});
