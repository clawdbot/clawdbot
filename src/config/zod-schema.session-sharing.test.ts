import { describe, expect, it } from "vitest";
import { SessionSchema } from "./zod-schema.session.js";

describe("SessionSchema sharing policy", () => {
  it("accepts the three additive mode gates", () => {
    expect(
      SessionSchema.parse({
        sharing: { readOnly: false, suggest: true, drafts: false },
      }),
    ).toEqual({ sharing: { readOnly: false, suggest: true, drafts: false } });
  });

  it("rejects additional sharing knobs", () => {
    expect(SessionSchema.safeParse({ sharing: { default: "draft" } }).success).toBe(false);
  });
});
