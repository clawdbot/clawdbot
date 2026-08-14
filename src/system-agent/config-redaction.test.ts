import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { isSystemAgentSensitiveConfigValue, redactSystemAgentConfig } from "./config-redaction.js";
import {
  installSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";

let pluginMetadata: SystemAgentPluginMetadataTestSnapshot | undefined;

beforeEach(() => {
  setRuntimeConfigSnapshot({}, {});
  pluginMetadata = installSystemAgentPluginMetadataTestSnapshot();
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
});
