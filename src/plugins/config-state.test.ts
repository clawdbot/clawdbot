import { describe, expect, it } from "vitest";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveEnableState,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
} from "./config-state.js";

function normalizeVoiceCallEntry(entry: Record<string, unknown>) {
  return normalizePluginsConfig({
    entries: {
      "voice-call": entry,
    },
  }).entries["voice-call"];
}

function expectResolvedEnableState(
  params: Parameters<typeof resolveEnableState>,
  expected: ReturnType<typeof resolveEnableState>,
) {
  expect(resolveEnableState(...params)).toEqual(expected);
}

function expectNormalizedEnableState(params: {
  id: string;
  origin: "bundled" | "workspace";
  config: Record<string, unknown>;
  manifestEnabledByDefault?: boolean;
  expected: ReturnType<typeof resolveEnableState>;
}) {
  expectResolvedEnableState(
    [
      params.id,
      params.origin,
      normalizePluginsConfig(params.config),
      params.manifestEnabledByDefault,
    ],
    params.expected,
  );
}

describe("normalizePluginsConfig", () => {
  it.each([
    [{}, "memory-core"],
    [{ slots: { memory: "custom-memory" } }, "custom-memory"],
    [{ slots: { memory: "none" } }, null],
    [{ slots: { memory: "None" } }, null],
    [{ slots: { memory: "  custom-memory  " } }, "custom-memory"],
    [{ slots: { memory: "" } }, "memory-core"],
    [{ slots: { memory: "   " } }, "memory-core"],
  ] as const)("normalizes memory slot for %o", (config, expected) => {
    expect(normalizePluginsConfig(config).slots.memory).toBe(expected);
  });

  it.each([
    [{}, undefined],
    [{ slots: { contextEngine: "lossless-claw" } }, "lossless-claw"],
    [{ slots: { contextEngine: "none" } }, null],
    [{ slots: { contextEngine: "  cortex  " } }, "cortex"],
    [{ slots: { contextEngine: "" } }, undefined],
  ] as const)("preserves contextEngine slot for %o (#64170)", (config, expected) => {
    expect(normalizePluginsConfig(config).slots.contextEngine).toBe(expected);
  });

  it.each([
    {
      name: "normalizes plugin hook policy flags",
      entry: {
        hooks: {
          allowPromptInjection: false,
          allowConversationAccess: true,
        },
      },
      expectedHooks: {
        allowPromptInjection: false,
        allowConversationAccess: true,
      },
    },
    {
      name: "drops invalid plugin hook policy values",
      entry: {
        hooks: {
          allowPromptInjection: "nope",
          allowConversationAccess: "nope",
        } as unknown as { allowPromptInjection: boolean; allowConversationAccess: boolean },
      },
      expectedHooks: undefined,
    },
  ] as const)("$name", ({ entry, expectedHooks }) => {
    expect(normalizeVoiceCallEntry(entry)?.hooks).toEqual(expectedHooks);
  });

  it.each([
    {
      name: "normalizes plugin subagent override policy settings",
      subagent: {
        allowModelOverride: true,
        allowedModels: [" anthropic/claude-sonnet-4-6 ", "", "openai/gpt-5.5"],
      },
      expected: {
        allowModelOverride: true,
        hasAllowedModelsConfig: true,
        allowedModels: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.5"],
      },
    },
    {
      name: "preserves explicit subagent allowlist intent even when all entries are invalid",
      subagent: {
        allowModelOverride: true,
        allowedModels: [42, null, "anthropic"],
      } as unknown as { allowModelOverride: boolean; allowedModels: string[] },
      expected: {
        allowModelOverride: true,
        hasAllowedModelsConfig: true,
        allowedModels: ["anthropic"],
      },
    },
    {
      name: "keeps explicit invalid subagent allowlist config visible to callers",
      subagent: {
        allowModelOverride: "nope",
        allowedModels: [42, null],
      } as unknown as { allowModelOverride: boolean; allowedModels: string[] },
      expected: {
        hasAllowedModelsConfig: true,
      },
    },
  ] as const)("$name", ({ subagent, expected }) => {
    expect(normalizeVoiceCallEntry({ subagent })?.subagent).toEqual(expected);
  });

  it("normalizes legacy plugin ids to their merged bundled plugin id", () => {
    const result = normalizePluginsConfig({
      allow: ["openai-codex", "google-gemini-cli", "minimax-portal-auth"],
      deny: ["openai-codex", "google-gemini-cli", "minimax-portal-auth"],
      entries: {
        "openai-codex": {
          enabled: true,
        },
        "google-gemini-cli": {
          enabled: true,
        },
        "minimax-portal-auth": {
          enabled: false,
        },
      },
    });

    expect(result.allow).toEqual(["openai", "google", "minimax"]);
    expect(result.deny).toEqual(["openai", "google", "minimax"]);
    expect(result.entries.openai?.enabled).toBe(true);
    expect(result.entries.google?.enabled).toBe(true);
    expect(result.entries.minimax?.enabled).toBe(false);
  });
});

describe("resolveEffectiveEnableState", () => {
  function resolveBundledTelegramState(config: Parameters<typeof normalizePluginsConfig>[0]) {
    const normalized = normalizePluginsConfig(config);
    return resolveEffectiveEnableState({
      id: "telegram",
      origin: "bundled",
      config: normalized,
      rootConfig: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
      },
    });
  }

  function resolveConfigOriginTelegramState(config: Parameters<typeof normalizePluginsConfig>[0]) {
    const normalized = normalizePluginsConfig(config);
    return resolveEffectiveEnableState({
      id: "telegram",
      origin: "config",
      config: normalized,
      rootConfig: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
      },
    });
  }

  it.each([
    [{ enabled: true }, { enabled: true }],
    [{ enabled: true, allow: ["browser"] as string[] }, { enabled: true }],
    [
      {
        enabled: true,
        entries: {
          telegram: {
            enabled: false,
          },
        },
      },
      { enabled: false, reason: "disabled in config" },
    ],
  ] as const)("resolves bundled telegram state for %o", (config, expected) => {
    expect(resolveBundledTelegramState(config)).toEqual(expected);
  });

  it("does not bypass allowlists for non-bundled plugins that reuse a channel id", () => {
    expect(
      resolveConfigOriginTelegramState({
        enabled: true,
        allow: ["browser"] as string[],
      }),
    ).toEqual({ enabled: false, reason: "not in allowlist" });
  });
});

describe("resolveEffectivePluginActivationState", () => {
  it("distinguishes explicit enablement from auto activation", () => {
    const rawConfig: NonNullable<
      Parameters<typeof resolveEffectivePluginActivationState>[0]["rootConfig"]
    > = {
      channels: {
        telegram: {
          botToken: "x",
        },
      },
    };
    const effectiveConfig: NonNullable<
      Parameters<typeof resolveEffectivePluginActivationState>[0]["rootConfig"]
    > = {
      channels: {
        telegram: {
          botToken: "x",
          enabled: true,
        },
      },
    };

    expect(
      resolveEffectivePluginActivationState({
        id: "telegram",
        origin: "bundled",
        config: normalizePluginsConfig(effectiveConfig.plugins),
        rootConfig: effectiveConfig,
        activationSource: createPluginActivationSource({ config: rawConfig }),
        autoEnabledReason: "telegram configured",
      }),
    ).toEqual({
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "auto",
      reason: "telegram configured",
    });
  });

  it("preserves explicit selection even when plugins are globally disabled", () => {
    const rawConfig = {
      plugins: {
        enabled: false,
        entries: {
          browser: {
            enabled: true,
          },
        },
      },
    };

    expect(
      resolveEffectivePluginActivationState({
        id: "browser",
        origin: "bundled",
        config: normalizePluginsConfig(rawConfig.plugins),
        rootConfig: rawConfig,
        activationSource: createPluginActivationSource({ config: rawConfig }),
      }),
    ).toEqual({
      enabled: false,
      activated: false,
      explicitlyEnabled: true,
      source: "disabled",
      reason: "plugins disabled",
    });
  });

  it("marks bundled default-enabled plugins as default activation", () => {
    expect(
      resolveEffectivePluginActivationState({
        id: "openai",
        origin: "bundled",
        config: normalizePluginsConfig({}),
        enabledByDefault: true,
      }),
    ).toEqual({
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "default",
      reason: "bundled default enablement",
    });
  });

  it("keeps allowlists authoritative over explicit bundled plugin enablement", () => {
    const rawConfig = {
      plugins: {
        allow: ["browser"],
        entries: {
          telegram: {
            enabled: true,
          },
        },
      },
    };

    expect(
      resolveEffectivePluginActivationState({
        id: "telegram",
        origin: "bundled",
        config: normalizePluginsConfig(rawConfig.plugins),
        rootConfig: rawConfig,
        activationSource: createPluginActivationSource({ config: rawConfig }),
      }),
    ).toEqual({
      enabled: false,
      activated: false,
      explicitlyEnabled: true,
      source: "disabled",
      reason: "not in allowlist",
    });
  });

  it("lets explicit bundled channel activation bypass the allowlist", () => {
    const rawConfig = {
      channels: {
        telegram: {
          enabled: true,
        },
      },
      plugins: {
        allow: ["browser"],
      },
    };

    expect(
      resolveEffectivePluginActivationState({
        id: "telegram",
        origin: "bundled",
        config: normalizePluginsConfig(rawConfig.plugins),
        rootConfig: rawConfig,
        activationSource: createPluginActivationSource({ config: rawConfig }),
      }),
    ).toEqual({
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      reason: "channel enabled in config",
    });
  });

  it("keeps denylist authoritative over explicit bundled channel activation", () => {
    const rawConfig = {
      channels: {
        telegram: {
          enabled: true,
        },
      },
      plugins: {
        deny: ["telegram"],
      },
    };

    expect(
      resolveEffectivePluginActivationState({
        id: "telegram",
        origin: "bundled",
        config: normalizePluginsConfig(rawConfig.plugins),
        rootConfig: rawConfig,
        activationSource: createPluginActivationSource({ config: rawConfig }),
      }),
    ).toEqual({
      enabled: false,
      activated: false,
      explicitlyEnabled: true,
      source: "disabled",
      reason: "blocked by denylist",
    });
  });

  it("does not let auto-enable reasons bypass the allowlist", () => {
    const rawConfig = {
      plugins: {
        allow: ["browser"],
      },
    };

    expect(
      resolveEffectivePluginActivationState({
        id: "telegram",
        origin: "bundled",
        config: normalizePluginsConfig(rawConfig.plugins),
        rootConfig: rawConfig,
        activationSource: createPluginActivationSource({ config: rawConfig }),
        autoEnabledReason: "telegram configured",
      }),
    ).toEqual({
      enabled: false,
      activated: false,
      explicitlyEnabled: false,
      source: "disabled",
      reason: "not in allowlist",
    });
  });

  it("preserves activation when only the effective config enables a bundled plugin", () => {
    const sourceConfig = {
      plugins: {},
    };
    const effectiveConfig = {
      plugins: {
        entries: {
          openai: {
            enabled: true,
          },
        },
      },
    };

    expect(
      resolveEffectivePluginActivationState({
        id: "openai",
        origin: "bundled",
        config: normalizePluginsConfig(effectiveConfig.plugins),
        rootConfig: effectiveConfig,
        activationSource: createPluginActivationSource({ config: sourceConfig }),
      }),
    ).toEqual({
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "auto",
      reason: "enabled by effective config",
    });
  });

  it("treats an explicitly selected workspace context engine as explicit activation", () => {
    const rawConfig = {
      plugins: {
        slots: {
          contextEngine: "lossless-claw",
        },
      },
    };

    expect(
      resolveEffectivePluginActivationState({
        id: "lossless-claw",
        origin: "workspace",
        config: normalizePluginsConfig(rawConfig.plugins),
        rootConfig: rawConfig,
        activationSource: createPluginActivationSource({ config: rawConfig }),
      }),
    ).toEqual({
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      reason: "selected context engine slot",
    });
  });
});

describe("resolveEnableState", () => {
  it.each([
    [
      "openai",
      "bundled",
      normalizePluginsConfig({}),
      undefined,
      { enabled: false, reason: "bundled (disabled by default)" },
    ],
    ["openai", "bundled", normalizePluginsConfig({}), true, { enabled: true }],
    ["google", "bundled", normalizePluginsConfig({}), true, { enabled: true }],
    ["profile-aware", "bundled", normalizePluginsConfig({}), true, { enabled: true }],
  ] as const)(
    "resolves %s enable state for origin=%s manifestEnabledByDefault=%s",
    (id, origin, config, manifestEnabledByDefault, expected) => {
      expectResolvedEnableState([id, origin, config, manifestEnabledByDefault], expected);
    },
  );

  it.each([
    {
      name: "keeps the selected memory slot plugin enabled even when omitted from plugins.allow",
      config: {
        allow: ["telegram"],
        slots: { memory: "memory-core" },
      },
      expected: { enabled: true },
    },
    {
      name: "keeps explicit disable authoritative for the selected memory slot plugin",
      config: {
        allow: ["telegram"],
        slots: { memory: "memory-core" },
        entries: {
          "memory-core": {
            enabled: false,
          },
        },
      },
      expected: { enabled: false, reason: "disabled in config" },
    },
  ] as const)("$name", ({ config, expected }) => {
    expectNormalizedEnableState({
      id: "memory-core",
      origin: "bundled",
      config,
      expected,
    });
  });

  it.each([
    [
      normalizePluginsConfig({}),
      {
        enabled: false,
        reason: "workspace plugin (disabled by default)",
      },
    ],
    [
      normalizePluginsConfig({
        allow: ["workspace-helper"],
      }),
      { enabled: true },
    ],
    [
      normalizePluginsConfig({
        entries: {
          "workspace-helper": {
            enabled: true,
          },
        },
      }),
      { enabled: true },
    ],
  ] as const)("resolves workspace-helper enable state for %o", (config, expected) => {
    expect(resolveEnableState("workspace-helper", "workspace", config)).toEqual(expected);
  });

  it("does not let the default memory slot auto-enable an untrusted workspace plugin", () => {
    expectNormalizedEnableState({
      id: "memory-core",
      origin: "workspace",
      config: {
        slots: { memory: "memory-core" },
      },
      expected: {
        enabled: false,
        reason: "workspace plugin (disabled by default)",
      },
    });
  });

  it("keeps an explicitly selected workspace context engine enabled when omitted from plugins.allow", () => {
    expectNormalizedEnableState({
      id: "lossless-claw",
      origin: "workspace",
      config: {
        allow: ["telegram"],
        slots: { contextEngine: "lossless-claw" },
      },
      expected: {
        enabled: true,
      },
    });
  });
});

describe("resolveMemorySlotDecision", () => {
  it("disables a memory-only plugin when slot points elsewhere", () => {
    const result = resolveMemorySlotDecision({
      id: "old-memory",
      kind: "memory",
      slot: "new-memory",
      selectedId: null,
    });
    expect(result.enabled).toBe(false);
  });

  it("keeps a dual-kind plugin enabled when memory slot points elsewhere", () => {
    const result = resolveMemorySlotDecision({
      id: "dual-plugin",
      kind: ["memory", "context-engine"],
      slot: "new-memory",
      selectedId: null,
    });
    expect(result.enabled).toBe(true);
    expect(result.selected).toBeUndefined();
  });

  it("selects a dual-kind plugin when it owns the memory slot", () => {
    const result = resolveMemorySlotDecision({
      id: "dual-plugin",
      kind: ["memory", "context-engine"],
      slot: "dual-plugin",
      selectedId: null,
    });
    expect(result.enabled).toBe(true);
    expect(result.selected).toBe(true);
  });

  it("keeps a dual-kind plugin enabled when memory slot is null", () => {
    const result = resolveMemorySlotDecision({
      id: "dual-plugin",
      kind: ["memory", "context-engine"],
      slot: null,
      selectedId: null,
    });
    expect(result.enabled).toBe(true);
  });

  it("disables a memory-only plugin when memory slot is null", () => {
    const result = resolveMemorySlotDecision({
      id: "old-memory",
      kind: "memory",
      slot: null,
      selectedId: null,
    });
    expect(result.enabled).toBe(false);
  });
});
