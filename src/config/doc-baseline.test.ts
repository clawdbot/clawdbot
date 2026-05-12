import { describe, expect, it } from "vitest";
import {
  collectConfigDocBaselineEntries,
  dedupeConfigDocBaselineEntries,
  normalizeConfigDocBaselineHelpPath,
} from "./doc-baseline.js";

describe("config doc baseline", () => {
  it("normalizes array and record paths to wildcard form", () => {
    expect(normalizeConfigDocBaselineHelpPath("agents.list[].skills")).toBe("agents.list.*.skills");
    expect(normalizeConfigDocBaselineHelpPath("session.sendPolicy.rules[0].match.keyPrefix")).toBe(
      "session.sendPolicy.rules.*.match.keyPrefix",
    );
    expect(normalizeConfigDocBaselineHelpPath(".env.*.")).toBe("env.*");
  });

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
    const tupleEntry = new Map(entries.map((entry) => [entry.path, entry])).get("tupleValues.*");

    expect(tupleEntry?.type).toEqual(["number", "string"]);
    expect(tupleEntry?.enumValues).toContain(42);
    expect(tupleEntry?.enumValues).toContain("alpha");
    expect(tupleEntry?.enumValues).toHaveLength(2);
  });
});
