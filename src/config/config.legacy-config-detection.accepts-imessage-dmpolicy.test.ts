import { describe, expect, it } from "vitest";
import {
  expectSchemaConfigValue,
  expectSchemaValid,
} from "./legacy-config-detection.test-support.js";
import { AudioSchema, BindingsSchema } from "./zod-schema.agents.js";
import { OpenClawSchema } from "./zod-schema.js";

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
  it("accepts tools audio transcription without cli", () => {
    expectSchemaValid(AudioSchema, {
      transcription: { command: ["whisper", "--model", "base"] },
    });
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
