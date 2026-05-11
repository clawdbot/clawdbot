import {
  buildLegacyDmAccountAllowlistAdapter,
  createAccountScopedAllowlistNameResolver,
  createFlatAllowlistOverrideResolver,
} from "openclaw/plugin-sdk/allowlist-config-edit";
import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  buildThreadAwareOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-message";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import {
  createAttachedChannelResultAdapter,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  createChannelDirectoryAdapter,
  createRuntimeDirectoryLiveAdapter,
} from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-send-deps";
import { buildOutboundBaseSessionKey, type RoutePeer } from "openclaw/plugin-sdk/routing";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  resolveSlackAccountAllowFrom,
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
import { resolveSlackChannelType, resolveSlackConversationInfo } from "./channel-type.js";
import { shouldSuppressLocalSlackExecApprovalPrompt } from "./exec-approvals.js";
import { resolveSlackGroupRequireMention, resolveSlackGroupToolPolicy } from "./group-policy.js";
import {
  compileSlackInteractiveReplies,
  isSlackInteractiveRepliesEnabled,
} from "./interactive-replies.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import type { SlackProbe } from "./probe.js";
import { resolveSlackReplyBlocks } from "./reply-blocks.js";
import { getOptionalSlackRuntime } from "./runtime.js";
import { slackSecurityAdapter } from "./security.js";
import { createSlackSetupWizardProxy, slackSetupAdapter } from "./setup-core.js";
import {
  createSlackPluginBase,
  isSlackPluginAccountConfigured,
  SLACK_CHANNEL,
  slackConfigAdapter,
} from "./shared.js";
import { parseSlackTarget } from "./target-parsing.js";
import { normalizeSlackThreadTsCandidate, resolveSlackThreadTsValue } from "./thread-ts.js";
import { buildSlackThreadingToolContext } from "./threading-tool-context.js";

// Lazy SDK loaders. The dynamic import is hidden behind a string-literal
// module id and typed by a hand-written structural alias so TypeScript does
// not have to crawl the SDK module's type graph just to type the loader.
//
// `openclaw/plugin-sdk/channel-policy` is intentionally NOT lazy here —
// `./group-policy.js` already imports it eagerly, so deferring it from
// `channel.ts` would not change the load graph.

type ExtensionSharedSurface = {
  buildPassiveProbedChannelStatusSummary: <TExtra extends object>(
    snapshot: {
      configured?: boolean;
      running?: boolean;
      lastStartAt?: number | null;
      lastStopAt?: number | null;
      lastError?: string | null;
      probe?: unknown;
      lastProbeAt?: number | null;
    },
    extra?: TExtra,
  ) => {
    configured: boolean;
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    probe: unknown;
    lastProbeAt: number | null;
  } & TExtra;
};

type TargetResolverRuntimeSurface = {
  resolveTargetsWithOptionalToken: <TResult>(params: {
    token?: string | null;
    inputs: string[];
    missingTokenNote: string;
    resolveWithToken: (params: { token: string; inputs: string[] }) => Promise<TResult[]>;
    mapResolved: (entry: TResult) => {
      input: string;
      resolved: boolean;
      id?: string;
      name?: string;
      note?: string;
    };
  }) => Promise<
    Array<{ input: string; resolved: boolean; id?: string; name?: string; note?: string }>
  >;
};

const EXTENSION_SHARED_MODULE_ID = "openclaw/plugin-sdk/extension-shared";
const TARGET_RESOLVER_RUNTIME_MODULE_ID = "openclaw/plugin-sdk/target-resolver-runtime";

const loadExtensionSharedSdk = createLazyRuntimeModule(
  () => import(EXTENSION_SHARED_MODULE_ID) as Promise<ExtensionSharedSurface>,
);
const loadTargetResolverRuntimeSdk = createLazyRuntimeModule(
  () => import(TARGET_RESOLVER_RUNTIME_MODULE_ID) as Promise<TargetResolverRuntimeSurface>,
);

const loadSlackSetupSurfaceModule = createLazyRuntimeModule(() => import("./setup-surface.js"));
const loadSlackScopesModule = createLazyRuntimeModule(() => import("./scopes.js"));
const loadSlackOutboundAdapterModule = createLazyRuntimeModule(
  () => import("./outbound-adapter.js"),
);
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
  // expected to be resolved from this snapshot. Strict mode
  // is intentional so boot-time misconfigurations surface loudly. See #68237.
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const token = getTokenForOperation(account, "write");
  const botToken = account.botToken?.trim();
  const tokenOverride = token && token !== botToken ? token : undefined;
  const threadTsValue = resolveSlackThreadTsValue(params);
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

function normalizeSlackAcpConversationId(raw: string | undefined | null) {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return null;
  }
  const parsed = parseSlackTarget(trimmed, { defaultKind: "channel" });
  const conversationId = normalizeLowercaseStringOrEmpty(
    parsed?.id ?? trimmed.replace(/^slack:/i, "").replace(/^(?:channel|group|direct|user):/i, ""),
  );
  return conversationId ? { conversationId } : null;
}

function matchSlackAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}) {
  const bindingConversationId = normalizeSlackAcpConversationId(
    params.bindingConversationId,
  )?.conversationId;
  const conversationId = normalizeSlackAcpConversationId(params.conversationId)?.conversationId;
  const parentConversationId = normalizeSlackAcpConversationId(
    params.parentConversationId,
  )?.conversationId;
  if (!bindingConversationId || !conversationId) {
    return null;
  }
  if (bindingConversationId === conversationId) {
    return { conversationId, matchPriority: 2 };
  }
  if (
    parentConversationId &&
    parentConversationId !== conversationId &&
    bindingConversationId === parentConversationId
  ) {
    return { conversationId: parentConversationId, matchPriority: 1 };
  }
  return null;
}

function buildSlackBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({ ...params, channel: "slack" });
}

function shouldRecoverSlackThreadFromCurrentSession(params: {
  cfg: OpenClawConfig;
  peerKind: RoutePeer["kind"];
}): boolean {
  // Shared DM sessions (dmScope="main") do not encode the DM peer in the base key,
  // so inheriting a prior thread can bleed across unrelated direct-message targets.
  if (params.peerKind === "direct" && (params.cfg.session?.dmScope ?? "main") === "main") {
    return false;
  }
  return true;
}

async function resolveSlackOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  currentSessionKey?: string | null;
}) {
  const parsed = parseSlackTarget(params.target, { defaultKind: "channel" });
  if (!parsed) {
    return null;
  }
  const isDm = parsed.kind === "user";
  let peerKind: "direct" | "channel" | "group" = isDm ? "direct" : "channel";
  let peerId = parsed.id;
  if (!isDm && /^D/i.test(parsed.id)) {
    const conversation = await resolveSlackConversationInfo({
      cfg: params.cfg,
      accountId: params.accountId,
      channelId: parsed.id,
    });
    if (conversation.type !== "dm" || !conversation.user) {
      return null;
    }
    peerKind = "direct";
    peerId = conversation.user;
  } else if (!isDm && /^G/i.test(parsed.id)) {
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
    id: peerId,
  };
  const baseSessionKey = buildSlackBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    accountId: params.accountId,
    peer,
  });
  return buildThreadAwareOutboundSessionRoute({
    route: {
      sessionKey: baseSessionKey,
      baseSessionKey,
      peer,
      chatType: peerKind === "direct" ? ("direct" as const) : ("channel" as const),
      from:
        peerKind === "direct"
          ? `slack:${peerId}`
          : peerKind === "group"
            ? `slack:group:${peerId}`
            : `slack:channel:${peerId}`,
      to: peerKind === "direct" ? `user:${peerId}` : `channel:${peerId}`,
    },
    replyToId: params.replyToId,
    threadId: params.threadId,
    currentSessionKey: params.currentSessionKey,
    canRecoverCurrentThread: () =>
      shouldRecoverSlackThreadFromCurrentSession({
        cfg: params.cfg,
        peerKind,
      }),
  });
}

// Mirrors `SlackScopesResult` in ./scopes.ts so the type does not pull the
// scopes module back in at module-load time. Keep the two in sync.
type SlackScopesResultShape = {
  ok: boolean;
  scopes?: string[];
  source?: string;
  error?: string;
};

function formatSlackScopeDiagnostic(params: {
  tokenType: "bot" | "user";
  result: SlackScopesResultShape;
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

const slackChannelOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: SLACK_TEXT_LIMIT,
  normalizePayload: ({ payload, cfg, accountId }) =>
    isSlackInteractiveRepliesEnabled({ cfg, accountId })
      ? compileSlackInteractiveReplies(payload)
      : payload,
  deliveryCapabilities: {
    durableFinal: {
      text: true,
      media: true,
      payload: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  shouldTreatDeliveredTextAsVisible: shouldTreatSlackDeliveredTextAsVisible,
  shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload }) =>
    shouldSuppressLocalSlackExecApprovalPrompt({
      cfg,
      accountId,
      payload,
    }),
  sendPayload: async (ctx) => {
    const { send, threadTsValue, tokenOverride } = await resolveSlackSendContext({
      cfg: ctx.cfg,
      accountId: ctx.accountId ?? undefined,
      deps: ctx.deps,
      replyToId: ctx.replyToId,
      threadId: ctx.threadId,
    });
    const { slackOutbound } = await loadSlackOutboundAdapterModule();
    return await slackOutbound.sendPayload!({
      ...ctx,
      replyToId: threadTsValue,
      threadId: null,
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
  ...createAttachedChannelResultAdapter({
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
        threadTs: threadTsValue,
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
        threadTs: threadTsValue,
        accountId: accountId ?? undefined,
        ...(tokenOverride ? { token: tokenOverride } : {}),
      });
    },
  }),
};

const slackMessageAdapter = createChannelMessageAdapterFromOutbound({
  id: "slack",
  outbound: slackChannelOutbound,
  live: {
    capabilities: {
      draftPreview: true,
      previewFinalization: true,
      progressUpdates: true,
      nativeStreaming: true,
    },
    finalizer: {
      capabilities: {
        finalEdit: true,
        normalFallback: true,
        discardPending: true,
      },
    },
  },
});

export const slackPlugin: ChannelPlugin<ResolvedSlackAccount, SlackProbe> = createChatChannelPlugin<
  ResolvedSlackAccount,
  SlackProbe
>({
  base: {
    ...createSlackPluginBase({
      setupWizard: createSlackSetupWizardProxy(loadSlackSetupSurfaceModule),
      setup: slackSetupAdapter,
    }),
    allowlist: {
      ...buildLegacyDmAccountAllowlistAdapter({
        channelId: "slack",
        resolveAccount: resolveSlackAccount,
        normalize: ({ cfg, accountId, values }) =>
          slackConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
        resolveDmAllowFrom: (account, { cfg }) =>
          resolveSlackAccountAllowFrom({ cfg, accountId: account.accountId }),
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
    bindings: {
      compileConfiguredBinding: ({ conversationId }) =>
        normalizeSlackAcpConversationId(conversationId),
      matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) =>
        matchSlackAcpConversation({
          bindingConversationId: compiledBinding.conversationId,
          conversationId,
          parentConversationId,
        }),
    },
    messaging: {
      targetPrefixes: ["slack"],
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
        self: (runtime) => runtime.getSlackDirectorySelfLive,
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
        const { resolveTargetsWithOptionalToken } = await loadTargetResolverRuntimeSdk();
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
    message: slackMessageAdapter,
    status: createComputedAccountStatusAdapter<ResolvedSlackAccount, SlackProbe>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      buildChannelSummary: async ({ snapshot }) => {
        const { buildPassiveProbedChannelStatusSummary } = await loadExtensionSharedSdk();
        return buildPassiveProbedChannelStatusSummary(snapshot, {
          botTokenSource: snapshot.botTokenSource ?? "none",
          appTokenSource: snapshot.appTokenSource ?? "none",
        });
      },
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
        const { fetchSlackScopes } = await loadSlackScopesModule();
        const botScopes: SlackScopesResultShape = botToken
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
      notify: async ({ cfg, id, message }) => {
        const account = resolveSlackAccount({
          cfg,
          accountId: resolveDefaultSlackAccountId(cfg),
        });
        const { sendMessageSlack } = await loadSlackSendRuntime();
        const token = getTokenForOperation(account, "write");
        await sendMessageSlack(`user:${id}`, message, {
          cfg,
          accountId: account.accountId,
          ...(token ? { token } : {}),
        });
      },
    },
  },
  security: slackSecurityAdapter,
  threading: {
    scopedAccountReplyToMode: {
      resolveAccount: adaptScopedAccountAccessor(resolveSlackAccount),
      resolveReplyToMode: (account, chatType) => resolveSlackReplyToMode(account, chatType),
    },
    allowExplicitReplyTagsWhenOff: false,
    buildToolContext: (params) => buildSlackThreadingToolContext(params),
    resolveAutoThreadId: ({ to, toolContext, replyToId }) =>
      normalizeSlackThreadTsCandidate(replyToId)
        ? undefined
        : normalizeSlackThreadTsCandidate(
            resolveSlackAutoThreadId({
              to,
              toolContext,
            }),
          ),
    resolveReplyTransport: ({ threadId, replyToId }) => ({
      replyToId: resolveSlackThreadTsValue({ replyToId, threadId }),
      threadId: null,
    }),
  },
  outbound: slackChannelOutbound,
});
