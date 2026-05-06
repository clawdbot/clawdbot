import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readStyleSheet(path: string): string {
  const cssPath = [resolve(process.cwd(), path), resolve(process.cwd(), "..", path)].find(
    (candidate) => existsSync(candidate),
  );
  expect(cssPath).toBeTruthy();
  return readFileSync(cssPath!, "utf8");
}

function readComponentsCss(): string {
  return readStyleSheet("ui/src/styles/components.css");
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

describe("sessions table responsive styles", () => {
  it("keeps the compaction disclosure and details usable on narrow screens", () => {
    const componentsCss = readComponentsCss();
    const mobileCss = readStyleSheet("ui/src/styles/layout.mobile.css");

    expect(componentsCss).toContain(".session-compaction-cell {");
    expect(componentsCss).toContain(".session-compaction-trigger {");
    expect(componentsCss).toContain(".session-details-panel {");
    expect(componentsCss).not.toContain(".session-checkpoint-toggle {");
    expect(mobileCss).toContain(".data-table.sessions-table {\n    min-width: 540px;");
    expect(mobileCss).toContain(
      ".sessions-table th:nth-child(10),\n  .sessions-table td:nth-child(10),\n  .sessions-table th:nth-child(11),\n  .sessions-table td:nth-child(11)",
    );
    expect(mobileCss).toContain(
      ".sessions-table th:nth-child(4),\n  .sessions-table td:nth-child(4),\n  .sessions-table th:nth-child(9),\n  .sessions-table td:nth-child(9)",
    );
    expect(mobileCss).toContain(
      ".sessions-table th:nth-child(3),\n  .sessions-table td:nth-child(3),\n  .sessions-table th:nth-child(8),\n  .sessions-table td:nth-child(8)",
    );
    expect(mobileCss).toContain(
      ".sessions-table th:nth-child(5),\n  .sessions-table td:nth-child(5)",
    );
    expect(mobileCss).toContain(".data-table.sessions-table .data-table-key-col {");
    expect(mobileCss).not.toContain(".sessions-table th:nth-child(7),");
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
