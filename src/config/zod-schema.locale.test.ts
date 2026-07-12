import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { installZodDefaultLocale, OpenClawSchema } from "./zod-schema.js";

function firstIssueMessage(result: z.ZodSafeParseResult<unknown>): string {
  if (result.success) {
    throw new Error("expected parse failure");
  }
  return result.error.issues[0]?.message ?? "";
}

describe("installZodDefaultLocale", () => {
  const previousLocaleError = z.config().localeError;

  afterEach(() => {
    z.config({ localeError: previousLocaleError });
  });

  it("restores real issue messages when the bundled locale registration was tree-shaken", () => {
    // Simulate a built dist: zod@4 is sideEffects:false, so the classic
    // entry's implicit config(en()) call is dropped and no locale is set.
    z.config({ localeError: undefined });
    const degraded = OpenClawSchema.safeParse({
      agents: { defaults: { session: { pruneAfter: "1d" } } },
    });
    expect(firstIssueMessage(degraded)).toBe("Invalid input");

    installZodDefaultLocale();

    const restored = OpenClawSchema.safeParse({
      agents: { defaults: { session: { pruneAfter: "1d" } } },
    });
    expect(firstIssueMessage(restored)).toBe('Unrecognized key: "session"');
    const typeError = OpenClawSchema.safeParse({ gateway: { port: "not-a-number" } });
    expect(firstIssueMessage(typeError)).toBe("Invalid input: expected number, received string");
  });
});
