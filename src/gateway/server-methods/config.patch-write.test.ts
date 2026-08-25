/**
 * Tests which config.patch persists: the authored config, not the runtime-shaped validation input.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAgentWorkspaceDirs } from "../../agents/workspace-dirs.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { isChannelOwnershipSourcePath } from "../channel-ownership-change.js";
import { buildGatewayReloadPlan, isNoopGatewayReloadPlan } from "../config-reload-plan.js";
import { clearConfigSchemaResponseCacheForTests, configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

const REDACTED = "__OPENCLAW_REDACTED__";
const REAL_OWNERSHIP_CHANNEL_ID = "zzwriteownershipchat";
const REAL_ORIGINAL_PLUGIN_ID = "zzwriteownership-classic";
const REAL_REPLACEMENT_PLUGIN_ID = "zzwriteownership-replacement";
const ROSTER_OWNERSHIP_CHANNEL_ID = "zze2echan";
const ROSTER_ORIGINAL_PLUGIN_ID = "zz-base";
const ROSTER_REPLACEMENT_PLUGIN_ID = "zz-repl";
const ROSTER_WORKSPACE_A = "/tmp/zz-workspace-a";
const ROSTER_WORKSPACE_B = "/tmp/zz-workspace-b";
const realOwnershipManifestRegistry = makeRegistry([
  {
    id: REAL_ORIGINAL_PLUGIN_ID,
    channels: [REAL_OWNERSHIP_CHANNEL_ID],
    channelConfigs: { [REAL_OWNERSHIP_CHANNEL_ID]: { schema: { type: "object" } } },
  },
  {
    id: REAL_REPLACEMENT_PLUGIN_ID,
    channels: [REAL_OWNERSHIP_CHANNEL_ID],
    channelConfigs: {
      [REAL_OWNERSHIP_CHANNEL_ID]: {
        schema: { type: "object" },
        preferOver: [REAL_ORIGINAL_PLUGIN_ID],
      },
    },
  },
]);
const rosterBaseManifestRegistry = makeRegistry([
  {
    id: ROSTER_ORIGINAL_PLUGIN_ID,
    channels: [ROSTER_OWNERSHIP_CHANNEL_ID],
    channelConfigs: { [ROSTER_OWNERSHIP_CHANNEL_ID]: { schema: { type: "object" } } },
  },
]);
const rosterExpandedManifestRegistry = makeRegistry([
  {
    id: ROSTER_ORIGINAL_PLUGIN_ID,
    channels: [ROSTER_OWNERSHIP_CHANNEL_ID],
    channelConfigs: { [ROSTER_OWNERSHIP_CHANNEL_ID]: { schema: { type: "object" } } },
  },
  {
    id: ROSTER_REPLACEMENT_PLUGIN_ID,
    channels: [ROSTER_OWNERSHIP_CHANNEL_ID],
    channelConfigs: {
      [ROSTER_OWNERSHIP_CHANNEL_ID]: {
        schema: { type: "object" },
        preferOver: [ROSTER_ORIGINAL_PLUGIN_ID],
      },
    },
  },
]);

const configWriteMocks = vi.hoisted(() => ({
  commitGatewayConfigWrite: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
  resolveGatewayConfigRestartWriteResult: vi.fn(),
}));

const channelOwnershipMocks = vi.hoisted(() => ({
  findChannelOwnershipChange: vi.fn(),
}));

const manifestRegistryMocks = vi.hoisted(() => ({
  resolve: undefined as undefined | ((params: { config: unknown }) => unknown),
}));

vi.mock("../channel-ownership-change.js", async () => {
  const actual = await vi.importActual<typeof import("../channel-ownership-change.js")>(
    "../channel-ownership-change.js",
  );
  return {
    ...actual,
    findChannelOwnershipChange: channelOwnershipMocks.findChannelOwnershipChange,
  };
});

vi.mock("../../config/io.plugin-metadata.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/io.plugin-metadata.js")>(
    "../../config/io.plugin-metadata.js",
  );
  return {
    ...actual,
    resolveConfigWidePluginManifestRegistry: (params: { config: unknown }) =>
      manifestRegistryMocks.resolve?.(params) ??
      actual.resolveConfigWidePluginManifestRegistry(params as never),
  };
});

vi.mock("../../config/io.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/io.js")>("../../config/io.js");
  return {
    ...actual,
    readConfigFileSnapshotForWrite: configWriteMocks.readConfigFileSnapshotForWrite,
  };
});

const configValidationMocks = vi.hoisted(() => ({
  validateConfigObjectRawWithPlugins: vi.fn(),
  validateConfigObjectWithPlugins: vi.fn(),
}));

vi.mock("../../config/validation.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/validation.js")>(
    "../../config/validation.js",
  );
  return {
    ...actual,
    validateConfigObjectRawWithPlugins: configValidationMocks.validateConfigObjectRawWithPlugins,
    validateConfigObjectWithPlugins: configValidationMocks.validateConfigObjectWithPlugins,
  };
});

vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: vi.fn(async ({ config }: { config: OpenClawConfig }) => ({
    config,
  })),
}));

vi.mock("./config-write-flow.js", async () => {
  const actual =
    await vi.importActual<typeof import("./config-write-flow.js")>("./config-write-flow.js");
  return {
    ...actual,
    commitGatewayConfigWrite: configWriteMocks.commitGatewayConfigWrite,
    resolveGatewayConfigRestartWriteResult: configWriteMocks.resolveGatewayConfigRestartWriteResult,
  };
});

const { loadGatewayRuntimeConfigSchemaMock, buildRuntimeConfigSchemaForConfigMock } = vi.hoisted(
  () => ({
    loadGatewayRuntimeConfigSchemaMock: vi.fn(),
    buildRuntimeConfigSchemaForConfigMock: vi.fn(),
  }),
);

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: loadGatewayRuntimeConfigSchemaMock,
  buildRuntimeConfigSchemaForConfig: buildRuntimeConfigSchemaForConfigMock,
}));

let runtimeConfig: OpenClawConfig;
let authoredConfig: OpenClawConfig;

function schemaResponse(uiHints: Record<string, { sensitive?: boolean }>) {
  return { schema: { type: "object" }, uiHints, version: "test-schema" };
}

/** Persists the config the handler actually handed the write flow. */
function persistedConfig(): OpenClawConfig {
  const call = expectDefined(
    configWriteMocks.commitGatewayConfigWrite.mock.calls.at(-1),
    "commitGatewayConfigWrite call",
  );
  return (call[0] as { nextConfig: OpenClawConfig }).nextConfig;
}

async function invokeConfigPatch(raw: unknown) {
  const harness = createConfigHandlerHarness({
    method: "config.patch",
    params: { raw: JSON.stringify(raw), baseHash: "base-hash" },
  });
  await expectDefined(
    configHandlers["config.patch"],
    'configHandlers["config.patch"] test invariant',
  )(harness.options);
  return harness;
}

async function invokeConfigApply(raw: unknown) {
  const harness = createConfigHandlerHarness({
    method: "config.apply",
    params: { raw: JSON.stringify(raw), baseHash: "base-hash" },
  });
  await expectDefined(
    configHandlers["config.apply"],
    'configHandlers["config.apply"] test invariant',
  )(harness.options);
  return harness;
}

beforeEach(() => {
  channelOwnershipMocks.findChannelOwnershipChange.mockReset().mockReturnValue(null);
  manifestRegistryMocks.resolve = undefined;
  loadGatewayRuntimeConfigSchemaMock.mockReturnValue(schemaResponse({}));
  buildRuntimeConfigSchemaForConfigMock.mockReturnValue(schemaResponse({}));
  configValidationMocks.validateConfigObjectRawWithPlugins.mockImplementation(
    (config: OpenClawConfig) => ({ ok: true, config, warnings: [] }),
  );
  configValidationMocks.validateConfigObjectWithPlugins.mockImplementation(
    (config: OpenClawConfig) => ({ ok: true, config, warnings: [] }),
  );
  configWriteMocks.readConfigFileSnapshotForWrite.mockImplementation(async () => {
    const result = createConfigWriteSnapshot(runtimeConfig);
    result.snapshot.hash = "base-hash";
    result.snapshot.raw = JSON.stringify(runtimeConfig);
    // The authored half is what the operator's file holds; the runtime half carries what
    // validation and auto-enable materialized on top of it.
    result.snapshot.sourceConfig = authoredConfig;
    return result;
  });
  configWriteMocks.resolveGatewayConfigRestartWriteResult.mockImplementation(async () => ({
    payload: { kind: "config-patch", mode: "config.patch", configPath: "/tmp/openclaw.json" },
    sentinelPersisted: false,
    restart: undefined,
  }));
  configWriteMocks.commitGatewayConfigWrite.mockImplementation(
    async ({ nextConfig }: { nextConfig: OpenClawConfig }) => ({
      path: "/tmp/openclaw.json",
      config: nextConfig,
      hash: "next-hash",
      queueFollowUp: vi.fn(),
    }),
  );
});

afterEach(() => {
  clearConfigSchemaResponseCacheForTests();
  resetPluginRuntimeStateForTest();
  vi.clearAllMocks();
});

describe("config.patch persists the authored config", () => {
  // Codex review P1 on #128904: the patch is merged onto the runtime-shaped `snapshot.config` for
  // validation, and that same merge was handed to the write flow. Validation seeds
  // `plugins.entries.<id>.config` for every enabled claimant, so the write put a record in the
  // authored file the operator never wrote — and explicit selection is exactly what sets a
  // declared `preferOver` aside, so the next load moves the channel to a different plugin.
  it("does not write a validation-seeded plugin entry the operator never authored", async () => {
    runtimeConfig = {
      channels: { voxchat: { replyMode: "inline" } },
      plugins: { entries: { "voxchat-classic": { config: {} } } },
    } as unknown as OpenClawConfig;
    authoredConfig = {
      channels: { voxchat: { replyMode: "inline" } },
      plugins: {},
    } as OpenClawConfig;

    await invokeConfigPatch({ channels: { voxchat: { replyMode: "thread" } } });

    const written = persistedConfig() as {
      channels?: { voxchat?: { replyMode?: string } };
      plugins?: { entries?: Record<string, unknown> };
    };
    // The operator's own edit still lands.
    expect(written.channels?.voxchat?.replyMode).toBe("thread");
    expect(written.plugins?.entries).toBeUndefined();
  });

  // Guards the hazard the fix above introduces if the authored merge is persisted raw: the Control
  // UI echoes `__OPENCLAW_REDACTED__` back for a sensitive value, and only the runtime half holds
  // the real one when it is materialized from a default, an env var or a secret ref. Writing the
  // authored merge without resolving sentinels against the runtime config would overwrite a live
  // credential with the placeholder.
  it("resolves an echoed sentinel from the runtime config instead of persisting it", async () => {
    runtimeConfig = {
      channels: { voxchat: { botToken: "real-token", replyMode: "inline" } },
    } as unknown as OpenClawConfig;
    // The token is materialized, never authored.
    authoredConfig = {
      channels: { voxchat: { replyMode: "inline" } },
    } as unknown as OpenClawConfig;
    buildRuntimeConfigSchemaForConfigMock.mockReturnValue(
      schemaResponse({ "channels.voxchat.botToken": { sensitive: true } }),
    );

    await invokeConfigPatch({ channels: { voxchat: { botToken: REDACTED, replyMode: "thread" } } });

    const written = persistedConfig() as {
      channels?: { voxchat?: { botToken?: string; replyMode?: string } };
    };
    expect(written.channels?.voxchat?.botToken).toBe("real-token");
    expect(written.channels?.voxchat?.replyMode).toBe("thread");
  });
});

/** The path list the handler actually handed restart planning. */
function restartPlanningChangedPaths(): string[] {
  const call = expectDefined(
    configWriteMocks.resolveGatewayConfigRestartWriteResult.mock.calls.at(-1),
    "resolveGatewayConfigRestartWriteResult call",
  );
  return (call[0] as { changedPaths: string[] }).changedPaths;
}

describe("channel ownership source path guard", () => {
  it("treats both bare ownership roots and their descendants symmetrically", () => {
    expect(
      ["plugins", "channels", "plugins.entries.example", "channels.example.token"].map(
        isChannelOwnershipSourcePath,
      ),
    ).toEqual([true, true, true, true]);
    expect(isChannelOwnershipSourcePath("ui.prefs.theme")).toBe(false);
  });
});

describe("config.patch restart planning", () => {
  // Regression on #128904: adding an explicit selection auto-enable had already materialized
  // leaves the runtime diff empty, so restart planning was handed `[]`, classified the write a
  // no-op before the reload-off branch, and left the previous channel owner running.
  it("forwards the persisted ownership path when the runtime diff is empty", async () => {
    runtimeConfig = {
      channels: { voxchat: { enabled: true } },
      plugins: { entries: { "voxchat-classic": { enabled: true } } },
    } as unknown as OpenClawConfig;
    authoredConfig = {
      channels: { voxchat: { enabled: true } },
      plugins: {},
    } as unknown as OpenClawConfig;
    channelOwnershipMocks.findChannelOwnershipChange.mockReturnValueOnce({
      channelId: "voxchat",
      previousOwner: "voxchat-classic",
      nextOwner: "voxchat-replacement",
    });

    await invokeConfigPatch({ plugins: { entries: { "voxchat-classic": { enabled: true } } } });

    const changedPaths = restartPlanningChangedPaths();
    expect(changedPaths).toEqual(["plugins.entries.voxchat-classic.enabled"]);
    const plan = buildGatewayReloadPlan(changedPaths, { candidateConfig: runtimeConfig });
    expect(isNoopGatewayReloadPlan(plan)).toBe(false);
    expect(plan.restartGateway).toBe(false);
    expect(plan.hotReasons).toEqual(["plugins.entries.voxchat-classic.enabled"]);
    expect(plan.reloadPlugins).toBe(true);
    expect(plan.disposeMcpRuntimes).toBe(true);
    expect(plan.noopPaths).toEqual([]);
  });

  it("binds a real ownership comparison through the write path", async () => {
    runtimeConfig = {
      channels: { [REAL_OWNERSHIP_CHANNEL_ID]: { enabled: true } },
      plugins: {
        entries: {
          [REAL_ORIGINAL_PLUGIN_ID]: { enabled: true },
          [REAL_REPLACEMENT_PLUGIN_ID]: { enabled: true },
        },
      },
    } as unknown as OpenClawConfig;
    authoredConfig = {
      channels: { [REAL_OWNERSHIP_CHANNEL_ID]: { enabled: true } },
      plugins: {},
    } as unknown as OpenClawConfig;
    const metadataSnapshot = createPluginMetadataSnapshot({
      config: runtimeConfig,
      manifestRegistry: realOwnershipManifestRegistry,
    });
    configWriteMocks.readConfigFileSnapshotForWrite.mockImplementationOnce(async () => {
      const result = createConfigWriteSnapshot(runtimeConfig);
      result.snapshot.sourceConfig = authoredConfig;
      return { ...result, writeOptions: { basePluginMetadataSnapshot: metadataSnapshot } };
    });
    const actual = await vi.importActual<typeof import("../channel-ownership-change.js")>(
      "../channel-ownership-change.js",
    );
    channelOwnershipMocks.findChannelOwnershipChange.mockImplementation(
      actual.findChannelOwnershipChange,
    );

    await invokeConfigPatch({
      plugins: { entries: { [REAL_ORIGINAL_PLUGIN_ID]: { enabled: true } } },
    });

    expect(channelOwnershipMocks.findChannelOwnershipChange).toHaveReturnedWith({
      channelId: REAL_OWNERSHIP_CHANNEL_ID,
      previousOwner: REAL_REPLACEMENT_PLUGIN_ID,
      nextOwner: REAL_ORIGINAL_PLUGIN_ID,
    });
    expect(restartPlanningChangedPaths()).toEqual([
      `plugins.entries.${REAL_ORIGINAL_PLUGIN_ID}.enabled`,
    ]);
  });

  it("refreshes ownership discovery when an agent roster edit moves workspace roots", async () => {
    runtimeConfig = {
      agents: { list: [{ id: "base", workspace: ROSTER_WORKSPACE_A }] },
      channels: { [ROSTER_OWNERSHIP_CHANNEL_ID]: { token: "same-token" } },
    } as unknown as OpenClawConfig;
    authoredConfig = {
      agents: { list: [{ id: "base", workspace: ROSTER_WORKSPACE_A }] },
      channels: { [ROSTER_OWNERSHIP_CHANNEL_ID]: {} },
    } as unknown as OpenClawConfig;
    const metadataSnapshot = createPluginMetadataSnapshot({
      config: runtimeConfig,
      manifestRegistry: rosterBaseManifestRegistry,
    });
    configWriteMocks.readConfigFileSnapshotForWrite.mockImplementationOnce(async () => {
      const result = createConfigWriteSnapshot(runtimeConfig);
      result.snapshot.sourceConfig = authoredConfig;
      return { ...result, writeOptions: { basePluginMetadataSnapshot: metadataSnapshot } };
    });
    manifestRegistryMocks.resolve = ({ config }) =>
      listAgentWorkspaceDirs(config as OpenClawConfig).includes(ROSTER_WORKSPACE_B)
        ? rosterExpandedManifestRegistry
        : rosterBaseManifestRegistry;
    const actual = await vi.importActual<typeof import("../channel-ownership-change.js")>(
      "../channel-ownership-change.js",
    );
    channelOwnershipMocks.findChannelOwnershipChange.mockImplementation(
      actual.findChannelOwnershipChange,
    );

    await invokeConfigPatch({
      agents: {
        list: [
          { id: "base", workspace: ROSTER_WORKSPACE_A },
          { id: "replacement", workspace: ROSTER_WORKSPACE_B },
        ],
      },
      channels: { [ROSTER_OWNERSHIP_CHANNEL_ID]: { token: "same-token" } },
    });

    expect(channelOwnershipMocks.findChannelOwnershipChange).toHaveReturnedWith({
      channelId: ROSTER_OWNERSHIP_CHANNEL_ID,
      previousOwner: ROSTER_ORIGINAL_PLUGIN_ID,
      nextOwner: ROSTER_REPLACEMENT_PLUGIN_ID,
    });
    expect(restartPlanningChangedPaths()).toEqual([
      "agents.list",
      `channels.${ROSTER_OWNERSHIP_CHANNEL_ID}.token`,
    ]);
    expect(
      isNoopGatewayReloadPlan(
        buildGatewayReloadPlan(restartPlanningChangedPaths(), {
          candidateConfig: persistedConfig(),
        }),
      ),
    ).toBe(false);
  });

  it.each([
    ["replyMode", "thread"],
    ["token", "same-token"],
  ] as const)(
    "does not restart for an ownership-neutral authored-only channels.%s edit",
    async (key, value) => {
      runtimeConfig = {
        channels: { voxchat: { [key]: value } },
      } as unknown as OpenClawConfig;
      authoredConfig = {
        channels: { voxchat: {} },
      } as unknown as OpenClawConfig;

      await invokeConfigPatch({ channels: { voxchat: { [key]: value } } });

      expect(restartPlanningChangedPaths()).toEqual([]);
      expect(channelOwnershipMocks.findChannelOwnershipChange).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves subtree-root granularity for an ordinary plugins edit", async () => {
    runtimeConfig = {
      plugins: { entries: { a: { enabled: true } } },
    } as unknown as OpenClawConfig;
    authoredConfig = structuredClone(runtimeConfig);

    await invokeConfigPatch({ plugins: { entries: { b: { enabled: true, k: "v" } } } });

    expect(restartPlanningChangedPaths()).toEqual(["plugins.entries.b"]);
    expect(channelOwnershipMocks.findChannelOwnershipChange).not.toHaveBeenCalled();
  });

  it("preserves subtree-root granularity for an ordinary channels edit", async () => {
    runtimeConfig = { channels: {} } as OpenClawConfig;
    authoredConfig = structuredClone(runtimeConfig);

    await invokeConfigPatch({ channels: { newchan: { enabled: true, token: "abc" } } });

    expect(restartPlanningChangedPaths()).toEqual(["channels.newchan"]);
    expect(channelOwnershipMocks.findChannelOwnershipChange).not.toHaveBeenCalled();
  });

  it("adds a source-only ownership move beside a runtime no-op path", async () => {
    runtimeConfig = {
      ui: { prefs: { theme: "one" } },
      plugins: { entries: { "voxchat-classic": { enabled: true } } },
    } as unknown as OpenClawConfig;
    authoredConfig = {
      ui: { prefs: { theme: "one" } },
      plugins: {},
    } as unknown as OpenClawConfig;
    channelOwnershipMocks.findChannelOwnershipChange.mockReturnValueOnce({
      channelId: "voxchat",
      previousOwner: "voxchat-classic",
      nextOwner: "voxchat-replacement",
    });

    await invokeConfigPatch({
      ui: { prefs: { theme: "two" } },
      plugins: { entries: { "voxchat-classic": { enabled: true } } },
    });

    const changedPaths = restartPlanningChangedPaths();
    expect(changedPaths).toEqual(["ui.prefs.theme", "plugins.entries.voxchat-classic.enabled"]);
    const plan = buildGatewayReloadPlan(changedPaths, { candidateConfig: runtimeConfig });
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toEqual(["ui.prefs.theme"]);
    expect(plan.hotReasons).toEqual(["plugins.entries.voxchat-classic.enabled"]);
    expect(plan.reloadPlugins).toBe(true);
    expect(plan.disposeMcpRuntimes).toBe(true);
  });

  it("fails safe with the ownership paths and a warning when comparison throws", async () => {
    runtimeConfig = {
      ui: { prefs: { theme: "one" } },
      plugins: { entries: { "voxchat-classic": { enabled: true } } },
    } as unknown as OpenClawConfig;
    authoredConfig = {
      ui: { prefs: { theme: "one" } },
      plugins: {},
    } as unknown as OpenClawConfig;
    channelOwnershipMocks.findChannelOwnershipChange.mockImplementationOnce(() => {
      throw new Error("manifest registry failed");
    });

    const { logGateway } = await invokeConfigPatch({
      ui: { prefs: { theme: "two" } },
      plugins: { entries: { "voxchat-classic": { enabled: true } } },
    });

    expect(restartPlanningChangedPaths()).toEqual([
      "ui.prefs.theme",
      "plugins.entries.voxchat-classic.enabled",
    ]);
    expect(logGateway.warn).toHaveBeenCalledExactlyOnceWith(
      "config ownership comparison failed; scheduling conservatively: manifest registry failed",
    );
  });

  it("does not compare for a persisted-only source path outside ownership", async () => {
    runtimeConfig = {
      ui: { prefs: { theme: "one", density: "same" } },
    } as unknown as OpenClawConfig;
    authoredConfig = {
      ui: { prefs: { theme: "two" } },
    } as unknown as OpenClawConfig;

    await invokeConfigPatch({ ui: { prefs: { theme: "two", density: "same" } } });

    expect(persistedConfig()).toEqual({
      ui: { prefs: { theme: "two", density: "same" } },
    });
    expect(restartPlanningChangedPaths()).toEqual(["ui.prefs.theme"]);
    expect(channelOwnershipMocks.findChannelOwnershipChange).not.toHaveBeenCalled();
  });

  it("does not forward a source-only edit outside the ownership surface", async () => {
    runtimeConfig = { ui: { prefs: { theme: "same" } } } as unknown as OpenClawConfig;
    authoredConfig = { ui: {} } as OpenClawConfig;

    await invokeConfigPatch({ ui: { prefs: { theme: "same" } } });

    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
    expect(configWriteMocks.resolveGatewayConfigRestartWriteResult).not.toHaveBeenCalled();
    expect(channelOwnershipMocks.findChannelOwnershipChange).not.toHaveBeenCalled();
  });

  it("plans from the authoritative committed source instead of the pre-write candidate", async () => {
    runtimeConfig = {
      plugins: { entries: { "voxchat-classic": { enabled: true } } },
    } as unknown as OpenClawConfig;
    authoredConfig = { plugins: {} } as OpenClawConfig;
    configWriteMocks.commitGatewayConfigWrite.mockImplementationOnce(async () => ({
      path: "/tmp/openclaw.json",
      config: structuredClone(authoredConfig),
      hash: "next-hash",
      queueFollowUp: vi.fn(),
    }));

    await invokeConfigPatch({ plugins: { entries: { "voxchat-classic": { enabled: true } } } });

    expect(restartPlanningChangedPaths()).toEqual([]);
    expect(channelOwnershipMocks.findChannelOwnershipChange).not.toHaveBeenCalled();
  });
});

describe("config.apply restart planning", () => {
  it("forwards a persisted ownership path when the runtime diff is empty", async () => {
    runtimeConfig = {
      channels: { voxchat: { enabled: true } },
      plugins: { entries: { "voxchat-classic": { enabled: true } } },
    } as unknown as OpenClawConfig;
    authoredConfig = {
      channels: { voxchat: { enabled: true } },
      plugins: {},
    } as unknown as OpenClawConfig;
    channelOwnershipMocks.findChannelOwnershipChange.mockReturnValueOnce({
      channelId: "voxchat",
      previousOwner: "voxchat-classic",
      nextOwner: "voxchat-replacement",
    });

    await invokeConfigApply({
      channels: { voxchat: { enabled: true } },
      plugins: { entries: { "voxchat-classic": { enabled: true } } },
    });

    expect(restartPlanningChangedPaths()).toEqual(["plugins.entries.voxchat-classic.enabled"]);
  });
});
