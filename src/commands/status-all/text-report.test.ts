// Text report tests cover mixed raw, line, and table section rendering order for status-all output.
import { describe, expect, it } from "vitest";
import { appendStatusReportSections } from "./text-report.js";

describe("appendStatusReportSections", () => {
  it("renders mixed raw, line, and table sections in order", () => {
    const lines: string[] = ["# Start"];

    appendStatusReportSections({
      lines,
      heading: (text) => `# ${text}`,
      width: 120,
      renderTable: ({ width, rows }) => `  table:${width}:${rows.length} \n\t`,
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
          columns: [{ key: "Item", header: "Item" }],
          rows: [{ Item: "Gateway" }],
          trailer: "trailer  ",
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
      "  table:120:1",
      "trailer  ",
    ]);
  });

  it.each([{ initial: [] }, { initial: ["# Start"] }, { initial: ["# Start", ""] }])(
    "keeps empty sections unless explicitly skipped after $initial",
    ({ initial }) => {
      const lines = [...initial];
      appendStatusReportSections({
        lines,
        heading: (text) => `# ${text}`,
        width: 80,
        renderTable: ({ width, rows }) => `table:${width}:${rows.length}\n`,
        sections: [
          { kind: "raw", body: [], skipIfEmpty: true },
          { kind: "lines", title: "Skipped", body: [], skipIfEmpty: true },
          {
            kind: "table",
            title: "Skipped table",
            columns: [],
            rows: [],
            skipIfEmpty: true,
            trailer: "skipped trailer",
          },
          { kind: "lines", title: "Empty lines", body: [] },
          { kind: "raw", body: [] },
          {
            kind: "table",
            title: "Empty table",
            columns: [],
            rows: [],
            trailer: "empty trailer",
          },
          {
            kind: "table",
            title: "More rows",
            columns: [{ key: "Item", header: "Item" }],
            rows: [{ Item: "Gateway" }],
            skipIfEmpty: true,
            trailer: "",
          },
        ],
      });
      expect(lines).toEqual([
        ...initial,
        ...(initial.length ? [""] : []),
        "# Empty lines",
        "",
        "# Empty table",
        "table:80:0",
        "empty trailer",
        "",
        "# More rows",
        "table:80:1",
      ]);
    },
  );
});
