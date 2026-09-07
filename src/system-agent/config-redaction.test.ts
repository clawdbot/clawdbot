import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  isSystemAgentSensitiveConfigPathEmbedding as isSystemAgentSensitiveConfigPathEmbeddingImpl,
  isSystemAgentSensitiveConfigValue as isSystemAgentSensitiveConfigValueImpl,
  redactSystemAgentConfigPath as redactSystemAgentConfigPathImpl,
  redactSystemAgentConfig as redactSystemAgentConfigImpl,
} from "./config-redaction.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";

let pluginMetadata: SystemAgentPluginMetadataTestSnapshot | undefined;

const isSystemAgentSensitiveConfigPathEmbedding: typeof isSystemAgentSensitiveConfigPathEmbeddingImpl =
  (...args) => pluginMetadata!.run(() => isSystemAgentSensitiveConfigPathEmbeddingImpl(...args));

const isSystemAgentSensitiveConfigValue: typeof isSystemAgentSensitiveConfigValueImpl = (...args) =>
  pluginMetadata!.run(() => isSystemAgentSensitiveConfigValueImpl(...args));

const redactSystemAgentConfigPath: typeof redactSystemAgentConfigPathImpl = (...args) =>
  pluginMetadata!.run(() => redactSystemAgentConfigPathImpl(...args));

const redactSystemAgentConfig: typeof redactSystemAgentConfigImpl = (...args) =>
  pluginMetadata!.run(() => redactSystemAgentConfigImpl(...args));

beforeEach(() => {
  const config = {};
  setRuntimeConfigSnapshot(config, config);
  pluginMetadata = createSystemAgentPluginMetadataTestSnapshot(config);
});

afterEach(() => {
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

  it.each([
    "channels.missing.opaque.abcDEF123",
    "plugins.entries.missing.config.opaque.abcDEF123",
    "plugins.entries.codex.config.opaque=abcDEF123",
    'channels.synology-chat["webhookUrl=abcDEF123"]',
    'plugins.entries.codex.config.appServer.headers["Authorization=Bearer-abc"]',
    'hooks.mappings["token=abcDEF123"].agentId',
    'channels.buzz.groups["gateway.auth.token=ACTUAL_GATEWAY_TOKEN"].enabled',
  ])("redacts unknown-owner or secret-bearing path %s", (path) => {
    expect(redactSystemAgentConfigPath(path)).toBe("<redacted path>");
  });

  it.each([
    'channels.synology-chat.accounts["prod=us"].enabled',
    "plugins.entries.codex.config.appServer.headers.AuthorizationabcDEF123",
    'plugins.entries.codex.config.appServer.headers["X-Test"]',
    'channels.synology-chat.accounts["token=prod"].enabled',
    'broadcast["token=prod"]',
    'session.identityLinks["token=prod"]',
    'channels.modelByChannel["token=prod"].chat',
    'channels.telegram.groups["prod.guild"].topics["token=prod"].groupPolicy',
  ])("preserves schema-valid path %s", (path) => {
    expect(redactSystemAgentConfigPath(path)).toBe(path);
  });
});

describe("redactSystemAgentConfig", () => {
  it.each(["plus", "core"])(
    "redacts retained owner credentials with %s selected first",
    (first) => {
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: ["core", "plus"].map((id) => ({
          id,
          origin: "config",
          channels: ["proofchat"],
          channelConfigs: {
            proofchat: {
              ...(id === "plus" ? { preferOver: ["core"] } : {}),
              schema: {
                type: "object",
                properties: { core: { type: "string" }, plus: { type: "string" } },
              },
              uiHints: { [id]: { sensitive: true } },
            },
          },
        })),
      });
      const preferred: OpenClawConfig = {
        plugins: { entries: { plus: { enabled: true } } },
        channels: { proofchat: { plus: "synthetic-plus", core: "synthetic-core" } },
      };
      const fallback: OpenClawConfig = {
        plugins: { entries: { plus: { enabled: false }, core: { enabled: true } } },
        channels: { proofchat: { plus: "synthetic-plus", core: "synthetic-core" } },
      };
      withPluginMetadataSnapshotScope(
        snapshot,
        () => {
          const configs =
            first === "plus" ? ([preferred, fallback] as const) : ([fallback, preferred] as const);
          for (const config of [...configs, configs[0]]) {
            setRuntimeConfigSnapshot(config, config);
            expect(redactSystemAgentConfigImpl(config, { config })).toMatchObject({
              channels: { proofchat: { plus: "<redacted>", core: "<redacted>" } },
            });
            for (const owner of ["core", "plus"]) {
              expect(
                isSystemAgentSensitiveConfigValueImpl(`channels.proofchat.${owner}`, "synthetic"),
              ).toBe(true);
              expect(redactSystemAgentConfigPathImpl(`channels.proofchat.${owner}.synthetic`)).toBe(
                "<redacted path>",
              );
            }
          }
        },
        { config: preferred, compatibleConfigs: [preferred, fallback] },
      );
    },
  );

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
