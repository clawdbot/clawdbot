import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { initApiConfig } from "./api.js";
import { qqbotConfigAdapter, qqbotMeta, qqbotSetupAdapterShared } from "./channel-config-shared.js";
import { qqbotChannelConfigSchema } from "./config-schema.js";
import { DEFAULT_ACCOUNT_ID, resolveQQBotAccount } from "./config.js";
import { getQQBotRuntime } from "./runtime.js";
import { qqbotSetupWizard } from "./setup-surface.js";
// Re-export text helpers so existing consumers of channel.ts are unaffected.
// The canonical definition lives in text-utils.ts to avoid a circular
// dependency: channel.ts → (dynamic) gateway.ts → outbound-deliver.ts → channel.ts.
export { chunkText, TEXT_CHUNK_LIMIT } from "./text-utils.js";
import type { ResolvedQQBotAccount } from "./types.js";

type QQBotOutboundModule = typeof import("./outbound.js");

// Shared promise so concurrent multi-account startups serialize the dynamic
// import of the gateway module, avoiding an ESM circular-dependency race.
let _gatewayModulePromise: Promise<typeof import("./gateway.js")> | undefined;
let _outboundModulePromise: Promise<QQBotOutboundModule> | undefined;

function loadGatewayModule(): Promise<typeof import("./gateway.js")> {
  _gatewayModulePromise ??= import("./gateway.js");
  return _gatewayModulePromise;
}

function loadOutboundModule(): Promise<QQBotOutboundModule> {
  _outboundModulePromise ??= import("./outbound.js");
  return _outboundModulePromise;
}

export const qqbotPlugin: ChannelPlugin<ResolvedQQBotAccount> = {
  id: "qqbot",
  setupWizard: qqbotSetupWizard,
  meta: {
    ...qqbotMeta,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    /**
     * blockStreaming=true means the channel supports block streaming.
     * The framework collects streamed blocks and sends them through deliver().
     */
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.qqbot"] },
  configSchema: qqbotChannelConfigSchema,

  config: {
    ...qqbotConfigAdapter,
  },
  setup: {
    ...qqbotSetupAdapterShared,
  },
  messaging: {
    /** Normalize common QQ Bot target formats into the canonical qqbot:... form. */
    normalizeTarget: (target: string): string | undefined => {
      const id = target.replace(/^qqbot:/i, "");
      if (id.startsWith("c2c:") || id.startsWith("group:") || id.startsWith("channel:")) {
        return `qqbot:${id}`;
      }
      const openIdHexPattern = /^[0-9a-fA-F]{32}$/;
      if (openIdHexPattern.test(id)) {
        return `qqbot:c2c:${id}`;
      }
      const openIdUuidPattern =
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
      if (openIdUuidPattern.test(id)) {
        return `qqbot:c2c:${id}`;
      }

      return undefined;
    },
    targetResolver: {
      /** Return true when the id looks like a QQ Bot target. */
      looksLikeId: (id: string): boolean => {
        if (/^qqbot:(c2c|group|channel):/i.test(id)) {
          return true;
        }
        if (/^(c2c|group|channel):/i.test(id)) {
          return true;
        }
        if (/^[0-9a-fA-F]{32}$/.test(id)) {
          return true;
        }
        const openIdPattern =
          /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
        return openIdPattern.test(id);
      },
      hint: "QQ Bot target format: qqbot:c2c:openid (direct) or qqbot:group:groupid (group)",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getQQBotRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 5000,
    sendText: async ({ to, text, accountId, replyToId, cfg }) => {
      const account = resolveQQBotAccount(cfg, accountId);
      const { sendText } = await loadOutboundModule();
      initApiConfig(account.appId, { markdownSupport: account.markdownSupport });
      const result = await sendText({ to, text, accountId, replyToId, account });
      return {
        channel: "qqbot" as const,
        messageId: result.messageId ?? "",
        meta: result.error ? { error: result.error } : undefined,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId, cfg }) => {
      const account = resolveQQBotAccount(cfg, accountId);
      const { sendMedia } = await loadOutboundModule();
      initApiConfig(account.appId, { markdownSupport: account.markdownSupport });
      const result = await sendMedia({
        to,
        text: text ?? "",
        mediaUrl: mediaUrl ?? "",
        accountId,
        replyToId,
        account,
      });
      return {
        channel: "qqbot" as const,
        messageId: result.messageId ?? "",
        meta: result.error ? { error: result.error } : undefined,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account } = ctx;
      const { abortSignal, log, cfg } = ctx;
      // Serialize the dynamic import so concurrent multi-account startups
      // do not hit an ESM circular-dependency race where the gateway chunk's
      // transitive imports have not finished evaluating yet.
      const { startGateway } = await loadGatewayModule();

      log?.info(
        `[qqbot:${account.accountId}] Starting gateway — appId=${account.appId}, enabled=${account.enabled}, name=${account.name ?? "unnamed"}`,
      );

      await startGateway({
        account,
        abortSignal,
        cfg,
        log,
        onReady: () => {
          log?.info(`[qqbot:${account.accountId}] Gateway ready`);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
          });
        },
        onError: (error) => {
          log?.error(`[qqbot:${account.accountId}] Gateway error: ${error.message}`);
          ctx.setStatus({
            ...ctx.getStatus(),
            lastError: error.message,
          });
        },
      });
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const nextCfg = { ...cfg } as OpenClawConfig;
      const nextQQBot = cfg.channels?.qqbot ? { ...cfg.channels.qqbot } : undefined;
      let cleared = false;
      let changed = false;

      if (nextQQBot) {
        const qqbot = nextQQBot as Record<string, unknown>;
        if (accountId === DEFAULT_ACCOUNT_ID) {
          if (qqbot.clientSecret) {
            delete qqbot.clientSecret;
            cleared = true;
            changed = true;
          }
          if (qqbot.clientSecretFile) {
            delete qqbot.clientSecretFile;
            cleared = true;
            changed = true;
          }
        }
        const accounts = qqbot.accounts as Record<string, Record<string, unknown>> | undefined;
        if (accounts && accountId in accounts) {
          const entry = accounts[accountId] as Record<string, unknown> | undefined;
          if (entry && "clientSecret" in entry) {
            delete entry.clientSecret;
            cleared = true;
            changed = true;
          }
          if (entry && "clientSecretFile" in entry) {
            delete entry.clientSecretFile;
            cleared = true;
            changed = true;
          }
          if (entry && Object.keys(entry).length === 0) {
            delete accounts[accountId];
            changed = true;
          }
        }
      }

      if (changed && nextQQBot) {
        nextCfg.channels = { ...nextCfg.channels, qqbot: nextQQBot };
        const runtime = getQQBotRuntime();
        const configApi = runtime.config as {
          writeConfigFile: (cfg: OpenClawConfig) => Promise<void>;
        };
        await configApi.writeConfigFile(nextCfg);
      }

      const resolved = resolveQQBotAccount(changed ? nextCfg : cfg, accountId);
      const loggedOut = resolved.secretSource === "none";
      const envToken = Boolean(process.env.QQBOT_CLIENT_SECRET);

      return { ok: true, cleared, envToken, loggedOut };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.appId && account?.clientSecret),
      tokenSource: account?.secretSource,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
};
