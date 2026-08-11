// Verifies plugin loader prefer-over selection behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginLoaderCache, loadOpenClawPlugins } from "./loader.test-fixtures.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

const tempDirs: string[] = [];

function makePluginLoaderTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-prefer-over-"));
  if (process.platform !== "win32") {
    fs.chmodSync(dir, 0o755);
  }
  tempDirs.push(dir);
  return dir;
}

function writeChannelToolPlugin(params: {
  rootDir: string;
  id: string;
  channelId: string;
  enabledByDefault?: boolean;
  preferOver?: string[];
  toolName?: string;
  autoEnableWhenConfiguredProviders?: string[];
  registerThrows?: boolean;
  throwsAfterChannel?: boolean;
  channelLabels?: [string, string];
}): string {
  const toolName = params.toolName ?? "qqbot_remind";
  const pluginDir = path.join(params.rootDir, params.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  if (process.platform !== "win32") {
    fs.chmodSync(pluginDir, 0o755);
  }
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        channels: [params.channelId],
        contracts: { tools: [toolName] },
        ...(params.enabledByDefault ? { enabledByDefault: true } : {}),
        ...(params.autoEnableWhenConfiguredProviders
          ? { autoEnableWhenConfiguredProviders: params.autoEnableWhenConfiguredProviders }
          : {}),
        channelConfigs: {
          [params.channelId]: {
            schema: { type: "object" },
            ...(params.preferOver ? { preferOver: params.preferOver } : {}),
          },
        },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    ),
    "utf-8",
  );
  if (params.registerThrows) {
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `module.exports = {
        id: ${JSON.stringify(params.id)},
        register() { throw new Error("fixture registration failure"); },
      };`,
      "utf-8",
    );
    return pluginDir;
  }
  if (params.channelLabels) {
    const [firstLabel, secondLabel] = params.channelLabels;
    const channelPayload = (label: string) => `{
          plugin: {
            id: ${JSON.stringify(params.channelId)},
            meta: {
              id: ${JSON.stringify(params.channelId)},
              label: ${JSON.stringify(label)},
              selectionLabel: ${JSON.stringify(label)},
              docsPath: ${JSON.stringify(`/channels/${params.channelId}`)},
              blurb: "fixture channel",
            },
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => [],
              resolveAccount: () => ({ accountId: "default" }),
            },
            outbound: { deliveryMode: "direct" },
          },
        }`;
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `module.exports = {
        id: ${JSON.stringify(params.id)},
        register(api) {
          api.registerChannel(${channelPayload(firstLabel ?? "first")});
          api.registerChannel(${channelPayload(secondLabel ?? "second")});
        },
      };`,
      "utf-8",
    );
    return pluginDir;
  }
  if (params.throwsAfterChannel) {
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `module.exports = {
        id: ${JSON.stringify(params.id)},
        register(api) {
          api.registerChannel({
            plugin: {
              id: ${JSON.stringify(params.channelId)},
              meta: {
                id: ${JSON.stringify(params.channelId)},
                label: ${JSON.stringify(params.channelId)},
                selectionLabel: ${JSON.stringify(params.channelId)},
                docsPath: ${JSON.stringify(`/channels/${params.channelId}`)},
                blurb: "fixture channel",
              },
              capabilities: { chatTypes: ["direct"] },
              config: {
                listAccountIds: () => [],
                resolveAccount: () => ({ accountId: "default" }),
              },
              outbound: { deliveryMode: "direct" },
            },
          });
          throw new Error("fixture post-channel failure");
        },
      };`,
      "utf-8",
    );
    return pluginDir;
  }
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `module.exports = {
      id: ${JSON.stringify(params.id)},
      register(api) {
        api.registerChannel({
          plugin: {
            id: ${JSON.stringify(params.channelId)},
            meta: {
              id: ${JSON.stringify(params.channelId)},
              label: ${JSON.stringify(params.channelId)},
              selectionLabel: ${JSON.stringify(params.channelId)},
              docsPath: ${JSON.stringify(`/channels/${params.channelId}`)},
              blurb: "fixture channel",
            },
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => [],
              resolveAccount: () => ({ accountId: "default" }),
            },
            outbound: { deliveryMode: "direct" },
          },
        });
        api.registerTool({
          name: ${JSON.stringify(toolName)},
          description: "fixture",
          parameters: { type: "object", properties: {} },
          execute() { return { content: [{ type: "text", text: "ok" }] }; },
        }, { name: ${JSON.stringify(toolName)} });
      },
    };`,
    "utf-8",
  );
  return pluginDir;
}

afterEach(() => {
  clearPluginLoaderCache();
  resetPluginRuntimeStateForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin loader preferOver activation", () => {
  it("loads the preferred external channel plugin without the replaced bundled plugin tools", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot",
      channelId: "qqbot",
      enabledByDefault: true,
    });
    const externalRoot = makePluginLoaderTempDir();
    const externalPluginDir = writeChannelToolPlugin({
      rootDir: externalRoot,
      id: "openclaw-qqbot",
      channelId: "qqbot",
      preferOver: ["qqbot"],
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };
    const rawConfig = {
      channels: { qqbot: { appId: "app", clientSecret: "secret" } },
      plugins: { load: { paths: [externalPluginDir] } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    expect(autoEnabled.config.plugins?.entries?.["openclaw-qqbot"]?.enabled).toBe(true);
    expect(autoEnabled.config.plugins?.entries?.qqbot?.enabled).toBe(false);
    expect(registry.plugins.find((plugin) => plugin.id === "openclaw-qqbot")?.status).toBe(
      "loaded",
    );
    expect(registry.plugins.find((plugin) => plugin.id === "qqbot")?.status).toBe("disabled");
    expect(registry.tools.map((tool) => tool.pluginId)).toEqual(["openclaw-qqbot"]);
    expect(registry.diagnostics.map((diag) => diag.message).join("\n")).not.toContain(
      "plugin tool name conflict",
    );
  });

  it("blocks tools from a plugin that loses a duplicate channel registration", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot",
      channelId: "qqbot",
      enabledByDefault: true,
    });
    const externalRoot = makePluginLoaderTempDir();
    const externalPluginDir = writeChannelToolPlugin({
      rootDir: externalRoot,
      id: "openclaw-qqbot",
      channelId: "qqbot",
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        channels: { qqbot: { appId: "app", clientSecret: "secret" } },
        plugins: {
          load: { paths: [externalPluginDir] },
          entries: {
            qqbot: { enabled: true },
            "openclaw-qqbot": { enabled: true },
          },
        },
      },
      env,
    });

    const diagnostics = registry.diagnostics.map((diag) => diag.message).join("\n");
    expect(diagnostics).toContain("channel already registered: qqbot");
    expect(diagnostics).not.toContain("plugin tool name conflict");
    expect(registry.tools.map((tool) => tool.pluginId)).toHaveLength(1);
  });

  // #120332 round 37 (P1) / round 40 (P1): an IMPLICITLY superseded plugin that stays loaded
  // for its provider capability has its dead channel claim suppressed at registration instead
  // of racing first-wins. Without suppression the preserved incumbent either wins the channel
  // the plan gave its replacement (loads first) or lands in the channel-conflict set and loses
  // every later TOOL registration (loads second).
  it("preserves an implicitly superseded plugin's tools when the replacement wins the channel", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot",
      channelId: "qqbot",
      enabledByDefault: true,
      toolName: "qqbot_remind_legacy",
      autoEnableWhenConfiguredProviders: ["acme-prov"],
    });
    const externalRoot = makePluginLoaderTempDir();
    const externalPluginDir = writeChannelToolPlugin({
      rootDir: externalRoot,
      id: "openclaw-qqbot",
      channelId: "qqbot",
      preferOver: ["qqbot"],
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };
    const rawConfig: OpenClawConfig = {
      channels: { qqbot: { appId: "app", clientSecret: "secret" } },
      auth: { profiles: { "acme-prov:default": { provider: "acme-prov", mode: "api_key" } } },
      plugins: { load: { paths: [externalPluginDir] } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });
    // The provider capability keeps the superseded incumbent loaded beside the replacement:
    // its implicit disable is skipped, so the default-enabled bundled plugin stays loaded.
    expect(autoEnabled.config.plugins?.entries?.qqbot?.enabled).not.toBe(false);
    expect(autoEnabled.config.plugins?.entries?.["openclaw-qqbot"]?.enabled).toBe(true);

    // The preserved incumbent loads SECOND (bundled scans after config load paths): without
    // plan-aware suppression its channel registration conflicts and drops its tool.
    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    expect(registry.channels.map((entry) => entry.pluginId)).toEqual(["openclaw-qqbot"]);
    expect(registry.tools.map((tool) => tool.pluginId).toSorted()).toEqual([
      "openclaw-qqbot",
      "qqbot",
    ]);
    expect(registry.diagnostics.map((diag) => diag.message).join("\n")).not.toContain(
      "channel already registered",
    );
  });

  it("suppresses an implicitly superseded claim in first-loads order too", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot",
      channelId: "qqbot",
      enabledByDefault: true,
      preferOver: ["legacy-qqbot"],
    });
    const externalRoot = makePluginLoaderTempDir();
    const externalPluginDir = writeChannelToolPlugin({
      rootDir: externalRoot,
      id: "legacy-qqbot",
      channelId: "qqbot",
      toolName: "qqbot_remind_legacy",
      autoEnableWhenConfiguredProviders: ["acme-prov"],
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };
    const rawConfig: OpenClawConfig = {
      channels: { qqbot: { appId: "app", clientSecret: "secret" } },
      auth: { profiles: { "acme-prov:default": { provider: "acme-prov", mode: "api_key" } } },
      plugins: { load: { paths: [externalPluginDir] } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    // The preserved incumbent loads FIRST (config load path scans before bundled): without
    // plan-aware suppression it registers the channel the plan gave the replacement, and the
    // replacement's conflict drops the REPLACEMENT's tool instead.
    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    expect(registry.channels.map((entry) => entry.pluginId)).toEqual(["qqbot"]);
    expect(registry.tools.map((tool) => tool.pluginId).toSorted()).toEqual([
      "legacy-qqbot",
      "qqbot",
    ]);
    expect(registry.diagnostics.map((diag) => diag.message).join("\n")).not.toContain(
      "channel already registered",
    );
  });

  // #120332 round 40 (P1): explicit operator selections are NEVER suppressed. The manifest
  // contract preserves both explicitly enabled plugins and reports duplicate channel
  // diagnostics instead of silently changing the requested plugin set — registration stays
  // first-wins and the loser's conflict is visible.
  it("keeps first-wins registration and the duplicate diagnostic for explicit selections", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot",
      channelId: "qqbot",
      enabledByDefault: true,
      toolName: "qqbot_remind_legacy",
    });
    const externalRoot = makePluginLoaderTempDir();
    const externalPluginDir = writeChannelToolPlugin({
      rootDir: externalRoot,
      id: "openclaw-qqbot",
      channelId: "qqbot",
      preferOver: ["qqbot"],
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        channels: { qqbot: { appId: "app", clientSecret: "secret" } },
        plugins: {
          load: { paths: [externalPluginDir] },
          entries: {
            qqbot: { enabled: true },
            "openclaw-qqbot": { enabled: true },
          },
        },
      },
      env,
    });

    // First registrant (the external replacement loads first) keeps the channel; the kept
    // incumbent's conflict is reported, not suppressed.
    expect(registry.channels.map((entry) => entry.pluginId)).toEqual(["openclaw-qqbot"]);
    expect(registry.diagnostics.map((diag) => diag.message).join("\n")).toContain(
      "channel already registered: qqbot",
    );
  });

  // #120332 round 52 (P2): the keep contract holds across alias-equivalent spellings. Two
  // explicitly selected plugins can register the same logical channel under variant ids (case
  // variant, built-in alias); the conflict lookup compares canonical identity like the restore
  // path, or both implementations start with neither the duplicate diagnostic nor first-wins.
  it("keeps first-wins registration across alias-equivalent channel spellings", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot",
      channelId: "qqbot",
      enabledByDefault: true,
      toolName: "qqbot_remind_legacy",
    });
    const externalRoot = makePluginLoaderTempDir();
    const externalPluginDir = writeChannelToolPlugin({
      rootDir: externalRoot,
      id: "openclaw-qqbot",
      channelId: "QQBot",
      preferOver: ["qqbot"],
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        channels: { qqbot: { appId: "app", clientSecret: "secret" } },
        plugins: {
          load: { paths: [externalPluginDir] },
          entries: {
            qqbot: { enabled: true },
            "openclaw-qqbot": { enabled: true },
          },
        },
      },
      env,
    });

    // The replacement registered the variant spelling first: the incumbent's raw-spelled
    // registration is the SAME logical channel and must lose first-wins with the diagnostic.
    expect(registry.channels.map((entry) => entry.pluginId)).toEqual(["openclaw-qqbot"]);
    expect(registry.diagnostics.map((diag) => diag.message).join("\n")).toContain(
      "channel already registered",
    );
  });

  // #120332 round 40 (P1): suppression is reconciled against the registrations that actually
  // landed. A planned replacement whose registration throws is tolerated and rolled back, so
  // the suppressed incumbent's claim must be restored — the configured channel keeps an owner.
  it("restores a suppressed claim when the planned replacement fails to register", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot",
      channelId: "qqbot",
      enabledByDefault: true,
      toolName: "qqbot_remind_legacy",
      autoEnableWhenConfiguredProviders: ["acme-prov"],
    });
    const externalRoot = makePluginLoaderTempDir();
    const externalPluginDir = writeChannelToolPlugin({
      rootDir: externalRoot,
      id: "openclaw-qqbot",
      channelId: "qqbot",
      preferOver: ["qqbot"],
      registerThrows: true,
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };
    const rawConfig: OpenClawConfig = {
      channels: { qqbot: { appId: "app", clientSecret: "secret" } },
      auth: { profiles: { "acme-prov:default": { provider: "acme-prov", mode: "api_key" } } },
      plugins: { load: { paths: [externalPluginDir] } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    // The failed replacement never registered, so the suppressed incumbent serves the channel.
    expect(registry.channels.map((entry) => entry.pluginId)).toEqual(["qqbot"]);
    expect(registry.tools.map((tool) => tool.pluginId)).toEqual(["qqbot"]);
  });

  // #120332 round 43 (P2): the loader cache key distinguishes MEANINGFUL channel config from a
  // bare present entry. `{}` is not a configured channel (config-presence), so its load plans no
  // supersession; adding credentials flips the plan — the two must not share a cached registry.
  it("does not reuse a cached registry when a present channel gains meaningful config", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot-aa-inc",
      channelId: "qqbot",
      enabledByDefault: true,
      toolName: "qqbot_remind_legacy",
    });
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot-bb-rep",
      channelId: "qqbot",
      enabledByDefault: true,
      preferOver: ["qqbot-aa-inc"],
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };

    // An empty channel entry is present but not configured: no supersession candidates exist
    // and first-wins registration serves the incumbent.
    const emptyEntryLoad = loadOpenClawPlugins({
      config: { channels: { qqbot: {} } },
      env,
      activate: false,
    });
    expect(emptyEntryLoad.channels.map((entry) => entry.pluginId)).toEqual(["qqbot-aa-inc"]);

    // Credentials make the channel configured, the plan supersedes the implicit incumbent, and
    // the cached empty-entry registry must not be served.
    const configuredLoad = loadOpenClawPlugins({
      config: { channels: { qqbot: { appId: "app", clientSecret: "secret" } } },
      env,
      activate: false,
    });
    expect(configuredLoad.channels.map((entry) => entry.pluginId)).toEqual(["qqbot-bb-rep"]);
  });

  // #120332 round 44 (P2): restoring a suppressed claimant replays ALL its stashed
  // registrations in order — the same-plugin path updates the registration in place, so the
  // fallback serves the plugin's FINAL registration, not the first call's stale callbacks.
  it("replays a restored claimant's later registrations", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot",
      channelId: "qqbot",
      enabledByDefault: true,
      autoEnableWhenConfiguredProviders: ["acme-prov"],
      channelLabels: ["first", "second"],
    });
    const externalRoot = makePluginLoaderTempDir();
    const externalPluginDir = writeChannelToolPlugin({
      rootDir: externalRoot,
      id: "openclaw-qqbot",
      channelId: "qqbot",
      preferOver: ["qqbot"],
      registerThrows: true,
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };
    const rawConfig: OpenClawConfig = {
      channels: { qqbot: { appId: "app", clientSecret: "secret" } },
      auth: { profiles: { "acme-prov:default": { provider: "acme-prov", mode: "api_key" } } },
      plugins: { load: { paths: [externalPluginDir] } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    expect(registry.channels.map((entry) => entry.pluginId)).toEqual(["qqbot"]);
    expect(registry.channels[0]?.plugin.meta?.label).toBe("second");
  });

  // #120332 round 44 (P2): env-derived channel presence and the ambient-trigger policy feed
  // the suppression plan, so both key the loader cache and the policy reaches the replan.
  it("keys the cache on env-derived channel presence and honors the ambient policy", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "clickclack-aa-inc",
      channelId: "clickclack",
      enabledByDefault: true,
      toolName: "clickclack_remind_legacy",
    });
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "clickclack-bb-rep",
      channelId: "clickclack",
      enabledByDefault: true,
      preferOver: ["clickclack-aa-inc"],
      toolName: "clickclack_remind",
    });
    const baseEnv = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };

    // No channel anywhere: no supersession candidates, first-wins registration.
    const unconfigured = loadOpenClawPlugins({ config: {}, env: baseEnv, activate: false });
    expect(unconfigured.channels.map((entry) => entry.pluginId)).toEqual(["clickclack-aa-inc"]);

    // An ambient credential env var configures the channel: the plan supersedes the implicit
    // incumbent, and the cached env-less registry must not be served.
    const envConfigured = loadOpenClawPlugins({
      config: {},
      env: { ...baseEnv, CLICKCLACK_BOT_TOKEN: "token" },
      activate: false,
    });
    expect(envConfigured.channels.map((entry) => entry.pluginId)).toEqual(["clickclack-bb-rep"]);

    // Suppressing ambient triggers removes the env-only channel from the plan — a distinct
    // cache identity AND a plan with no supersession.
    const suppressed = loadOpenClawPlugins({
      config: {},
      env: { ...baseEnv, CLICKCLACK_BOT_TOKEN: "token" },
      ambientEnvTriggers: "suppress",
      activate: false,
    });
    expect(suppressed.channels.map((entry) => entry.pluginId)).toEqual(["clickclack-aa-inc"]);
  });

  // #120332 round 42 (P2): the loader cache key covers MATERIAL selection. A raw authored
  // entry's config/apiKey/env fields flip a supersession from disable (suppressed) to keep
  // (preserved), but normalized entries drop them — two loads differing only in materiality
  // must not share a cached registry.
  it("does not reuse a cached registry across differing material selections", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot-aa-inc",
      channelId: "qqbot",
      enabledByDefault: true,
      toolName: "qqbot_remind_legacy",
    });
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot-bb-rep",
      channelId: "qqbot",
      enabledByDefault: true,
      preferOver: ["qqbot-aa-inc"],
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };

    // Non-material entry: the incumbent's claim is an implicit supersession, suppressed.
    const implicitLoad = loadOpenClawPlugins({
      config: {
        channels: { qqbot: { appId: "app", clientSecret: "secret" } },
        plugins: { entries: { "qqbot-aa-inc": {} } },
      },
      env,
      activate: false,
    });
    expect(implicitLoad.channels.map((entry) => entry.pluginId)).toEqual(["qqbot-bb-rep"]);

    // A hooks record makes the entry a material operator selection: the claim is KEPT, races
    // first-wins, and the incumbent (first in discovery) serves — the cached implicit-plan
    // registry must not be returned.
    const materialLoad = loadOpenClawPlugins({
      config: {
        channels: { qqbot: { appId: "app", clientSecret: "secret" } },
        plugins: { entries: { "qqbot-aa-inc": { hooks: { allowPromptInjection: true } } } },
      },
      env,
      activate: false,
    });
    expect(materialLoad.channels.map((entry) => entry.pluginId)).toEqual(["qqbot-aa-inc"]);
  });

  // #120332 round 42 (P2): the restore path never re-registers a channel from a plugin whose
  // own registration failed — rollback removed its other contributions, so exposing its channel
  // callbacks would serve a half-registered plugin.
  it("does not restore a suppressed claim from a plugin whose registration failed", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot",
      channelId: "qqbot",
      enabledByDefault: true,
      autoEnableWhenConfiguredProviders: ["acme-prov"],
      throwsAfterChannel: true,
    });
    const externalRoot = makePluginLoaderTempDir();
    const externalPluginDir = writeChannelToolPlugin({
      rootDir: externalRoot,
      id: "openclaw-qqbot",
      channelId: "qqbot",
      preferOver: ["qqbot"],
      registerThrows: true,
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };
    const rawConfig: OpenClawConfig = {
      channels: { qqbot: { appId: "app", clientSecret: "secret" } },
      auth: { profiles: { "acme-prov:default": { provider: "acme-prov", mode: "api_key" } } },
      plugins: { load: { paths: [externalPluginDir] } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    // Both plugins failed registration: the suppressed incumbent's stashed claim must stay
    // out of the registry rather than expose a rolled-back plugin's channel.
    expect(registry.channels).toEqual([]);
  });

  // #120332 round 40 (P2): the loader cache key covers channel PRESENCE. Two loads with
  // identical activation metadata but a differing configured (credentials-only) channel have
  // different suppression plans and must not share a cached registry.
  it("does not reuse a cached registry across differing configured channels", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot-aa-legacy",
      channelId: "qqbot",
      enabledByDefault: true,
      toolName: "qqbot_remind_legacy",
    });
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot-bb-rep",
      channelId: "qqbot",
      enabledByDefault: true,
      preferOver: ["qqbot-aa-legacy"],
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };

    // First load: channel unconfigured, no supersession candidates, first-wins registration.
    const unconfigured = loadOpenClawPlugins({ config: {}, env, activate: false });
    expect(unconfigured.channels.map((entry) => entry.pluginId)).toEqual(["qqbot-aa-legacy"]);

    // Second load: the configured channel makes the plan supersede the implicit incumbent, so
    // the cached unconfigured registry must not be served.
    const configured = loadOpenClawPlugins({
      config: { channels: { qqbot: { appId: "app", clientSecret: "secret" } } },
      env,
      activate: false,
    });
    expect(configured.channels.map((entry) => entry.pluginId)).toEqual(["qqbot-bb-rep"]);
  });

  // #120332 round 45 (P2): the restore path compares channel identity canonically. A suppressed
  // incumbent registering a variant spelling of a built-in channel id and a replacement
  // registering the canonical id serve the SAME logical channel — raw-id equality concluded the
  // replacement never landed and restored the incumbent beside it.
  it("does not restore a claim whose channel the replacement serves under another spelling", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot",
      channelId: "QQBot",
      enabledByDefault: true,
      autoEnableWhenConfiguredProviders: ["acme-prov"],
      toolName: "qqbot_remind_legacy",
    });
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "openclaw-qqbot",
      channelId: "qqbot",
      enabledByDefault: true,
      preferOver: ["qqbot"],
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };
    const rawConfig: OpenClawConfig = {
      channels: { qqbot: { appId: "app", clientSecret: "secret" } },
      auth: { profiles: { "acme-prov:default": { provider: "acme-prov", mode: "api_key" } } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    // The capability-loaded incumbent's variant-spelled claim stays suppressed: the replacement
    // owns the canonical channel, so no restore may put a second implementation beside it.
    expect(registry.channels.map((entry) => entry.pluginId)).toEqual(["openclaw-qqbot"]);
  });

  // #120332 round 45 (P1): a scoped setup-only load deliberately executes an inactive incumbent
  // with status "disabled" — that is its SUCCESS status. When the planned replacement is outside
  // the scope and never registers, the restore path must replay the stashed claim; rejecting the
  // status strips the setup registration the operator requested.
  it("restores a suppressed claim from a successful setup-only scoped load", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot",
      channelId: "qqbot",
      toolName: "qqbot_remind_legacy",
    });
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "openclaw-qqbot",
      channelId: "qqbot",
      preferOver: ["qqbot"],
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };

    const registry = loadOpenClawPlugins({
      cache: false,
      config: { channels: { qqbot: { appId: "app", clientSecret: "secret" } } },
      env,
      onlyPluginIds: ["qqbot"],
      includeSetupOnlyChannelPlugins: true,
      activate: false,
    });

    // The scope excludes the replacement, so the channel ended unserved: the incumbent's
    // successful setup-only registration is restored for the operator's setup flow.
    expect(registry.channelSetups.map((entry) => entry.pluginId)).toContain("qqbot");
  });
});
