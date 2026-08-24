// Verifies plugin loader preferOver cede mechanics: case-variant registrations, cede behavior
// under scoped loads, CLI registry cede lists, and ceded channels left without a registered
// owner. Split from loader.prefer-over.test.ts (which keeps the selection/settlement tests) to
// stay within the file-size budget; the temp-dir and multi-channel fixture helpers are
// intentionally duplicated from that sibling, trimmed to the parameters these tests use.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { loadOpenClawPluginCliRegistry } from "./loader.js";
import { clearPluginLoaderCache, loadOpenClawPlugins } from "./loader.test-fixtures.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

const tempDirs: string[] = [];

function makePluginLoaderTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-prefer-over-cede-"));
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
  registeredChannelIds?: string[];
  throwOnRegister?: boolean;
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
  const registrations = (params.registeredChannelIds ?? params.channelIds)
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
        ${params.throwOnRegister ? 'throw new Error("register failed after channel registration");' : ""}
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

describe("plugin loader preferOver cede", () => {
  // Registration accepts whatever id the plugin passes, while the cede list carries the manifest
  // claim. Downstream lookups lowercase both and treat them as the same channel, so a raw-string
  // comparison lets a differently-cased registration slip past its own cede and re-opens the
  // order-dependent duplicate path the cede exists to close.
  it("cedes a channel registered under a case variant of the manifest claim", () => {
    const root = makePluginLoaderTempDir();
    const fallbackDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-fallback",
      channelIds: ["zzalpha", "zzbeta"],
      toolName: "zz_fallback_tool",
      registeredChannelIds: ["ZZALPHA", "zzbeta"],
    });
    const replacementDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-replacement",
      channelIds: ["zzalpha"],
      toolName: "zz_replacement_tool",
      preferOver: { zzalpha: ["zz-fallback"] },
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
    };
    const rawConfig = {
      channels: { zzalpha: { token: "alpha" }, zzbeta: { token: "beta" } },
      plugins: { load: { paths: [fallbackDir, replacementDir] } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    // One runtime owner however the registration spelled the id.
    const alphaOwners = registry.channels.filter(
      (entry) => entry.plugin.id.toLowerCase() === "zzalpha",
    );
    expect(alphaOwners.map((entry) => entry.pluginId)).toEqual(["zz-replacement"]);
    expect(registry.channels.find((entry) => entry.plugin.id === "zzbeta")?.pluginId).toBe(
      "zz-fallback",
    );
    expect(registry.tools.map((tool) => tool.pluginId).toSorted()).toEqual([
      "zz-fallback",
      "zz-replacement",
    ]);
  });

  // Schema ownership is computed from every manifest, but a scoped load may carry only the ceding
  // plugin. Skipping its registration then leaves the channel with no runtime owner at all — on
  // the fallback path the same load served it — so the cede must not apply.
  it("keeps a ceded channel when a scoped load omits the preferred claimant", () => {
    const root = makePluginLoaderTempDir();
    const fallbackDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-fallback",
      channelIds: ["zzalpha", "zzbeta"],
      toolName: "zz_fallback_tool",
    });
    const replacementDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-replacement",
      channelIds: ["zzalpha"],
      toolName: "zz_replacement_tool",
      preferOver: { zzalpha: ["zz-fallback"] },
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
    };
    const rawConfig = {
      channels: { zzalpha: { token: "alpha" }, zzbeta: { token: "beta" } },
      plugins: { load: { paths: [fallbackDir, replacementDir] } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
      onlyPluginIds: ["zz-fallback"],
    });

    const owner = (channelId: string) =>
      registry.channels.find((entry) => entry.plugin.id === channelId)?.pluginId;
    expect(owner("zzalpha")).toBe("zz-fallback");
    expect(owner("zzbeta")).toBe("zz-fallback");
    expect(
      registry.plugins.find((plugin) => plugin.id === "zz-fallback")?.cededChannelIds,
    ).toBeUndefined();
    expect(registry.diagnostics.map((diag) => diag.message).join("\n")).not.toContain(
      "ceded channel has no registered owner",
    );
  });

  it("still cedes when the scoped load contains both claimants", () => {
    const root = makePluginLoaderTempDir();
    const fallbackDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-fallback",
      channelIds: ["zzalpha", "zzbeta"],
      toolName: "zz_fallback_tool",
    });
    const replacementDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-replacement",
      channelIds: ["zzalpha"],
      toolName: "zz_replacement_tool",
      preferOver: { zzalpha: ["zz-fallback"] },
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
    };
    const rawConfig = {
      channels: { zzalpha: { token: "alpha" }, zzbeta: { token: "beta" } },
      plugins: { load: { paths: [fallbackDir, replacementDir] } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
      onlyPluginIds: ["zz-fallback", "zz-replacement"],
    });

    const owner = (channelId: string) =>
      registry.channels.find((entry) => entry.plugin.id === channelId)?.pluginId;
    expect(owner("zzalpha")).toBe("zz-replacement");
    expect(owner("zzbeta")).toBe("zz-fallback");
    expect(registry.diagnostics.map((diag) => diag.message).join("\n")).not.toContain(
      "channel already registered",
    );
  });

  // Claimants come from every manifest, so a third claimant the operator disabled is neither
  // displaced nor loadable. Reading it as the plugin the channel went to would hold the cede in
  // place for a channel nothing registers, which is the dead channel the scope check exists to
  // prevent — reached by a different route. Registry order puts the disabled claimant first so it
  // is the one a scope-only check would pick.
  it.each([
    {
      name: "cedes to the active claimant past a disabled one",
      onlyPluginIds: ["zz-fallback", "zz-inactive", "zz-replacement"],
      expectedOwner: "zz-replacement",
    },
    {
      name: "keeps the channel when only the disabled claimant is in scope",
      onlyPluginIds: ["zz-fallback", "zz-inactive"],
      expectedOwner: "zz-fallback",
    },
  ])("$name", ({ onlyPluginIds, expectedOwner }) => {
    const root = makePluginLoaderTempDir();
    // The fallback claims a second, uncontested channel so auto-enable keeps it enabled. A plugin
    // whose only channel is displaced is disabled in config and never reaches the loader at all.
    const fallbackDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-fallback",
      channelIds: ["zzalpha", "zzbeta"],
      toolName: "zz_fallback_tool",
    });
    const inactiveDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-inactive",
      channelIds: ["zzalpha"],
      toolName: "zz_inactive_tool",
    });
    const replacementDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-replacement",
      channelIds: ["zzalpha"],
      toolName: "zz_replacement_tool",
      preferOver: { zzalpha: ["zz-fallback"] },
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
    };
    const rawConfig = {
      channels: { zzalpha: { token: "alpha" }, zzbeta: { token: "beta" } },
      plugins: {
        entries: { "zz-inactive": { enabled: false } },
        load: { paths: [fallbackDir, inactiveDir, replacementDir] },
      },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
      onlyPluginIds,
    });

    expect(registry.channels.find((entry) => entry.plugin.id === "zzalpha")?.pluginId).toBe(
      expectedOwner,
    );
    expect(registry.diagnostics.map((diag) => diag.message).join("\n")).not.toContain(
      "ceded channel has no registered owner",
    );
  });

  // The CLI registry loads no runtime channels, but its records carry the same cede list, so a
  // scoped CLI load has to reach the same answer as the runtime loader or the surfaces disagree.
  it("scopes the CLI registry cede list to the plugins in the load", async () => {
    const root = makePluginLoaderTempDir();
    const fallbackDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-fallback",
      channelIds: ["zzalpha", "zzbeta"],
      toolName: "zz_fallback_tool",
    });
    const replacementDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-replacement",
      channelIds: ["zzalpha"],
      toolName: "zz_replacement_tool",
      preferOver: { zzalpha: ["zz-fallback"] },
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
    };
    const rawConfig = {
      channels: { zzalpha: { token: "alpha" }, zzbeta: { token: "beta" } },
      plugins: { load: { paths: [fallbackDir, replacementDir] } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const scopedToCeder = await loadOpenClawPluginCliRegistry({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
      onlyPluginIds: ["zz-fallback"],
    });
    expect(
      scopedToCeder.plugins.find((plugin) => plugin.id === "zz-fallback")?.cededChannelIds,
    ).toBeUndefined();

    const scopedToBoth = await loadOpenClawPluginCliRegistry({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
      onlyPluginIds: ["zz-fallback", "zz-replacement"],
    });
    expect(
      scopedToBoth.plugins.find((plugin) => plugin.id === "zz-fallback")?.cededChannelIds,
    ).toEqual(["zzalpha"]);
  });

  // Restoring the ceding plugin after its replacement rolls back would hand the channel to the
  // fallback while the Gateway schema, computed from config, still names the replacement. The
  // load keeps the cede, so it has to say the channel ended up with no owner at all.
  it("reports a ceded channel whose preferred claimant fails during register", () => {
    const root = makePluginLoaderTempDir();
    const fallbackDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-fallback",
      channelIds: ["zzalpha", "zzbeta"],
      toolName: "zz_fallback_tool",
    });
    const replacementDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-replacement",
      channelIds: ["zzalpha"],
      toolName: "zz_replacement_tool",
      preferOver: { zzalpha: ["zz-fallback"] },
      throwOnRegister: true,
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
    };
    const rawConfig = {
      channels: { zzalpha: { token: "alpha" }, zzbeta: { token: "beta" } },
      plugins: { load: { paths: [fallbackDir, replacementDir] } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    expect(registry.plugins.find((plugin) => plugin.id === "zz-replacement")?.status).toBe("error");
    expect(registry.channels.find((entry) => entry.plugin.id === "zzalpha")).toBeUndefined();
    const diagnostic = registry.diagnostics.find((diag) =>
      diag.message.includes("ceded channel has no registered owner"),
    );
    expect(diagnostic).toMatchObject({
      level: "error",
      pluginId: "zz-fallback",
      message: "ceded channel has no registered owner: zzalpha (ceded to zz-replacement)",
    });
  });

  // The shape above keeps the fallback loaded through a second channel. The ordinary shape is one
  // contested channel, where auto-enable turns the fallback off entirely — so the only record
  // carrying the cede never loads, and a diagnostic that reads activation status would go quiet in
  // exactly the case an operator hits.
  it("reports a ceded channel when auto-enable disabled the plugin that ceded it", () => {
    const root = makePluginLoaderTempDir();
    const fallbackDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-fallback",
      channelIds: ["zzalpha"],
      toolName: "zz_fallback_tool",
    });
    const replacementDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-replacement",
      channelIds: ["zzalpha"],
      toolName: "zz_replacement_tool",
      preferOver: { zzalpha: ["zz-fallback"] },
      throwOnRegister: true,
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
    };
    const rawConfig = {
      channels: { zzalpha: { token: "alpha" } },
      plugins: { load: { paths: [fallbackDir, replacementDir] } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    expect(autoEnabled.config.plugins?.entries?.["zz-fallback"]?.enabled).toBe(false);
    expect(registry.plugins.find((plugin) => plugin.id === "zz-fallback")?.status).not.toBe(
      "loaded",
    );
    expect(registry.channels.find((entry) => entry.plugin.id === "zzalpha")).toBeUndefined();
    const matching = registry.diagnostics.filter((diag) =>
      diag.message.includes("ceded channel has no registered owner"),
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      level: "error",
      pluginId: "zz-fallback",
      message: "ceded channel has no registered owner: zzalpha (ceded to zz-replacement)",
    });
  });

  // A declared contest narrows activation's candidate set to the declaring pair, so a third
  // claimant of the same channel is excluded from the plan without any declaration naming it.
  // Ceding only the ids the declaration displaced let that claimant — kept enabled through a
  // second configured channel and discovered first — take zzalpha at runtime while schema
  // ownership validated the replacement, the exact two-plane split the cede exists to close.
  it("cedes a contested channel from a claimant the activation plan excludes", () => {
    const root = makePluginLoaderTempDir();
    const thirdDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-third",
      channelIds: ["zzalpha", "zzgamma"],
      toolName: "zz_third_tool",
    });
    const fallbackDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-fallback",
      channelIds: ["zzalpha"],
      toolName: "zz_fallback_tool",
    });
    const replacementDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-replacement",
      channelIds: ["zzalpha"],
      toolName: "zz_replacement_tool",
      preferOver: { zzalpha: ["zz-fallback"] },
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
    };
    const rawConfig = {
      channels: { zzalpha: { token: "alpha" }, zzgamma: { token: "gamma" } },
      plugins: { load: { paths: [thirdDir, fallbackDir, replacementDir] } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    const owner = (channelId: string) =>
      registry.channels.find((entry) => entry.plugin.id === channelId)?.pluginId;
    // The plan's winner takes the contested channel even though the excluded claimant loads first.
    expect(owner("zzalpha")).toBe("zz-replacement");
    // The excluded claimant stays a full citizen everywhere it is a candidate.
    expect(owner("zzgamma")).toBe("zz-third");
    expect(registry.plugins.find((plugin) => plugin.id === "zz-third")?.cededChannelIds).toEqual([
      "zzalpha",
    ]);
    // Yielding by cede is not a duplicate registration, so neither loaded claimant loses tools.
    expect(registry.diagnostics.map((diag) => diag.message).join("\n")).not.toContain(
      "channel already registered",
    );
    expect(registry.tools.map((tool) => tool.pluginId).toSorted()).toEqual([
      "zz-replacement",
      "zz-third",
    ]);
  });

  // A channel nobody declared anything about keeps its fallback. Both planes settle an undeclared
  // pair on the first registrant, and the loser stays registerable so a winner that fails during
  // register does not take the channel down with it. Ceding every claimant the activation plan
  // leaves out would silently delete that resilience, so the cede stays scoped to channels with a
  // declared contest.
  it("keeps the loser of an undeclared pair registerable when the winner fails to load", () => {
    const root = makePluginLoaderTempDir();
    const firstDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-first",
      channelIds: ["zzalpha"],
      toolName: "zz_first_tool",
      throwOnRegister: true,
    });
    const secondDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-second",
      channelIds: ["zzalpha", "zzgamma"],
      toolName: "zz_second_tool",
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
    };
    const rawConfig = {
      channels: { zzalpha: { token: "alpha" }, zzgamma: { token: "gamma" } },
      plugins: { load: { paths: [firstDir, secondDir] } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    expect(registry.plugins.find((plugin) => plugin.id === "zz-first")?.status).toBe("error");
    // The failed winner's registrations roll back, and the undeclared loser still serves the
    // channel instead of leaving it dead.
    expect(registry.channels.find((entry) => entry.plugin.id === "zzalpha")?.pluginId).toBe(
      "zz-second",
    );
    expect(
      registry.plugins.find((plugin) => plugin.id === "zz-second")?.cededChannelIds,
    ).toBeUndefined();
  });
});
