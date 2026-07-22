import { describe, expect, it } from "vitest";
import { AgentsSchema } from "./zod-schema.agents.js";

describe("agent roster defaults", () => {
  it("rejects an empty roster after load-time migration", () => {
    expect(AgentsSchema.safeParse({ list: [] }).success).toBe(false);
  });

  it("requires exactly one default in a non-empty roster", () => {
    expect(AgentsSchema.safeParse({ list: [{ id: "alpha", default: true }] }).success).toBe(true);
    for (const list of [
      [{ id: "alpha" }],
      [
        { id: "alpha", default: true },
        { id: "beta", default: true },
      ],
    ]) {
      const result = AgentsSchema.safeParse({ list });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["list"] }));
      }
    }
  });
});
