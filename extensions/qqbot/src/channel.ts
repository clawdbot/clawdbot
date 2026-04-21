import { getExecApprovalReplyMetadata } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
// Register the PlatformAdapter before any core/ module is used.
import "./bridge/bootstrap.js";
import { getQQBotApprovalCapability } from "./bridge/approval/capability.js";
import { qqbotConfigAdapter, qqbotMeta, qqbotSetupAdapterShared } from "./bridge/config-shared.js";
import {
  applyQQBotAccountConfig,
  DEFAULT_ACCOUNT_ID,
  resolveQQBotAccount,
} from "./bridge/config.js";
import { getQQBotRuntime } from "./bridge/runtime.js";
import { qqbotSetupWizard } from "./bridge/setup/surface.js";
import { qqbotChannelConfigSchema } from "./config-schema.js";
import { loadCredentialBackup, saveCredentialBackup } from "./engine/config/credential-backup.js";
import { clearAccountCredentials } from "./engine/config/credentials.js";
import {
  normalizeTarget as coreNormalizeTarget,
  looksLikeQQBotTarget,
} from "./engine/messaging/target-parser.js";
// Re-export text helpers from core/.
export { chunkText, TEXT_CHUNK_LIMIT } from "./engine/utils/text-chunk.js";
import type { ResolvedQQBotAccount } from "./types.js";

// Shared promise so concurrent multi-account startups serialize the dynamic
// import of the gateway module, avoiding an ESM circular-dependency race.
let _gatewayModulePromise: Promise<typeof import("./bridge/gateway.js")> | undefined;
function loadGatewayModule(): Promise<typeof import("./bridge/gateway.js")> {
  _gatewayModulePromise ??= import("./bridge/gateway.js");
  return _gatewayModulePromise;
}

const EXEC_APPROVAL_COMMAND_RE =
  /\/approve(?:@[^\s]+)?\s+[A-Za-z0-9][A-Za-z0-9._:-]*\s+(?:allow-once|allow-always|always|deny)\b/i;

function shouldSuppressLocalQQBotApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: { text?: string; channelData?: unknown };
  hint?: { kind: "approval-pending" | "approval-resolved"; approvalKind: "exec" | "plugin" };
}): boolean {
  if (params.hint?.kind !== "approval-pending" || params.hint.approvalKind !== "exec") {
    return false;
  }
  const account = resolveQQBotAccount(params.cfg, params.accountId);
  if (!account.enabled || account.secretSource === "none") {
    return false;
  }
  if (getExecApprovalReplyMetadata(params.payload as never)) {
    return true;
  }
  const text = typeof params.payload.text === "string" ? params.payload.text : "";
  return EXEC_APPROVAL_COMMAND_RE.test(text);
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
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.qqbot"] },
  configSchema: qqbotChannelConfigSchema,
  config: {
    ...qqbotConfigAdapter,
    /**
     * Treat an account as configured when either the live config has
     * credentials OR a recoverable credential backup exists. This mirrors
     * the standalone plugin and lets the gateway survive a hot upgrade
     * that wiped openclaw.json mid-flight.
     */
    isConfigured: (account: ResolvedQQBotAccount | undefined) => {
      if (qqbotConfigAdapter.isConfigured(account)) {
        return true;
      }
      if (!account) {
        return false;
      }
      const backup = loadCredentialBackup(account.accountId);
      return Boolean(backup?.appId && backup?.clientSecret);
    },
  },
  setup: {
    ...qqbotSetupAdapterShared,
  },
  approvalCapability: getQQBotApprovalCapability(),
  messaging: {
    /** Normalize common QQ Bot target formats into the canonical qqbot:... form. */
    normalizeTarget: coreNormalizeTarget,
    targetResolver: {
      /** Return true when the id looks like a QQ Bot target. */
      looksLikeId: looksLikeQQBotTarget,
      hint: "QQ Bot target format: qqbot:c2c:openid (direct) or qqbot:group:groupid (group)",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getQQBotRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 5000,
    shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload, hint }) =>
      shouldSuppressLocalQQBotApprovalPrompt({
        cfg,
        accountId,
        payload,
        hint,
      }),
    sendText: async ({ to, text, accountId, replyToId, cfg }) => {
      // Ensure bridge/gateway.ts module-level registrations (audio adapter factory,
      // platform adapter, etc.) have executed before engine code runs.
      await loadGatewayModule();
      const account = resolveQQBotAccount(cfg, accountId);
      const { sendText } = await import("./engine/messaging/outbound.js");
      const result = await sendText({ to, text, accountId, replyToId, account: account as never });
      return {
        channel: "qqbot" as const,
        messageId: result.messageId ?? "",
        meta: result.error ? { error: result.error } : undefined,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId, cfg }) => {
      // Same guard as sendText — ensure adapters are registered.
      await loadGatewayModule();
      const account = resolveQQBotAccount(cfg, accountId);
      const { sendMedia } = await import("./engine/messaging/outbound.js");
      const result = await sendMedia({
        to,
        text: text ?? "",
        mediaUrl: mediaUrl ?? "",
        accountId,
        replyToId,
        account: account as never,
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
      let { account, cfg } = ctx;
      const { abortSignal, log } = ctx;

      // Recover credentials from the per-account backup if the live
      // config is missing appId/secret (e.g. a hot-upgrade wiped
      // openclaw.json). We only restore when both fields are empty so a
      // user's intentional clear isn't silently undone.
      if (!account.appId || !account.clientSecret) {
        const backup = loadCredentialBackup(account.accountId);
        if (backup?.appId && backup?.clientSecret) {
          try {
            const nextCfg = applyQQBotAccountConfig(cfg, account.accountId, {
              appId: backup.appId,
              clientSecret: backup.clientSecret,
            });
            const runtime = getQQBotRuntime();
            const configApi = runtime.config as {
              writeConfigFile: (cfg: OpenClawConfig) => Promise<void>;
            };
            await configApi.writeConfigFile(nextCfg);
            cfg = nextCfg;
            account = resolveQQBotAccount(nextCfg, account.accountId);
            log?.info(
              `[qqbot:${account.accountId}] Restored credentials from backup (appId=${account.appId})`,
            );
          } catch (err) {
            log?.error(
              `[qqbot:${account.accountId}] Failed to restore credentials from backup: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

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
        channelRuntime: ctx.channelRuntime as never,
        onReady: () => {
          log?.info(`[qqbot:${account.accountId}] Gateway ready`);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
          });
          // Snapshot credentials so we can recover from the next hot
          // upgrade that might wipe openclaw.json mid-flight.
          if (account.appId && account.clientSecret) {
            saveCredentialBackup(account.accountId, account.appId, account.clientSecret);
          }
        },
        onResumed: () => {
          log?.info(`[qqbot:${account.accountId}] Gateway resumed`);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
          });
          if (account.appId && account.clientSecret) {
            saveCredentialBackup(account.accountId, account.appId, account.clientSecret);
          }
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
      const { nextCfg, cleared, changed } = clearAccountCredentials(
        cfg as unknown as Record<string, unknown>,
        accountId,
      );

      if (changed) {
        const runtime = getQQBotRuntime();
        const configApi = runtime.config as {
          writeConfigFile: (cfg: OpenClawConfig) => Promise<void>;
        };
        await configApi.writeConfigFile(nextCfg as OpenClawConfig);
      }

      const resolved = resolveQQBotAccount((changed ? nextCfg : cfg) as OpenClawConfig, accountId);
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
