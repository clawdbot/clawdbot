// Slack plugin module implements channel behavior.
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
import {
  createChannelMessageAdapterFromOutbound,
  createRuntimeOutboundDelegates,
  resolveOutboundSendDep,
} from "openclaw/plugin-sdk/channel-outbound";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  createChannelDirectoryAdapter,
  createRuntimeDirectoryLiveAdapter,
} from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { buildOutboundBaseSessionKey, type RoutePeer } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import {
  mergeSlackAccountConfig,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  resolveSlackAccountAllowFrom,
  resolveSlackOperationToken,
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
import { createSlackWebClient } from "./client.js";
import { assertSlackDirectSendAllowed } from "./direct-send-admission.js";
import { formatSlackError } from "./errors.js";
import { shouldSuppressLocalSlackExecApprovalPrompt } from "./exec-approvals.js";
import { resolveSlackGroupRequireMention, resolveSlackGroupToolPolicy } from "./group-policy.js";
import {
  compileSlackInteractiveReplies,
  isSlackInteractiveRepliesEnabled,
} from "./interactive-replies.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import { SLACK_PRESENTATION_CAPABILITIES } from "./presentation.js";
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
import { canonicalizeSlackApiTargetId, parseSlackTarget } from "./target-parsing.js";
import { slackContextTargetsMatch } from "./targets.js";
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

type SlackSendFn = typeof import("./send.runtime.js").sendMessageSlack;

const loadSlackDirectoryConfigModule = createLazyRuntimeModule(
  () => import("./directory-config.js"),
);
const loadSlackResolveChannelsModule = createLazyRuntimeModule(
  () => import("./resolve-channels.js"),
);
const loadSlackResolveUsersModule = createLazyRuntimeModule(() => import("./resolve-users.js"));

const loadSlackActionRuntime = createLazyRuntimeModule(() => import("./action-runtime.runtime.js"));

const loadSlackSendRuntime = createLazyRuntimeModule(() => import("./send.runtime.js"));

const loadSlackProbeModule = createLazyRuntimeModule(() => import("./probe.js"));

const loadSlackMonitorModule = createLazyRuntimeModule(() => import("./monitor.js"));

const loadSlackDirectoryLiveModule = createLazyRuntimeModule(() => import("./directory-live.js"));

async function resolveSlackSendContext(params: {
  cfg: Parameters<typeof resolveSlackAccount>[0]["cfg"];
  accountId?: string;
  deps?: { [channelId: string]: unknown };
  replyToId?: string | number | null;
  threadId?: string | number | null;
}) {
  // params.cfg is the scoped channel-dispatch config; channel credentials are
  // expected to be resolved from this snapshot. Strict mode
  // is intentional so boot-time misconfigurations surface loudly. See #68237.
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  assertSlackDirectSendAllowed(account);
  const send =
    resolveOutboundSendDep<SlackSendFn>(params.deps, "slack") ??
    (await loadSlackSendRuntime()).sendMessageSlack;
  const token = resolveSlackOperationToken(account, "write");
  const botToken = account.botToken?.trim();
  const tokenOverride = token && token !== botToken ? token : undefined;
  const threadTsValue = resolveSlackThreadTsValue(params);
  return { send, threadTsValue, tokenOverride };
}

async function setSlackHeartbeatThreadStatus(params: {
  cfg: OpenClawConfig;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
  status: string;
}) {
  const threadTs = resolveSlackThreadTsValue({ threadId: params.threadId });
  const target = parseSlackTarget(params.to, { defaultKind: "channel" });
  if (!threadTs || !target) {
    return;
  }
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  assertSlackDirectSendAllowed(account);
  const botToken = normalizeOptionalString(account.botToken);
  if (!botToken) {
    return;
  }
  try {
    const client = createSlackWebClient(botToken);
    const apiTargetId = canonicalizeSlackApiTargetId(target.kind, target.id, params.to);
    const channelId =
      target.kind === "channel"
        ? apiTargetId
        : await (
            await loadSlackSendRuntime()
          ).resolveSlackDmChannelId({
            client,
            userId: apiTargetId,
            accountId: account.accountId,
            token: botToken,
          });
    await client.assistant.threads.setStatus({
      token: botToken,
      channel_id: channelId,
      thread_ts: threadTs,
      status: params.status,
    });
  } catch (error) {
    logVerbose(`slack heartbeat status update failed: ${formatSlackError(error)}`);
  }
}

function withSlackSendOverride(params: {
  deps?: { [channelId: string]: unknown } | null;
  send: SlackSendFn;
  tokenOverride?: string;
  deliveryQueueId?: string;
  onPlatformSendDispatch?: () => Promise<void>;
}) {
  return {
    ...params.deps,
    slack: async (
      to: Parameters<SlackSendFn>[0],
      text: Parameters<SlackSendFn>[1],
      opts: Parameters<SlackSendFn>[2],
    ) =>
      await params.send(to, text, {
        ...opts,
        ...(params.tokenOverride ? { token: params.tokenOverride } : {}),
        ...(params.deliveryQueueId ? { deliveryQueueId: params.deliveryQueueId } : {}),
        ...(params.onPlatformSendDispatch
          ? { onPlatformSendDispatch: params.onPlatformSendDispatch }
          : {}),
      }),
  };
}

function resolveSlackRouteTarget(raw: string) {
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
  const apiTargetId = canonicalizeSlackApiTargetId(parsed.kind, parsed.id, params.target);
  const isDm = parsed.kind === "user";
  let peerKind: "direct" | "channel" | "group" = isDm ? "direct" : "channel";
  let peerId = parsed.id;
  let recipientSessionExact = isDm
    ? /^[UW][A-Z0-9]{8,}$/i.test(parsed.id)
    : /^C[A-Z0-9]{8,}$/i.test(parsed.id);
  if (!isDm && /^D/i.test(parsed.id)) {
    const conversation = await resolveSlackConversationInfo({
      cfg: params.cfg,
      accountId: params.accountId,
      channelId: apiTargetId,
    });
    if (conversation.type !== "dm" || !conversation.user) {
      return null;
    }
    peerKind = "direct";
    peerId = conversation.user;
    recipientSessionExact = true;
  } else if (!isDm && /^G/i.test(parsed.id)) {
    const channelType = await resolveSlackChannelType({
      cfg: params.cfg,
      accountId: params.accountId,
      channelId: apiTargetId,
    });
    if (channelType === "group") {
      peerKind = "group";
    }
    if (channelType === "dm") {
      peerKind = "direct";
    }
    recipientSessionExact = channelType !== "unknown";
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
      recipientSessionExact,
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
    normalizeOptionalString(account.userToken) ?? normalizeOptionalString(account.botToken),
  resolveNames: async ({ token, entries }) =>
    (await loadSlackResolveUsersModule()).resolveSlackUserAllowlist({ token, entries }),
});

const slackChannelOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: SLACK_TEXT_LIMIT,
  sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
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
  preferFinalAssistantVisibleText: true,
  shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload }) =>
    shouldSuppressLocalSlackExecApprovalPrompt({
      cfg,
      accountId,
      payload,
    }),
  presentationCapabilities: SLACK_PRESENTATION_CAPABILITIES,
  ...createRuntimeOutboundDelegates({
    getRuntime: loadSlackOutboundAdapterModule,
    renderPresentation: {
      resolve: ({ slackOutbound }) => slackOutbound.renderPresentation,
      unavailableMessage: "Slack outbound presentation rendering is unavailable",
    },
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
      deliveryQueueId: undefined,
      onPlatformSendDispatch: undefined,
      deps: withSlackSendOverride({
        deps: ctx.deps,
        send,
        tokenOverride,
      }),
    });
  },
  sendText: async (ctx) => {
    const { send, threadTsValue, tokenOverride } = await resolveSlackSendContext({
      cfg: ctx.cfg,
      accountId: ctx.accountId ?? undefined,
      deps: ctx.deps,
      replyToId: ctx.replyToId,
      threadId: ctx.threadId,
    });
    const { slackOutbound } = await loadSlackOutboundAdapterModule();
    return await slackOutbound.sendText!({
      ...ctx,
      replyToId: threadTsValue,
      threadId: null,
      deliveryQueueId: undefined,
      onPlatformSendDispatch: undefined,
      deps: withSlackSendOverride({
        deps: ctx.deps,
        send,
        tokenOverride,
        deliveryQueueId: ctx.deliveryQueueId,
        onPlatformSendDispatch: ctx.onPlatformSendDispatch,
      }),
    });
  },
  sendMedia: async (ctx) => {
    const { send, threadTsValue, tokenOverride } = await resolveSlackSendContext({
      cfg: ctx.cfg,
      accountId: ctx.accountId ?? undefined,
      deps: ctx.deps,
      replyToId: ctx.replyToId,
      threadId: ctx.threadId,
    });
    const { slackOutbound } = await loadSlackOutboundAdapterModule();
    return await slackOutbound.sendMedia!({
      ...ctx,
      replyToId: threadTsValue,
      threadId: null,
      deliveryQueueId: undefined,
      onPlatformSendDispatch: undefined,
      deps: withSlackSendOverride({
        deps: ctx.deps,
        send,
        tokenOverride,
        onPlatformSendDispatch: ctx.onPlatformSendDispatch,
      }),
    });
  },
};

const slackMessageAdapterBase = createChannelMessageAdapterFromOutbound({
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

const slackMessageAdapter = {
  ...slackMessageAdapterBase,
  durableFinal: {
    capabilities: {
      ...slackMessageAdapterBase.durableFinal?.capabilities,
      reconcileUnknownSend: true,
    },
    admitDeferredDelivery: ({ cfg, accountId }) => {
      const effectiveAccountId =
        normalizeOptionalString(accountId) ?? resolveDefaultSlackAccountId(cfg);
      return mergeSlackAccountConfig(cfg, effectiveAccountId).enterpriseOrgInstall === true
        ? {
            status: "permanent_rejection" as const,
            reason: "unsupported_enterprise_slack_delivery",
          }
        : { status: "allowed" as const };
    },
    reconcileUnknownSendKinds: { text: true },
    reconcileUnknownSend: async (ctx) =>
      await (await loadSlackSendRuntime()).reconcileSlackUnknownSend(ctx),
  },
} satisfies typeof slackMessageAdapterBase;

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
    conversationBindings: {
      isCurrentConversationBindingSupported: ({ accountId }) => {
        const cfg = getOptionalSlackRuntime()?.config.current() as OpenClawConfig | undefined;
        return cfg ? mergeSlackAccountConfig(cfg, accountId).enterpriseOrgInstall !== true : false;
      },
    },
    messaging: {
      targetPrefixes: ["slack"],
      directTargetStyle: "user-prefixed",
      targetIdComparison: "lowercase",
      normalizeTarget: normalizeSlackMessagingTarget,
      // Session and delivery identities stay folded; Slack API boundaries restore ID casing.
      resolveDeliveryTarget: ({ conversationId, parentConversationId }) => {
        const parent = parentConversationId?.trim();
        const child = conversationId.trim();
        return parent && parent !== child
          ? { to: normalizeSlackMessagingTarget(`channel:${parent}`), threadId: child }
          : { to: normalizeSlackMessagingTarget(`channel:${child}`) };
      },
      resolveSessionTarget: ({ id }) => {
        // Session identities stay folded; send.ts restores unambiguous IDs at the API boundary.
        return normalizeSlackMessagingTarget(`channel:${id}`);
      },
      inferTargetChatType: ({ to }) => resolveSlackRouteTarget(to)?.chatType,
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
          const parsed = resolveSlackRouteTarget(input);
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
              normalizeOptionalString(account.userToken) ??
              normalizeOptionalString(account.botToken),
            inputs,
            missingTokenNote: "missing Slack token",
            resolveWithToken: async ({ token, inputs: inputsValue }) =>
              (await loadSlackResolveChannelsModule()).resolveSlackChannelAllowlist({
                token,
                entries: inputsValue,
              }),
            mapResolved: (entry) =>
              toResolvedTarget(entry, entry.archived ? "archived" : undefined),
          });
        }
        return resolveTargetsWithOptionalToken({
          token:
            normalizeOptionalString(account.userToken) ?? normalizeOptionalString(account.botToken),
          inputs,
          missingTokenNote: "missing Slack token",
          resolveWithToken: async ({ token, inputs: inputsLocal }) =>
            (await loadSlackResolveUsersModule()).resolveSlackUserAllowlist({
              token,
              entries: inputsLocal,
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
    heartbeat: {
      sendTyping: async ({ cfg, to, accountId, threadId }) => {
        await setSlackHeartbeatThreadStatus({
          cfg,
          to,
          accountId,
          threadId,
          status: "is typing...",
        });
      },
      clearTyping: async ({ cfg, to, accountId, threadId }) => {
        await setSlackHeartbeatThreadStatus({
          cfg,
          to,
          accountId,
          threadId,
          status: "",
        });
      },
    },
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
        return await (
          await loadSlackProbeModule()
        ).probeSlack(token, timeoutMs, {
          accountId: account.accountId,
        });
      },
      formatCapabilitiesProbe: ({ probe }) => {
        const slackProbe = probe as SlackProbe | undefined;
        const lines = [];
        if (slackProbe?.warning) {
          lines.push({ text: `Warning: ${slackProbe.warning}`, tone: "warn" } as const);
        }
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
        const userToken = account.userToken?.trim();
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
        const credentialConfigured =
          mode === "http"
            ? resolveConfiguredFromRequiredCredentialStatuses(account, [
                "botTokenStatus",
                "signingSecretStatus",
              ])
            : mode === "socket"
              ? resolveConfiguredFromRequiredCredentialStatuses(account, [
                  "botTokenStatus",
                  "appTokenStatus",
                ])
              : undefined;
        const configured = credentialConfigured ?? isSlackPluginAccountConfigured(account);
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
        assertSlackDirectSendAllowed(account);
        const { sendMessageSlack } = await loadSlackSendRuntime();
        const token = resolveSlackOperationToken(account, "write");
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
    matchesToolContextTarget: ({ target, toolContext }) =>
      slackContextTargetsMatch(target, toolContext),
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
    resolveReplyTransport: ({ threadId, replyToId, replyToIsExplicit, replyDelivery }) => {
      const allowedReplyToId = replyDelivery?.replyToMode === "off" ? undefined : replyToId;
      // Slack's thread_ts identifies the root. Only known inherited replies may let
      // that root replace a child timestamp; explicit and unknown callers stay reply-first.
      const preferThreadId = replyToIsExplicit === false;
      const resolvedReplyToId = resolveSlackThreadTsValue({
        replyToId: preferThreadId ? threadId : allowedReplyToId,
        threadId: preferThreadId ? allowedReplyToId : threadId,
      });
      return {
        replyToId:
          replyDelivery?.replyToMode === "off" && !resolvedReplyToId ? null : resolvedReplyToId,
        threadId: null,
      };
    },
  },
  outbound: slackChannelOutbound,
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
