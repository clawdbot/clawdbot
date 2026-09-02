// Covers plugin config state normalization and reset behavior.
import { describe, expect, it, vi } from "vitest";
import * as bundledChannelCatalog from "../channels/bundled-channel-catalog-read.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveEnableState,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
} from "./config-state.js";
import * as discovery from "./discovery.js";
import * as manifest from "./manifest.js";

function normalizeVoiceCallEntry(entry: Record<string, unknown>) {
  return normalizePluginsConfig({
    entries: {
      "voice-call": entry,
    },
  }).entries["voice-call"];
}

type ActivationProvenance = Pick<
  ReturnType<typeof resolveEffectivePluginActivationState>,
  "explicitlyEnabled" | "source" | "reason"
>;

function expectResolvedEnableState(
  params: Parameters<typeof resolveEnableState>,
  expected: ReturnType<typeof resolveEnableState>,
  provenance?: ActivationProvenance,
) {
  expect(resolveEnableState(...params)).toEqual(expected);
  if (provenance) {
    const [id, origin, config, enabledByDefault] = params;
    expect(resolveEffectivePluginActivationState({ id, origin, config, enabledByDefault })).toEqual(
      { enabled: expected.enabled, activated: expected.enabled, ...provenance },
    );
  }
}

function expectNormalizedEnableState(params: {
  id: string;
  origin: "bundled" | "workspace";
  config: Record<string, unknown>;
  manifestEnabledByDefault?: boolean;
  expected: ReturnType<typeof resolveEnableState>;
  provenance?: ActivationProvenance;
}) {
  expectResolvedEnableState(
    [
      params.id,
      params.origin,
      normalizePluginsConfig(params.config),
      params.manifestEnabledByDefault,
    ],
    params.expected,
    params.provenance,
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
          timeoutMs: 250,
          timeouts: {
            before_prompt_build: 90_000,
            agent_end: 60_000,
          },
        },
      },
      expectedHooks: {
        allowPromptInjection: false,
        allowConversationAccess: true,
        timeoutMs: 250,
        timeouts: {
          before_prompt_build: 90_000,
          agent_end: 60_000,
        },
      },
    },
    {
      name: "drops invalid plugin hook policy values",
      entry: {
        hooks: {
          allowPromptInjection: "nope",
          allowConversationAccess: "nope",
          timeoutMs: 0,
          timeouts: {
            before_prompt_build: 900_000,
          },
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

  it("normalizes plugin llm override policy settings", () => {
    expect(
      normalizeVoiceCallEntry({
        llm: {
          allowModelOverride: true,
          allowedModels: [" openai/gpt-5.4 ", "", "anthropic/claude-sonnet-4-6"],
          allowedCompletionModels: [" openai/gpt-5.4 ", "", "google/gemini-3-flash"],
          allowAuthProfileOverride: true,
          allowAgentIdOverride: false,
        },
      })?.llm,
    ).toEqual({
      allowModelOverride: true,
      hasAllowedModelsConfig: true,
      allowedModels: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
      hasAllowedCompletionModelsConfig: true,
      allowedCompletionModels: ["openai/gpt-5.4", "google/gemini-3-flash"],
      allowAuthProfileOverride: true,
      allowAgentIdOverride: false,
    });
  });

  it("normalizes legacy plugin ids to their merged bundled plugin id", () => {
    const result = normalizePluginsConfig({
      allow: ["openai", "google-gemini-cli", "minimax-portal-auth"],
      deny: ["openai", "google-gemini-cli", "minimax-portal-auth"],
      entries: {
        openai: {
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

  it("normalizes unknown plugin ids without consulting discovery", async () => {
    const discoverPlugins = vi.spyOn(discovery, "discoverOpenClawPlugins");
    discoverPlugins.mockClear();

    const result = normalizePluginsConfig({
      allow: ["unknown-plugin-one", "unknown-plugin-two"],
      deny: ["unknown-plugin-three"],
      entries: {
        "unknown-plugin-four": {
          enabled: true,
        },
      },
    });

    expect(result.allow).toEqual(["unknown-plugin-one", "unknown-plugin-two"]);
    expect(result.deny).toEqual(["unknown-plugin-three"]);
    expect(result.entries["unknown-plugin-four"]?.enabled).toBe(true);
    expect(discoverPlugins).not.toHaveBeenCalled();
  });

  it("normalizes unknown plugin ids to lowercase canonical keys", () => {
    const result = normalizePluginsConfig({
      allow: [" Demo-Plugin "],
      deny: [" OTHER-PLUGIN "],
      entries: {
        " CODEX ": { enabled: true },
      },
    });

    expect(result.allow).toEqual(["demo-plugin"]);
    expect(result.deny).toEqual(["other-plugin"]);
    expect(result.entries.codex?.enabled).toBe(true);
  });

  it("does not consult discovery or manifests for alias lookup", async () => {
    const discoverPlugins = vi.spyOn(discovery, "discoverOpenClawPlugins").mockReturnValue({
      candidates: [
        {
          idHint: "anthropic",
          source: "/tmp/openclaw-bundled-anthropic/index.js",
          rootDir: "/tmp/openclaw-bundled-anthropic",
          origin: "bundled",
          bundledManifest: {
            id: "anthropic",
            configSchema: {},
            providers: ["anthropic"],
          },
        },
        {
          idHint: "external-anthropic",
          source: "/tmp/openclaw-global-anthropic/index.js",
          rootDir: "/tmp/openclaw-global-anthropic",
          origin: "global",
        },
      ],
      diagnostics: [],
    });
    const loadManifest = vi.spyOn(manifest, "loadPluginManifest").mockReturnValue({
      ok: true,
      manifestPath: "/tmp/openclaw-global-anthropic/openclaw.plugin.json",
      manifest: {
        id: "external-anthropic",
        configSchema: {},
        providers: ["anthropic"],
      },
    });
    discoverPlugins.mockClear();
    loadManifest.mockClear();

    const result = normalizePluginsConfig({
      deny: ["anthropic"],
    });

    expect(result.deny).toEqual(["anthropic"]);
    expect(discoverPlugins).not.toHaveBeenCalled();
    expect(loadManifest).not.toHaveBeenCalled();
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
  type ActivationParams = Parameters<typeof resolveEffectivePluginActivationState>[0];

  it.each<{
    name: string;
    params: Pick<
      ActivationParams,
      "id" | "origin" | "enabledByDefault" | "autoEnabledReason" | "channelIds"
    >;
    rawConfig?: ActivationParams["rootConfig"];
    effectiveConfig?: ActivationParams["rootConfig"];
    expected: ReturnType<typeof resolveEffectivePluginActivationState>;
  }>([
    {
      name: "distinguishes explicit enablement from auto activation",
      params: { id: "telegram", origin: "bundled", autoEnabledReason: "telegram configured" },
      rawConfig: { channels: { telegram: { botToken: "x" } } },
      effectiveConfig: { channels: { telegram: { botToken: "x", enabled: true } } },
      expected: {
        enabled: true,
        activated: true,
        explicitlyEnabled: false,
        source: "auto",
        reason: "telegram configured",
      },
    },
    {
      name: "preserves explicit selection even when plugins are globally disabled",
      params: { id: "browser", origin: "bundled" },
      rawConfig: { plugins: { enabled: false, entries: { browser: { enabled: true } } } },
      expected: {
        enabled: false,
        activated: false,
        explicitlyEnabled: true,
        source: "disabled",
        reason: "plugins disabled",
      },
    },
    {
      name: "marks bundled default-enabled plugins as default activation",
      params: { id: "openai", origin: "bundled", enabledByDefault: true },
      rawConfig: {},
      expected: {
        enabled: true,
        activated: true,
        explicitlyEnabled: false,
        source: "default",
        reason: "bundled default enablement",
      },
    },
    {
      name: "keeps allowlists authoritative over explicit bundled plugin enablement",
      params: { id: "telegram", origin: "bundled" },
      rawConfig: { plugins: { allow: ["browser"], entries: { telegram: { enabled: true } } } },
      expected: {
        enabled: false,
        activated: false,
        explicitlyEnabled: true,
        source: "disabled",
        reason: "not in allowlist",
      },
    },
    {
      name: "lets explicit bundled channel activation bypass the allowlist",
      params: { id: "telegram", origin: "bundled" },
      rawConfig: {
        channels: { telegram: { enabled: true } },
        plugins: { allow: ["browser"] },
      },
      expected: {
        enabled: true,
        activated: true,
        explicitlyEnabled: true,
        source: "explicit",
        reason: "channel enabled in config",
      },
    },
    {
      name: "keeps denylist authoritative over explicit bundled channel activation",
      params: { id: "telegram", origin: "bundled" },
      rawConfig: {
        channels: { telegram: { enabled: true } },
        plugins: { deny: ["telegram"] },
      },
      expected: {
        enabled: false,
        activated: false,
        explicitlyEnabled: true,
        source: "disabled",
        reason: "blocked by denylist",
      },
    },
    {
      name: "does not let auto-enable reasons bypass the allowlist",
      params: { id: "telegram", origin: "bundled", autoEnabledReason: "telegram configured" },
      rawConfig: { plugins: { allow: ["browser"] } },
      expected: {
        enabled: false,
        activated: false,
        explicitlyEnabled: false,
        source: "disabled",
        reason: "not in allowlist",
      },
    },
    {
      name: "preserves activation when only the effective config enables a bundled plugin",
      params: { id: "openai", origin: "bundled" },
      rawConfig: { plugins: {} },
      effectiveConfig: { plugins: { entries: { openai: { enabled: true } } } },
      expected: {
        enabled: true,
        activated: true,
        explicitlyEnabled: false,
        source: "auto",
        reason: "enabled by effective config",
      },
    },
    {
      name: "treats an explicitly selected workspace context engine as explicit activation",
      params: { id: "lossless-claw", origin: "workspace" },
      rawConfig: { plugins: { slots: { contextEngine: "lossless-claw" } } },
      expected: {
        enabled: true,
        activated: true,
        explicitlyEnabled: true,
        source: "explicit",
        reason: "selected context engine slot",
      },
    },
    {
      name: "marks a channel enabled only in effective config as auto activation without an override reason",
      params: { id: "telegram", origin: "bundled" },
      rawConfig: {},
      effectiveConfig: { channels: { telegram: { enabled: true } } },
      expected: {
        enabled: true,
        activated: true,
        explicitlyEnabled: false,
        source: "auto",
        reason: "channel configured",
      },
    },
    {
      name: "keeps an explicit channel disable authoritative over plugin entry enablement",
      params: { id: "telegram", origin: "bundled" },
      rawConfig: {
        channels: { telegram: { enabled: false } },
        plugins: { entries: { telegram: { enabled: true } } },
      },
      expected: {
        enabled: false,
        activated: false,
        explicitlyEnabled: true,
        source: "disabled",
        reason: "channel disabled in config",
      },
    },
    {
      name: "resolves an explicit channel disable through manifest-owned channel ids",
      // QQ Bot style: plugin id `openclaw-demo` owns `channels.demo`, which the built-in
      // catalog cannot map from the plugin id alone.
      params: { id: "openclaw-demo", origin: "bundled", channelIds: ["demo"] },
      rawConfig: {
        channels: { demo: { enabled: false } },
        plugins: { entries: { "openclaw-demo": { enabled: true } } },
      },
      expected: {
        enabled: false,
        activated: false,
        explicitlyEnabled: true,
        source: "disabled",
        reason: "channel disabled in config",
      },
    },
    {
      name: "keeps a global plugin default-enabled without inventing explicit selection or a reason",
      params: { id: "global-helper", origin: "global" },
      expected: {
        enabled: true,
        activated: true,
        explicitlyEnabled: false,
        source: "default",
        reason: undefined,
      },
    },
  ])("$name", ({ params, rawConfig, effectiveConfig = rawConfig, expected }) => {
    const catalog = vi.spyOn(bundledChannelCatalog, "listBundledChannelCatalogEntries");
    try {
      expect(
        resolveEffectivePluginActivationState({
          ...params,
          config: normalizePluginsConfig(effectiveConfig ? effectiveConfig.plugins : {}),
          ...(effectiveConfig ? { rootConfig: effectiveConfig } : {}),
          ...(rawConfig
            ? { activationSource: createPluginActivationSource({ config: rawConfig }) }
            : {}),
        }),
      ).toEqual(expected);
      if (!rawConfig?.channels && !effectiveConfig?.channels) {
        expect(catalog).not.toHaveBeenCalled();
      }
    } finally {
      catalog.mockRestore();
    }
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
      {
        explicitlyEnabled: false,
        source: "disabled",
        reason: "bundled (disabled by default)",
      },
    ],
    ["openai", "bundled", normalizePluginsConfig({}), true, { enabled: true }],
    ["google", "bundled", normalizePluginsConfig({}), true, { enabled: true }],
    ["profile-aware", "bundled", normalizePluginsConfig({}), true, { enabled: true }],
  ] as const)(
    "resolves %s enable state for origin=%s manifestEnabledByDefault=%s",
    (id, origin, config, manifestEnabledByDefault, expected, provenance?: ActivationProvenance) => {
      expectResolvedEnableState(
        [id, origin, config, manifestEnabledByDefault],
        expected,
        provenance,
      );
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
      provenance: {
        explicitlyEnabled: true,
        source: "explicit",
        reason: "selected memory slot",
      },
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
      provenance: {
        explicitlyEnabled: true,
        source: "disabled",
        reason: "disabled in config",
      },
    },
  ] as const)("$name", ({ config, expected, provenance }) => {
    expectNormalizedEnableState({
      id: "memory-core",
      origin: "bundled",
      config,
      expected,
      provenance,
    });
  });

  it.each([
    [
      normalizePluginsConfig({}),
      {
        enabled: false,
        reason: "workspace plugin (disabled by default)",
      },
      {
        explicitlyEnabled: false,
        source: "disabled",
        reason: "workspace plugin (disabled by default)",
      },
    ],
    [
      normalizePluginsConfig({
        allow: ["workspace-helper"],
      }),
      { enabled: true },
      { explicitlyEnabled: true, source: "explicit", reason: "selected in allowlist" },
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
      { explicitlyEnabled: true, source: "explicit", reason: "enabled in config" },
    ],
  ] as const)("resolves workspace-helper enable state for %o", (config, expected, provenance) => {
    expect(resolveEnableState("workspace-helper", "workspace", config)).toEqual(expected);
    expect(
      resolveEffectivePluginActivationState({
        id: "workspace-helper",
        origin: "workspace",
        config,
      }),
    ).toEqual({ enabled: expected.enabled, activated: expected.enabled, ...provenance });
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
      provenance: {
        explicitlyEnabled: true,
        source: "disabled",
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
