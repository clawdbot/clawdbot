import { describe, expect, it } from "vitest";
import { AudioSchema, BindingsSchema } from "./zod-schema.agents.js";
import { OpenClawSchema } from "./zod-schema.js";
import {
  DiscordConfigSchema,
  IMessageConfigSchema,
  MSTeamsConfigSchema,
  SlackConfigSchema,
} from "./zod-schema.providers-core.js";

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

function expectSchemaValid(
  schema: {
    safeParse: (value: unknown) => { success: true } | { success: false };
  },
  config: unknown,
) {
  const res = schema.safeParse(config);
  expect(res.success).toBe(true);
}

function expectInvalidSchemaIssuePath(params: {
  schema: {
    safeParse: (
      value: unknown,
    ) => { success: true } | { success: false; error: { issues: Array<{ path: PropertyKey[] }> } };
  };
  config: unknown;
  expectedPath: string;
}) {
  const res = params.schema.safeParse(params.config);
  expect(res.success).toBe(false);
  if (!res.success) {
    expect(res.error.issues[0]?.path.join(".")).toBe(params.expectedPath);
  }
}

function expectOpenClawSchemaInvalidPreservesField(params: {
  config: unknown;
  readValue: (parsed: unknown) => unknown;
  expectedValue: unknown;
  expectedPath?: string;
  expectedMessageIncludes?: string;
}) {
  const before = JSON.stringify(params.config);
  const res = OpenClawSchema.safeParse(params.config);
  expect(res.success).toBe(false);
  if (!res.success) {
    if (params.expectedPath !== undefined) {
      expect(res.error.issues[0]?.path.join(".")).toBe(params.expectedPath);
    }
    if (params.expectedMessageIncludes !== undefined) {
      expect(res.error.issues[0]?.message).toContain(params.expectedMessageIncludes);
    }
  }
  expect(params.readValue(params.config)).toBe(params.expectedValue);
  expect(JSON.stringify(params.config)).toBe(before);
}

describe("legacy config detection", () => {
  it('accepts imessage.dmPolicy="open" with allowFrom "*"', () => {
    expectSchemaConfigValue({
      schema: IMessageConfigSchema,
      config: { dmPolicy: "open", allowFrom: ["*"] },
      readValue: (config) => (config as { dmPolicy?: string }).dmPolicy,
      expectedValue: "open",
    });
  });
  it("defaults imessage.dmPolicy to pairing when imessage section exists", () => {
    expectSchemaConfigValue({
      schema: IMessageConfigSchema,
      config: {},
      readValue: (config) => (config as { dmPolicy?: string }).dmPolicy,
      expectedValue: "pairing",
    });
  });
  it("defaults imessage.groupPolicy to allowlist when imessage section exists", () => {
    expectSchemaConfigValue({
      schema: IMessageConfigSchema,
      config: {},
      readValue: (config) => (config as { groupPolicy?: string }).groupPolicy,
      expectedValue: "allowlist",
    });
  });
  it.each([
    [
      "defaults discord.groupPolicy to allowlist when discord section exists",
      DiscordConfigSchema,
      {},
      (config: unknown) => (config as { groupPolicy?: string }).groupPolicy,
      "allowlist",
    ],
    [
      "defaults slack.groupPolicy to allowlist when slack section exists",
      SlackConfigSchema,
      {},
      (config: unknown) => (config as { groupPolicy?: string }).groupPolicy,
      "allowlist",
    ],
    [
      "defaults msteams.groupPolicy to allowlist when msteams section exists",
      MSTeamsConfigSchema,
      {},
      (config: unknown) => (config as { groupPolicy?: string }).groupPolicy,
      "allowlist",
    ],
  ])("defaults: %s", (_name, schema, config, readValue, expectedValue) => {
    expectSchemaConfigValue({ schema, config, readValue, expectedValue });
  });
  it("rejects unsafe executable config values", () => {
    expectInvalidSchemaIssuePath({
      schema: IMessageConfigSchema,
      config: { cliPath: "imsg; rm -rf /" },
      expectedPath: "cliPath",
    });
  });
  it("accepts tools audio transcription without cli", () => {
    expectSchemaValid(AudioSchema, {
      transcription: { command: ["whisper", "--model", "base"] },
    });
  });
  it("accepts path-like executable values with spaces", () => {
    expectSchemaValid(IMessageConfigSchema, {
      cliPath: "/Applications/Imsg Tools/imsg",
    });
  });
  it.each([
    [
      'rejects discord.dm.policy="open" without allowFrom "*"',
      DiscordConfigSchema,
      { dm: { policy: "open", allowFrom: ["123"] } },
      "dm.allowFrom",
    ],
    [
      'rejects discord.dmPolicy="open" without allowFrom "*"',
      DiscordConfigSchema,
      { dmPolicy: "open", allowFrom: ["123"] },
      "allowFrom",
    ],
    [
      'rejects slack.dm.policy="open" without allowFrom "*"',
      SlackConfigSchema,
      { dm: { policy: "open", allowFrom: ["U123"] } },
      "dm.allowFrom",
    ],
    [
      'rejects slack.dmPolicy="open" without allowFrom "*"',
      SlackConfigSchema,
      { dmPolicy: "open", allowFrom: ["U123"] },
      "allowFrom",
    ],
  ])("rejects: %s", (_name, schema, config, expectedPath) => {
    expectInvalidSchemaIssuePath({ schema, config, expectedPath });
  });

  it.each([
    {
      name: 'accepts discord dm.allowFrom="*" with top-level allowFrom alias',
      schema: DiscordConfigSchema,
      config: {
        dm: { policy: "open", allowFrom: ["123"] },
        allowFrom: ["*"],
      },
    },
    {
      name: 'accepts slack dm.allowFrom="*" with top-level allowFrom alias',
      schema: SlackConfigSchema,
      config: {
        dm: { policy: "open", allowFrom: ["U123"] },
        allowFrom: ["*"],
      },
    },
  ])("$name", ({ schema, config }) => {
    expectSchemaValid(schema, config);
  });
  it("rejects legacy agent.model string", () => {
    const res = OpenClawSchema.safeParse({
      agent: { model: "anthropic/claude-opus-4-6" },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("");
      expect(res.error.issues[0]?.message).toContain('"agent"');
    }
  });
  it("rejects removed legacy provider sections", () => {
    expectOpenClawSchemaInvalidPreservesField({
      config: { whatsapp: { allowFrom: ["+1555"] } },
      readValue: (parsed) =>
        (parsed as { whatsapp?: { allowFrom?: string[] } }).whatsapp?.allowFrom?.[0],
      expectedValue: "+1555",
      expectedPath: "",
      expectedMessageIncludes: '"whatsapp"',
    });
  });
  it("preserves claude-cli auth profile mode during validation", () => {
    const config = {
      auth: {
        profiles: {
          "anthropic:claude-cli": { provider: "anthropic", mode: "token" },
        },
      },
    };
    const res = OpenClawSchema.safeParse(config);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.auth?.profiles?.["anthropic:claude-cli"]?.mode).toBe("token");
    }
    expect(config.auth.profiles["anthropic:claude-cli"].mode).toBe("token");
  });
  it("rejects bindings[].match.provider without mutating the source", () => {
    expectOpenClawSchemaInvalidPreservesField({
      config: {
        bindings: [{ agentId: "main", match: { provider: "slack" } }],
      },
      readValue: (parsed) =>
        (parsed as { bindings?: Array<{ match?: { provider?: string } }> }).bindings?.[0]?.match
          ?.provider,
      expectedValue: "slack",
    });
  });
  it("rejects bindings[].match.accountID without mutating the source", () => {
    expectOpenClawSchemaInvalidPreservesField({
      config: {
        bindings: [{ agentId: "main", match: { channel: "telegram", accountID: "work" } }],
      },
      readValue: (parsed) =>
        (parsed as { bindings?: Array<{ match?: { accountID?: string } }> }).bindings?.[0]?.match
          ?.accountID,
      expectedValue: "work",
    });
  });
  it("accepts bindings[].comment during validation", () => {
    expectSchemaConfigValue({
      schema: BindingsSchema,
      config: [{ agentId: "main", comment: "primary route", match: { channel: "telegram" } }],
      readValue: (config) => (config as Array<{ comment?: string }> | undefined)?.[0]?.comment,
      expectedValue: "primary route",
    });
  });
  it("rejects session.sendPolicy.rules[].match.provider without mutating the source", () => {
    expectOpenClawSchemaInvalidPreservesField({
      config: {
        session: {
          sendPolicy: {
            rules: [{ action: "deny", match: { provider: "telegram" } }],
          },
        },
      },
      readValue: (parsed) =>
        (
          parsed as {
            session?: { sendPolicy?: { rules?: Array<{ match?: { provider?: string } }> } };
          }
        ).session?.sendPolicy?.rules?.[0]?.match?.provider,
      expectedValue: "telegram",
    });
  });
  it("rejects messages.queue.byProvider without mutating the source", () => {
    expectOpenClawSchemaInvalidPreservesField({
      config: { messages: { queue: { byProvider: { whatsapp: "queue" } } } },
      readValue: (parsed) =>
        (
          parsed as {
            messages?: {
              queue?: {
                byProvider?: Record<string, unknown>;
              };
            };
          }
        ).messages?.queue?.byProvider?.whatsapp,
      expectedValue: "queue",
    });
  });
});
