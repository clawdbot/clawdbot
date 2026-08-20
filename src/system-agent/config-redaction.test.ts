import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  isSystemAgentSensitiveConfigPathEmbedding,
  isSystemAgentSensitiveConfigValue,
  redactSystemAgentConfigPath,
  redactSystemAgentConfig,
} from "./config-redaction.js";
import {
  installSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";

let pluginMetadata: SystemAgentPluginMetadataTestSnapshot | undefined;

beforeEach(() => {
  const config = {};
  setRuntimeConfigSnapshot(config, config);
  pluginMetadata = installSystemAgentPluginMetadataTestSnapshot(config);
});

afterEach(() => {
  pluginMetadata?.restore();
  pluginMetadata = undefined;
  clearRuntimeConfigSnapshot();
});

describe("isSystemAgentSensitiveConfigValue", () => {
  it("detects sensitive descendants in structured parent writes", () => {
    expect(
      isSystemAgentSensitiveConfigValue(
        "channels.synology-chat",
        '{ accounts: { work: { webhookUrl: "https://gateway.invalid/webhook?token=synthetic" } } }',
      ),
    ).toBe(true);
  });

  it("keeps structured parent writes visible when no descendant is sensitive", () => {
    expect(
      isSystemAgentSensitiveConfigValue(
        "channels.synology-chat",
        '{ enabled: true, webhookPath: "/synology" }',
      ),
    ).toBe(false);
  });

  it("preserves escaped path segments while matching wildcard descendant hints", () => {
    expect(
      isSystemAgentSensitiveConfigValue(
        'channels.synology-chat.accounts["prod.guild"]',
        '{ webhookUrl: "https://gateway.invalid/webhook?token=synthetic" }',
      ),
    ).toBe(true);
  });

  it("fails closed when a dynamic config owner has no current metadata", () => {
    expect(
      isSystemAgentSensitiveConfigValue("plugins.entries.missing.config.opaque", "plugin-secret"),
    ).toBe(true);
    expect(isSystemAgentSensitiveConfigValue("channels.missing.opaque", "channel-secret")).toBe(
      true,
    );
    expect(
      isSystemAgentSensitiveConfigValue('channels["defaults.foo"].opaque', "channel-secret"),
    ).toBe(true);
    expect(
      isSystemAgentSensitiveConfigValue('channels["modelByChannel.evil"].opaque', "channel-secret"),
    ).toBe(true);
  });

  it.each([
    ["channels.defaults.groupPolicy", '"open"'],
    ["channels.modelByChannel.telegram.chat", '"openai/gpt-5.5"'],
    ['channels.modelByChannel["token=prod"].chat', '"openai/gpt-5.5"'],
  ])("keeps kernel-owned channel config %s visible", (path, value) => {
    expect(isSystemAgentSensitiveConfigValue(path, value)).toBe(false);
  });
});

describe("isSystemAgentSensitiveConfigPathEmbedding", () => {
  it.each([
    "gateway.auth.token=abcDEF123",
    String.raw`gateway.auth.token\=abcDEF123`,
    String.raw`gateway.auth.token\ abcDEF123`,
    "gateway.auth.tokenabcDEF123",
    "gateway.auth.token_abcDEF123",
    "gateway.auth.token$abcDEF123",
    "plugins.entries.codex.config.appServer.headersabcDEF123",
    'gateway.auth["token=abcDEF123"]',
    'gateway.auth["token abcDEF123"]',
    'gateway.auth["token:abcDEF123"]',
    'gateway.auth["token=abcDEF123"].nested',
  ])("detects sensitive data embedded in path %s", (path) => {
    expect(isSystemAgentSensitiveConfigPathEmbedding(path)).toBe(true);
  });

  it("preserves a non-sensitive dynamic key containing an assignment delimiter", () => {
    expect(
      isSystemAgentSensitiveConfigPathEmbedding(
        'channels.synology-chat.accounts["prod=us"].webhookUrl',
      ),
    ).toBe(false);
  });

  it.each([
    "plugins.entries.codex.config.appServer.headers.Authorization",
    'plugins.entries.codex.config.appServer.headers["X-Test"]',
    String.raw`plugins.entries.codex.config.appServer.headers.X\-Test`,
    'channels.synology-chat.accounts["token=prod"].webhookUrl',
    String.raw`channels.synology-chat.accounts.token\=prod.webhookUrl`,
    'channels.synology-chat.accounts["token=prod"].webhookPath',
    String.raw`channels.synology-chat.accounts.token\=prod.webhookPath`,
    'broadcast["token=prod"]',
    'session.identityLinks["token=prod"]',
    'channels.modelByChannel["token=prod"].chat',
    'channels.telegram.groups["prod.guild"].topics["token=prod"].groupPolicy',
    'channels.buzz.groups["00000000-0000-4000-8000-000000000000"].enabled',
    'hooks.entries.work["token=prod"]',
    String.raw`hooks.entries.work.token\=prod`,
    'talk.providers.openai["token=prod"]',
    "hooks.mappings[0].agentId",
  ])("preserves schema-valid dynamic path %s", (path) => {
    expect(isSystemAgentSensitiveConfigPathEmbedding(path)).toBe(false);
  });

  it("rejects a nonnumeric array index", () => {
    expect(
      isSystemAgentSensitiveConfigPathEmbedding('hooks.mappings["token=abcDEF123"].agentId'),
    ).toBe(true);
  });

  it("redacts unknown-owner and sensitive descendant paths", () => {
    expect(redactSystemAgentConfigPath("channels.missing.opaque.abcDEF123")).toBe(
      "<redacted path>",
    );
    expect(redactSystemAgentConfigPath("plugins.entries.missing.config.opaque.abcDEF123")).toBe(
      "<redacted path>",
    );
    expect(redactSystemAgentConfigPath("plugins.entries.codex.config.opaque=abcDEF123")).toBe(
      "<redacted path>",
    );
    expect(redactSystemAgentConfigPath('channels.synology-chat["webhookUrl=abcDEF123"]')).toBe(
      "<redacted path>",
    );
    expect(redactSystemAgentConfigPath('channels.synology-chat.accounts["prod=us"].enabled')).toBe(
      'channels.synology-chat.accounts["prod=us"].enabled',
    );
    expect(
      redactSystemAgentConfigPath(
        'plugins.entries.codex.config.appServer.headers["Authorization=Bearer-abc"]',
      ),
    ).toBe("<redacted path>");
    expect(
      redactSystemAgentConfigPath(
        "plugins.entries.codex.config.appServer.headers.AuthorizationabcDEF123",
      ),
    ).toBe("plugins.entries.codex.config.appServer.headers.AuthorizationabcDEF123");
    expect(
      redactSystemAgentConfigPath('plugins.entries.codex.config.appServer.headers["X-Test"]'),
    ).toBe('plugins.entries.codex.config.appServer.headers["X-Test"]');
    expect(
      redactSystemAgentConfigPath('channels.synology-chat.accounts["token=prod"].enabled'),
    ).toBe('channels.synology-chat.accounts["token=prod"].enabled');
    expect(redactSystemAgentConfigPath('broadcast["token=prod"]')).toBe('broadcast["token=prod"]');
    expect(redactSystemAgentConfigPath('session.identityLinks["token=prod"]')).toBe(
      'session.identityLinks["token=prod"]',
    );
    expect(redactSystemAgentConfigPath('channels.modelByChannel["token=prod"].chat')).toBe(
      'channels.modelByChannel["token=prod"].chat',
    );
    expect(
      redactSystemAgentConfigPath(
        'channels.telegram.groups["prod.guild"].topics["token=prod"].groupPolicy',
      ),
    ).toBe('channels.telegram.groups["prod.guild"].topics["token=prod"].groupPolicy');
    expect(redactSystemAgentConfigPath('hooks.mappings["token=abcDEF123"].agentId')).toBe(
      "<redacted path>",
    );
    expect(
      redactSystemAgentConfigPath(
        'channels.buzz.groups["gateway.auth.token=ACTUAL_GATEWAY_TOKEN"].enabled',
      ),
    ).toBe("<redacted path>");
  });
});

describe("redactSystemAgentConfig", () => {
  it("fails closed for dynamic owner secrets when the exact config is invalid", () => {
    expect(
      redactSystemAgentConfig(
        {
          plugins: { entries: { "custom.plugin": { config: { opaque: "plugin-secret" } } } },
          channels: { "custom.channel": { opaque: "channel-secret" } },
        },
        { valid: false },
      ),
    ).toEqual({
      plugins: { entries: { "custom.plugin": { config: "<redacted>" } } },
      channels: { "custom.channel": "<redacted>" },
    });
  });

  it("does not trust known owner metadata for an invalid config snapshot", () => {
    expect(
      redactSystemAgentConfig(
        { channels: { "synology-chat": { opaque: "invalid-channel-secret" } } },
        { valid: false },
      ),
    ).toEqual({ channels: { "synology-chat": "<redacted>" } });
  });

  it("preserves kernel-owned channel namespaces while unknown owners fail closed", () => {
    expect(
      redactSystemAgentConfig(
        {
          channels: {
            defaults: { groupPolicy: "open" },
            modelByChannel: { telegram: { chat: "openai/gpt-5.5" } },
            missing: { opaque: "channel-secret" },
            "defaults.foo": { opaque: "dotted-channel-secret" },
            "modelByChannel.evil": { opaque: "dotted-model-secret" },
          },
        },
        { valid: false },
      ),
    ).toEqual({
      channels: {
        defaults: { groupPolicy: "open" },
        modelByChannel: { telegram: { chat: "openai/gpt-5.5" } },
        missing: "<redacted>",
        "defaults.foo": "<redacted>",
        "modelByChannel.evil": "<redacted>",
      },
    });
  });

  it("redacts invalid descendants inside core channel namespaces", () => {
    expect(
      redactSystemAgentConfig(
        {
          channels: {
            defaults: { groupPolicy: "open", opaque: "kernel-secret" },
            modelByChannel: { telegram: { chat: 42 } },
          },
        },
        { valid: false },
      ),
    ).toEqual({
      channels: {
        defaults: { groupPolicy: "open", opaque: "<redacted>" },
        modelByChannel: "<redacted>",
      },
    });
  });

  it("fails closed for malformed invalid-config owner containers", () => {
    expect(
      redactSystemAgentConfig(
        {
          channels: [{ opaque: "channel-secret" }],
          plugins: { entries: { broken: "plugin-secret" } },
        },
        { valid: false },
      ),
    ).toEqual({
      channels: "<redacted>",
      plugins: { entries: { broken: "<redacted>" } },
    });
  });
});
