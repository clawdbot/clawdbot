import { describe, expect, it } from "vitest";
import { AgentsSchema } from "./zod-schema.agents.js";

describe("agent roster defaults", () => {
  it("rejects an empty roster after load-time migration", () => {
    expect(AgentsSchema.safeParse({ entries: {} }).success).toBe(false);
  });

  it("requires exactly one default in a non-empty roster", () => {
    expect(AgentsSchema.safeParse({ entries: { alpha: { default: true } } }).success).toBe(true);
    for (const entries of [{ alpha: {} }, { alpha: { default: true }, beta: { default: true } }]) {
      const result = AgentsSchema.safeParse({ entries });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["entries"] }));
      }
    }
  });
});
