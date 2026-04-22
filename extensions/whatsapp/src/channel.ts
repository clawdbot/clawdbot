import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createAsyncComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { resolveWhatsAppAccount, type ResolvedWhatsAppAccount } from "./accounts.js";
import { createWhatsAppLoginTool } from "./agent-tools-login.js";
import { whatsappApprovalAuth } from "./approval-auth.js";
import type { WebChannelStatus } from "./auto-reply/types.js";
import {
  describeWhatsAppMessageActions,
  resolveWhatsAppAgentReactionGuidance,
} from "./channel-actions.js";
import { whatsappChannelOutbound } from "./channel-outbound.js";
import { whatsappCommandPolicy } from "./command-policy.js";
import { formatWhatsAppConfigAllowFromEntries } from "./config-accessors.js";
import {
  resolveWhatsAppGroupIntroHint,
  resolveWhatsAppMentionStripRegexes,
} from "./group-intro.js";
import {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
import { resolveWhatsAppHeartbeatRecipients } from "./heartbeat-recipients.js";
import { checkWhatsAppHeartbeatReady } from "./heartbeat.js";
import {
  isWhatsAppGroupJid,
  looksLikeWhatsAppTargetId,
  normalizeWhatsAppMessagingTarget,
  normalizeWhatsAppTarget,
} from "./normalize.js";
import { getWhatsAppRuntime } from "./runtime.js";
import { sendTypingWhatsApp } from "./send.js";
import { resolveWhatsAppOutboundSessionRoute } from "./session-route.js";
import { whatsappSetupAdapter } from "./setup-core.js";
import {
  createWhatsAppPluginBase,
  loadWhatsAppChannelRuntime,
  whatsappSetupWizardProxy,
} from "./shared.js";
import { detectWhatsAppLegacyStateMigrations } from "./state-migrations.js";
import { collectWhatsAppStatusIssues } from "./status-issues.js";

const loadWhatsAppDirectoryConfig = createLazyRuntimeModule(() => import("./directory-config.js"));
const loadWhatsAppChannelReactAction = createLazyRuntimeModule(
  () => import("./channel-react-action.js"),
);

function parseWhatsAppExplicitTarget(raw: string) {
  const normalized = normalizeWhatsAppTarget(raw);
  if (!normalized) {
    return null;
  }
  return {
    to: normalized,
    chatType: isWhatsAppGroupJid(normalized) ? ("group" as const) : ("direct" as const),
  };
}

export const whatsappPlugin: ChannelPlugin<ResolvedWhatsAppAccount> =
  createChatChannelPlugin<ResolvedWhatsAppAccount>({
    pairing: {
      idLabel: "whatsappSenderId",
    },
    outbound: whatsappChannelOutbound,
    base: {
      ...createWhatsAppPluginBase({
        groups: {
          resolveRequireMention: resolveWhatsAppGroupRequireMention,
          resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
          resolveGroupIntroHint: resolveWhatsAppGroupIntroHint,
        },
        setupWizard: whatsappSetupWizardProxy,
        setup: whatsappSetupAdapter,
        isConfigured: async (account) => {
          const channelRuntime = await loadWhatsAppChannelRuntime();
          return (await channelRuntime.readWebAuthState(account.authDir)) === "linked";
        },
      }),
      agentTools: () => [createWhatsAppLoginTool()],
      allowlist: buildDmGroupAccountAllowlistAdapter({
        channelId: "whatsapp",
        resolveAccount: resolveWhatsAppAccount,
        normalize: ({ values }) => formatWhatsAppConfigAllowFromEntries(values),
        resolveDmAllowFrom: (account) => account.allowFrom,
        resolveGroupAllowFrom: (account) => account.groupAllowFrom,
        resolveDmPolicy: (account) => account.dmPolicy,
        resolveGroupPolicy: (account) => account.groupPolicy,
      }),
      mentions: {
        stripRegexes: ({ ctx }) => resolveWhatsAppMentionStripRegexes(ctx),
      },
      commands: whatsappCommandPolicy,
      agentPrompt: {
        reactionGuidance: ({ cfg, accountId }) => {
          const level = resolveWhatsAppAgentReactionGuidance({
            cfg,
            accountId: accountId ?? undefined,
          });
          return level ? { level, channelLabel: "WhatsApp" } : undefined;
        },
      },
      messaging: {
        normalizeTarget: normalizeWhatsAppMessagingTarget,
        resolveOutboundSessionRoute: (params) => resolveWhatsAppOutboundSessionRoute(params),
        parseExplicitTarget: ({ raw }) => parseWhatsAppExplicitTarget(raw),
        inferTargetChatType: ({ to }) => parseWhatsAppExplicitTarget(to)?.chatType,
        targetResolver: {
          looksLikeId: looksLikeWhatsAppTargetId,
          hint: "<E.164|group JID>",
        },
      },
      directory: {
        self: async ({ cfg, accountId }) => {
          const account = resolveWhatsAppAccount({ cfg, accountId });
          const { e164, jid } = (await loadWhatsAppChannelRuntime()).readWebSelfId(account.authDir);
          const id = e164 ?? jid;
          if (!id) {
            return null;
          }
          return {
            kind: "user",
            id,
            name: account.name,
            raw: { e164, jid },
          };
        },
        listPeers: async (params) =>
          (await loadWhatsAppDirectoryConfig()).listWhatsAppDirectoryPeersFromConfig(params),
        listGroups: async (params) =>
          (await loadWhatsAppDirectoryConfig()).listWhatsAppDirectoryGroupsFromConfig(params),
      },
      actions: {
        describeMessageTool: ({ cfg, accountId }) =>
          describeWhatsAppMessageActions({ cfg, accountId }),
        supportsAction: ({ action }) => action === "react",
        resolveExecutionMode: ({ action }) => (action === "react" ? "gateway" : "local"),
        handleAction: async ({ action, params, cfg, accountId, requesterSenderId, toolContext }) =>
          await (
            await loadWhatsAppChannelReactAction()
          ).handleWhatsAppReactAction({
            action,
            params,
            cfg,
            accountId,
            requesterSenderId,
            toolContext,
          }),
      },
      approvalCapability: whatsappApprovalAuth,
      auth: {
        login: async ({ cfg, accountId, runtime, verbose }) => {
          const resolvedAccountId =
            accountId?.trim() ||
            whatsappPlugin.config.defaultAccountId?.(cfg) ||
            DEFAULT_ACCOUNT_ID;
          await (
            await loadWhatsAppChannelRuntime()
          ).loginWeb(Boolean(verbose), undefined, runtime, resolvedAccountId);
        },
      },
      lifecycle: {
        detectLegacyStateMigrations: ({ oauthDir }) =>
          detectWhatsAppLegacyStateMigrations({ oauthDir }),
      },
      heartbeat: {
        checkReady: async ({ cfg, accountId, deps }) =>
          await checkWhatsAppHeartbeatReady({ cfg, accountId: accountId ?? undefined, deps }),
        sendTyping: async ({ cfg, to, accountId }) => {
          await sendTypingWhatsApp(to, {
            cfg,
            ...(accountId ? { accountId } : {}),
          });
        },
        resolveRecipients: ({ cfg, opts }) => resolveWhatsAppHeartbeatRecipients(cfg, opts),
      },
      status: createAsyncComputedAccountStatusAdapter<ResolvedWhatsAppAccount>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
          connected: false,
          reconnectAttempts: 0,
          lastConnectedAt: null,
          lastDisconnect: null,
          lastInboundAt: null,
          lastMessageAt: null,
          lastEventAt: null,
          healthState: "stopped",
        }),
        collectStatusIssues: collectWhatsAppStatusIssues,
        buildChannelSummary: async ({ account, snapshot }) => {
          const channelRuntime = await loadWhatsAppChannelRuntime();
          const authDir = account.authDir;
          const auth = authDir
            ? await channelRuntime.readWebAuthSnapshot(authDir)
            : {
                state: "not-linked" as const,
                authAgeMs: null,
                selfId: { e164: null, jid: null, lid: null },
              };
          const linked =
            typeof snapshot.linked === "boolean"
              ? snapshot.linked
              : auth.state === "unstable"
                ? undefined
                : auth.state === "linked";
          const summaryAuthState =
            auth.state === "unstable"
              ? auth.state
              : linked === true
                ? "linked"
                : linked === false
                  ? "not-linked"
                  : undefined;
          const statusState = summaryAuthState === undefined ? undefined : summaryAuthState;
          const configured =
            auth.state === "unstable"
              ? typeof snapshot.configured === "boolean"
                ? snapshot.configured
                : true
              : typeof linked === "boolean"
                ? linked
                : auth.state === "linked";
          const authAgeMs = typeof linked === "boolean" && linked ? auth.authAgeMs : null;
          const self =
            typeof linked === "boolean" && linked
              ? auth.selfId
              : { e164: null, jid: null, lid: null };
          return {
            configured,
            ...(statusState ? { statusState } : {}),
            ...(typeof linked === "boolean" ? { linked } : {}),
            authAgeMs,
            self,
            running: snapshot.running ?? false,
            connected: snapshot.connected ?? false,
            lastConnectedAt: snapshot.lastConnectedAt ?? null,
            lastDisconnect: snapshot.lastDisconnect ?? null,
            reconnectAttempts: snapshot.reconnectAttempts,
            lastInboundAt: snapshot.lastInboundAt ?? snapshot.lastMessageAt ?? null,
            lastMessageAt: snapshot.lastMessageAt ?? null,
            lastEventAt: snapshot.lastEventAt ?? null,
            lastError: snapshot.lastError ?? null,
            healthState: snapshot.healthState ?? undefined,
          };
        },
        resolveAccountSnapshot: async ({ account, runtime }) => {
          const channelRuntime = await loadWhatsAppChannelRuntime();
          const authState = await channelRuntime.readWebAuthState(account.authDir);
          return {
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: true,
            extra: {
              statusState: authState,
              ...(authState === "linked"
                ? { linked: true }
                : authState === "not-linked"
                  ? { linked: false }
                  : {}),
              connected: runtime?.connected ?? false,
              reconnectAttempts: runtime?.reconnectAttempts,
              lastConnectedAt: runtime?.lastConnectedAt ?? null,
              lastDisconnect: runtime?.lastDisconnect ?? null,
              lastInboundAt: runtime?.lastInboundAt ?? runtime?.lastMessageAt ?? null,
              lastMessageAt: runtime?.lastMessageAt ?? null,
              lastEventAt: runtime?.lastEventAt ?? null,
              healthState: runtime?.healthState ?? undefined,
              dmPolicy: account.dmPolicy,
              allowFrom: account.allowFrom,
            },
          };
        },
        resolveAccountState: ({ configured }) => (configured ? "linked" : "not linked"),
        logSelfId: ({ account, runtime, includeChannelPrefix }) => {
          void loadWhatsAppChannelRuntime().then((runtimeExports) =>
            runtimeExports.logWebSelfId(account.authDir, runtime, includeChannelPrefix),
          );
        },
      }),
      gateway: {
        startAccount: async (ctx) => {
          const account = ctx.account;
          const { e164, jid } = (await loadWhatsAppChannelRuntime()).readWebSelfId(account.authDir);
          const identity = e164 ? e164 : jid ? `jid ${jid}` : "unknown";
          ctx.log?.info(`[${account.accountId}] starting provider (${identity})`);
          return (await loadWhatsAppChannelRuntime()).monitorWebChannel(
            getWhatsAppRuntime().logging.shouldLogVerbose(),
            undefined,
            true,
            undefined,
            ctx.runtime,
            ctx.abortSignal,
            {
              statusSink: (next: WebChannelStatus) =>
                ctx.setStatus({ accountId: ctx.accountId, ...next }),
              accountId: account.accountId,
            },
          );
        },
        loginWithQrStart: async ({ accountId, force, timeoutMs, verbose }) =>
          await (
            await loadWhatsAppChannelRuntime()
          ).startWebLoginWithQr({
            accountId,
            force,
            timeoutMs,
            verbose,
          }),
        loginWithQrWait: async ({ accountId, timeoutMs }) =>
          await (await loadWhatsAppChannelRuntime()).waitForWebLogin({ accountId, timeoutMs }),
        logoutAccount: async ({ account, runtime }) => {
          const cleared = await (
            await loadWhatsAppChannelRuntime()
          ).logoutWeb({
            authDir: account.authDir,
            isLegacyAuthDir: account.isLegacyAuthDir,
            runtime,
          });
          return { cleared, loggedOut: cleared };
        },
      },
    },
  });
