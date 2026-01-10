import { describe, expect, it } from "vitest";

import { renderTable } from "./table.js";

describe("renderTable", () => {
  it("prefers shrinking flex columns to avoid wrapping non-flex labels", () => {
    const out = renderTable({
      width: 40,
      columns: [
        { key: "Item", header: "Item", minWidth: 10 },
        { key: "Value", header: "Value", flex: true, minWidth: 24 },
      ],
      rows: [{ Item: "Dashboard", Value: "http://127.0.0.1:18789/" }],
    });

    expect(out).toContain("Dashboard");
    expect(out).toMatch(/│ Dashboard\s+│/);
  });
});
