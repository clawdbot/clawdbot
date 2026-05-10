import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  isCommandFlagEnabled,
  isRestartEnabled,
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "./commands.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

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

  it("uses only enabled package channel metadata for bundled auto defaults before runtime loads", () => {
    setActivePluginRegistry(createTestRegistry([]));
    const env = {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
      OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1",
    };

    expect(
      resolveNativeSkillsEnabled({
        providerId: "discord",
        globalSetting: "auto",
        env,
      }),
    ).toBe(false);
    expect(
      resolveNativeSkillsEnabled({
        providerId: "discord",
        globalSetting: "auto",
        env,
        config: {
          plugins: {
            entries: {
              discord: {
                enabled: true,
              },
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      resolveNativeCommandsEnabled({
        providerId: "slack",
        globalSetting: "auto",
        env,
      }),
    ).toBe(false);
    expect(
      resolveNativeCommandsEnabled({
        providerId: "discord",
        globalSetting: "auto",
        env,
        config: {
          plugins: {
            entries: {
              discord: {
                enabled: false,
              },
            },
          },
        },
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

describe("plugin registry auto defaults", () => {
  it.each([
    {
      name: "native skills",
      resolve: resolveNativeSkillsEnabled,
    },
    {
      name: "native commands",
      resolve: resolveNativeCommandsEnabled,
    },
  ])(
    "uses the plugin registry for auto defaults even when chat-channel normalization misses for $name",
    ({ resolve }) => {
      expect(
        resolve({
          providerId: "demo-channel",
          globalSetting: "auto",
        }),
      ).toBe(true);
    },
  );
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

describe("deprecated commands compatibility", () => {
  it("ignores legacy modelsWrite during validation", () => {
    const result = validateConfigObjectWithPlugins({
      commands: { text: true, modelsWrite: false },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.commands?.text).toBe(true);
      expect(Object.hasOwn(result.config.commands ?? {}, "modelsWrite")).toBe(false);
    }
  });
});
