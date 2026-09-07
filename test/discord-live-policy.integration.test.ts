import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../src/channels/plugins/types.public.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { diffGatewayReloadPaths } from "../src/gateway/config-diff.js";
import {
  buildGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "../src/gateway/config-reload-plan.js";
import { createLazyGatewayCronState } from "../src/gateway/server-cron-lazy.js";
import type { GatewayReloadHandlerParams } from "../src/gateway/server-reload-contracts.js";
import { createGatewayReloadHandlers } from "../src/gateway/server-reload-hot.js";
import type { fanInChannelIngressLifecycles } from "../src/plugin-sdk/channel-ingress-runtime.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../src/plugins/runtime.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../src/process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import { loadBundledPluginFacade } from "../src/test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { createTempDirTracker } from "./helpers/temp-dir.js";

const tempDirs = createTempDirTracker();
let registrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;

beforeEach(() => {
  registrySnapshot = captureActivePluginRegistrySnapshot();
  const stateDir = tempDirs.make("discord-live-policy-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_SKIP_CHANNELS", undefined);
  vi.stubEnv("OPENCLAW_SKIP_PROVIDERS", undefined);
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  restoreActivePluginRegistrySnapshot(registrySnapshot);
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

function waitForFast(callback: () => unknown) {
  return vi.waitFor(callback, { interval: 1 });
}

describe("Discord admission through Gateway policy publication", () => {
  it("admits newly allowed Discord messages during active work without restarting", async () => {
    // Describe the public calls this fixture consumes without importing plugin implementation types.
    const discord = await loadBundledPluginFacade<{
      createDiscordMessageHandler: (options: ReturnType<typeof createHandlerOptions>) => {
        (raw: ReturnType<typeof createRawMessage>, transport: typeof client): Promise<void>;
        deactivate: () => Promise<void>;
      };
      createNoopThreadBindingManager: (accountId: string) => object;
    }>({ pluginId: "discord", artifactBasename: "runtime-api.js" });
    const { discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
      pluginId: "discord",
      artifactBasename: "api.js",
    });
    const cfg: OpenClawConfig = {
      channels: { discord: { token: "synthetic-token", groupPolicy: "allowlist", guilds: {} } },
      messages: { inbound: { debounceMs: 0 } },
    };
    const registry = createTestRegistry([
      { pluginId: "discord", plugin: discordPlugin, source: "synthetic" },
    ]);
    setActivePluginRegistry(registry);
    setRuntimeConfigSnapshot(cfg, cfg);
    let channelId = "456";
    let pendingChannelLookup: Promise<void> | undefined;
    let channelLookupStarted = false;
    const guildId = "123";
    const userId = "789";
    // The synthetic transport supplies only metadata lookups; preflight stays real.
    const client = {
      fetchChannel: async () => {
        channelLookupStarted = true;
        await pendingChannelLookup;
        return { id: channelId, type: 0, name: "synthetic" };
      },
      fetchGuild: async () => null,
    };
    const admitted: string[] = [];
    const abort = new AbortController();
    const createTransportEvent = (raw: ReturnType<typeof createRawMessage>) => ({
      author: raw.author,
      guild_id: guildId,
      guild: { id: guildId, name: "synthetic" },
      channel_id: channelId,
      message: {
        ...raw,
        channelId,
        mentionedUsers: [],
        mentionedRoles: [],
        mentionedEveryone: false,
      },
    });
    const createHandlerOptions = (threadBindings: object) => ({
      client,
      cfg,
      discordConfig: cfg.channels?.discord,
      accountId: "default",
      token: "synthetic-token",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: (code: number) => {
          throw new Error(`unexpected exit ${code}`);
        },
      },
      botUserId: "999",
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 1_000,
      textLimit: 2_000,
      replyToMode: "off",
      dmEnabled: true,
      dmPolicy: "pairing",
      groupDmEnabled: false,
      guildEntries: {},
      threadBindings,
      abortSignal: abort.signal,
      testing: {
        processDiscordMessage: async ({ message }: { message: { id: string } }) => {
          admitted.push(message.id);
        },
        createIngressMonitor: ({
          dispatch,
        }: {
          dispatch: (
            event: ReturnType<typeof createTransportEvent>,
            lifecycle: NonNullable<Parameters<typeof fanInChannelIngressLifecycles>[0][number]>,
          ) => Promise<unknown>;
        }) => ({
          start() {},
          async stop() {},
          async accept(raw: ReturnType<typeof createRawMessage>) {
            await dispatch(createTransportEvent(raw), {
              abortSignal: abort.signal,
              onAdopted() {},
              onDeferred() {},
              onAdoptionFinalizing() {},
              onAbandoned() {},
            });
          },
        }),
      },
    });
    const createRawMessage = (id: string) => ({
      id,
      channel_id: channelId,
      content: "hello",
      author: {
        id: userId,
        username: "synthetic",
        discriminator: "0",
        avatar: null,
        global_name: null,
      },
      attachments: [],
      embeds: [],
      mentions: [],
      mention_roles: [],
      components: [],
      mention_everyone: false,
      timestamp: "2026-09-06T00:00:00.000Z",
      edited_timestamp: null,
      type: 0,
      tts: false,
      pinned: false,
    });
    const handler = discord.createDiscordMessageHandler(
      createHandlerOptions(discord.createNoopThreadBindingManager("default")),
    );
    const send = (id: string) => handler(createRawMessage(id), client);
    const startChannel = vi.fn(async () => new Map());
    const stopChannel = vi.fn(async () => {});
    let state: ReturnType<GatewayReloadHandlerParams["getState"]> = {
      hooksConfig: null,
      hookClientIpConfig: { allowRealIpFallback: false },
      heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() },
      cronState: createLazyGatewayCronState({ cfg, deps: {}, broadcast: vi.fn() }),
    };
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {},
      broadcast: vi.fn(),
      getPluginRegistry: () => registry,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      startChannel,
      stopChannel,
      releaseChannelRouteHandoffs: vi.fn(),
      pruneInactiveChannelAccountState: vi.fn(),
      reloadPlugins: async () => {
        throw new Error("policy edit must not reload plugins");
      },
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      cronReconciliation: { arm: () => ({ complete: async () => {} }), invalidate: vi.fn() },
    });
    let pendingReload: Promise<unknown> | undefined;
    let committed = cfg;
    const apply = async (next: OpenClawConfig) => {
      const paths = diffGatewayReloadPaths(committed, next, listConfigReloadRefinementPrefixes());
      const plan = buildGatewayReloadPlan(paths, {
        previousConfig: committed,
        candidateConfig: next,
      });
      pendingReload = applyHotReload(plan, next, {
        sourceConfig: next,
        isCurrent: () => true,
        publish: async (commit) => {
          setRuntimeConfigSnapshot(next, next);
          await commit();
          committed = next;
        },
      });
      await waitForFast(() =>
        expect(committed, "policy-only publication must not wait for the active turn").toBe(next),
      );
      await pendingReload;
    };
    const activeTurn = tryBeginGatewayRootWorkAdmission();
    expect(activeTurn).not.toBeNull();
    try {
      await send("before-policy");
      expect(admitted).toEqual([]);
      await apply({
        ...cfg,
        channels: {
          discord: {
            ...cfg.channels?.discord,
            guilds: {
              [guildId]: { users: [userId], requireMention: false },
            },
          },
        },
      });
      await send("newly-allowed");
      await waitForFast(() => expect(admitted).toEqual(["newly-allowed"]));
      channelId = "457";
      channelLookupStarted = false;
      let releaseChannelLookup!: () => void;
      pendingChannelLookup = new Promise<void>((resolve) => {
        releaseChannelLookup = resolve;
      });
      const pendingMessage = send("pending-revocation");
      try {
        await waitForFast(() => expect(channelLookupStarted).toBe(true));
        await apply(cfg);
      } finally {
        releaseChannelLookup();
        await pendingMessage;
      }
      pendingChannelLookup = undefined;
      await send("after-revocation");
      expect(admitted).toEqual(["newly-allowed"]);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(startChannel).not.toHaveBeenCalled();
      expect(stopChannel).not.toHaveBeenCalled();
    } finally {
      activeTurn?.release();
      await pendingReload?.catch(() => {});
      abort.abort();
      await handler.deactivate();
      clearRuntimeConfigSnapshot();
    }
  });
});
