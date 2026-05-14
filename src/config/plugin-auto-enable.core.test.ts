import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  applyPluginAutoEnable,
  detectPluginAutoEnableCandidates,
  materializePluginAutoEnableCandidates,
  resolvePluginAutoEnableCandidateReason,
} from "./plugin-auto-enable.js";
import {
  makeIsolatedEnv,
  makeRegistry,
  resetPluginAutoEnableTestState,
} from "./plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObject } from "./validation.js";

vi.mock("../channels/plugins/configured-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/plugins/configured-state.js")>();
  return {
    ...actual,
    hasBundledChannelConfiguredState: (params: {
      channelId: string;
      cfg: OpenClawConfig;
      env?: NodeJS.ProcessEnv;
    }) => {
      if (params.channelId === "irc") {
        return Boolean(params.env?.IRC_HOST?.trim() && params.env?.IRC_NICK?.trim());
      }
      if (params.channelId === "slack") {
        return ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "SLACK_USER_TOKEN"].some((key) =>
          Boolean(params.env?.[key]?.trim()),
        );
      }
      return actual.hasBundledChannelConfiguredState(params);
    },
  };
});

const setupRegistryMock = vi.hoisted(() => ({
  resolvePluginSetupAutoEnableReasons: vi.fn(
    (params: { config?: OpenClawConfig; pluginIds?: readonly string[] }) => {
      const pluginIds = new Set(params.pluginIds ?? []);
      const browserEntry = params.config?.plugins?.entries?.browser;
      const hasBrowserEntry =
        browserEntry && typeof browserEntry === "object" && browserEntry.enabled !== false;
      return pluginIds.has("browser") && hasBrowserEntry
        ? [{ pluginId: "browser", reason: "browser plugin configured" }]
        : [];
    },
  ),
}));

vi.mock("../plugins/setup-registry.js", () => ({
  clearPluginSetupRegistryCache: vi.fn(),
  resolvePluginSetupAutoEnableReasons: setupRegistryMock.resolvePluginSetupAutoEnableReasons,
}));

const env = makeIsolatedEnv();

function createPluginMetadataSnapshot(params: {
  config?: OpenClawConfig;
  manifestRegistry: PluginManifestRegistry;
  workspaceDir?: string;
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
  return {
    policyHash,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash,
      generatedAtMs: 1,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: params.manifestRegistry,
    plugins: params.manifestRegistry.plugins,
    diagnostics: params.manifestRegistry.diagnostics,
    byPluginId: new Map(params.manifestRegistry.plugins.map((plugin) => [plugin.id, plugin])),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: params.manifestRegistry.plugins.length,
    },
  };
}

afterAll(() => {
  resetPluginAutoEnableTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyPluginAutoEnable core", () => {
  it("detects typed channel-configured candidates", () => {
    const candidates = detectPluginAutoEnableCandidates({
      config: {
        channels: { slack: { botToken: "x" } },
      },
      env,
    });

    expect(candidates).toEqual([
      {
        pluginId: "slack",
        kind: "channel-configured",
        channelId: "slack",
      },
    ]);
  });

  it("reuses policy-compatible current manifest registry when runtime config differs", () => {
    const manifestRegistry = makeRegistry([{ id: "custom-chat", channels: ["custom-chat"] }]);
    const snapshotConfig: OpenClawConfig = { plugins: { allow: ["existing"] } };
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({
        config: snapshotConfig,
        manifestRegistry,
        workspaceDir: "/tmp/workspace",
      }),
      {
        config: snapshotConfig,
        env,
        workspaceDir: "/tmp/workspace",
      },
    );

    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          allow: ["existing"],
          entries: {
            "custom-chat": { config: { token: "x" } },
          },
        },
      },
      env,
    });

    expect(result.config.plugins?.allow).toContain("custom-chat");
    expect(result.changes).toContain(
      "custom-chat plugin config present, added to plugin allowlist.",
    );
  });

  it("does not reuse an unscoped current manifest registry when plugin load paths change", () => {
    const manifestRegistry = makeRegistry([{ id: "load-path-chat", channels: ["load-path-chat"] }]);
    const snapshotConfig: OpenClawConfig = { plugins: { allow: ["existing"] } };
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({
        config: snapshotConfig,
        manifestRegistry,
        workspaceDir: "/tmp/workspace",
      }),
      {
        config: snapshotConfig,
        env,
        workspaceDir: "/tmp/workspace",
      },
    );

    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          allow: ["existing"],
          load: { paths: ["/tmp/changed-plugin-root"] },
          entries: {
            "load-path-chat": { config: { token: "x" } },
          },
        },
      },
      env,
    });

    expect(result.config.plugins?.allow).toEqual(["existing"]);
    expect(result.changes).not.toContain(
      "load-path-chat plugin config present, added to plugin allowlist.",
    );
  });

  it("does not reuse a load-path current manifest registry for a config with default load paths", () => {
    const manifestRegistry = makeRegistry([{ id: "load-path-chat", channels: ["load-path-chat"] }]);
    const snapshotConfig: OpenClawConfig = {
      plugins: {
        allow: ["existing"],
        load: { paths: ["/tmp/custom-plugin-root"] },
      },
    };
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({
        config: snapshotConfig,
        manifestRegistry,
      }),
      { config: snapshotConfig, env },
    );

    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          allow: ["existing"],
          entries: {
            "load-path-chat": { config: { token: "x" } },
          },
        },
      },
      env,
    });

    expect(result.config.plugins?.allow).toEqual(["existing"]);
    expect(result.changes).not.toContain(
      "load-path-chat plugin config present, added to plugin allowlist.",
    );
  });

  it("formats typed provider-auth candidates into stable reasons", () => {
    expect(
      resolvePluginAutoEnableCandidateReason({
        pluginId: "google",
        kind: "provider-auth-configured",
        providerId: "google",
      }),
    ).toBe("google auth configured");
  });

  it("treats an undefined config as empty", () => {
    const result = applyPluginAutoEnable({
      config: undefined,
      env,
    });

    expect(result.config).toStrictEqual({});
    expect(result.changes).toStrictEqual([]);
    expect(result.autoEnabledReasons).toStrictEqual({});
  });

  it("auto-enables built-in channels and preserves them in restrictive plugins.allow", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { allow: ["telegram"] },
      },
      env,
    });

    expect(result.config.channels?.slack?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.slack).toBeUndefined();
    expect(result.config.plugins?.allow).toEqual(["telegram", "slack"]);
    expect(result.autoEnabledReasons).toEqual({
      slack: ["slack configured"],
    });
    expect(result.changes.join("\n")).toContain("Slack configured, enabled automatically.");
  });

  it("does not create plugins.allow when allowlist is unset", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
      },
      env,
    });

    expect(result.config.channels?.slack?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toBeUndefined();
  });

  it("does not auto-enable Slack from unrelated Slack-prefixed env vars", () => {
    const result = applyPluginAutoEnable({
      config: {},
      env: makeIsolatedEnv({
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/XXX",
      }),
    });

    expect(result.config.channels?.slack).toBeUndefined();
    expect(result.config.plugins?.entries?.slack).toBeUndefined();
    expect(result.changes).toStrictEqual([]);
  });

  it("stores auto-enable reasons in a null-prototype dictionary", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
      },
      env,
    });

    expect(Object.getPrototypeOf(result.autoEnabledReasons)).toBeNull();
  });

  it("materializes setup auto-enable candidates under a restrictive plugins.allow", () => {
    const result = materializePluginAutoEnableCandidates({
      config: {
        plugins: {
          allow: ["telegram"],
        },
      },
      candidates: [
        {
          pluginId: "browser",
          kind: "setup-auto-enable",
          reason: "browser configured",
        },
      ],
      env,
    });

    expect(result.config.plugins?.allow).toEqual(["telegram", "browser"]);
    expect(result.config.plugins?.entries?.browser?.enabled).toBe(true);
    expect(result.changes).toContain("browser configured, enabled automatically.");
  });

  it("materializes setup auto-enable tool-reference reasons", () => {
    const result = materializePluginAutoEnableCandidates({
      config: {
        plugins: {
          allow: ["telegram"],
        },
      },
      candidates: [
        {
          pluginId: "browser",
          kind: "setup-auto-enable",
          reason: "browser tool referenced",
        },
      ],
      env,
    });

    expect(result.config.plugins?.allow).toEqual(["telegram", "browser"]);
    expect(result.config.plugins?.entries?.browser?.enabled).toBe(true);
    expect(result.changes).toContain("browser tool referenced, enabled automatically.");
  });

  it("keeps restrictive plugins.allow unchanged when browser is not referenced", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          allow: ["telegram"],
        },
      },
      env,
    });

    expect(result.config.plugins?.allow).toEqual(["telegram"]);
    expect(result.config.plugins?.entries?.browser).toBeUndefined();
    expect(result.changes).toStrictEqual([]);
  });

  it("does not load plugin manifests for disabled plugin entries under a restrictive allowlist", () => {
    const readFileSync = vi.spyOn(fs, "readFileSync");

    const result = applyPluginAutoEnable({
      config: {
        browser: { enabled: false },
        plugins: {
          allow: ["telegram"],
          entries: {
            browser: { enabled: false },
          },
        },
      },
      env,
    });

    expect(result.config.plugins?.allow).toEqual(["telegram"]);
    expect(result.config.plugins?.entries?.browser?.enabled).toBe(false);
    expect(result.changes).toStrictEqual([]);
    expect(
      readFileSync.mock.calls.some(
        ([filePath]) => typeof filePath === "string" && filePath.endsWith("openclaw.plugin.json"),
      ),
    ).toBe(false);
  });

  it("does not load disabled setup plugin manifests when another setup signal exists", () => {
    const readFileSync = vi.spyOn(fs, "readFileSync");

    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          allow: ["telegram"],
          entries: {
            browser: { enabled: false },
          },
        },
        tools: {
          allow: ["browser"],
        },
      },
      env,
    });

    expect(result.config.plugins?.allow).toEqual(["telegram"]);
    expect(result.config.plugins?.entries?.browser?.enabled).toBe(false);
    expect(result.changes).toStrictEqual([]);
    expect(
      readFileSync.mock.calls.some(
        ([filePath]) => typeof filePath === "string" && filePath.endsWith("openclaw.plugin.json"),
      ),
    ).toBe(false);
  });

  it("still treats a non-disabled browser plugin entry as setup auto-enable input", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          allow: ["telegram"],
          entries: {
            browser: {},
          },
        },
      },
      env,
    });

    expect(result.config.plugins?.allow).toEqual(["telegram", "browser"]);
    expect(result.config.plugins?.entries?.browser?.enabled).toBe(true);
    expect(result.changes).toContain("browser plugin configured, enabled automatically.");
  });

  it("does not auto-enable or allowlist non-bundled web fetch providers from config", () => {
    const result = applyPluginAutoEnable({
      config: {
        tools: {
          web: {
            fetch: {
              provider: "evilfetch",
            },
          },
        },
        plugins: {
          allow: ["telegram"],
        },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "evil-plugin",
          channels: [],
          contracts: { webFetchProviders: ["evilfetch"] },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.["evil-plugin"]).toBeUndefined();
    expect(result.config.plugins?.allow).toEqual(["telegram"]);
    expect(result.changes).toStrictEqual([]);
  });

  it("auto-enables bundled firecrawl when plugin-owned webFetch config exists", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          allow: ["telegram"],
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: "firecrawl-key",
                },
              },
            },
          },
        },
      },
      env,
    });

    expect(result.config.plugins?.entries?.firecrawl?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "firecrawl"]);
    expect(result.changes).toContain("firecrawl web fetch configured, enabled automatically.");
  });

  it("auto-enables an opt-in provider plugin when an explicit provider model is configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            model: "codex/gpt-5.4",
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([{ id: "codex", channels: [], providers: ["codex"] }]),
    });

    expect(result.config.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toBeUndefined();
    expect(result.changes).toContain("codex/gpt-5.4 model configured, enabled automatically.");
  });

  it("auto-enables provider plugins referenced by media generation model fallbacks", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "openai/gpt-image-1",
              fallbacks: ["google/gemini-3-pro-image-preview"],
            },
            videoGenerationModel: {
              primary: "openai/sora-2",
              fallbacks: ["google/veo-3.1-fast-generate-preview", "minimax/MiniMax-Hailuo-2.3"],
            },
            musicGenerationModel: {
              primary: "minimax/music-2.6",
              fallbacks: ["google/lyria-3-clip-preview"],
            },
          },
        },
        plugins: {
          allow: ["openai"],
          entries: {
            openai: { enabled: true },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        { id: "openai", channels: [], providers: ["openai"] },
        { id: "google", channels: [], providers: ["google"] },
        { id: "minimax", channels: [], providers: ["minimax"] },
      ]),
    });

    expect(result.config.plugins?.entries?.google?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.minimax?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["openai", "google", "minimax"]);
    expect(result.changes).toEqual([
      "google/gemini-3-pro-image-preview model configured, enabled automatically.",
      "minimax/MiniMax-Hailuo-2.3 model configured, enabled automatically.",
    ]);
  });

  it("does not auto-enable Codex when only the OpenAI plugin is explicitly enabled", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          allow: ["openai"],
          entries: {
            openai: { enabled: true },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        { id: "openai", channels: [], providers: ["openai", "openai-codex"] },
        {
          id: "codex",
          channels: [],
          providers: ["codex"],
          activation: { onAgentHarnesses: ["codex"] },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.codex).toBeUndefined();
    expect(result.config.plugins?.allow).toEqual(["openai"]);
    expect(result.changes).toStrictEqual([]);
  });

  it("keeps OpenAI Codex OAuth model refs provider-owned by OpenAI and runtime-owned by Codex", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        { id: "openai", channels: [], providers: ["openai", "openai-codex"] },
        {
          id: "codex",
          channels: [],
          providers: ["codex"],
          activation: { onAgentHarnesses: ["codex"] },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.openai?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.changes).toEqual([
      "openai-codex/gpt-5.5 model configured, enabled automatically.",
      "codex agent runtime configured, enabled automatically.",
    ]);
  });

  it("auto-enables Codex only for the native Codex harness with OpenAI model refs", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            agentRuntime: {
              id: "codex",
            },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        { id: "openai", channels: [], providers: ["openai", "openai-codex"] },
        {
          id: "codex",
          channels: [],
          providers: ["codex"],
          activation: { onAgentHarnesses: ["codex"] },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.openai?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.changes).toEqual([
      "openai/gpt-5.5 model configured, enabled automatically.",
      "codex agent runtime configured, enabled automatically.",
    ]);
  });

  it("auto-enables Codex when OpenAI agent models use the implicit runtime default", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        { id: "openai", channels: [], providers: ["openai", "openai-codex"] },
        {
          id: "codex",
          channels: [],
          providers: ["codex"],
          activation: { onAgentHarnesses: ["codex"] },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.openai?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.changes).toEqual([
      "openai/gpt-5.5 model configured, enabled automatically.",
      "codex agent runtime configured, enabled automatically.",
    ]);
  });

  it("auto-enables Codex when OpenAI is a selectable default agent model", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
            models: {
              "openai/gpt-5.5": {},
            },
          },
        },
        plugins: {
          allow: ["openai"],
          entries: {
            openai: { enabled: true },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        { id: "openai", channels: [], providers: ["openai", "openai-codex"] },
        {
          id: "codex",
          channels: [],
          providers: ["codex"],
          activation: { onAgentHarnesses: ["codex"] },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["openai", "codex"]);
    expect(result.changes).toEqual(["codex agent runtime configured, enabled automatically."]);
  });

  it("auto-enables an opt-in plugin when a provider runtime is configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [],
              agentRuntime: {
                id: "codex",
              },
            },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "codex",
          channels: [],
          activation: {
            onAgentHarnesses: ["codex"],
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.changes).toContain("codex agent runtime configured, enabled automatically.");
  });

  it("auto-enables an opt-in plugin when a default model runtime is configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": {
                agentRuntime: {
                  id: "codex",
                },
              },
            },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "codex",
          channels: [],
          activation: {
            onAgentHarnesses: ["codex"],
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.changes).toContain("codex agent runtime configured, enabled automatically.");
  });

  it("auto-enables a CLI backend owner when a provider runtime is configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              models: [],
              agentRuntime: {
                id: "claude-cli",
              },
            },
          },
        },
        plugins: {
          allow: ["telegram"],
        },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "anthropic",
          channels: [],
          providers: ["anthropic"],
          cliBackends: ["claude-cli"],
        },
      ]),
    });

    expect(result.config.plugins?.entries?.anthropic?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "anthropic"]);
    expect(result.changes).toContain("claude-cli agent runtime configured, enabled automatically.");
  });

  it("ignores agent harness runtime env when auto-enabling plugins", () => {
    const result = applyPluginAutoEnable({
      config: {},
      env: makeIsolatedEnv({ OPENCLAW_AGENT_RUNTIME: "codex" }),
      manifestRegistry: makeRegistry([
        {
          id: "codex",
          channels: [],
          activation: {
            onAgentHarnesses: ["codex"],
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.codex?.enabled).toBeUndefined();
    expect(result.changes).not.toContain("codex agent runtime configured, enabled automatically.");
  });

  it("skips auto-enable work for configs without channel or plugin-owned surfaces", () => {
    const result = applyPluginAutoEnable({
      config: {
        gateway: {
          auth: {
            mode: "token",
            token: "ok",
          },
        },
        agents: {
          list: [{ id: "pi" }],
        },
      },
      env,
    });

    expect(result.config).toEqual({
      gateway: {
        auth: {
          mode: "token",
          token: "ok",
        },
      },
      agents: {
        list: [{ id: "pi" }],
      },
    });
    expect(result.changes).toStrictEqual([]);
  });

  it("ignores channels.modelByChannel for plugin auto-enable", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: {
          modelByChannel: {
            openai: {
              whatsapp: "openai/gpt-5.4",
            },
          },
        },
      },
      env,
    });

    expect(result.config.plugins?.entries?.modelByChannel).toBeUndefined();
    expect(result.config.plugins?.allow).toBeUndefined();
    expect(result.changes).toStrictEqual([]);
  });

  it("keeps auto-enabled WhatsApp config schema-valid", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: {
          whatsapp: {
            allowFrom: ["+15555550123"],
          },
        },
      },
      env,
    });

    expect(result.config.channels?.whatsapp?.enabled).toBe(true);
    expect(validateConfigObject(result.config).ok).toBe(true);
  });

  it("appends built-in WhatsApp to restrictive plugins.allow during auto-enable", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: {
          whatsapp: {
            allowFrom: ["+15555550123"],
          },
        },
        plugins: {
          allow: ["telegram"],
        },
      },
      env,
    });

    expect(result.config.channels?.whatsapp?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "whatsapp"]);
    expect(validateConfigObject(result.config).ok).toBe(true);
  });

  it("does not auto-enable WhatsApp from persisted auth state alone", () => {
    const persistedEnv = makeIsolatedEnv();
    const authDir = path.join(
      persistedEnv.OPENCLAW_STATE_DIR ?? "",
      "credentials",
      "whatsapp",
      "default",
    );
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "creds.json"), "{}", "utf-8");

    const candidates = detectPluginAutoEnableCandidates({
      config: {},
      env: persistedEnv,
    });
    const result = applyPluginAutoEnable({
      config: {},
      env: persistedEnv,
    });

    expect(candidates).toStrictEqual([]);
    expect(result.config).toStrictEqual({});
    expect(result.changes).toStrictEqual([]);
  });

  it("preserves configured plugin entries in restrictive plugins.allow", () => {
    const result = materializePluginAutoEnableCandidates({
      config: {
        plugins: {
          allow: ["glueclaw"],
          entries: {
            discord: {
              config: {
                token: "x",
              },
            },
          },
        },
      },
      candidates: [],
      env,
      manifestRegistry: makeRegistry([{ id: "discord", channels: [] }]),
    });

    expect(result.config.plugins?.allow).toEqual(["glueclaw", "discord"]);
    expect(result.changes).toContain("discord plugin config present, added to plugin allowlist.");
  });

  it("does not preserve stale configured plugin entries in restrictive plugins.allow", () => {
    const result = materializePluginAutoEnableCandidates({
      config: {
        plugins: {
          allow: ["glueclaw"],
          entries: {
            "missing-plugin": {
              config: {
                token: "x",
              },
            },
          },
        },
      },
      candidates: [],
      env,
      manifestRegistry: makeRegistry([]),
    });

    expect(result.config.plugins?.allow).toEqual(["glueclaw"]);
    expect(result.changes).toStrictEqual([]);
  });

  it("does not re-emit built-in auto-enable changes when rerun with plugins.allow set", () => {
    const first = applyPluginAutoEnable({
      config: {
        channels: {
          whatsapp: {
            allowFrom: ["+15555550123"],
          },
        },
        plugins: {
          allow: ["telegram"],
        },
      },
      env,
    });

    const second = applyPluginAutoEnable({
      config: first.config,
      env,
    });

    expect(first.changes).toHaveLength(1);
    expect(second.changes).toStrictEqual([]);
    expect(second.config).toEqual(first.config);
  });

  it("respects explicit disable", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { entries: { slack: { enabled: false } } },
      },
      env,
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBe(false);
    expect(result.changes).toStrictEqual([]);
  });

  it("respects built-in channel explicit disable via channels.<id>.enabled", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x", enabled: false } },
      },
      env,
    });

    expect(result.config.channels?.slack?.enabled).toBe(false);
    expect(result.config.plugins?.entries?.slack).toBeUndefined();
    expect(result.changes).toStrictEqual([]);
  });

  it("does not auto-enable plugin channels when only enabled=false is set", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { matrix: { enabled: false } },
      },
      env,
      manifestRegistry: makeRegistry([{ id: "matrix", channels: ["matrix"] }]),
    });

    expect(result.config.plugins?.entries?.matrix).toBeUndefined();
    expect(result.changes).toStrictEqual([]);
  });

  it("auto-enables irc when configured via env", () => {
    const result = applyPluginAutoEnable({
      config: {},
      env: {
        ...makeIsolatedEnv(),
        IRC_HOST: "irc.libera.chat",
        IRC_NICK: "openclaw-bot",
      },
    });

    expect(result.config.channels?.irc?.enabled).toBe(true);
    expect(result.changes.join("\n")).toContain("IRC configured, enabled automatically.");
  });

  it("uses the provided manifest registry for plugin channel ids", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { apn: { someKey: "value" } },
      },
      env,
      manifestRegistry: makeRegistry([{ id: "apn-channel", channels: ["apn"] }]),
    });

    expect(result.config.plugins?.entries?.["apn-channel"]?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.apn).toBeUndefined();
  });

  it("skips when plugins are globally disabled", () => {
    expect(
      detectPluginAutoEnableCandidates({
        config: {
          channels: { slack: { botToken: "x" } },
          plugins: {
            enabled: false,
            allow: ["slack"],
            entries: { slack: { config: { botToken: "x" } } },
          },
        },
        env,
        manifestRegistry: makeRegistry([{ id: "slack", channels: ["slack"] }]),
      }),
    ).toStrictEqual([]);

    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { enabled: false },
      },
      env,
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBeUndefined();
    expect(result.changes).toStrictEqual([]);
  });
});
