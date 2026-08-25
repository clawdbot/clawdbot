// Covers the reload-path escalation for channel ownership moves: a hot `channels.<id>` edit that
// moves the channel's selected owner must rebuild the plugin registry before the channel restart,
// so the restarted channel registers the replacement instead of the displaced owner from the
// previous registry generation. An ownership-neutral channel edit must keep its cheap plan.
import chokidar from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginRegistry } from "../plugins/registry.js";
import {
  requireActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import type { ChannelKind, GatewayReloadPlan } from "./config-reload-plan.js";
import { startGatewayConfigReloader } from "./config-reload.js";
import { restartGatewayChannels } from "./server-reload-channel-restart.js";
import type { GatewayReloadHandlerParams } from "./server-reload-contracts.js";

const configAuditMocks = vi.hoisted(() => ({
  append: vi.fn(),
  readSnapshot: vi.fn(),
  readLatestSnapshot: vi.fn(),
  upsertSnapshot: vi.fn(),
}));

vi.mock("../config/io.audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/io.audit.js")>();
  return {
    ...actual,
    appendConfigAuditRecordSync: configAuditMocks.append,
  };
});

vi.mock("../config/config-journal-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config-journal-snapshot.js")>();
  return {
    ...actual,
    readConfigSnapshotAuditRecord: configAuditMocks.readSnapshot,
    readLatestConfigSnapshotAuditRecord: configAuditMocks.readLatestSnapshot,
    upsertConfigSnapshotAuditRecord: configAuditMocks.upsertSnapshot,
  };
});

// The reload path resolves the manifest registry from the lifecycle snapshot machinery; pin the
// registry to a fixed claimant set so the test controls exactly which plugins claim the channel
// while the real ownership policy and schema-plane selection run against the real configs.
const manifestMocks = vi.hoisted(() => ({
  registry: { plugins: [], diagnostics: [] } as unknown,
  // Workspace-move tests install a per-config resolver: production discovery scans manifests per
  // agent workspace dir, so the registry each comparison side resolves depends on its config.
  resolve: undefined as undefined | ((params: { config: unknown }) => unknown),
}));

vi.mock("../config/io.plugin-metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/io.plugin-metadata.js")>();
  return {
    ...actual,
    resolveConfigWidePluginManifestRegistry: (params: { config: unknown }) =>
      manifestMocks.resolve ? manifestMocks.resolve(params) : manifestMocks.registry,
  };
});

const CHANNEL_ID = "clawtest";
const REPLACEMENT_PLUGIN_ID = "clawtest-replacement";
const DISPLACED_PLUGIN_ID = "clawtest-displaced";
const LEGACY_PLUGIN_ID = "clawtest-legacy";

function makeClaimantRecordBase(id: string): PluginManifestRecord {
  return {
    id,
    channels: [CHANNEL_ID],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "config",
    rootDir: `/tmp/${id}`,
    source: `/tmp/${id}/index.js`,
    manifestPath: `/tmp/${id}/openclaw.plugin.json`,
  };
}

function makeClaimantRecord(params: { id: string; preferOver?: string[] }): PluginManifestRecord {
  return {
    ...makeClaimantRecordBase(params.id),
    channelConfigs: {
      [CHANNEL_ID]: {
        schema: { type: "object" },
        ...(params.preferOver ? { preferOver: params.preferOver } : {}),
      },
    },
  };
}

/**
 * Three claimants of one channel, in registry order. While the channel is unconfigured every
 * claimant stays active and the legacy record wins the schema as the first undeclared registrant,
 * the same claimant the runtime facade keeps. Configuring the channel narrows activation's
 * candidate set to the declaring pair, which moves the selected owner to the replacement on both
 * planes at once — the ownership flip a `channels.<id>` hot edit causes.
 *
 * Legacy-first on purpose: ordering it last made the flip depend on the schema plane's old
 * last-writer tie-break disagreeing with the facade's first-registrant rule, so the fixture was
 * manufacturing its move out of the divergence this branch removes.
 */
function makeClaimantRegistry(): PluginManifestRegistry {
  return {
    plugins: [
      makeClaimantRecord({ id: LEGACY_PLUGIN_ID }),
      makeClaimantRecord({ id: DISPLACED_PLUGIN_ID }),
      makeClaimantRecord({ id: REPLACEMENT_PLUGIN_ID, preferOver: [DISPLACED_PLUGIN_ID] }),
    ],
    diagnostics: [],
  };
}

/**
 * The same three-claimant contest with no schema descriptor anywhere: the replacement's
 * `preferOver` travels on `channelCatalogMeta`, which auto-enable honors just like a
 * `channelConfigs` declaration, and every claim is a bare `record.channels` entry. The schema
 * plane reports no owner on either side of the edit, so only the runtime plane's cede owner can
 * see this flip. Registry order is legacy-first so the unconfigured cede owner is the legacy
 * claimant.
 */
function makeDescriptorlessClaimantRegistry(): PluginManifestRegistry {
  return {
    plugins: [
      makeClaimantRecordBase(LEGACY_PLUGIN_ID),
      makeClaimantRecordBase(DISPLACED_PLUGIN_ID),
      {
        ...makeClaimantRecordBase(REPLACEMENT_PLUGIN_ID),
        channelCatalogMeta: { id: CHANNEL_ID, preferOver: [DISPLACED_PLUGIN_ID] },
      },
    ],
    diagnostics: [],
  };
}

function makeChannelRuntimeRegistry(
  ownerPluginId: string,
  reload: ChannelPlugin["reload"] = { configPrefixes: [`channels.${CHANNEL_ID}`] },
): PluginRegistry {
  return createTestRegistry([
    {
      pluginId: ownerPluginId,
      plugin: {
        id: CHANNEL_ID,
        meta: {
          id: CHANNEL_ID,
          label: "Clawtest",
          selectionLabel: "Clawtest",
          docsPath: `/channels/${CHANNEL_ID}`,
          blurb: "test stub.",
        },
        capabilities: { chatTypes: ["direct"] },
        config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
        reload,
      } satisfies ChannelPlugin,
      source: "test",
    },
  ]);
}

/**
 * WhatsApp's shipped reload shape (`extensions/whatsapp/src/shared.ts`): a broad
 * `channels.<id>` noop prefix with only named subtrees restarting the channel. An edit under
 * the noop prefix never reaches `plan.restartChannels`, so the ownership escalation cannot key
 * off the plan for it.
 */
const NOOP_CLASSIFIED_RELOAD: ChannelPlugin["reload"] = {
  configPrefixes: [`channels.${CHANNEL_ID}.enabled`],
  noopPrefixes: [`channels.${CHANNEL_ID}`],
};

type WatcherHandler = (value?: unknown) => void;

function createWatcherMock() {
  const handlers = new Map<string, WatcherHandler[]>();
  return {
    options: { usePolling: false },
    on(event: string, handler: WatcherHandler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
      return this;
    },
    emit(event: string, value?: unknown) {
      for (const handler of handlers.get(event) ?? []) {
        handler(value ?? "/tmp/openclaw.json");
      }
    },
    close: vi.fn(async () => {}),
  };
}

function makeSnapshot(config: OpenClawConfig, hash: string): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    includedPaths: [],
    exists: true,
    raw: "{}",
    parsed: {},
    sourceConfig: config,
    resolved: config,
    valid: true,
    runtimeConfig: config,
    config,
    issues: [],
    warnings: [],
    legacyIssues: [],
    hash,
  } as ConfigFileSnapshot;
}

describe("gateway config reload channel ownership escalation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    configAuditMocks.append.mockReset();
    configAuditMocks.readSnapshot.mockReset().mockReturnValue(null);
    configAuditMocks.readLatestSnapshot.mockReset().mockReturnValue(null);
    configAuditMocks.upsertSnapshot.mockReset();
    manifestMocks.registry = makeClaimantRegistry();
    manifestMocks.resolve = undefined;
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function startReloader(params: {
    initialConfig: OpenClawConfig;
    /** Materializes both authored configs onto one effective config, as auto-enable does. */
    materializedConfig?: OpenClawConfig;
    /** Like `materializedConfig`, but derived from each authored source as auto-enable is. */
    materializeConfig?: (sourceConfig: OpenClawConfig) => OpenClawConfig;
    nextConfig: OpenClawConfig;
    staleRegistryOwnerPluginId: string;
    reloadedRegistryOwnerPluginId: string;
    channelReload?: ChannelPlugin["reload"];
  }) {
    setActivePluginRegistry(
      makeChannelRuntimeRegistry(params.staleRegistryOwnerPluginId, params.channelReload),
    );

    const startedOwners: Array<string | undefined> = [];
    const startChannel = vi.fn(async (channel: ChannelKind) => {
      const registry = requireActivePluginChannelRegistry();
      const setup = registry.channelSetups.find(
        (entry) => (entry.plugin as ChannelPlugin).id === channel,
      );
      startedOwners.push(setup?.pluginId);
    });
    const stopChannel = vi.fn(async () => {});
    const reloadPlugins = vi.fn(async () => {
      // The real handler replaces the active registry with the generation activation builds from
      // the accepted config; here that generation registers the replacement owner.
      setActivePluginRegistry(
        makeChannelRuntimeRegistry(params.reloadedRegistryOwnerPluginId, params.channelReload),
      );
    });
    const handlerParams = {
      startChannel,
      stopChannel,
      logChannels: { info: vi.fn(), error: vi.fn() },
    } as unknown as GatewayReloadHandlerParams;

    const onHotReload = vi.fn(async (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => {
      // Mirror the real hot reload handler's ordering: the plugin registry is replaced before the
      // planned channel restarts run, so the restart registers from the new generation.
      if (plan.reloadPlugins) {
        await reloadPlugins();
      }
      await restartGatewayChannels({
        params: handlerParams,
        plan,
        nextConfig,
        channelsToRestart: new Set(plan.restartChannels),
        restartChannelAccounts: plan.restartChannelAccounts ?? new Map(),
        activePluginChannelsAfterReload: plan.reloadPlugins
          ? new Set<ChannelKind>([CHANNEL_ID])
          : null,
        channelsStoppedBeforePluginReload: new Set(),
        accountsStoppedBeforePluginReload: new Map(),
        shouldSkipChannelRestart: false,
        skipChannelRestartLogMessage: "",
        pluginReloadAborted: false,
        isLifecycleReloadAborted: () => false,
        getChannelAutostartSuppression: () => null,
        channelReloadTargets: () => new Set(plan.restartChannels),
        logSuppressedChannelRestart: () => {},
        scheduleRecoveryRestart: () => {},
      });
    });

    let nextSnapshot = makeSnapshot(params.nextConfig, "next-hash");
    const onConfigCandidateCommitted = vi.fn();
    const onNoopConfigCommit = vi.fn(async () => {});
    const watcher = createWatcherMock();
    vi.spyOn(chokidar, "watch").mockReturnValue(watcher as unknown as never);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const onRestart = vi.fn((_plan: GatewayReloadPlan, _nextConfig: OpenClawConfig) => {});
    const reloader = startGatewayConfigReloader({
      testDebounceMs: 0,
      initialConfig: params.initialConfig,
      ...(params.materializedConfig
        ? {
            prepareConfigCandidate: () => ({
              runtimeConfig: params.materializedConfig as OpenClawConfig,
              compareConfig: params.materializedConfig as OpenClawConfig,
            }),
          }
        : {}),
      ...(params.materializeConfig
        ? {
            prepareConfigCandidate: ({ sourceConfig }: { sourceConfig: OpenClawConfig }) => {
              const prepared = params.materializeConfig!(sourceConfig);
              return { runtimeConfig: prepared, compareConfig: prepared };
            },
          }
        : {}),
      initialSnapshotRawHash: "initial-hash",
      initialAuthoredConfig: params.initialConfig,
      initialSnapshotValid: true,
      initialSnapshotIssues: [],
      readSnapshot: vi.fn(async () => nextSnapshot),
      initialPluginInstallRecords: {},
      readPluginInstallRecords: async () => ({}),
      onNoopConfigCommit,
      onConfigCandidateCommitted,
      onHotReload,
      onRestart,
      log,
      watchPath: "/tmp/openclaw.json",
    });

    return {
      log,
      onConfigCandidateCommitted,
      onHotReload,
      onNoopConfigCommit,
      onRestart,
      reloadPlugins,
      reloader,
      setNextSnapshot: (config: OpenClawConfig, hash: string) => {
        nextSnapshot = makeSnapshot(config, hash);
      },
      startChannel,
      startedOwners,
      stopChannel,
      watcher,
    };
  }

  it("rebuilds the plugin registry before restart when a channels.<id> edit moves ownership", async () => {
    const harness = startReloader({
      initialConfig: {
        gateway: { reload: {} },
        channels: { [CHANNEL_ID]: { enabled: false } },
      } as OpenClawConfig,
      nextConfig: {
        gateway: { reload: {} },
        channels: { [CHANNEL_ID]: { enabled: false, token: "abc" } },
      } as OpenClawConfig,
      staleRegistryOwnerPluginId: LEGACY_PLUGIN_ID,
      reloadedRegistryOwnerPluginId: REPLACEMENT_PLUGIN_ID,
    });
    try {
      harness.watcher.emit("change");
      await vi.runAllTimersAsync();

      expect(harness.onRestart).not.toHaveBeenCalled();
      expect(harness.onHotReload).toHaveBeenCalledTimes(1);
      const plan = harness.onHotReload.mock.calls[0]?.[0];
      expect(plan?.restartChannels).toEqual(new Set([CHANNEL_ID]));
      expect(plan?.reloadPlugins).toBe(true);
      expect(plan?.disposeMcpRuntimes).toBe(true);
      expect(harness.log.info).toHaveBeenCalledWith(
        `channel ownership moved (${CHANNEL_ID}: ${LEGACY_PLUGIN_ID} -> ${REPLACEMENT_PLUGIN_ID}); reloading plugins`,
      );

      // The regression this pins: the restarted channel must register from the replaced registry
      // generation, not start the displaced owner from the previous one.
      expect(harness.reloadPlugins).toHaveBeenCalledTimes(1);
      expect(harness.startChannel).toHaveBeenCalledWith(CHANNEL_ID);
      expect(
        harness.reloadPlugins.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      ).toBeLessThan(harness.startChannel.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY);
      expect(harness.startedOwners).toEqual([REPLACEMENT_PLUGIN_ID]);
    } finally {
      await harness.reloader.stop();
    }
  });

  it("escalates when a catalog-declared replacement moves ownership with no schema descriptor", async () => {
    manifestMocks.registry = makeDescriptorlessClaimantRegistry();
    const harness = startReloader({
      initialConfig: {
        gateway: { reload: {} },
        channels: { [CHANNEL_ID]: { enabled: false } },
      } as OpenClawConfig,
      nextConfig: {
        gateway: { reload: {} },
        channels: { [CHANNEL_ID]: { enabled: false, token: "abc" } },
      } as OpenClawConfig,
      staleRegistryOwnerPluginId: LEGACY_PLUGIN_ID,
      reloadedRegistryOwnerPluginId: REPLACEMENT_PLUGIN_ID,
    });
    try {
      harness.watcher.emit("change");
      await vi.runAllTimersAsync();

      expect(harness.onRestart).not.toHaveBeenCalled();
      expect(harness.onHotReload).toHaveBeenCalledTimes(1);
      const plan = harness.onHotReload.mock.calls[0]?.[0];
      expect(plan?.restartChannels).toEqual(new Set([CHANNEL_ID]));
      expect(plan?.reloadPlugins).toBe(true);
      expect(plan?.disposeMcpRuntimes).toBe(true);
      expect(harness.log.info).toHaveBeenCalledWith(
        `channel ownership moved (${CHANNEL_ID}: ${LEGACY_PLUGIN_ID} -> ${REPLACEMENT_PLUGIN_ID}); reloading plugins`,
      );
      expect(harness.reloadPlugins).toHaveBeenCalledTimes(1);
      expect(harness.startedOwners).toEqual([REPLACEMENT_PLUGIN_ID]);
    } finally {
      await harness.reloader.stop();
    }
  });

  it("escalates when a source-only commit already recorded the ownership move", async () => {
    // Transaction 1 lands the ownership-moving `channels.<id>` edit with reload mode off, so the
    // runtime skips it: the source baseline advances while the runtime config and the active
    // plugin registry keep the displaced owner. Transaction 2 turns reload back on with the edit
    // still present. Its plan restarts the channel, so the escalation must compare against the
    // runtime-applied source baseline; the plain source baseline already selects the replacement
    // on both sides and would hide the move.
    const harness = startReloader({
      initialConfig: {
        gateway: { reload: {} },
        channels: { [CHANNEL_ID]: { enabled: false } },
      } as OpenClawConfig,
      nextConfig: {
        gateway: { reload: { mode: "off" } },
        channels: { [CHANNEL_ID]: { enabled: false, token: "abc" } },
      } as OpenClawConfig,
      staleRegistryOwnerPluginId: LEGACY_PLUGIN_ID,
      reloadedRegistryOwnerPluginId: REPLACEMENT_PLUGIN_ID,
    });
    try {
      harness.watcher.emit("change");
      await vi.runAllTimersAsync();

      expect(harness.log.info).toHaveBeenCalledWith(
        "config reload disabled (gateway.reload.mode=off)",
      );
      expect(harness.onHotReload).not.toHaveBeenCalled();
      expect(harness.startChannel).not.toHaveBeenCalled();
      // Reload-off discards the plan wholesale, so the escalation gate must not pay the
      // ownership comparison for it — nor log a plugin reload that never happens. The move is
      // still caught: transaction 2 compares against the runtime-applied baseline below.
      expect(harness.log.info).not.toHaveBeenCalledWith(
        expect.stringContaining("channel ownership moved"),
      );
      harness.log.info.mockClear();

      harness.setNextSnapshot(
        {
          gateway: { reload: {} },
          channels: { [CHANNEL_ID]: { enabled: false, token: "abc" } },
        } as OpenClawConfig,
        "reenabled-hash",
      );
      harness.watcher.emit("change");
      await vi.runAllTimersAsync();

      expect(harness.onRestart).not.toHaveBeenCalled();
      expect(harness.onHotReload).toHaveBeenCalledTimes(1);
      const plan = harness.onHotReload.mock.calls[0]?.[0];
      expect(plan?.restartChannels).toEqual(new Set([CHANNEL_ID]));
      expect(plan?.reloadPlugins).toBe(true);
      expect(plan?.disposeMcpRuntimes).toBe(true);
      expect(harness.log.info).toHaveBeenCalledWith(
        `channel ownership moved (${CHANNEL_ID}: ${LEGACY_PLUGIN_ID} -> ${REPLACEMENT_PLUGIN_ID}); reloading plugins`,
      );
      expect(harness.reloadPlugins).toHaveBeenCalledTimes(1);
      expect(harness.startedOwners).toEqual([REPLACEMENT_PLUGIN_ID]);
    } finally {
      await harness.reloader.stop();
    }
  });

  // Codex review P1 on #123209: an authored edit can move the selected owner while auto-enable
  // leaves the effective config identical. Here the operator writes explicitly what auto-enable had
  // already materialized, so both authored configs prepare onto one effective config and the
  // reload diff is empty, while the source gains an explicit selection that sets the replacement's
  // declaration aside. The zero-changedPaths branch still publishes the source snapshot, so
  // validation and the Control UI moved off the replacement while the active registry kept serving
  // it.
  it("escalates when an ownership move leaves the effective config unchanged", async () => {
    const authoredConfig = {
      gateway: { reload: {} },
      channels: { [CHANNEL_ID]: { token: "abc" } },
    } as unknown as OpenClawConfig;
    const selectedConfig = {
      gateway: { reload: {} },
      channels: { [CHANNEL_ID]: { token: "abc" } },
      plugins: { entries: { [DISPLACED_PLUGIN_ID]: { enabled: true } } },
    } as unknown as OpenClawConfig;
    const harness = startReloader({
      initialConfig: authoredConfig,
      materializedConfig: selectedConfig,
      nextConfig: selectedConfig,
      staleRegistryOwnerPluginId: REPLACEMENT_PLUGIN_ID,
      reloadedRegistryOwnerPluginId: DISPLACED_PLUGIN_ID,
    });
    try {
      harness.watcher.emit("change");
      await vi.runAllTimersAsync();

      expect(harness.onRestart).not.toHaveBeenCalled();
      expect(harness.onHotReload).toHaveBeenCalledTimes(1);
      const plan = harness.onHotReload.mock.calls[0]?.[0];
      expect(plan?.restartChannels.size).toBe(0);
      expect(plan?.reloadPlugins).toBe(true);
      expect(plan?.disposeMcpRuntimes).toBe(true);
      expect(harness.reloadPlugins).toHaveBeenCalledTimes(1);
      // Regression on #128904: the transaction's `changedPaths` is the effective diff, empty
      // by construction here, so the commit notification — the single point the `config.changed`
      // broadcast hangs off — never fired and subscribed config clients kept the previous owner's
      // config and schema until an unrelated edit landed.
      expect(harness.onConfigCandidateCommitted).toHaveBeenCalledTimes(1);
      expect(harness.onConfigCandidateCommitted.mock.calls[0]?.[0]).toMatchObject({
        path: "/tmp/openclaw.json",
        persistedHash: "next-hash",
        // `diffConfigPaths` reports the added subtree root, the same granularity every other
        // `changedPaths` on this transaction uses.
        changedPaths: ["plugins"],
      });
    } finally {
      await harness.reloader.stop();
    }
  });

  it("keeps the cheap channel restart plan for an ownership-neutral channels.<id> edit", async () => {
    const harness = startReloader({
      initialConfig: {
        gateway: { reload: {} },
        channels: { [CHANNEL_ID]: { token: "a" } },
      } as OpenClawConfig,
      nextConfig: {
        gateway: { reload: {} },
        channels: { [CHANNEL_ID]: { token: "b" } },
      } as OpenClawConfig,
      staleRegistryOwnerPluginId: REPLACEMENT_PLUGIN_ID,
      reloadedRegistryOwnerPluginId: REPLACEMENT_PLUGIN_ID,
    });
    try {
      harness.watcher.emit("change");
      await vi.runAllTimersAsync();

      expect(harness.onRestart).not.toHaveBeenCalled();
      expect(harness.onHotReload).toHaveBeenCalledTimes(1);
      const plan = harness.onHotReload.mock.calls[0]?.[0];
      expect(plan?.restartChannels).toEqual(new Set([CHANNEL_ID]));
      expect(plan?.reloadPlugins).toBe(false);
      expect(plan?.disposeMcpRuntimes).toBe(false);
      expect(harness.reloadPlugins).not.toHaveBeenCalled();
      expect(harness.startedOwners).toEqual([REPLACEMENT_PLUGIN_ID]);
      expect(harness.log.info).not.toHaveBeenCalledWith(
        expect.stringContaining("channel ownership moved"),
      );
    } finally {
      await harness.reloader.stop();
    }
  });

  // Codex review P2: the escalation used to key off the plan, so it only ran when the plan
  // already restarted the channel. Under WhatsApp's shipped reload shape a `channels.<id>` edit
  // beneath the broad noop prefix is classified a reload no-op, yet it still makes the channel
  // meaningfully configured and moves the owner — the schema snapshot switched owners while the
  // active registry kept its old `cededChannelIds` and served the previous claimant.
  it("escalates when a reload-noop-classified channels.<id> edit moves ownership", async () => {
    const harness = startReloader({
      initialConfig: {
        gateway: { reload: {} },
        channels: { [CHANNEL_ID]: { enabled: false } },
      } as OpenClawConfig,
      nextConfig: {
        gateway: { reload: {} },
        channels: { [CHANNEL_ID]: { enabled: false, token: "abc" } },
      } as OpenClawConfig,
      staleRegistryOwnerPluginId: LEGACY_PLUGIN_ID,
      reloadedRegistryOwnerPluginId: REPLACEMENT_PLUGIN_ID,
      channelReload: NOOP_CLASSIFIED_RELOAD,
    });
    try {
      harness.watcher.emit("change");
      await vi.runAllTimersAsync();

      expect(harness.onRestart).not.toHaveBeenCalled();
      expect(harness.onHotReload).toHaveBeenCalledTimes(1);
      const plan = harness.onHotReload.mock.calls[0]?.[0];
      // The no-op classification keeps its channel-restart economy; only the registry reloads.
      expect(plan?.restartChannels.size).toBe(0);
      expect(plan?.reloadPlugins).toBe(true);
      expect(plan?.disposeMcpRuntimes).toBe(true);
      expect(harness.log.info).toHaveBeenCalledWith(
        `channel ownership moved (${CHANNEL_ID}: ${LEGACY_PLUGIN_ID} -> ${REPLACEMENT_PLUGIN_ID}); reloading plugins`,
      );
      expect(harness.reloadPlugins).toHaveBeenCalledTimes(1);
    } finally {
      await harness.reloader.stop();
    }
  });

  // The notification fallback intentionally follows the authored surface the ownership comparison
  // reads, not its result: an ownership-neutral plugins edit with no effective diff still tells
  // config clients that the persisted source changed.
  it("notifies an ownership-neutral authored plugins edit with unchanged effective config", async () => {
    const authoredConfig = {
      gateway: { reload: {} },
      channels: { [CHANNEL_ID]: { token: "abc" } },
    } as unknown as OpenClawConfig;
    const materializedConfig = {
      ...authoredConfig,
      plugins: { entries: { [REPLACEMENT_PLUGIN_ID]: { enabled: true } } },
    } as unknown as OpenClawConfig;
    const harness = startReloader({
      initialConfig: authoredConfig,
      materializedConfig,
      nextConfig: materializedConfig,
      staleRegistryOwnerPluginId: REPLACEMENT_PLUGIN_ID,
      reloadedRegistryOwnerPluginId: REPLACEMENT_PLUGIN_ID,
    });
    try {
      harness.watcher.emit("change");
      await vi.runAllTimersAsync();

      expect(harness.onRestart).not.toHaveBeenCalled();
      // This binds the effective-diff-empty branch; the ordinary nonempty-diff/noop-plan path calls
      // `onNoopConfigCommit` instead.
      expect(harness.onNoopConfigCommit).not.toHaveBeenCalled();
      expect(harness.onHotReload).not.toHaveBeenCalled();
      expect(harness.reloadPlugins).not.toHaveBeenCalled();
      expect(harness.startChannel).not.toHaveBeenCalled();
      expect(harness.onConfigCandidateCommitted).toHaveBeenCalledTimes(1);
      expect(harness.onConfigCandidateCommitted.mock.calls[0]?.[0]).toEqual({
        path: "/tmp/openclaw.json",
        persistedHash: "next-hash",
        changedPaths: ["plugins"],
      });
      expect(harness.log.info).not.toHaveBeenCalledWith(
        expect.stringContaining("channel ownership moved"),
      );
    } finally {
      await harness.reloader.stop();
    }
  });

  // The trigger reads the authored edit, not the effective diff: here the operator writes
  // explicitly what auto-enable had already materialized — a source-only ownership move — in the
  // same write as an unrelated hot edit. The effective diff carries only the unrelated path, so
  // a changed-paths trigger would miss the move exactly like the plan-keyed one did.
  it("escalates a source-only ownership move landing beside an unrelated hot edit", async () => {
    const materializedPlugins = {
      entries: { [DISPLACED_PLUGIN_ID]: { enabled: true } },
    } as OpenClawConfig["plugins"];
    const harness = startReloader({
      initialConfig: {
        gateway: { reload: {} },
        channels: { [CHANNEL_ID]: { token: "abc" } },
      } as OpenClawConfig,
      materializeConfig: (sourceConfig) =>
        ({ ...sourceConfig, plugins: materializedPlugins }) as OpenClawConfig,
      nextConfig: {
        gateway: { reload: {} },
        channels: { [CHANNEL_ID]: { token: "abc" } },
        plugins: { entries: { [DISPLACED_PLUGIN_ID]: { enabled: true } } },
        cron: { enabled: true },
      } as unknown as OpenClawConfig,
      staleRegistryOwnerPluginId: REPLACEMENT_PLUGIN_ID,
      reloadedRegistryOwnerPluginId: DISPLACED_PLUGIN_ID,
    });
    try {
      harness.watcher.emit("change");
      await vi.runAllTimersAsync();

      expect(harness.onRestart).not.toHaveBeenCalled();
      expect(harness.onHotReload).toHaveBeenCalledTimes(1);
      const plan = harness.onHotReload.mock.calls[0]?.[0];
      expect(plan?.changedPaths).toEqual(["cron"]);
      expect(plan?.restartChannels.size).toBe(0);
      expect(plan?.reloadPlugins).toBe(true);
      expect(plan?.disposeMcpRuntimes).toBe(true);
      expect(harness.reloadPlugins).toHaveBeenCalledTimes(1);
    } finally {
      await harness.reloader.stop();
    }
  });

  // Codex review P2 round 2: workspace roots feed plugin discovery itself.
  // `resolveConfigWidePluginManifestRegistry` scans manifests per agent workspace dir, so an
  // `agents.entries.<id>.workspace` edit changes which claimants exist while touching no
  // `plugins.*` or `channels.*` path — past the source predicate, with no channel restart in the
  // plan. A plugin reload cannot honor the move either: `reloadAttachedGatewayPlugins` rebuilds
  // from the process-stable startup `pluginWorkspaceDir`, so the only lever that re-resolves
  // discovery from the new root is a gateway restart.
  function installWorkspaceScopedResolver() {
    manifestMocks.resolve = ({ config }) => {
      const [root] = listAgentWorkspaceDirs(config as OpenClawConfig);
      return {
        plugins: [
          makeClaimantRecord({
            id: root?.endsWith("claw-ws-b") ? REPLACEMENT_PLUGIN_ID : DISPLACED_PLUGIN_ID,
          }),
        ],
        diagnostics: [],
      };
    };
  }

  function makeWorkspaceConfig(workspace: string, plugins?: OpenClawConfig["plugins"]) {
    return {
      gateway: { reload: {} },
      agents: { entries: { main: { workspace } } },
      channels: { [CHANNEL_ID]: { token: "abc" } },
      ...(plugins ? { plugins } : {}),
    } as unknown as OpenClawConfig;
  }

  it("restarts the gateway when a moved agent workspace root moves channel ownership", async () => {
    installWorkspaceScopedResolver();
    const harness = startReloader({
      initialConfig: makeWorkspaceConfig("/tmp/claw-ws-a"),
      nextConfig: makeWorkspaceConfig("/tmp/claw-ws-b"),
      staleRegistryOwnerPluginId: DISPLACED_PLUGIN_ID,
      reloadedRegistryOwnerPluginId: REPLACEMENT_PLUGIN_ID,
    });
    try {
      harness.watcher.emit("change");
      await vi.runAllTimersAsync();

      // Not a plugin reload: it would rebuild from the startup workspace root and claim success.
      expect(harness.onHotReload).not.toHaveBeenCalled();
      expect(harness.reloadPlugins).not.toHaveBeenCalled();
      expect(harness.onRestart).toHaveBeenCalledTimes(1);
      const plan = harness.onRestart.mock.calls[0]?.[0];
      expect(plan?.restartGateway).toBe(true);
      expect(plan?.restartReasons).toContain(
        `channel ownership moved with an agent workspace root (${CHANNEL_ID}: ${DISPLACED_PLUGIN_ID} -> ${REPLACEMENT_PLUGIN_ID})`,
      );
      expect(harness.log.info).toHaveBeenCalledWith(
        `channel ownership moved with an agent workspace root (${CHANNEL_ID}: ${DISPLACED_PLUGIN_ID} -> ${REPLACEMENT_PLUGIN_ID}); restarting gateway`,
      );
    } finally {
      await harness.reloader.stop();
    }
  });

  // The property the moved-roots trigger must not spend: when both roots discover the same
  // claimants the owners hold still, and the workspace edit keeps its cheap hot plan instead of
  // bouncing the gateway.
  it("keeps the hot plan when a moved workspace root does not move ownership", async () => {
    const harness = startReloader({
      initialConfig: makeWorkspaceConfig("/tmp/claw-ws-a"),
      nextConfig: makeWorkspaceConfig("/tmp/claw-ws-b"),
      staleRegistryOwnerPluginId: REPLACEMENT_PLUGIN_ID,
      reloadedRegistryOwnerPluginId: REPLACEMENT_PLUGIN_ID,
    });
    try {
      harness.watcher.emit("change");
      await vi.runAllTimersAsync();

      expect(harness.onRestart).not.toHaveBeenCalled();
      expect(harness.onHotReload).toHaveBeenCalledTimes(1);
      const plan = harness.onHotReload.mock.calls[0]?.[0];
      expect(plan?.restartGateway).toBe(false);
      expect(plan?.reloadPlugins).toBe(false);
      expect(harness.reloadPlugins).not.toHaveBeenCalled();
      expect(harness.log.info).not.toHaveBeenCalledWith(
        expect.stringContaining("channel ownership moved"),
      );
    } finally {
      await harness.reloader.stop();
    }
  });

  // A compound edit can already carry `plan.reloadPlugins` (any `plugins.*` path) in the same
  // write that moves a workspace root. The reload would rebuild from the stale startup root, so
  // the moved-roots trigger must bypass the reload-planned guard and still restart.
  it("restarts instead of reloading when a plugins edit lands beside a moved workspace root", async () => {
    installWorkspaceScopedResolver();
    const harness = startReloader({
      initialConfig: makeWorkspaceConfig("/tmp/claw-ws-a"),
      nextConfig: makeWorkspaceConfig("/tmp/claw-ws-b", {
        entries: { [REPLACEMENT_PLUGIN_ID]: { enabled: true } },
      } as OpenClawConfig["plugins"]),
      staleRegistryOwnerPluginId: DISPLACED_PLUGIN_ID,
      reloadedRegistryOwnerPluginId: REPLACEMENT_PLUGIN_ID,
    });
    try {
      harness.watcher.emit("change");
      await vi.runAllTimersAsync();

      expect(harness.onHotReload).not.toHaveBeenCalled();
      expect(harness.reloadPlugins).not.toHaveBeenCalled();
      expect(harness.onRestart).toHaveBeenCalledTimes(1);
      const plan = harness.onRestart.mock.calls[0]?.[0];
      expect(plan?.restartGateway).toBe(true);
      expect(plan?.restartReasons).toContain(
        `channel ownership moved with an agent workspace root (${CHANNEL_ID}: ${DISPLACED_PLUGIN_ID} -> ${REPLACEMENT_PLUGIN_ID})`,
      );
    } finally {
      await harness.reloader.stop();
    }
  });
});
