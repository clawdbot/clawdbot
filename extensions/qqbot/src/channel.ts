// Qqbot plugin module implements channel behavior.
import { getExecApprovalReplyMetadata } from "openclaw/plugin-sdk/approval-runtime";
import { buildChannelOutboundSessionRoute } from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageSendResult,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Register the PlatformAdapter before any core/ module is used.
import "./bridge/bootstrap.js";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { getQQBotApprovalCapability } from "./bridge/approval/capability.js";
import {
  qqbotConfigAdapter,
  qqbotMeta,
  qqbotSetupAdapterShared,
  qqbotSetupContract,
} from "./bridge/config-shared.js";
import {
  applyQQBotAccountConfig,
  DEFAULT_ACCOUNT_ID,
  resolveQQBotAccount,
} from "./bridge/config.js";
import type { GatewayContext } from "./bridge/gateway.js";
import { toGatewayAccount, writeOpenClawConfigThroughRuntime } from "./bridge/narrowing.js";
import { getQQBotRuntime } from "./bridge/runtime.js";
import { qqbotSetupWizard } from "./bridge/setup/surface.js";
import { qqbotChannelConfigSchema } from "./config-schema.js";
import { qqbotDoctor } from "./doctor.js";
import { loadCredentialBackup, saveCredentialBackup } from "./engine/config/credential-backup.js";
import { clearAccountCredentials } from "./engine/config/credentials.js";
import { chunkQQBotMarkdownText } from "./engine/messaging/markdown-table-chunking.js";
import type { OutboundMediaAccessContext } from "./engine/messaging/outbound-types.js";
import {
  normalizeTarget as coreNormalizeTarget,
  looksLikeQQBotTarget,
  parseTarget,
} from "./engine/messaging/target-parser.js";
import { normalizeOptionalString } from "./engine/utils/string-normalize.js";
import { resolveQQBotGroupToolPolicy } from "./group-policy.js";
import type { ResolvedQQBotAccount } from "./types.js";

const loadGatewayModule = createLazyRuntimeModule(() => import("./bridge/gateway.js"));
const loadOutboundMessagingModule = createLazyRuntimeModule(
  () => import("./engine/messaging/outbound.js"),
);

function createQQBotSendReceipt(params: {
  messageId?: string;
  target: string;
  kind: MessageReceiptPartKind;
}) {
  const messageId = params.messageId?.trim();
  return createMessageReceiptFromOutboundResults({
    results: messageId
      ? [
          {
            channel: "qqbot",
            messageId,
            conversationId: params.target,
          },
        ]
      : [],
    threadId: params.target,
    kind: params.kind,
  });
}

function resolveQQBotOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
}) {
  const target = parseTarget(params.target);
  const chatType = target.type === "c2c" ? "direct" : "group";
  const qualifiedTarget = `qqbot:${target.type}:${target.id}`;
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "qqbot",
    accountId: params.accountId,
    recipientSessionExact: true,
    peer: { kind: chatType, id: target.id },
    chatType,
    from: qualifiedTarget,
    to: qualifiedTarget,
  });
}

async function sendQQBotText(
  params: {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    accountId?: string | null;
    replyToId?: string | null;
  } & OutboundMediaAccessContext,
) {
  // Ensure bridge/gateway.ts module-level registrations (audio adapter factory,
  // platform adapter, etc.) have executed before engine code runs.
  await loadGatewayModule();
  const account = resolveQQBotAccount(params.cfg, params.accountId);
  const { sendText } = await loadOutboundMessagingModule();
  const result = await sendText({
    to: params.to,
    text: params.text,
    accountId: params.accountId,
    replyToId: params.replyToId,
    account: toGatewayAccount(account),
    ...(params.mediaAccess ? { mediaAccess: params.mediaAccess } : {}),
    ...(params.mediaLocalRoots ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    ...(params.mediaReadFile ? { mediaReadFile: params.mediaReadFile } : {}),
  });
  return {
    channel: "qqbot" as const,
    messageId: result.messageId ?? "",
    receipt: createQQBotSendReceipt({
      messageId: result.messageId,
      target: params.to,
      kind: "text",
    }),
    meta: result.error ? { error: result.error } : undefined,
  };
}

async function sendQQBotMedia(
  params: {
    cfg: OpenClawConfig;
    to: string;
    text?: string | null;
    mediaUrl?: string | null;
    accountId?: string | null;
    replyToId?: string | null;
  } & OutboundMediaAccessContext,
) {
  // Same guard as sendText — ensure adapters are registered.
  await loadGatewayModule();
  const account = resolveQQBotAccount(params.cfg, params.accountId);
  const { sendMedia } = await loadOutboundMessagingModule();
  const result = await sendMedia({
    to: params.to,
    text: params.text ?? "",
    mediaUrl: params.mediaUrl ?? "",
    accountId: params.accountId,
    replyToId: params.replyToId,
    account: toGatewayAccount(account),
    ...(params.mediaAccess ? { mediaAccess: params.mediaAccess } : {}),
    ...(params.mediaLocalRoots ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    ...(params.mediaReadFile ? { mediaReadFile: params.mediaReadFile } : {}),
  });
  return {
    channel: "qqbot" as const,
    messageId: result.messageId ?? "",
    receipt: createQQBotSendReceipt({
      messageId: result.messageId,
      target: params.to,
      kind: "media",
    }),
    meta: result.error ? { error: result.error } : undefined,
  };
}

function resolveQQBotOutboundMediaAccessContext(ctx: unknown): OutboundMediaAccessContext {
  const record = ctx && typeof ctx === "object" ? (ctx as OutboundMediaAccessContext) : undefined;
  return {
    ...(record?.mediaAccess ? { mediaAccess: record.mediaAccess } : {}),
    ...(record?.mediaLocalRoots ? { mediaLocalRoots: record.mediaLocalRoots } : {}),
    ...(record?.mediaReadFile ? { mediaReadFile: record.mediaReadFile } : {}),
  };
}

function toQQBotMessageSendResult(result: Awaited<ReturnType<typeof sendQQBotText>>) {
  if (result.meta?.error) {
    throw new Error(result.meta.error);
  }
  if (result.receipt.platformMessageIds.length === 0) {
    throw new Error("QQBot message adapter send did not return a platform message id");
  }
  return {
    messageId: result.messageId || result.receipt.primaryPlatformMessageId,
    receipt: result.receipt,
  } satisfies ChannelMessageSendResult;
}

const qqbotMessageAdapter = defineChannelMessageAdapter({
  id: "qqbot",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      replyTo: true,
    },
  },
  send: {
    text: async (ctx) =>
      toQQBotMessageSendResult(
        await sendQQBotText({
          cfg: ctx.cfg,
          to: ctx.to,
          text: ctx.text,
          accountId: ctx.accountId,
          replyToId: ctx.replyToId,
          ...resolveQQBotOutboundMediaAccessContext(ctx),
        }),
      ),
    media: async (ctx) =>
      toQQBotMessageSendResult(
        await sendQQBotMedia({
          cfg: ctx.cfg,
          to: ctx.to,
          text: ctx.text,
          mediaUrl: ctx.mediaUrl,
          accountId: ctx.accountId,
          replyToId: ctx.replyToId,
          ...resolveQQBotOutboundMediaAccessContext(ctx),
        }),
      ),
  },
});

const EXEC_APPROVAL_COMMAND_RE =
  /\/approve(?:@[^\s]+)?\s+[A-Za-z0-9][A-Za-z0-9._:-]*\s+(?:allow-once|allow-always|always|deny)\b/i;

function persistAccountCredentialSnapshot(account: ResolvedQQBotAccount): void {
  if (account.appId && account.clientSecret) {
    saveCredentialBackup(account.accountId, account.appId, account.clientSecret);
  }
}

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
  doctor: qqbotDoctor,
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
  setupContract: qqbotSetupContract,
  approvalCapability: getQQBotApprovalCapability(),
  groups: {
    resolveToolPolicy: resolveQQBotGroupToolPolicy,
  },
  message: qqbotMessageAdapter,
  messaging: {
    targetPrefixes: ["qqbot"],
    /** Normalize common QQ Bot target formats into the canonical qqbot:... form. */
    normalizeTarget: coreNormalizeTarget,
    resolveOutboundSessionRoute: (params) => resolveQQBotOutboundSessionRoute(params),
    targetResolver: {
      /** Return true when the id looks like a QQ Bot target. */
      looksLikeId: looksLikeQQBotTarget,
      hint: "QQ Bot target format: qqbot:c2c:openid (direct) or qqbot:group:groupid (group)",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) =>
      chunkQQBotMarkdownText(text, limit, getQQBotRuntime().channel.text.chunkMarkdownText),
    chunkerMode: "markdown",
    textChunkLimit: 5000,
    sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
    shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload, hint }) =>
      shouldSuppressLocalQQBotApprovalPrompt({
        cfg,
        accountId,
        payload,
        hint,
      }),
    sendText: async (ctx) =>
      await sendQQBotText({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        accountId: ctx.accountId,
        replyToId: ctx.replyToId,
        ...resolveQQBotOutboundMediaAccessContext(ctx),
      }),
    sendMedia: async (ctx) =>
      await sendQQBotMedia({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        mediaUrl: ctx.mediaUrl,
        accountId: ctx.accountId,
        replyToId: ctx.replyToId,
        ...resolveQQBotOutboundMediaAccessContext(ctx),
      }),
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
            await writeOpenClawConfigThroughRuntime(getQQBotRuntime(), nextCfg);
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
        channelRuntime: ctx.channelRuntime as GatewayContext["channelRuntime"],
        onReady: () => {
          log?.info(`[qqbot:${account.accountId}] Gateway ready`);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
            lastError: null,
          });
          // Snapshot credentials so we can recover from the next hot
          // upgrade that might wipe openclaw.json mid-flight.
          persistAccountCredentialSnapshot(account);
        },
        onResumed: () => {
          log?.info(`[qqbot:${account.accountId}] Gateway resumed`);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
            lastError: null,
          });
          persistAccountCredentialSnapshot(account);
        },
        onError: (error) => {
          log?.error(`[qqbot:${account.accountId}] Gateway error: ${error.message}`);
          ctx.setStatus({
            ...ctx.getStatus(),
            lastError: error.message,
          });
        },
        onDisconnected: ({ reason, fatal }) => {
          log?.info(
            `[qqbot:${account.accountId}] Gateway disconnected${reason ? `: ${reason}` : ""}`,
          );
          // Keep the raw lifecycle snapshot truthful so readiness and the shared
          // health monitor see the failed transport. QQBot's fatal flag only
          // suppresses its immediate reconnect policy.
          ctx.setStatus({
            ...ctx.getStatus(),
            connected: false,
            ...(fatal && reason ? { lastError: reason } : {}),
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
        await writeOpenClawConfigThroughRuntime(getQQBotRuntime(), nextCfg as OpenClawConfig);
      }

      const resolved = resolveQQBotAccount((changed ? nextCfg : cfg) as OpenClawConfig, accountId);
      const loggedOut = resolved.secretSource === "none";
      const envToken = Boolean(normalizeOptionalString(process.env.QQBOT_CLIENT_SECRET));

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
