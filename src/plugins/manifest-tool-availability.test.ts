// Manifest tool-availability tests cover config, auth, environment, and base-URL gates.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import {
  hasManifestToolAvailability,
  hasNonEmptyManifestEnvCandidate,
  manifestConfigSignalPasses,
  manifestPluginSetupProviderEnvVars,
  manifestProviderBaseUrlGuardPasses,
} from "./manifest-tool-availability.js";

function makePlugin(overrides: Partial<PluginManifestRecord>): PluginManifestRecord {
  return {
    id: "demo",
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: "/tmp/demo",
    source: "/tmp/demo/index.js",
    manifestPath: "/tmp/demo/openclaw.plugin.json",
    ...overrides,
  };
}

function makeConfig(value: Record<string, unknown>): OpenClawConfig {
  return value as OpenClawConfig;
}

const webSearchSignal = {
  rootPath: "plugins.entries.xai.config",
  overlayPath: "webSearch",
  required: ["apiKey"],
};

function xaiConfig(config: Record<string, unknown>): OpenClawConfig {
  return makeConfig({ plugins: { entries: { xai: { config } } } });
}

describe("manifestConfigSignalPasses", () => {
  it.each([
    {
      name: "missing root",
      config: makeConfig({}),
      signal: webSearchSignal,
      expected: false,
    },
    {
      name: "overlay supplies required value",
      config: xaiConfig({ apiKey: "", webSearch: { apiKey: "token" } }),
      signal: webSearchSignal,
      expected: true,
    },
    {
      name: "overlay clears root required value",
      config: xaiConfig({ apiKey: "token", webSearch: { apiKey: "" } }),
      signal: webSearchSignal,
      expected: false,
    },
    {
      name: "requiredAny accepts one configured path",
      config: makeConfig({ channels: { demo: { tokenFile: "/tmp/token" } } }),
      signal: { rootPath: "channels.demo", requiredAny: ["token", "tokenFile"] },
      expected: true,
    },
    {
      name: "requiredAny rejects missing configured paths",
      config: makeConfig({ channels: { demo: { other: true } } }),
      signal: { rootPath: "channels.demo", requiredAny: ["token", "tokenFile"] },
      expected: false,
    },
    {
      name: "mode uses an allowed default",
      config: makeConfig({ channels: { demo: {} } }),
      signal: {
        rootPath: "channels.demo",
        mode: { default: "poll", allowed: ["poll", "webhook"] },
      },
      expected: true,
    },
    {
      name: "mode rejects a value outside the allowlist",
      config: makeConfig({ channels: { demo: { mode: "off" } } }),
      signal: {
        rootPath: "channels.demo",
        mode: { allowed: ["poll", "webhook"] },
      },
      expected: false,
    },
    {
      name: "mode rejects a disallowed value",
      config: makeConfig({ channels: { demo: { mode: "webhook" } } }),
      signal: { rootPath: "channels.demo", mode: { disallowed: ["webhook"] } },
      expected: false,
    },
    {
      name: "mode rejects a missing value without a default",
      config: makeConfig({ channels: { demo: {} } }),
      signal: { rootPath: "channels.demo", mode: {} },
      expected: false,
    },
    {
      name: "overlay map accepts one configured account",
      config: makeConfig({
        channels: { demo: { accounts: { first: {}, second: { token: "abc" } } } },
      }),
      signal: { rootPath: "channels.demo", overlayMapPath: "accounts", required: ["token"] },
      expected: true,
    },
    {
      name: "overlay map rejects a missing map",
      config: makeConfig({ channels: { demo: { token: "abc" } } }),
      signal: { rootPath: "channels.demo", overlayMapPath: "accounts", required: ["token"] },
      expected: false,
    },
  ])("handles $name", ({ config, signal, expected }) => {
    expect(manifestConfigSignalPasses({ config, env: {}, signal })).toBe(expected);
  });

  it.each([
    ["", false],
    ["   ", false],
    [[], false],
    [{}, false],
    [null, false],
    [undefined, false],
    [0, true],
    [false, true],
    [["value"], true],
    [{ value: true }, true],
  ] as const)("treats required value %o as configured=%s", (apiKey, expected) => {
    expect(
      manifestConfigSignalPasses({
        config: xaiConfig({ webSearch: { apiKey } }),
        env: {},
        signal: webSearchSignal,
      }),
    ).toBe(expected);
  });

  it("resolves env secret refs only when their value is non-empty", () => {
    const config = xaiConfig({
      webSearch: { apiKey: { source: "env", id: "XAI_API_KEY" } },
    });
    expect(
      manifestConfigSignalPasses({
        config,
        env: { XAI_API_KEY: "token" },
        signal: webSearchSignal,
      }),
    ).toBe(true);
    expect(
      manifestConfigSignalPasses({
        config,
        env: { XAI_API_KEY: "   " },
        signal: webSearchSignal,
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "present selected env",
      selected: true,
      env: { COLLISION_KEY: "synthetic-key" },
      expected: true,
    },
    { name: "missing selected env", selected: true, env: {}, expected: false },
    {
      name: "non-default mismatch",
      selected: false,
      env: { COLLISION_KEY: "synthetic-key" },
      expected: false,
    },
  ])("evaluates $name under an exec collision", ({ selected, env, expected }) => {
    const config = xaiConfig({
      webSearch: { apiKey: { source: "env", provider: "selected", id: "COLLISION_KEY" } },
    });
    config.secrets = {
      defaults: selected ? { env: "selected" } : undefined,
      providers: { selected: { source: "exec", command: "/unused" } },
    };
    expect(manifestConfigSignalPasses({ config, env, signal: webSearchSignal })).toBe(expected);
  });

  it.each([
    { allowlist: ["XAI_API_KEY"], expected: true },
    { allowlist: ["OTHER_API_KEY"], expected: false },
  ])("honors the explicit env provider allowlist $allowlist", ({ allowlist, expected }) => {
    const config: OpenClawConfig = {
      ...xaiConfig({
        webSearch: { apiKey: { source: "env", provider: "shared", id: "XAI_API_KEY" } },
      }),
      secrets: { providers: { shared: { source: "env", allowlist } } },
    };
    expect(
      manifestConfigSignalPasses({
        config,
        env: { XAI_API_KEY: "token" },
        signal: webSearchSignal,
      }),
    ).toBe(expected);
  });
});

describe("manifestProviderBaseUrlGuardPasses", () => {
  const guard = {
    provider: "xai",
    defaultBaseUrl: "https://api.x.ai/v1",
    allowedBaseUrls: ["https://api.x.ai/v1"],
  };

  it("normalizes allowed URLs and rejects missing or foreign URLs", () => {
    expect(manifestProviderBaseUrlGuardPasses({ config: makeConfig({}), guard: undefined })).toBe(
      true,
    );
    expect(manifestProviderBaseUrlGuardPasses({ config: makeConfig({}), guard })).toBe(true);
    expect(
      manifestProviderBaseUrlGuardPasses({
        config: makeConfig({
          models: { providers: { xai: { baseUrl: "https://api.x.ai/v1//" } } },
        }),
        guard,
      }),
    ).toBe(true);
    expect(
      manifestProviderBaseUrlGuardPasses({
        config: makeConfig({}),
        guard: { provider: "xai", allowedBaseUrls: ["https://api.x.ai/v1"] },
      }),
    ).toBe(false);
  });
});

describe("manifest auth environment helpers", () => {
  it("uses setup provider env vars and returns empty without setup metadata", () => {
    // providerAuthEnvVars is retired; setup provider metadata is the canonical env source.
    const plugin = makePlugin({
      setup: { providers: [{ id: "xai", envVars: ["XAI_API_KEY"] }] },
    });
    expect(manifestPluginSetupProviderEnvVars(plugin, "xai")).toEqual(["XAI_API_KEY"]);
    expect(manifestPluginSetupProviderEnvVars(plugin, "other")).toEqual([]);
    expect(manifestPluginSetupProviderEnvVars(makePlugin({}), "xai")).toEqual([]);
  });

  it.each([
    [{ XAI_API_KEY: "token" }, ["XAI_API_KEY"], true],
    [{ XAI_API_KEY: "   " }, ["XAI_API_KEY"], false],
    [{ SECOND: "token" }, ["FIRST", "SECOND"], true],
    [{ OTHER: "token" }, [" ", ""], false],
  ] as const)("resolves env candidates", (env, envVars, expected) => {
    expect(hasNonEmptyManifestEnvCandidate(env, envVars)).toBe(expected);
  });
});

describe("hasManifestToolAvailability", () => {
  const xaiPlugin = makePlugin({
    id: "xai",
    providers: ["xai"],
    setup: { providers: [{ id: "xai", envVars: ["XAI_API_KEY"] }] },
    toolMetadata: {
      x_search: {
        authSignals: [{ provider: "xai" }],
        configSignals: [webSearchSignal],
      },
    },
  });

  it.each<{
    name: string;
    ref: SecretRef;
    secrets?: OpenClawConfig["secrets"];
    expected: boolean;
  }>([
    {
      name: "implicit store default",
      ref: { source: "store", provider: "default", id: "TOOL_API_KEY" },
      expected: true,
    },
    {
      name: "selected store default without a declaration",
      ref: { source: "store", provider: "shared", id: "TOOL_API_KEY" },
      secrets: { defaults: { store: "shared" } },
      expected: true,
    },
    ...(
      [
        { source: "file", path: "/tmp/unused-store-alias-fixture.json" },
        { source: "env" },
        { source: "exec", command: "/tmp/unused-store-alias-command" },
      ] as const
    ).map((provider) => ({
      name: `selected store default shadowing ${provider.source}`,
      ref: { source: "store", provider: "shared", id: "TOOL_API_KEY" } as const,
      secrets: { defaults: { store: "shared" }, providers: { shared: provider } },
      expected: true,
    })),
    ...(
      [
        { source: "store" },
        { source: "file", path: "/tmp/unused-store-alias-fixture.json" },
        { source: "exec", command: "/tmp/unused-store-alias-command" },
      ] as const
    ).map((provider) => ({
      name: `explicit matching non-default ${provider.source} provider`,
      ref: {
        source: provider.source,
        provider: "shared",
        id: provider.source === "file" ? "/tool/apiKey" : "TOOL_API_KEY",
      },
      secrets: { providers: { shared: provider } },
      expected: true,
    })),
    {
      name: "missing non-default store provider",
      ref: { source: "store", provider: "shared", id: "TOOL_API_KEY" },
      expected: false,
    },
    {
      name: "mismatched non-default store provider",
      ref: { source: "store", provider: "shared", id: "TOOL_API_KEY" },
      secrets: { providers: { shared: { source: "file", path: "/tmp/unused.json" } } },
      expected: false,
    },
    {
      name: "old store default after selecting another alias",
      ref: { source: "store", provider: "default", id: "TOOL_API_KEY" },
      secrets: { defaults: { store: "shared" } },
      expected: false,
    },
    ...(["file", "exec"] as const).map((source) => ({
      name: `undeclared ${source} default`,
      ref: { source, provider: "default", id: source === "file" ? "/tool/apiKey" : "TOOL_API_KEY" },
      expected: false,
    })),
  ])("checks $name through config-only metadata", ({ ref, secrets, expected }) => {
    const plugin = makePlugin({
      toolMetadata: { x_search: { configSignals: [webSearchSignal] } },
    });
    const config: OpenClawConfig = {
      ...xaiConfig({ webSearch: { apiKey: ref } }),
      secrets,
    };
    expect(hasManifestToolAvailability({ plugin, toolNames: ["x_search"], config, env: {} })).toBe(
      expected,
    );
  });

  it("fails open for tools without availability signals", () => {
    expect(
      hasManifestToolAvailability({ plugin: xaiPlugin, toolNames: ["unlisted"], env: {} }),
    ).toBe(true);
    expect(
      hasManifestToolAvailability({
        plugin: makePlugin({ toolMetadata: { listed: {} } }),
        toolNames: ["listed"],
        env: {},
      }),
    ).toBe(true);
    expect(
      hasManifestToolAvailability({
        plugin: xaiPlugin,
        toolNames: ["x_search", "unlisted"],
        env: {},
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "config",
      config: xaiConfig({ webSearch: { apiKey: "token" } }),
      env: {},
    },
    { name: "setup env", config: undefined, env: { XAI_API_KEY: "token" } },
  ] as const)("passes with a satisfied $name signal", ({ config, env }) => {
    expect(
      hasManifestToolAvailability({
        plugin: xaiPlugin,
        toolNames: ["x_search"],
        config,
        env,
      }),
    ).toBe(true);
  });

  it("passes with profile auth and fails without any signal", () => {
    expect(
      hasManifestToolAvailability({
        plugin: xaiPlugin,
        toolNames: ["x_search"],
        env: {},
        hasAuthForProvider: (providerId) => providerId === "xai",
      }),
    ).toBe(true);
    expect(
      hasManifestToolAvailability({ plugin: xaiPlugin, toolNames: ["x_search"], env: {} }),
    ).toBe(false);
  });

  it("lets a provider base-URL guard veto otherwise valid auth", () => {
    const guardedPlugin = makePlugin({
      toolMetadata: {
        x_search: {
          authSignals: [
            {
              provider: "xai",
              providerBaseUrl: {
                provider: "xai",
                defaultBaseUrl: "https://api.x.ai/v1",
                allowedBaseUrls: ["https://api.x.ai/v1"],
              },
            },
          ],
        },
      },
    });
    expect(
      hasManifestToolAvailability({
        plugin: guardedPlugin,
        toolNames: ["x_search"],
        config: makeConfig({
          models: { providers: { xai: { baseUrl: "https://proxy.example/v1" } } },
        }),
        env: {},
        hasAuthForProvider: () => true,
      }),
    ).toBe(false);
    expect(
      hasManifestToolAvailability({
        plugin: guardedPlugin,
        toolNames: ["x_search"],
        env: {},
        hasAuthForProvider: () => true,
      }),
    ).toBe(true);
  });

  it("maps legacy provider and alias shorthand into auth signals", () => {
    const legacyPlugin = makePlugin({
      setup: { providers: [{ id: "alias", envVars: ["ALIAS_KEY"] }] },
      toolMetadata: { legacy_tool: { authProviders: ["primary"], aliases: ["alias"] } },
    });
    expect(
      hasManifestToolAvailability({
        plugin: legacyPlugin,
        toolNames: ["legacy_tool"],
        env: {},
        hasAuthForProvider: (providerId) => providerId === "primary",
      }),
    ).toBe(true);
    expect(
      hasManifestToolAvailability({
        plugin: legacyPlugin,
        toolNames: ["legacy_tool"],
        env: { ALIAS_KEY: "token" },
      }),
    ).toBe(true);
    expect(
      hasManifestToolAvailability({
        plugin: legacyPlugin,
        toolNames: ["legacy_tool"],
        env: {},
      }),
    ).toBe(false);
  });
});
