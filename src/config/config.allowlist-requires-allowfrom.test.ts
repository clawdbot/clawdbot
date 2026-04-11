import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";
import {
  BlueBubblesConfigSchema,
  DiscordConfigSchema,
  IMessageConfigSchema,
  IrcConfigSchema,
  SignalConfigSchema,
  SlackConfigSchema,
  TelegramConfigSchema,
} from "./zod-schema.providers-core.js";
import { WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp.js";

const providerSchemas = {
  bluebubbles: BlueBubblesConfigSchema,
  discord: DiscordConfigSchema,
  imessage: IMessageConfigSchema,
  irc: IrcConfigSchema,
  signal: SignalConfigSchema,
  slack: SlackConfigSchema,
  telegram: TelegramConfigSchema,
  whatsapp: WhatsAppConfigSchema,
} as const;

function expectChannelAllowlistIssue(
  result: ReturnType<typeof validateConfigObject>,
  path: string | readonly string[],
) {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    const pathParts = Array.isArray(path) ? path : [path];
    expect(
      result.issues.some((issue) => pathParts.every((part) => issue.path.includes(part))),
    ).toBe(true);
  }
}

function expectSchemaAllowlistIssue(params: {
  schema: { safeParse: (value: unknown) => { success: true } | { success: false; error: unknown } };
  config: unknown;
  path: string | readonly string[];
}) {
  const result = params.schema.safeParse(params.config);
  expect(result.success).toBe(false);
  if (!result.success) {
    const pathParts = Array.isArray(params.path) ? params.path : [params.path];
    const issues =
      (result.error as { issues?: Array<{ path?: Array<string | number> }> }).issues ?? [];
    const expectedParts = pathParts
      .map((part) => part.replace(/^channels\.[^.]+\.?/u, ""))
      .filter(Boolean);
    expect(
      issues.some((issue) => {
        const issuePath = issue.path?.join(".") ?? "";
        return expectedParts.every((part) => issuePath.includes(part));
      }),
    ).toBe(true);
  }
}

describe('dmPolicy="allowlist" requires non-empty effective allowFrom', () => {
  it.each([
    {
      name: "telegram",
      config: { telegram: { dmPolicy: "allowlist", botToken: "fake" } },
      issuePath: "channels.telegram.allowFrom",
    },
    {
      name: "signal",
      config: { signal: { dmPolicy: "allowlist" } },
      issuePath: "channels.signal.allowFrom",
    },
    {
      name: "discord",
      config: { discord: { dmPolicy: "allowlist" } },
      issuePath: ["channels.discord", "allowFrom"],
    },
    {
      name: "whatsapp",
      config: { whatsapp: { dmPolicy: "allowlist" } },
      issuePath: "channels.whatsapp.allowFrom",
    },
  ] as const)(
    'rejects $name dmPolicy="allowlist" without allowFrom',
    ({ name, config, issuePath }) => {
      const providerConfig = config[name];
      const schema = providerSchemas[name as keyof typeof providerSchemas];
      if (schema) {
        expectSchemaAllowlistIssue({ schema, config: providerConfig, path: issuePath });
        return;
      }
      expectChannelAllowlistIssue(validateConfigObject({ channels: config }), issuePath);
    },
  );

  it('accepts dmPolicy="pairing" without allowFrom', () => {
    const res = TelegramConfigSchema.safeParse({ dmPolicy: "pairing", botToken: "fake" });
    expect(res.success).toBe(true);
  });
});

describe('account dmPolicy="allowlist" uses inherited allowFrom', () => {
  it.each([
    {
      name: "telegram",
      config: {
        telegram: {
          allowFrom: ["12345"],
          accounts: { bot1: { dmPolicy: "allowlist", botToken: "fake" } },
        },
      },
    },
    {
      name: "signal",
      config: {
        signal: { allowFrom: ["+15550001111"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    },
    {
      name: "discord",
      config: {
        discord: { allowFrom: ["123456789"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    },
    {
      name: "slack",
      config: {
        slack: {
          allowFrom: ["U123"],
          botToken: "xoxb-top",
          appToken: "xapp-top",
          accounts: {
            work: { dmPolicy: "allowlist", botToken: "xoxb-work", appToken: "xapp-work" },
          },
        },
      },
    },
    {
      name: "whatsapp",
      config: {
        whatsapp: { allowFrom: ["+15550001111"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    },
    {
      name: "imessage",
      config: {
        imessage: { allowFrom: ["alice"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    },
    {
      name: "irc",
      config: {
        irc: { allowFrom: ["nick"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    },
    {
      name: "bluebubbles",
      config: {
        bluebubbles: { allowFrom: ["sender"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    },
  ] as const)(
    "accepts $name account allowlist when parent allowFrom exists",
    ({ name, config }) => {
      const providerConfig = config[name];
      const schema = providerSchemas[name];
      if (schema) {
        expect(schema.safeParse(providerConfig).success).toBe(true);
        return;
      }
      expect(validateConfigObject({ channels: config }).ok).toBe(true);
    },
  );

  it("rejects telegram account allowlist when neither account nor parent has allowFrom", () => {
    expectSchemaAllowlistIssue({
      schema: TelegramConfigSchema,
      config: { accounts: { bot1: { dmPolicy: "allowlist", botToken: "fake" } } },
      path: "accounts.bot1.allowFrom",
    });
  });
});
