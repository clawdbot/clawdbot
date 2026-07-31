// Regresses allowlist config requiring explicit allowFrom entries.
import { describe, expect, it } from "vitest";
import { WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp.js";

function expectSchemaAllowlistIssue(
  schema: {
    safeParse: (
      value: unknown,
    ) =>
      | { success: true; data: unknown }
      | { success: false; error: { issues: Array<{ path: PropertyKey[] }> } };
  },
  config: unknown,
  path: string | readonly string[],
) {
  const result = schema.safeParse(config);
  expect(result.success).toBe(false);
  if (!result.success) {
    const pathParts = Array.isArray(path) ? path : [path];
    expect(
      result.error.issues.some((issue) => pathParts.every((part) => issue.path.includes(part))),
    ).toBe(true);
  }
}

describe('dmPolicy="allowlist" requires non-empty effective allowFrom', () => {
  it.each([
    {
      name: "whatsapp",
      schema: WhatsAppConfigSchema,
      config: { dmPolicy: "allowlist" },
      issuePath: "allowFrom",
    },
  ] as const)(
    'rejects $name dmPolicy="allowlist" without allowFrom',
    ({ schema, config, issuePath }) => {
      expectSchemaAllowlistIssue(schema, config, issuePath);
    },
  );
});

describe('account dmPolicy="allowlist" uses inherited allowFrom', () => {
  it.each([
    {
      name: "whatsapp",
      schema: WhatsAppConfigSchema,
      config: { allowFrom: ["+15550001111"], accounts: { work: { dmPolicy: "allowlist" } } },
    },
  ] as const)(
    "accepts $name account allowlist when parent allowFrom exists",
    ({ schema, config }) => {
      expect(schema.safeParse(config).success).toBe(true);
    },
  );
});
