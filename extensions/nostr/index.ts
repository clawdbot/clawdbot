import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawConfig, PluginRuntime, ResolvedNostrAccount } from "./api.js";

function createNostrProfileHttpHandler() {
  return loadBundledEntryExportSync<
    (params: Record<string, unknown>) => (ctx: unknown) => Promise<void> | void
  >(import.meta.url, {
    specifier: "./api.js",
    exportName: "createNostrProfileHttpHandler",
  });
}

function getNostrRuntime() {
  return loadBundledEntryExportSync<() => PluginRuntime>(import.meta.url, {
    specifier: "./api.js",
    exportName: "getNostrRuntime",
  })();
}

function resolveNostrAccount(params: { cfg: unknown; accountId: string }) {
  return loadBundledEntryExportSync<
    (params: { cfg: unknown; accountId: string }) => ResolvedNostrAccount
  >(import.meta.url, {
    specifier: "./api.js",
    exportName: "resolveNostrAccount",
  })(params);
}

export default defineBundledChannelEntry({
  id: "nostr",
  name: "Nostr",
  description: "Nostr DM channel plugin via NIP-04",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "nostrPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setNostrRuntime",
  },
  registerFull(api) {
    const httpHandler = createNostrProfileHttpHandler()({
      getConfigProfile: (accountId: string) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.current() as OpenClawConfig;
        const account = resolveNostrAccount({ cfg, accountId });
        return account.profile;
      },
      updateConfigProfile: async (accountId: string, profile: unknown) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.current() as OpenClawConfig;

        const channels = (cfg.channels ?? {}) as Record<string, unknown>;
        const nostrConfig = (channels.nostr ?? {}) as Record<string, unknown>;

        await runtime.config.replaceConfigFile({
          nextConfig: {
            ...cfg,
            channels: {
              ...channels,
              nostr: {
                ...nostrConfig,
                profile,
              },
            },
          },
          afterWrite: { mode: "auto" },
        });
      },
      getAccountInfo: (accountId: string) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.current() as OpenClawConfig;
        const account = resolveNostrAccount({ cfg, accountId });
        if (!account.configured || !account.publicKey) {
          return null;
        }
        return {
          pubkey: account.publicKey,
          relays: account.relays,
        };
      },
      log: api.logger,
    });

    api.registerHttpRoute({
      path: "/api/channels/nostr",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: httpHandler,
    });
  },
});
