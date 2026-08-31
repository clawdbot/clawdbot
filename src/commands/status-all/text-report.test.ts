// Text report tests cover mixed raw, line, and table section rendering order for status-all output.
import { describe, expect, it } from "vitest";
import { appendStatusReportSections } from "./text-report.js";

describe("appendStatusReportSections", () => {
  it("renders mixed raw, line, and table sections in order", () => {
    const lines: string[] = ["# Start"];

    appendStatusReportSections({
      lines,
      heading: (text) => `# ${text}`,
      sections: [
        {
          kind: "raw",
          body: ["", "raw note"],
        },
        {
          kind: "lines",
          title: "Overview",
          body: ["overview body"],
        },
        {
          kind: "table",
          title: "Health",
          width: 120,
          renderTable: ({ rows }) => `table:${rows.length}`,
          columns: [{ key: "Item", header: "Item" }],
          rows: [{ Item: "Gateway" }],
          trailer: "trailer",
        },
        {
          kind: "lines",
          title: "Skipped",
          body: [],
          skipIfEmpty: true,
        },
      ],
    });

    expect(lines).toEqual([
      "# Start",
      "",
      "raw note",
      "",
      "# Overview",
      "overview body",
      "",
      "# Health",
      "table:1",
      "trailer",
    ]);
  });
});
