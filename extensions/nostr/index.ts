import type { MoltbotPluginApi, MoltbotConfig } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { nostrPlugin } from "./src/channel.js";
import { setNostrRuntime, getNostrRuntime } from "./src/runtime.js";
import { createNostrProfileHttpHandler } from "./src/nostr-profile-http.js";
import { createNostrBunkerHttpHandler } from "./src/nostr-bunker-http.js";
import { createNostrAgentTools } from "./src/agent-tools.js";
import { resolveNostrAccount } from "./src/types.js";
import type { NostrProfile, BunkerAccountConfig } from "./src/config-schema.js";

const plugin = {
  id: "nostr",
  name: "Nostr",
  description: "Nostr DM channel plugin via NIP-04",
  configSchema: emptyPluginConfigSchema(),
  register(api: MoltbotPluginApi) {
    setNostrRuntime(api.runtime);
    api.registerChannel({ plugin: nostrPlugin });

    // Register HTTP handler for profile management
    const httpHandler = createNostrProfileHttpHandler({
      getConfigProfile: (accountId: string) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig() as MoltbotConfig;
        const account = resolveNostrAccount({ cfg, accountId });
        return account.profile;
      },
      updateConfigProfile: async (accountId: string, profile: NostrProfile) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig() as MoltbotConfig;

        // Build the config patch for channels.nostr.profile
        const channels = (cfg.channels ?? {}) as Record<string, unknown>;
        const nostrConfig = (channels.nostr ?? {}) as Record<string, unknown>;

        const updatedNostrConfig = {
          ...nostrConfig,
          profile,
        };

        const updatedChannels = {
          ...channels,
          nostr: updatedNostrConfig,
        };

        await runtime.config.writeConfigFile({
          ...cfg,
          channels: updatedChannels,
        });
      },
      getAccountInfo: (accountId: string) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig() as MoltbotConfig;
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

    api.registerHttpHandler(httpHandler);

    // Register HTTP handler for bunker management
    const bunkerHttpHandler = createNostrBunkerHttpHandler({
      getBunkerAccounts: (accountId: string) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig() as ClawdbotConfig;
        const account = resolveNostrAccount({ cfg, accountId });
        return account.bunkerAccounts;
      },
      updateBunkerAccount: async (
        accountId: string,
        bunkerIndex: number,
        update: Partial<BunkerAccountConfig>
      ) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig() as ClawdbotConfig;
        const account = resolveNostrAccount({ cfg, accountId });

        // Update the specific bunker account
        const bunkerAccounts = [...account.bunkerAccounts];
        while (bunkerAccounts.length <= bunkerIndex) {
          bunkerAccounts.push({ bunkerUrl: "" });
        }
        bunkerAccounts[bunkerIndex] = {
          ...bunkerAccounts[bunkerIndex],
          ...update,
        };

        // Write back to config
        const channels = (cfg.channels ?? {}) as Record<string, unknown>;
        const nostrConfig = (channels.nostr ?? {}) as Record<string, unknown>;
        await runtime.config.writeConfigFile({
          ...cfg,
          channels: {
            ...channels,
            nostr: {
              ...nostrConfig,
              bunkerAccounts,
            },
          },
        });
      },
      clearConfigBunkerUrl: async (accountId: string, bunkerIndex: number) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig() as ClawdbotConfig;
        const account = resolveNostrAccount({ cfg, accountId });

        // Clear the specific bunker account
        const bunkerAccounts = [...account.bunkerAccounts];
        if (bunkerIndex < bunkerAccounts.length) {
          bunkerAccounts[bunkerIndex] = {
            ...bunkerAccounts[bunkerIndex],
            bunkerUrl: "",
            userPubkey: undefined,
            connectedAt: undefined,
          };
        }

        // Write back to config
        const channels = (cfg.channels ?? {}) as Record<string, unknown>;
        const nostrConfig = (channels.nostr ?? {}) as Record<string, unknown>;
        await runtime.config.writeConfigFile({
          ...cfg,
          channels: {
            ...channels,
            nostr: {
              ...nostrConfig,
              bunkerAccounts,
            },
          },
        });
      },
      log: api.logger,
    });

    api.registerHttpHandler(bunkerHttpHandler);

    // Register agent tools for bunker operations
    for (const tool of createNostrAgentTools()) {
      api.registerTool(tool);
    }
  },
};

export default plugin;
