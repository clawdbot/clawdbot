import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  isCommandFlagEnabled,
  isModelsWriteEnabled,
  isRestartEnabled,
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "./commands.js";

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "discord" }),
          commands: {
            nativeCommandsAutoEnabled: true,
            nativeSkillsAutoEnabled: true,
          },
        },
      },
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram" }),
          commands: {
            nativeCommandsAutoEnabled: true,
            nativeSkillsAutoEnabled: true,
          },
        },
      },
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "slack" }),
          commands: {
            nativeCommandsAutoEnabled: false,
            nativeSkillsAutoEnabled: false,
          },
        },
      },
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "whatsapp" }),
          commands: {
            nativeCommandsAutoEnabled: false,
            nativeSkillsAutoEnabled: false,
          },
        },
      },
      {
        pluginId: "demo-channel",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "demo-channel" }),
          commands: {
            nativeCommandsAutoEnabled: true,
            nativeSkillsAutoEnabled: true,
          },
        },
      },
    ]),
  );
});

describe("resolveNativeSkillsEnabled", () => {
  it("uses provider defaults for auto", () => {
    expect(
      resolveNativeSkillsEnabled({
        providerId: "discord",
        globalSetting: "auto",
      }),
    ).toBe(true);
    expect(
      resolveNativeSkillsEnabled({
        providerId: "telegram",
        globalSetting: "auto",
      }),
    ).toBe(true);
    expect(
      resolveNativeSkillsEnabled({
        providerId: "slack",
        globalSetting: "auto",
      }),
    ).toBe(false);
    expect(
      resolveNativeSkillsEnabled({
        providerId: "whatsapp",
        globalSetting: "auto",
      }),
    ).toBe(false);
  });

  it("honors explicit provider settings", () => {
    expect(
      resolveNativeSkillsEnabled({
        providerId: "slack",
        providerSetting: true,
        globalSetting: "auto",
      }),
    ).toBe(true);
    expect(
      resolveNativeSkillsEnabled({
        providerId: "discord",
        providerSetting: false,
        globalSetting: true,
      }),
    ).toBe(false);
  });

  it("uses the plugin registry for auto defaults even when chat-channel normalization misses", () => {
    expect(
      resolveNativeSkillsEnabled({
        providerId: "demo-channel",
        globalSetting: "auto",
      }),
    ).toBe(true);
  });
});

describe("resolveNativeCommandsEnabled", () => {
  it("follows the same provider default heuristic", () => {
    expect(resolveNativeCommandsEnabled({ providerId: "discord", globalSetting: "auto" })).toBe(
      true,
    );
    expect(resolveNativeCommandsEnabled({ providerId: "telegram", globalSetting: "auto" })).toBe(
      true,
    );
    expect(resolveNativeCommandsEnabled({ providerId: "slack", globalSetting: "auto" })).toBe(
      false,
    );
  });

  it("uses the plugin registry for auto defaults even when chat-channel normalization misses", () => {
    expect(
      resolveNativeCommandsEnabled({
        providerId: "demo-channel",
        globalSetting: "auto",
      }),
    ).toBe(true);
  });

  it("honors explicit provider/global booleans", () => {
    expect(
      resolveNativeCommandsEnabled({
        providerId: "slack",
        providerSetting: true,
        globalSetting: false,
      }),
    ).toBe(true);
    expect(
      resolveNativeCommandsEnabled({
        providerId: "discord",
        globalSetting: false,
      }),
    ).toBe(false);
  });
});

describe("isNativeCommandsExplicitlyDisabled", () => {
  it("returns true only for explicit false at provider or fallback global", () => {
    expect(
      isNativeCommandsExplicitlyDisabled({ providerSetting: false, globalSetting: true }),
    ).toBe(true);
    expect(
      isNativeCommandsExplicitlyDisabled({ providerSetting: undefined, globalSetting: false }),
    ).toBe(true);
    expect(
      isNativeCommandsExplicitlyDisabled({ providerSetting: true, globalSetting: false }),
    ).toBe(false);
    expect(
      isNativeCommandsExplicitlyDisabled({ providerSetting: "auto", globalSetting: false }),
    ).toBe(false);
  });
});

describe("isRestartEnabled", () => {
  it("defaults to enabled unless explicitly false", () => {
    expect(isRestartEnabled(undefined)).toBe(true);
    expect(isRestartEnabled({})).toBe(true);
    expect(isRestartEnabled({ commands: {} })).toBe(true);
    expect(isRestartEnabled({ commands: { restart: true } })).toBe(true);
    expect(isRestartEnabled({ commands: { restart: false } })).toBe(false);
  });

  it("ignores inherited restart flags", () => {
    expect(
      isRestartEnabled({
        commands: Object.create({ restart: false }) as Record<string, unknown>,
      }),
    ).toBe(true);
  });
});

describe("isModelsWriteEnabled", () => {
  it("defaults to enabled unless explicitly false", () => {
    expect(isModelsWriteEnabled(undefined)).toBe(true);
    expect(isModelsWriteEnabled({})).toBe(true);
    expect(isModelsWriteEnabled({ commands: {} })).toBe(true);
    expect(isModelsWriteEnabled({ commands: { modelsWrite: true } })).toBe(true);
    expect(isModelsWriteEnabled({ commands: { modelsWrite: false } })).toBe(false);
  });

  it("ignores inherited modelsWrite flags", () => {
    expect(
      isModelsWriteEnabled({
        commands: Object.create({ modelsWrite: false }) as Record<string, unknown>,
      }),
    ).toBe(true);
  });
});

describe("isCommandFlagEnabled", () => {
  it("requires own boolean true", () => {
    expect(isCommandFlagEnabled({ commands: { bash: true } }, "bash")).toBe(true);
    expect(isCommandFlagEnabled({ commands: { bash: false } }, "bash")).toBe(false);
    expect(
      isCommandFlagEnabled(
        {
          commands: Object.create({ bash: true }) as Record<string, unknown>,
        },
        "bash",
      ),
    ).toBe(false);
  });
});
