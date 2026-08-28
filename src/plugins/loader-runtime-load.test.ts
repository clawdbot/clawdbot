// Verifies the plugin registry cache key covers channel-ownership inputs. Making a contested
// channel meaningfully configured moves the cede map (loader-shared.ts collects it after the
// cache-hit return in loader-runtime-load.ts) without touching plugin entries, auto-enable
// reasons, or `channels.<id>.enabled`, so the key must change with the configured-channel set —
// and must NOT change for edits that leave that set alone, or every channel tweak rebuilds the
// registry. The temp-dir and multi-channel fixture helpers are intentionally duplicated from
// loader.prefer-over.cede.test.ts, trimmed to the parameters these tests use.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginRegistryLoadCacheKey } from "./loader.js";
import { clearPluginLoaderCache, loadOpenClawPlugins } from "./loader.test-fixtures.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

const tempDirs: string[] = [];

function makePluginLoaderTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-cache-ownership-"));
  if (process.platform !== "win32") {
    fs.chmodSync(dir, 0o755);
  }
  tempDirs.push(dir);
  return dir;
}

function writeMultiChannelPlugin(params: {
  rootDir: string;
  id: string;
  channelIds: string[];
  toolName: string;
  preferOver?: Record<string, string[]>;
}): string {
  const pluginDir = path.join(params.rootDir, params.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  if (process.platform !== "win32") {
    fs.chmodSync(pluginDir, 0o755);
  }
  const channelConfigs = Object.fromEntries(
    params.channelIds.map((channelId) => [
      channelId,
      {
        schema: { type: "object" },
        ...(params.preferOver?.[channelId] ? { preferOver: params.preferOver[channelId] } : {}),
      },
    ]),
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        channels: params.channelIds,
        contracts: { tools: [params.toolName] },
        channelConfigs,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    ),
    "utf-8",
  );
  const registrations = params.channelIds
    .map(
      (channelId) => `api.registerChannel({
          plugin: {
            id: ${JSON.stringify(channelId)},
            meta: {
              id: ${JSON.stringify(channelId)},
              label: ${JSON.stringify(channelId)},
              selectionLabel: ${JSON.stringify(channelId)},
              docsPath: ${JSON.stringify(`/channels/${channelId}`)},
              blurb: "fixture channel",
            },
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => [],
              resolveAccount: () => ({ accountId: "default" }),
            },
            outbound: { deliveryMode: "direct" },
          },
        });`,
    )
    .join("\n        ");
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `module.exports = {
      id: ${JSON.stringify(params.id)},
      register(api) {
        ${registrations}
        api.registerTool({
          name: ${JSON.stringify(params.toolName)},
          description: "fixture",
          parameters: { type: "object", properties: {} },
          execute() { return { content: [{ type: "text", text: "ok" }] }; },
        }, { name: ${JSON.stringify(params.toolName)} });
      },
    };`,
    "utf-8",
  );
  return pluginDir;
}

/**
 * Three claimants of the contested channel `zzalpha`: `aa-third` claims only that channel and
 * sits first in registry order, `zz-pref` declares it preferred over `zz-fallback` there, and
 * both of those are auto-enabled through their own private channels. While `zzalpha` is not
 * meaningfully configured every claimant is ownership-active and `aa-third` wins the channel, so
 * `zz-pref` cedes it; a `channels.zzalpha` token narrows the candidates to the declaring pair,
 * flips the winner to `zz-pref`, and changes nothing auto-enable materializes.
 */
function makeContestedChannelFixture() {
  const root = makePluginLoaderTempDir();
  const thirdDir = writeMultiChannelPlugin({
    rootDir: root,
    id: "aa-third",
    channelIds: ["zzalpha"],
    toolName: "aa_third_tool",
  });
  const prefDir = writeMultiChannelPlugin({
    rootDir: root,
    id: "zz-pref",
    channelIds: ["zzalpha", "zzother1"],
    toolName: "zz_pref_tool",
    preferOver: { zzalpha: ["zz-fallback"] },
  });
  const fallbackDir = writeMultiChannelPlugin({
    rootDir: root,
    id: "zz-fallback",
    channelIds: ["zzalpha", "zzother2"],
    toolName: "zz_fallback_tool",
  });
  const env = {
    OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
    OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
  };
  const makeRawConfig = (channels: Record<string, unknown>): OpenClawConfig => ({
    channels,
    plugins: { load: { paths: [thirdDir, prefDir, fallbackDir] } },
  });
  return { env, makeRawConfig };
}

function cededChannelIds(
  registry: ReturnType<typeof loadOpenClawPlugins>,
  pluginId: string,
): readonly string[] {
  return registry.plugins.find((plugin) => plugin.id === pluginId)?.cededChannelIds ?? [];
}

function channelOwner(
  registry: ReturnType<typeof loadOpenClawPlugins>,
  channelId: string,
): string | undefined {
  return registry.channels.find((entry) => entry.plugin.id === channelId)?.pluginId;
}

afterEach(() => {
  clearPluginLoaderCache();
  resetPluginRuntimeStateForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin registry cache key channel ownership coverage", () => {
  it("rebuilds the registry when a contested channel becomes meaningfully configured", () => {
    const { env, makeRawConfig } = makeContestedChannelFixture();
    const rawBase = makeRawConfig({
      zzother1: { token: "one" },
      zzother2: { token: "two" },
    });
    // The contested channel is added last so its claimants are already enabled when its
    // candidates are materialized: the edit must not move anything the activation hash reads.
    const rawConfigured = makeRawConfig({
      zzother1: { token: "one" },
      zzother2: { token: "two" },
      zzalpha: { token: "alpha" },
    });
    const base = applyPluginAutoEnable({ config: rawBase, env });
    const configured = applyPluginAutoEnable({ config: rawConfigured, env });
    // The reviewer-shape invariants: plugin entries and auto-enable reasons are untouched by the
    // edit, and `channels.zzalpha.enabled` is never set. Only the configured-channel set moved.
    expect(configured.autoEnabledReasons).toEqual(base.autoEnabledReasons);
    expect(configured.config.plugins?.entries).toEqual(base.config.plugins?.entries);

    const first = loadOpenClawPlugins({
      config: base.config,
      activationSourceConfig: rawBase,
      autoEnabledReasons: base.autoEnabledReasons,
      env,
    });
    // Unconfigured contest: every claimant is ownership-active, `aa-third` wins on registry
    // order, and the other claimants cede the channel to it.
    expect(cededChannelIds(first, "zz-pref")).toContain("zzalpha");
    expect(channelOwner(first, "zzalpha")).toBe("aa-third");

    const second = loadOpenClawPlugins({
      config: configured.config,
      activationSourceConfig: rawConfigured,
      autoEnabledReasons: configured.autoEnabledReasons,
      env,
    });
    // Configuring the channel narrows the candidates to the declaring pair and hands the channel
    // to `zz-pref`; a cache hit here would keep serving the stale cede map above.
    expect(second).not.toBe(first);
    expect(channelOwner(second, "zzalpha")).toBe("zz-pref");
    expect(cededChannelIds(second, "zz-pref")).not.toContain("zzalpha");
  });

  it("keys the registry on the configured-channel set, not on channel settings values", () => {
    const { env, makeRawConfig } = makeContestedChannelFixture();
    const rawBase = makeRawConfig({
      zzother1: { token: "one" },
      zzother2: { token: "two" },
    });
    const rawNeutral = makeRawConfig({
      zzother1: { token: "one-rotated" },
      zzother2: { token: "two" },
    });
    const rawConfigured = makeRawConfig({
      zzother1: { token: "one" },
      zzother2: { token: "two" },
      zzalpha: { token: "alpha" },
    });
    const base = applyPluginAutoEnable({ config: rawBase, env });
    const neutral = applyPluginAutoEnable({ config: rawNeutral, env });
    const configured = applyPluginAutoEnable({ config: rawConfigured, env });
    const cacheKeyFor = (raw: OpenClawConfig, applied: typeof base) =>
      resolvePluginRegistryLoadCacheKey({
        config: applied.config,
        activationSourceConfig: raw,
        autoEnabledReasons: applied.autoEnabledReasons,
        env,
      });

    const baseKey = cacheKeyFor(rawBase, base);
    // Rotating a configured channel's token flips no channel between configured and not, so the
    // key holds still: an ownership-neutral reload must keep hitting the cached registry.
    expect(cacheKeyFor(rawNeutral, neutral)).toBe(baseKey);
    expect(cacheKeyFor(rawConfigured, configured)).not.toBe(baseKey);

    const first = loadOpenClawPlugins({
      config: base.config,
      activationSourceConfig: rawBase,
      autoEnabledReasons: base.autoEnabledReasons,
      env,
    });
    const second = loadOpenClawPlugins({
      config: neutral.config,
      activationSourceConfig: rawNeutral,
      autoEnabledReasons: neutral.autoEnabledReasons,
      env,
    });
    expect(second).toBe(first);
  });

  // A cached registry carries the cede map that settled every contested channel, and external
  // catalogs contribute `preferOver` edges to that decision. The key was built from
  // `resolvePluginCacheInputs`, which covers only the source roots and load paths, so two loads in
  // one process reading DIFFERENT catalog files hashed identically and the second was served the
  // first's channel ownership while validation resolved the new catalog.
  it("separates cache keys for environments that read different catalog files", () => {
    const stateDir = makePluginLoaderTempDir();
    const bundledDir = makePluginLoaderTempDir();
    const rawConfig = { channels: { zzalpha: { token: "alpha" } } } as OpenClawConfig;
    const cacheKeyFor = (env: NodeJS.ProcessEnv) =>
      resolvePluginRegistryLoadCacheKey({
        config: rawConfig,
        activationSourceConfig: rawConfig,
        env,
      });
    const baseEnv = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir };

    const first = cacheKeyFor({
      ...baseEnv,
      OPENCLAW_PLUGIN_CATALOG_PATHS: path.join(makePluginLoaderTempDir(), "catalog.json"),
    });
    const second = cacheKeyFor({
      ...baseEnv,
      OPENCLAW_PLUGIN_CATALOG_PATHS: path.join(makePluginLoaderTempDir(), "catalog.json"),
    });
    expect(second).not.toBe(first);

    // The other catalog env var names the same kind of file and has to separate keys too.
    expect(
      cacheKeyFor({
        ...baseEnv,
        OPENCLAW_MPM_CATALOG_PATHS: path.join(makePluginLoaderTempDir(), "catalog.json"),
      }),
    ).not.toBe(cacheKeyFor(baseEnv));
  });

  // The identity has to be the RESOLVED path. One configured `~/catalog.json` names a different
  // file per HOME, so hashing the authored string would hand one environment another's catalog --
  // the same reason the catalog snapshot itself keys on resolved paths. HOME alone moves nothing
  // else in this key, so this separates a resolved identity from an authored one.
  it("separates cache keys for one configured catalog path across homes", () => {
    const stateDir = makePluginLoaderTempDir();
    const bundledDir = makePluginLoaderTempDir();
    const rawConfig = { channels: { zzalpha: { token: "alpha" } } } as OpenClawConfig;
    const keyForHome = (home: string) =>
      resolvePluginRegistryLoadCacheKey({
        config: rawConfig,
        activationSourceConfig: rawConfig,
        env: {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
          HOME: home,
          OPENCLAW_PLUGIN_CATALOG_PATHS: "~/catalog.json",
        },
      });

    expect(keyForHome(makePluginLoaderTempDir())).not.toBe(keyForHome(makePluginLoaderTempDir()));
  });
});
