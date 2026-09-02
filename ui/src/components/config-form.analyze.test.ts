// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { analyzeConfigSchema } from "./config-form.analyze.ts";

describe("analyzeConfigSchema", () => {
  it("keeps Zod format-constrained strings form-editable and preserves their annotations", () => {
    const schema = z.toJSONSchema(
      z.object({
        relayUrl: z
          .string()
          .regex(/^https?:\/\//)
          .url(),
        email: z.email(),
        consentedAt: z.string().datetime(),
      }),
    );

    const analysis = analyzeConfigSchema(schema);

    expect(analysis.unsupportedPaths).toEqual([]);
    expect(analysis.schema?.properties).toMatchObject({
      relayUrl: { type: "string", format: "uri", pattern: expect.any(String) },
      email: { type: "string", format: "email", pattern: expect.any(String) },
      consentedAt: { type: "string", format: "date-time" },
    });
  });
});
