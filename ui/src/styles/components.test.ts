import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readComponentsCss(): string {
  const cssPath = [
    resolve(process.cwd(), "ui/src/styles/components.css"),
    resolve(process.cwd(), "..", "ui/src/styles/components.css"),
  ].find((candidate) => existsSync(candidate));
  expect(cssPath).toBeTruthy();
  return readFileSync(cssPath!, "utf8");
}

describe("agent fallback chip styles", () => {
  it("styles the chip remove control inside the agent model input", () => {
    const css = readComponentsCss();

    expect(css).toContain(".agent-chip-input .chip {");
    expect(css).toContain(".agent-chip-input .chip-remove {");
    expect(css).toContain(".agent-chip-input .chip-remove:hover:not(:disabled)");
    expect(css).toContain(".agent-chip-input .chip-remove:focus-visible:not(:disabled)");
    expect(css).toContain("outline: 2px solid var(--accent);");
    expect(css).toContain("outline-offset: 2px;");
    expect(css).toContain(".agent-chip-input .chip-remove:disabled");
  });
});

describe("sessions filter styles", () => {
  it("keeps the expanded sessions filters on one row until the mobile breakpoint", () => {
    const css = readComponentsCss();

    expect(css).toContain(".sessions-filter-bar {\n  display: flex;\n  flex-wrap: wrap;");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain(".sessions-filter-bar {\n    flex-direction: column;");
  });
});

describe("overview access grid styles", () => {
  it("keeps access fields and native controls within the card", () => {
    const css = readComponentsCss();

    expect(css).toContain(
      "grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr));",
    );
    expect(css).toContain(".ov-access-grid .field {\n  min-width: 0;");
    expect(css).toContain(".ov-access-grid .field input,\n.ov-access-grid .field select {");
    expect(css).toContain("box-sizing: border-box;");
    expect(css).toContain("width: 100%;");
  });
});
