// Covers gateway config schema parsing, including auth rate-limit bounds.
import { describe, expect, it } from "vitest";
import { GatewayConfigSchema } from "./zod-schema.gateway.js";

type SchemaParseResult = {
  success: boolean;
  error?: { issues: Array<{ path: Array<string | number | symbol> }> };
};

function expectSchemaSuccess(result: SchemaParseResult): void {
  expect(result.success).toBe(true);
}

function expectSchemaFailurePath(result: SchemaParseResult, expectedPathPrefix: string): void {
  expect(result.success).toBe(false);
  if (result.success || !result.error) {
    throw new Error(`Expected schema validation to fail at ${expectedPathPrefix}.`);
  }
  const joined = result.error.issues.map((issue) => issue.path.join("."));
  expect(joined.some((path) => path.startsWith(expectedPathPrefix))).toBe(true);
}

describe("GatewayConfigSchema auth.rateLimit", () => {
  it("accepts a positive integer maxAttempts", () => {
    expectSchemaSuccess(GatewayConfigSchema.safeParse({ auth: { rateLimit: { maxAttempts: 5 } } }));
  });

  it("rejects zero maxAttempts (would lock out on the first failed attempt)", () => {
    expectSchemaFailurePath(
      GatewayConfigSchema.safeParse({ auth: { rateLimit: { maxAttempts: 0 } } }),
      "auth.rateLimit.maxAttempts",
    );
  });

  it("rejects negative maxAttempts", () => {
    expectSchemaFailurePath(
      GatewayConfigSchema.safeParse({ auth: { rateLimit: { maxAttempts: -1 } } }),
      "auth.rateLimit.maxAttempts",
    );
  });

  it("rejects fractional maxAttempts", () => {
    expectSchemaFailurePath(
      GatewayConfigSchema.safeParse({ auth: { rateLimit: { maxAttempts: 2.5 } } }),
      "auth.rateLimit.maxAttempts",
    );
  });
});
