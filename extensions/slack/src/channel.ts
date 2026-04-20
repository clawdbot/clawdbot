import {
  buildLegacyDmAccountAllowlistAdapter,
  createAccountScopedAllowlistNameResolver,
  createFlatAllowlistOverrideResolver,
} from "openclaw/plugin-sdk/allowlist-config-edit";
import {
  adaptScopedAccountAccessor,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { createOpenProviderConfiguredRouteWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import {
  createChannelDirectoryAdapter,
  createRuntimeDirectoryLiveAdapter,
} from "openclaw/plugin-sdk/directory-runtime";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-runtime";
import {
  buildOutboundBaseSessionKey,
  normalizeOutboundThreadId,
  resolveThreadSessionKeys,
  type RoutePeer,
} from "openclaw/plugin-sdk/routing";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { resolveTargetsWithOptionalToken } from "openclaw/plugin-sdk/target-resolver-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  resolveSlackReplyToMode,
  type ResolvedSlackAccount,
} from "./accounts.js";
import type { SlackActionContext } from "./action-runtime.js";
import { resolveSlackAutoThreadId } from "./action-threading.js";
import { slackApprovalCapability } from "./approval-native.js";
import { createSlackActions } from "./channel-actions.js";
import {
  DEFAULT_ACCOUNT_ID,
  looksLikeSlackTargetId,
  normalizeSlackMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  projectCredentialSnapshotFields,
  resolveConfiguredFromRequiredCredentialStatuses,
  type ChannelPlugin,
  type OpenClawConfig,
} from "./channel-api.js";
import { resolveSlackChannelType } from "./channel-type.js";
import { shouldSuppressLocalSlackExecApprovalPrompt } from "./exec-approvals.js";
import { resolveSlackGroupRequireMention, resolveSlackGroupToolPolicy } from "./group-policy.js";
import {
  compileSlackInteractiveReplies,
  isSlackInteractiveRepliesEnabled,
} from "./interactive-replies.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import { slackOutbound } from "./outbound-adapter.js";
import type { SlackProbe } from "./probe.js";
import { resolveSlackReplyBlocks } from "./reply-blocks.js";
import { getOptionalSlackRuntime, getSlackRuntime } from "./runtime.js";
import { fetchSlackScopes } from "./scopes.js";
import { collectSlackSecurityAuditFindings } from "./security-audit.js";
import { slackSetupAdapter } from "./setup-core.js";
import { slackSetupWizard } from "./setup-surface.js";
import {
  createSlackPluginBase,
  isSlackPluginAccountConfigured,
  SLACK_CHANNEL,
  slackConfigAdapter,
} from "./shared.js";
import { parseSlackTarget } from "./target-parsing.js";
import { buildSlackThreadingToolContext } from "./threading-tool-context.js";

const resolveSlackDmPolicy = createScopedDmSecurityResolver<ResolvedSlackAccount>({
  channelKey: "slack",
  resolvePolicy: (account) => account.dm?.policy,
  resolveAllowFrom: (account) => account.dm?.allowFrom,
  allowFromPathSuffix: "dm.",
  normalizeEntry: (raw) =>
    raw
      .trim()
      .replace(/^(slack|user):/i, "")
      .trim(),
});

async function resolveSlackHandleAction() {
  return (
    getOptionalSlackRuntime()?.channel?.slack?.handleSlackAction ??
    (await loadSlackActionRuntime()).handleSlackAction
  );
}

function shouldTreatSlackDeliveredTextAsVisible(params: {
  kind: "tool" | "block" | "final";
  text?: string;
}): boolean {
  return (
    params.kind === "block" && typeof params.text === "string" && params.text.trim().length > 0
  );
}

// Select the appropriate Slack token for read/write operations.
function getTokenForOperation(
  account: ResolvedSlackAccount,
  operation: "read" | "write",
): string | undefined {
  const userToken = normalizeOptionalString(account.config.userToken);
  const botToken = normalizeOptionalString(account.botToken);
  const allowUserWrites = account.config.userTokenReadOnly === false;
  if (operation === "read") {
    return userToken ?? botToken;
  }
  if (!allowUserWrites) {
    return botToken;
  }
  return botToken ?? userToken;
}

type SlackSendFn = typeof import("./send.runtime.js").sendMessageSlack;

let slackActionRuntimePromise: Promise<typeof import("./action-runtime.runtime.js")> | undefined;
let slackSendRuntimePromise: Promise<typeof import("./send.runtime.js")> | undefined;
let slackProbeModulePromise: Promise<typeof import("./probe.js")> | undefined;
let slackMonitorModulePromise: Promise<typeof import("./monitor.js")> | undefined;
let slackDirectoryLiveModulePromise: Promise<typeof import("./directory-live.js")> | undefined;

const loadSlackDirectoryConfigModule = createLazyRuntimeModule(
  () => import("./directory-config.js"),
);
const loadSlackResolveChannelsModule = createLazyRuntimeModule(
  () => import("./resolve-channels.js"),
);
const loadSlackResolveUsersModule = createLazyRuntimeModule(() => import("./resolve-users.js"));

async function loadSlackActionRuntime() {
  slackActionRuntimePromise ??= import("./action-runtime.runtime.js");
  return await slackActionRuntimePromise;
}

async function loadSlackSendRuntime() {
  slackSendRuntimePromise ??= import("./send.runtime.js");
  return await slackSendRuntimePromise;
}

async function loadSlackProbeModule() {
  slackProbeModulePromise ??= import("./probe.js");
  return await slackProbeModulePromise;
}

async function loadSlackMonitorModule() {
  slackMonitorModulePromise ??= import("./monitor.js");
  return await slackMonitorModulePromise;
}

async function loadSlackDirectoryLiveModule() {
  slackDirectoryLiveModulePromise ??= import("./directory-live.js");
  return await slackDirectoryLiveModulePromise;
}

async function resolveSlackSendContext(params: {
  cfg: Parameters<typeof resolveSlackAccount>[0]["cfg"];
  accountId?: string;
  deps?: { [channelId: string]: unknown };
  replyToId?: string | number | null;
  threadId?: string | number | null;
}) {
  const send =
    resolveOutboundSendDep<SlackSendFn>(params.deps, "slack") ??
    (await loadSlackSendRuntime()).sendMessageSlack;
  // params.cfg is the scoped channel-dispatch config; channel credentials are
  // expected to be resolved here (not a raw loadConfig() snapshot). Strict mode
  // is intentional so boot-time misconfigurations surface loudly. See #68237
  // for the companion tolerant-mode path in sendMessageSlack itself.
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const token = getTokenForOperation(account, "write");
  const botToken = account.botToken?.trim();
  const tokenOverride = token && token !== botToken ? token : undefined;
  const threadTsValue = params.replyToId ?? params.threadId;
  return { send, threadTsValue, tokenOverride };
}

function parseSlackExplicitTarget(raw: string) {
  const target = parseSlackTarget(raw, { defaultKind: "channel" });
  if (!target) {
    return null;
  }
  return {
    to: target.id,
    chatType: target.kind === "user" ? ("direct" as const) : ("channel" as const),
  };
}

function buildSlackBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({ ...params, channel: "slack" });
}

async function resolveSlackOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  replyToId?: string | null;
  threadId?: string | number | null;
}) {
  const parsed = parseSlackTarget(params.target, { defaultKind: "channel" });
  if (!parsed) {
    return null;
  }
  const isDm = parsed.kind === "user";
  let peerKind: "direct" | "channel" | "group" = isDm ? "direct" : "channel";
  if (!isDm && /^G/i.test(parsed.id)) {
    const channelType = await resolveSlackChannelType({
      cfg: params.cfg,
      accountId: params.accountId,
      channelId: parsed.id,
    });
    if (channelType === "group") {
      peerKind = "group";
    }
    if (channelType === "dm") {
      peerKind = "direct";
    }
  }
  const peer: RoutePeer = {
    kind: peerKind,
    id: parsed.id,
  };
  const baseSessionKey = buildSlackBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    accountId: params.accountId,
    peer,
  });
  const threadId = normalizeOutboundThreadId(params.threadId ?? params.replyToId);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId,
  });
  return {
    sessionKey: threadKeys.sessionKey,
    baseSessionKey,
    peer,
    chatType: peerKind === "direct" ? ("direct" as const) : ("channel" as const),
    from:
      peerKind === "direct"
        ? `slack:${parsed.id}`
        : peerKind === "group"
          ? `slack:group:${parsed.id}`
          : `slack:channel:${parsed.id}`,
    to: peerKind === "direct" ? `user:${parsed.id}` : `channel:${parsed.id}`,
    threadId,
  };
}

function formatSlackScopeDiagnostic(params: {
  tokenType: "bot" | "user";
  result: Awaited<ReturnType<typeof fetchSlackScopes>>;
}) {
  const source = params.result.source ? ` (${params.result.source})` : "";
  const label = params.tokenType === "user" ? "User scopes" : "Bot scopes";
  if (params.result.ok && params.result.scopes?.length) {
    return { text: `${label}${source}: ${params.result.scopes.join(", ")}` } as const;
  }
  return {
    text: `${label}: ${params.result.error ?? "scope lookup failed"}`,
    tone: "error",
  } as const;
}

const resolveSlackAllowlistGroupOverrides = createFlatAllowlistOverrideResolver({
  resolveRecord: (account: ResolvedSlackAccount) => account.channels,
  label: (key) => key,
  resolveEntries: (value) => value?.users,
});

const resolveSlackAllowlistNames = createAccountScopedAllowlistNameResolver({
  resolveAccount: resolveSlackAccount,
  resolveToken: (account: ResolvedSlackAccount) =>
    normalizeOptionalString(account.config.userToken) ?? normalizeOptionalString(account.botToken),
  resolveNames: async ({ token, entries }) =>
    (await loadSlackResolveUsersModule()).resolveSlackUserAllowlist({ token, entries }),
});

const collectSlackSecurityWarnings =
  createOpenProviderConfiguredRouteWarningCollector<ResolvedSlackAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.slack !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Boolean(account.config.channels) && Object.keys(account.config.channels ?? {}).length > 0,
    configureRouteAllowlist: {
      surface: "Slack channels",
      openScope: "any channel not explicitly denied",
      groupPolicyPath: "channels.slack.groupPolicy",
      routeAllowlistPath: "channels.slack.channels",
    },
    missingRouteAllowlist: {
      surface: "Slack channels",
      openBehavior: "with no channel allowlist; any channel can trigger (mention-gated)",
      remediation:
        'Set channels.slack.groupPolicy="allowlist" and configure channels.slack.channels',
    },
  });

export const slackPlugin: ChannelPlugin<ResolvedSlackAccount, SlackProbe> = createChatChannelPlugin<
  ResolvedSlackAccount,
  SlackProbe
>({
  base: {
    ...createSlackPluginBase({
      setupWizard: slackSetupWizard,
      setup: slackSetupAdapter,
    }),
    allowlist: {
      ...buildLegacyDmAccountAllowlistAdapter({
        channelId: "slack",
        resolveAccount: resolveSlackAccount,
        normalize: ({ cfg, accountId, values }) =>
          slackConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
        resolveDmAllowFrom: (account) => account.config.allowFrom ?? account.config.dm?.allowFrom,
        resolveGroupPolicy: (account) => account.groupPolicy,
        resolveGroupOverrides: resolveSlackAllowlistGroupOverrides,
      }),
      resolveNames: resolveSlackAllowlistNames,
    },
    approvalCapability: slackApprovalCapability,
    groups: {
      resolveRequireMention: resolveSlackGroupRequireMention,
      resolveToolPolicy: resolveSlackGroupToolPolicy,
    },
    messaging: {
      normalizeTarget: normalizeSlackMessagingTarget,
      resolveDeliveryTarget: ({ conversationId, parentConversationId }) => {
        const parent = parentConversationId?.trim();
        const child = conversationId.trim();
        return parent && parent !== child
          ? { to: `channel:${parent}`, threadId: child }
          : { to: normalizeSlackMessagingTarget(`channel:${child}`) };
      },
      resolveSessionTarget: ({ id }) => normalizeSlackMessagingTarget(`channel:${id}`),
      parseExplicitTarget: ({ raw }) => parseSlackExplicitTarget(raw),
      inferTargetChatType: ({ to }) => parseSlackExplicitTarget(to)?.chatType,
      resolveOutboundSessionRoute: async (params) => await resolveSlackOutboundSessionRoute(params),
      transformReplyPayload: ({ payload, cfg, accountId }) =>
        isSlackInteractiveRepliesEnabled({ cfg, accountId })
          ? compileSlackInteractiveReplies(payload)
          : payload,
      enableInteractiveReplies: ({ cfg, accountId }) =>
        isSlackInteractiveRepliesEnabled({ cfg, accountId }),
      hasStructuredReplyPayload: ({ payload }) => {
        try {
          return Boolean(resolveSlackReplyBlocks(payload)?.length);
        } catch {
          return false;
        }
      },
      targetResolver: {
        looksLikeId: looksLikeSlackTargetId,
        hint: "<channelId|user:ID|channel:ID>",
        resolveTarget: async ({ input }) => {
          const parsed = parseSlackExplicitTarget(input);
          if (!parsed) {
            return null;
          }
          return {
            to: parsed.to,
            kind: parsed.chatType === "direct" ? "user" : "group",
            source: "normalized",
          };
        },
      },
    },
    directory: createChannelDirectoryAdapter({
      listPeers: async (params) =>
        (await loadSlackDirectoryConfigModule()).listSlackDirectoryPeersFromConfig(params),
      listGroups: async (params) =>
        (await loadSlackDirectoryConfigModule()).listSlackDirectoryGroupsFromConfig(params),
      ...createRuntimeDirectoryLiveAdapter({
        getRuntime: loadSlackDirectoryLiveModule,
        listPeersLive: (runtime) => runtime.listSlackDirectoryPeersLive,
        listGroupsLive: (runtime) => runtime.listSlackDirectoryGroupsLive,
      }),
    }),
    resolver: {
      resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
        const toResolvedTarget = (
          entry: { input: string; resolved: boolean; id?: string; name?: string },
          note?: string,
        ) => ({
          input: entry.input,
          resolved: entry.resolved,
          id: entry.id,
          name: entry.name,
          note,
        });
        const account = resolveSlackAccount({ cfg, accountId });
        if (kind === "group") {
          return resolveTargetsWithOptionalToken({
            token:
              normalizeOptionalString(account.config.userToken) ??
              normalizeOptionalString(account.botToken),
            inputs,
            missingTokenNote: "missing Slack token",
            resolveWithToken: async ({ token, inputs }) =>
              (await loadSlackResolveChannelsModule()).resolveSlackChannelAllowlist({
                token,
                entries: inputs,
              }),
            mapResolved: (entry) =>
              toResolvedTarget(entry, entry.archived ? "archived" : undefined),
          });
        }
        return resolveTargetsWithOptionalToken({
          token:
            normalizeOptionalString(account.config.userToken) ??
            normalizeOptionalString(account.botToken),
          inputs,
          missingTokenNote: "missing Slack token",
          resolveWithToken: async ({ token, inputs }) =>
            (await loadSlackResolveUsersModule()).resolveSlackUserAllowlist({
              token,
              entries: inputs,
            }),
          mapResolved: (entry) => toResolvedTarget(entry, entry.note),
        });
      },
    },
    actions: createSlackActions(SLACK_CHANNEL, {
      invoke: async (action, cfg, toolContext) =>
        await (
          await resolveSlackHandleAction()
        )(action, cfg as OpenClawConfig, toolContext as SlackActionContext | undefined),
    }),
    status: createComputedAccountStatusAdapter<ResolvedSlackAccount, SlackProbe>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      buildChannelSummary: ({ snapshot }) =>
        buildPassiveProbedChannelStatusSummary(snapshot, {
          botTokenSource: snapshot.botTokenSource ?? "none",
          appTokenSource: snapshot.appTokenSource ?? "none",
        }),
      probeAccount: async ({ account, timeoutMs }) => {
        const token = account.botToken?.trim();
        if (!token) {
          return { ok: false, error: "missing token" };
        }
        return await (await loadSlackProbeModule()).probeSlack(token, timeoutMs);
      },
      formatCapabilitiesProbe: ({ probe }) => {
        const slackProbe = probe as SlackProbe | undefined;
        const lines = [];
        if (slackProbe?.bot?.name) {
          lines.push({ text: `Bot: @${slackProbe.bot.name}` });
        }
        if (slackProbe?.team?.name || slackProbe?.team?.id) {
          const id = slackProbe.team?.id ? ` (${slackProbe.team.id})` : "";
          lines.push({ text: `Team: ${slackProbe.team?.name ?? "unknown"}${id}` });
        }
        return lines;
      },
      buildCapabilitiesDiagnostics: async ({ account, timeoutMs }) => {
        const lines = [];
        const details: Record<string, unknown> = {};
        const botToken = account.botToken?.trim();
        const userToken = account.config.userToken?.trim();
        const botScopes = botToken
          ? await fetchSlackScopes(botToken, timeoutMs)
          : { ok: false, error: "Slack bot token missing." };
        lines.push(formatSlackScopeDiagnostic({ tokenType: "bot", result: botScopes }));
        details.botScopes = botScopes;
        if (userToken) {
          const userScopes = await fetchSlackScopes(userToken, timeoutMs);
          lines.push(formatSlackScopeDiagnostic({ tokenType: "user", result: userScopes }));
          details.userScopes = userScopes;
        }
        return { lines, details };
      },
      resolveAccountSnapshot: ({ account }) => {
        const mode = account.config.mode ?? "socket";
        const configured =
          (mode === "http"
            ? resolveConfiguredFromRequiredCredentialStatuses(account, [
                "botTokenStatus",
                "signingSecretStatus",
              ])
            : resolveConfiguredFromRequiredCredentialStatuses(account, [
                "botTokenStatus",
                "appTokenStatus",
              ])) ?? isSlackPluginAccountConfigured(account);
        return {
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured,
          extra: {
            ...projectCredentialSnapshotFields(account),
          },
        };
      },
    }),
    gateway: {
      startAccount: async (ctx) => {
        const account = ctx.account;
        const botToken = account.botToken?.trim();
        const appToken = account.appToken?.trim();
        ctx.log?.info(`[${account.accountId}] starting provider`);
        return (await loadSlackMonitorModule()).monitorSlackProvider({
          botToken: botToken ?? "",
          appToken: appToken ?? "",
          accountId: account.accountId,
          config: ctx.cfg,
          runtime: ctx.runtime,
          channelRuntime: ctx.channelRuntime,
          abortSignal: ctx.abortSignal,
          mediaMaxMb: account.config.mediaMaxMb,
          slashCommand: account.config.slashCommand,
          setStatus: ctx.setStatus as (next: Record<string, unknown>) => void,
          getStatus: ctx.getStatus as () => Record<string, unknown>,
        });
      },
    },
    mentions: {
      stripPatterns: () => ["<@[^>\\s]+>"],
    },
  },
  pairing: {
    text: {
      idLabel: "slackUserId",
      message: PAIRING_APPROVED_MESSAGE,
      normalizeAllowEntry: createPairingPrefixStripper(/^(slack|user):/i),
      notify: async ({ id, message }) => {
        const cfg = getSlackRuntime().config.loadConfig();
        const account = resolveSlackAccount({
          cfg,
          accountId: resolveDefaultSlackAccountId(cfg),
        });
        const { sendMessageSlack } = await loadSlackSendRuntime();
        const token = getTokenForOperation(account, "write");
        const botToken = account.botToken?.trim();
        const tokenOverride = token && token !== botToken ? token : undefined;
        if (tokenOverride) {
          await sendMessageSlack(`user:${id}`, message, {
            token: tokenOverride,
          });
        } else {
          await sendMessageSlack(`user:${id}`, message);
        }
      },
    },
  },
  security: {
    resolveDmPolicy: resolveSlackDmPolicy,
    collectWarnings: collectSlackSecurityWarnings,
    collectAuditFindings: collectSlackSecurityAuditFindings,
  },
  threading: {
    scopedAccountReplyToMode: {
      resolveAccount: adaptScopedAccountAccessor(resolveSlackAccount),
      resolveReplyToMode: (account, chatType) => resolveSlackReplyToMode(account, chatType),
    },
    allowExplicitReplyTagsWhenOff: false,
    buildToolContext: (params) => buildSlackThreadingToolContext(params),
    resolveAutoThreadId: ({ to, toolContext, replyToId }) =>
      replyToId
        ? undefined
        : resolveSlackAutoThreadId({
            to,
            toolContext,
          }),
    resolveReplyTransport: ({ threadId, replyToId }) => ({
      replyToId: replyToId ?? (threadId != null && threadId !== "" ? String(threadId) : undefined),
      threadId: null,
    }),
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      chunker: null,
      textChunkLimit: SLACK_TEXT_LIMIT,
      shouldTreatDeliveredTextAsVisible: shouldTreatSlackDeliveredTextAsVisible,
      shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload }) =>
        shouldSuppressLocalSlackExecApprovalPrompt({
          cfg,
          accountId,
          payload,
        }),
      sendPayload: async (ctx) => {
        const { send, tokenOverride } = await resolveSlackSendContext({
          cfg: ctx.cfg,
          accountId: ctx.accountId ?? undefined,
          deps: ctx.deps,
          replyToId: ctx.replyToId,
          threadId: ctx.threadId,
        });
        return await slackOutbound.sendPayload!({
          ...ctx,
          deps: {
            ...ctx.deps,
            slack: async (
              to: Parameters<SlackSendFn>[0],
              text: Parameters<SlackSendFn>[1],
              opts: Parameters<SlackSendFn>[2],
            ) =>
              await send(to, text, {
                ...opts,
                ...(tokenOverride ? { token: tokenOverride } : {}),
              }),
          },
        });
      },
    },
    attachedResults: {
      channel: "slack",
      sendText: async ({ to, text, accountId, deps, replyToId, threadId, cfg }) => {
        const { send, threadTsValue, tokenOverride } = await resolveSlackSendContext({
          cfg,
          accountId: accountId ?? undefined,
          deps,
          replyToId,
          threadId,
        });
        return await send(to, text, {
          cfg,
          threadTs: threadTsValue != null ? String(threadTsValue) : undefined,
          accountId: accountId ?? undefined,
          ...(tokenOverride ? { token: tokenOverride } : {}),
        });
      },
      sendMedia: async ({
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId,
        deps,
        replyToId,
        threadId,
        cfg,
      }) => {
        const { send, threadTsValue, tokenOverride } = await resolveSlackSendContext({
          cfg,
          accountId: accountId ?? undefined,
          deps,
          replyToId,
          threadId,
        });
        return await send(to, text, {
          cfg,
          mediaUrl,
          mediaLocalRoots,
          threadTs: threadTsValue != null ? String(threadTsValue) : undefined,
          accountId: accountId ?? undefined,
          ...(tokenOverride ? { token: tokenOverride } : {}),
        });
      },
    },
  },
});
