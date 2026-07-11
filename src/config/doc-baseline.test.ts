// Verifies generated config documentation baselines stay stable.
import { describe, expect, it } from "vitest";
import { collectConfigDocBaselineEntries, dedupeConfigDocBaselineEntries } from "./doc-baseline.js";

describe("config doc baseline", () => {
  it("merges tuple item metadata instead of dropping earlier entries", () => {
    const entries = dedupeConfigDocBaselineEntries(
      collectConfigDocBaselineEntries(
        {
          type: "array",
          items: [
            {
              type: "string",
              enum: ["alpha"],
            },
            {
              type: "number",
              enum: [42],
            },
          ],
        },
        {},
        "tupleValues",
      ),
    );
    expect(entries).toEqual([
      {
        path: "tupleValues",
        kind: "core",
        type: "array",
        required: false,
        deprecated: false,
        sensitive: false,
        tags: [],
        hasChildren: true,
      },
      {
        path: "tupleValues.*",
        kind: "core",
        type: ["number", "string"],
        required: false,
        enumValues: ["alpha", 42],
        deprecated: false,
        sensitive: false,
        tags: [],
        hasChildren: false,
      },
    ]);
  });
});
