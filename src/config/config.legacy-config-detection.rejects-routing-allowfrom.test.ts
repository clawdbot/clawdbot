import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";
import {
  DiscordConfigSchema,
  IMessageConfigSchema,
  MSTeamsConfigSchema,
  SignalConfigSchema,
  SlackConfigSchema,
  TelegramConfigSchema,
} from "./zod-schema.providers-core.js";
import { WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp.js";

function expectSchemaConfigValue(params: {
  schema: { safeParse: (value: unknown) => { success: true; data: unknown } | { success: false } };
  config: unknown;
  readValue: (config: unknown) => unknown;
  expectedValue: unknown;
}) {
  const res = params.schema.safeParse(params.config);
  expect(res.success).toBe(true);
  if (!res.success) {
    throw new Error("expected schema config to be valid");
  }
  expect(params.readValue(res.data)).toBe(params.expectedValue);
}

function expectProviderValidationIssuePath(params: {
  provider: string;
  config: unknown;
  expectedPath: string;
}) {
  const res = validateConfigObject({
    channels: {
      [params.provider]: params.config,
    },
  });
  expect(res.ok, params.provider).toBe(false);
  if (!res.ok) {
    expect(res.issues[0]?.path, params.provider).toBe(params.expectedPath);
  }
}

function expectProviderSchemaValidationIssuePath(params: {
  schema: { safeParse: (value: unknown) => { success: true } | { success: false; error: unknown } };
  config: unknown;
  expectedPath: string;
}) {
  const res = params.schema.safeParse(params.config);
  expect(res.success).toBe(false);
  if (!res.success) {
    const issues =
      (res.error as { issues?: Array<{ path?: Array<string | number> }> }).issues ?? [];
    expect(issues[0]?.path?.join(".")).toBe(params.expectedPath);
  }
}

function expectSchemaConfigValueStrict(params: {
  schema: { safeParse: (value: unknown) => { success: true; data: unknown } | { success: false } };
  config: unknown;
  readValue: (config: unknown) => unknown;
  expectedValue: unknown;
}) {
  const res = params.schema.safeParse(params.config);
  expect(res.success).toBe(true);
  if (!res.success) {
    throw new Error("expected provider schema config to be valid");
  }
  expect(params.readValue(res.data)).toBe(params.expectedValue);
}

const fastProviderSchemas = {
  telegram: TelegramConfigSchema,
  whatsapp: WhatsAppConfigSchema,
  signal: SignalConfigSchema,
  imessage: IMessageConfigSchema,
} as const;

describe("legacy config detection", () => {
  it.each([
    {
      name: "routing.allowFrom",
      input: { routing: { allowFrom: ["+15555550123"] } },
      expectedPath: "",
      expectedMessage: '"routing"',
    },
    {
      name: "routing.groupChat.requireMention",
      input: { routing: { groupChat: { requireMention: false } } },
      expectedPath: "",
      expectedMessage: '"routing"',
    },
  ] as const)(
    "rejects legacy routing key: $name",
    ({ input, expectedPath, expectedMessage, name }) => {
      const res = validateConfigObject(input);
      expect(res.ok, name).toBe(false);
      if (!res.ok) {
        expect(res.issues[0]?.path, name).toBe(expectedPath);
        expect(res.issues[0]?.message, name).toContain(expectedMessage);
      }
    },
  );

  it("accepts per-agent tools.elevated overrides", async () => {
    const res = validateConfigObject({
      tools: {
        elevated: {
          allowFrom: { whatsapp: ["+15555550123"] },
        },
      },
      agents: {
        list: [
          {
            id: "work",
            workspace: "~/openclaw-work",
            tools: {
              elevated: {
                enabled: false,
                allowFrom: { whatsapp: ["+15555550123"] },
              },
            },
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config?.agents?.list?.[0]?.tools?.elevated).toEqual({
        enabled: false,
        allowFrom: { whatsapp: ["+15555550123"] },
      });
    }
  });
  it("rejects telegram.requireMention", async () => {
    const res = validateConfigObject({
      telegram: { requireMention: true },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("");
      expect(res.issues[0]?.message).toContain('"telegram"');
    }
  });
  it("rejects gateway.token", async () => {
    const res = validateConfigObject({
      gateway: { token: "legacy-token" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway");
    }
  });
  it.each(["0.0.0.0", "::", "127.0.0.1", "localhost", "::1"] as const)(
    "flags gateway.bind host alias as legacy: %s",
    (bind) => {
      const validated = validateConfigObject({ gateway: { bind } });
      expect(validated.ok, bind).toBe(false);
      if (!validated.ok) {
        expect(
          validated.issues.some((issue) => issue.path === "gateway.bind"),
          bind,
        ).toBe(true);
      }
    },
  );
  it.each([
    {
      name: "telegram",
      allowFrom: ["123456789"],
      schema: TelegramConfigSchema,
      expectedIssuePath: "allowFrom",
    },
    {
      name: "whatsapp",
      allowFrom: ["+15555550123"],
      schema: WhatsAppConfigSchema,
      expectedIssuePath: "allowFrom",
    },
    {
      name: "signal",
      allowFrom: ["+15555550123"],
      schema: SignalConfigSchema,
      expectedIssuePath: "allowFrom",
    },
    {
      name: "imessage",
      allowFrom: ["+15555550123"],
      schema: IMessageConfigSchema,
      expectedIssuePath: "allowFrom",
    },
  ] as const)(
    'enforces dmPolicy="open" allowFrom wildcard for $name',
    ({ name, allowFrom, expectedIssuePath, schema }) => {
      const config = { dmPolicy: "open", allowFrom };
      if (schema) {
        expectProviderSchemaValidationIssuePath({
          schema,
          config,
          expectedPath: expectedIssuePath,
        });
        return;
      }
      expectProviderValidationIssuePath({
        provider: name,
        config,
        expectedPath: expectedIssuePath,
      });
    },
    180_000,
  );

  it.each(["telegram", "whatsapp", "signal"] as const)(
    'accepts dmPolicy="open" with wildcard for %s',
    (provider) => {
      expectSchemaConfigValueStrict({
        schema: fastProviderSchemas[provider],
        config: { dmPolicy: "open", allowFrom: ["*"] },
        readValue: (config) => (config as { dmPolicy?: string }).dmPolicy,
        expectedValue: "open",
      });
    },
  );

  it.each(["telegram", "whatsapp", "signal"] as const)(
    "defaults dm/group policy for configured provider %s",
    (provider) => {
      expectSchemaConfigValueStrict({
        schema: fastProviderSchemas[provider],
        config: {},
        readValue: (config) => (config as { dmPolicy?: string }).dmPolicy,
        expectedValue: "pairing",
      });
      expectSchemaConfigValueStrict({
        schema: fastProviderSchemas[provider],
        config: {},
        readValue: (config) => (config as { groupPolicy?: string }).groupPolicy,
        expectedValue: "allowlist",
      });
    },
  );

  it("accepts historyLimit overrides per provider and account", async () => {
    expectSchemaConfigValueStrict({
      schema: WhatsAppConfigSchema,
      config: { historyLimit: 9, accounts: { work: { historyLimit: 4 } } },
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      expectedValue: 9,
    });
    expectSchemaConfigValueStrict({
      schema: WhatsAppConfigSchema,
      config: { historyLimit: 9, accounts: { work: { historyLimit: 4 } } },
      readValue: (config) =>
        (config as { accounts?: { work?: { historyLimit?: number } } }).accounts?.work
          ?.historyLimit,
      expectedValue: 4,
    });
    expectSchemaConfigValueStrict({
      schema: TelegramConfigSchema,
      config: { historyLimit: 8, accounts: { ops: { historyLimit: 3 } } },
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      expectedValue: 8,
    });
    expectSchemaConfigValueStrict({
      schema: TelegramConfigSchema,
      config: { historyLimit: 8, accounts: { ops: { historyLimit: 3 } } },
      readValue: (config) =>
        (config as { accounts?: { ops?: { historyLimit?: number } } }).accounts?.ops?.historyLimit,
      expectedValue: 3,
    });
    expectSchemaConfigValue({
      schema: SlackConfigSchema,
      config: { historyLimit: 7, accounts: { ops: { historyLimit: 2 } } },
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      expectedValue: 7,
    });
    expectSchemaConfigValue({
      schema: SlackConfigSchema,
      config: { historyLimit: 7, accounts: { ops: { historyLimit: 2 } } },
      readValue: (config) =>
        (config as { accounts?: { ops?: { historyLimit?: number } } }).accounts?.ops?.historyLimit,
      expectedValue: 2,
    });
    expectSchemaConfigValueStrict({
      schema: SignalConfigSchema,
      config: { historyLimit: 6 },
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      expectedValue: 6,
    });
    expectSchemaConfigValueStrict({
      schema: IMessageConfigSchema,
      config: { historyLimit: 5 },
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      expectedValue: 5,
    });
    expectSchemaConfigValue({
      schema: MSTeamsConfigSchema,
      config: { historyLimit: 4 },
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      expectedValue: 4,
    });
    expectSchemaConfigValue({
      schema: DiscordConfigSchema,
      config: { historyLimit: 3 },
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      expectedValue: 3,
    });
  });
});
