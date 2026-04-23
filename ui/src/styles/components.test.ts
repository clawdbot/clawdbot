import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("agent fallback chip styles", () => {
  it("styles the chip remove control inside the agent model input", () => {
    const css = readFileSync(new URL("./components.css", import.meta.url), "utf8");

    expect(css).toContain(".agent-chip-input .chip {");
    expect(css).toContain(".agent-chip-input .chip-remove {");
    expect(css).toContain(".agent-chip-input .chip-remove:hover:not(:disabled)");
    expect(css).toContain(".agent-chip-input .chip-remove:focus-visible:not(:disabled)");
    expect(css).toContain("outline: 2px solid var(--accent);");
    expect(css).toContain("outline-offset: 2px;");
    expect(css).toContain(".agent-chip-input .chip-remove:disabled");
  });
});
