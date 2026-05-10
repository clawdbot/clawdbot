import { describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";

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
    expect(componentsCss).toContain(".session-status-badge {");
    expect(componentsCss).toContain(".sessions-table tbody tr.session-data-row > td {");
    expect(componentsCss).toContain(".session-runtime-cell .mono {");
    expect(componentsCss).toContain("text-overflow: ellipsis;");
    expect(componentsCss).toContain(".session-details-panel {");
    expect(componentsCss).not.toContain(".session-checkpoint-toggle {");
    expect(mobileCss).toContain(".data-table.sessions-table {\n    min-width: 560px;");
    expect(mobileCss).toContain(
      ".sessions-table th:nth-child(12),\n  .sessions-table td:nth-child(12),\n  .sessions-table th:nth-child(13),\n  .sessions-table td:nth-child(13)",
    );
    expect(mobileCss).toContain(
      ".sessions-table th:nth-child(4),\n  .sessions-table td:nth-child(4),\n  .sessions-table th:nth-child(11),\n  .sessions-table td:nth-child(11)",
    );
    expect(mobileCss).toContain(
      ".sessions-table th:nth-child(3),\n  .sessions-table td:nth-child(3),\n  .sessions-table th:nth-child(10),\n  .sessions-table td:nth-child(10)",
    );
    expect(mobileCss).toContain(
      ".sessions-table th:nth-child(6),\n  .sessions-table td:nth-child(6),\n  .sessions-table th:nth-child(7),\n  .sessions-table td:nth-child(7)",
    );
    expect(mobileCss).toContain(".data-table.sessions-table .data-table-key-col {");
    expect(mobileCss).toContain(".sessions-table .session-status-col {");
    expect(mobileCss).not.toContain(
      ".sessions-table th:nth-child(5),\n  .sessions-table td:nth-child(5)",
    );
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
