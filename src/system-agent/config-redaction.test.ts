import { describe, expect, it, vi } from "vitest";

const runtimeSchema = vi.hoisted(() => ({
  load: vi.fn(() => {
    throw new Error("invalid runtime config");
  }),
}));

vi.mock("../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: runtimeSchema.load,
}));

import { isSystemAgentSensitiveConfigValue, redactSystemAgentConfig } from "./config-redaction.js";

describe("isSystemAgentSensitiveConfigValue", () => {
  it("detects sensitive descendants in structured parent writes", () => {
    runtimeSchema.load.mockReturnValueOnce({
      uiHints: {
        "channels.synology-chat.webhookUrl": { sensitive: true },
        "channels.synology-chat.accounts.*.webhookUrl": { sensitive: true },
      },
    } as never);

    expect(
      isSystemAgentSensitiveConfigValue(
        "channels.synology-chat",
        '{ accounts: { work: { webhookUrl: "https://gateway.invalid/webhook?token=synthetic" } } }',
      ),
    ).toBe(true);
  });

  it("keeps structured parent writes visible when no descendant is sensitive", () => {
    runtimeSchema.load.mockReturnValueOnce({
      uiHints: {
        "channels.synology-chat.webhookUrl": { sensitive: true },
      },
    } as never);

    expect(
      isSystemAgentSensitiveConfigValue(
        "channels.synology-chat",
        '{ enabled: true, webhookPath: "/synology" }',
      ),
    ).toBe(false);
  });

  it("preserves escaped path segments while matching wildcard descendant hints", () => {
    runtimeSchema.load.mockReturnValueOnce({
      uiHints: {
        "channels.synology-chat.accounts.*.customSecret": { sensitive: true },
      },
    } as never);

    expect(
      isSystemAgentSensitiveConfigValue(
        'channels.synology-chat.accounts["prod.guild"]',
        '{ customSecret: "synthetic-secret" }',
      ),
    ).toBe(true);
  });
});

describe("redactSystemAgentConfig", () => {
  it("fails closed for dynamic plugin secrets when runtime config is invalid", () => {
    expect(
      redactSystemAgentConfig({
        plugins: { entries: { custom: { config: { opaque: "plugin-secret" } } } },
      }),
    ).toEqual({ plugins: { entries: { custom: { config: "<redacted>" } } } });
  });
});
