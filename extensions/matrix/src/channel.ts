import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  adaptScopedAccountAccessor,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-primitives";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createAllowlistProviderOpenWarningCollector,
  projectAccountConfigWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import { createScopedAccountReplyToModeResolver } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createChannelDirectoryAdapter,
  createResolvedDirectoryEntriesLister,
  createRuntimeDirectoryLiveAdapter,
} from "openclaw/plugin-sdk/directory-runtime";
import { buildTrafficStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { createRuntimeOutboundDelegates } from "openclaw/plugin-sdk/outbound-runtime";
import {
  buildProbeChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { matrixMessageActions } from "./actions.js";
import { matrixApprovalCapability } from "./approval-native.js";
import { createMatrixPairingText, createMatrixProbeAccount } from "./channel-account-paths.js";
import { DEFAULT_ACCOUNT_ID, matrixConfigAdapter } from "./config-adapter.js";
import { MatrixConfigSchema } from "./config-schema.js";
import { matrixDoctor } from "./doctor.js";
import { shouldSuppressLocalMatrixExecApprovalPrompt } from "./exec-approvals.js";
import {
  resolveMatrixGroupRequireMention,
  resolveMatrixGroupToolPolicy,
} from "./group-mentions.js";
import {
  resolveMatrixAccount,
  resolveMatrixAccountConfig,
  type ResolvedMatrixAccount,
} from "./matrix/accounts.js";
import { normalizeMatrixUserId } from "./matrix/monitor/allowlist.js";
import type { MatrixProbe } from "./matrix/probe.js";
import {
  normalizeMatrixMessagingTarget,
  resolveMatrixDirectUserId,
  resolveMatrixTargetIdentity,
} from "./matrix/target-ids.js";
import {
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingMaxAgeBySessionKey,
} from "./matrix/thread-bindings-shared.js";
import { matrixResolverAdapter } from "./resolver.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { resolveMatrixOutboundSessionRoute } from "./session-route.js";
import {
  namedAccountPromotionKeys,
  resolveSingleAccountPromotionTarget,
  singleAccountKeysToMove,
} from "./setup-contract.js";
import { matrixSetupAdapter } from "./setup-core.js";
import { matrixSetupWizard } from "./setup-surface.js";
import { runMatrixStartupMaintenance } from "./startup-maintenance.js";
import { resolveMatrixInboundConversation } from "./thread-binding-api.js";
import type { CoreConfig } from "./types.js";
// Mutex for serializing account startup (workaround for concurrent dynamic import race condition)
let matrixStartupLock: Promise<void> = Promise.resolve();

const loadMatrixChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "matrixChannelRuntime",
);

const meta = {
  id: "matrix",
  label: "Matrix",
  selectionLabel: "Matrix (plugin)",
  docsPath: "/channels/matrix",
  docsLabel: "matrix",
  blurb: "open protocol; configure a homeserver + access token.",
  order: 70,
  quickstartAllowFrom: true,
};

const listMatrixDirectoryPeersFromConfig =
  createResolvedDirectoryEntriesLister<ResolvedMatrixAccount>({
    kind: "user",
    resolveAccount: adaptScopedAccountAccessor(resolveMatrixAccount),
    resolveSources: (account) => [
      account.config.dm?.allowFrom ?? [],
      account.config.groupAllowFrom ?? [],
      ...Object.values(account.config.groups ?? account.config.rooms ?? {}).map(
        (room) => room.users ?? [],
      ),
    ],
    normalizeId: (entry) => {
      const raw = entry.replace(/^matrix:/i, "").trim();
      if (!raw || raw === "*") {
        return null;
      }
      const lowered = normalizeLowercaseStringOrEmpty(raw);
      const cleaned = lowered.startsWith("user:") ? raw.slice("user:".length).trim() : raw;
      return cleaned.startsWith("@") ? `user:${cleaned}` : cleaned;
    },
  });

const listMatrixDirectoryGroupsFromConfig =
  createResolvedDirectoryEntriesLister<ResolvedMatrixAccount>({
    kind: "group",
    resolveAccount: adaptScopedAccountAccessor(resolveMatrixAccount),
    resolveSources: (account) => [Object.keys(account.config.groups ?? account.config.rooms ?? {})],
    normalizeId: (entry) => {
      const raw = entry.replace(/^matrix:/i, "").trim();
      if (!raw || raw === "*") {
        return null;
      }
      const lowered = normalizeLowercaseStringOrEmpty(raw);
      if (lowered.startsWith("room:") || lowered.startsWith("channel:")) {
        return raw;
      }
      return raw.startsWith("!") ? `room:${raw}` : raw;
    },
  });

function projectMatrixConversationBinding(binding: {
  boundAt: number;
  metadata?: {
    lastActivityAt?: number;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
  };
}) {
  return {
    boundAt: binding.boundAt,
    lastActivityAt:
      typeof binding.metadata?.lastActivityAt === "number"
        ? binding.metadata.lastActivityAt
        : binding.boundAt,
    idleTimeoutMs:
      typeof binding.metadata?.idleTimeoutMs === "number"
        ? binding.metadata.idleTimeoutMs
        : undefined,
    maxAgeMs:
      typeof binding.metadata?.maxAgeMs === "number" ? binding.metadata.maxAgeMs : undefined,
  };
}

const resolveMatrixDmPolicy = createScopedDmSecurityResolver<ResolvedMatrixAccount>({
  channelKey: "matrix",
  resolvePolicy: (account) => account.config.dm?.policy,
  resolveAllowFrom: (account) => account.config.dm?.allowFrom,
  allowFromPathSuffix: "dm.",
  normalizeEntry: (raw) => normalizeMatrixUserId(raw),
});

const collectMatrixSecurityWarnings =
  createAllowlistProviderOpenWarningCollector<ResolvedMatrixAccount>({
    providerConfigPresent: (cfg) => (cfg as CoreConfig).channels?.matrix !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    buildOpenWarning: {
      surface: "Matrix rooms",
      openBehavior: "allows any room to trigger (mention-gated)",
      remediation:
        'Set channels.matrix.groupPolicy="allowlist" + channels.matrix.groups (and optionally channels.matrix.groupAllowFrom) to restrict rooms',
    },
  });

function resolveMatrixAccountConfigPath(accountId: string, field: string): string {
  return accountId === DEFAULT_ACCOUNT_ID
    ? `channels.matrix.${field}`
    : `channels.matrix.accounts.${accountId}.${field}`;
}

function collectMatrixSecurityWarningsForAccount(params: {
  account: ResolvedMatrixAccount;
  cfg: CoreConfig;
}): string[] {
  const warnings = collectMatrixSecurityWarnings(params);
  if (params.account.accountId !== DEFAULT_ACCOUNT_ID) {
    const groupPolicyPath = resolveMatrixAccountConfigPath(params.account.accountId, "groupPolicy");
    const groupsPath = resolveMatrixAccountConfigPath(params.account.accountId, "groups");
    const groupAllowFromPath = resolveMatrixAccountConfigPath(
      params.account.accountId,
      "groupAllowFrom",
    );
    return warnings.map((warning) =>
      warning
        .replace("channels.matrix.groupPolicy", groupPolicyPath)
        .replace("channels.matrix.groups", groupsPath)
        .replace("channels.matrix.groupAllowFrom", groupAllowFromPath),
    );
  }
  if (params.account.config.autoJoin !== "always") {
    return warnings;
  }
  const autoJoinPath = resolveMatrixAccountConfigPath(params.account.accountId, "autoJoin");
  const autoJoinAllowlistPath = resolveMatrixAccountConfigPath(
    params.account.accountId,
    "autoJoinAllowlist",
  );
  return [
    ...warnings,
    `- Matrix invites: autoJoin="always" joins any invited room before message policy applies. Set ${autoJoinPath}="allowlist" + ${autoJoinAllowlistPath} (or ${autoJoinPath}="off") to restrict joins.`,
  ];
}

function normalizeMatrixAcpConversationId(conversationId: string) {
  const target = resolveMatrixTargetIdentity(conversationId);
  if (!target || target.kind !== "room") {
    return null;
  }
  return { conversationId: target.id };
}

function matchMatrixAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}) {
  const binding = normalizeMatrixAcpConversationId(params.bindingConversationId);
  if (!binding) {
    return null;
  }
  if (binding.conversationId === params.conversationId) {
    return { conversationId: params.conversationId, matchPriority: 2 };
  }
  if (
    params.parentConversationId &&
    params.parentConversationId !== params.conversationId &&
    binding.conversationId === params.parentConversationId
  ) {
    return {
      conversationId: params.parentConversationId,
      matchPriority: 1,
    };
  }
  return null;
}

function resolveMatrixCommandConversation(params: {
  threadId?: string;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
}) {
  const parentConversationId = [params.originatingTo, params.commandTo, params.fallbackTo]
    .map((candidate) => {
      const trimmed = candidate?.trim();
      if (!trimmed) {
        return undefined;
      }
      const target = resolveMatrixTargetIdentity(trimmed);
      return target?.kind === "room" ? target.id : undefined;
    })
    .find((candidate): candidate is string => Boolean(candidate));
  if (params.threadId) {
    return {
      conversationId: params.threadId,
      ...(parentConversationId ? { parentConversationId } : {}),
    };
  }
  return parentConversationId ? { conversationId: parentConversationId } : null;
}

function resolveMatrixDeliveryTarget(params: {
  conversationId: string;
  parentConversationId?: string;
}) {
  const parentConversationId = params.parentConversationId?.trim();
  if (parentConversationId && parentConversationId !== params.conversationId.trim()) {
    const parentTarget = resolveMatrixTargetIdentity(parentConversationId);
    if (parentTarget?.kind === "room") {
      return {
        to: `room:${parentTarget.id}`,
        threadId: params.conversationId.trim(),
      };
    }
  }
  const conversationTarget = resolveMatrixTargetIdentity(params.conversationId);
  if (conversationTarget?.kind === "room") {
    return { to: `room:${conversationTarget.id}` };
  }
  return null;
}

export const matrixPlugin: ChannelPlugin<ResolvedMatrixAccount, MatrixProbe> =
  createChatChannelPlugin<ResolvedMatrixAccount, MatrixProbe>({
    base: {
      id: "matrix",
      meta,
      setupWizard: matrixSetupWizard,
      capabilities: {
        chatTypes: ["direct", "group", "thread"],
        polls: true,
        reactions: true,
        threads: true,
        media: true,
      },
      reload: { configPrefixes: ["channels.matrix"] },
      configSchema: buildChannelConfigSchema(MatrixConfigSchema),
      config: {
        ...matrixConfigAdapter,
        isConfigured: (account) => account.configured,
        describeAccount: (account) =>
          describeAccountSnapshot({
            account,
            configured: account.configured,
            extra: {
              baseUrl: account.homeserver,
            },
          }),
      },
      approvalCapability: matrixApprovalCapability,
      groups: {
        resolveRequireMention: resolveMatrixGroupRequireMention,
        resolveToolPolicy: resolveMatrixGroupToolPolicy,
      },
      conversationBindings: {
        supportsCurrentConversationBinding: true,
        defaultTopLevelPlacement: "child",
        setIdleTimeoutBySessionKey: ({ targetSessionKey, accountId, idleTimeoutMs }) =>
          setMatrixThreadBindingIdleTimeoutBySessionKey({
            targetSessionKey,
            accountId: accountId ?? "",
            idleTimeoutMs,
          }).map(projectMatrixConversationBinding),
        setMaxAgeBySessionKey: ({ targetSessionKey, accountId, maxAgeMs }) =>
          setMatrixThreadBindingMaxAgeBySessionKey({
            targetSessionKey,
            accountId: accountId ?? "",
            maxAgeMs,
          }).map(projectMatrixConversationBinding),
      },
      messaging: {
        normalizeTarget: normalizeMatrixMessagingTarget,
        resolveInboundConversation: ({ to, conversationId, threadId }) =>
          resolveMatrixInboundConversation({ to, conversationId, threadId }),
        resolveDeliveryTarget: ({ conversationId, parentConversationId }) =>
          resolveMatrixDeliveryTarget({ conversationId, parentConversationId }),
        resolveOutboundSessionRoute: (params) => resolveMatrixOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: (raw) => {
            const trimmed = raw.trim();
            if (!trimmed) {
              return false;
            }
            if (/^(matrix:)?[!#@]/i.test(trimmed)) {
              return true;
            }
            return trimmed.includes(":");
          },
          hint: "<room|alias|user>",
        },
      },
      directory: createChannelDirectoryAdapter({
        listPeers: async (params) => {
          const entries = await listMatrixDirectoryPeersFromConfig(params);
          return entries.map((entry) => {
            const raw = entry.id.startsWith("user:") ? entry.id.slice("user:".length) : entry.id;
            const incomplete = !raw.startsWith("@") || !raw.includes(":");
            return incomplete ? { ...entry, name: "incomplete id; expected @user:server" } : entry;
          });
        },
        listGroups: async (params) => await listMatrixDirectoryGroupsFromConfig(params),
        ...createRuntimeDirectoryLiveAdapter({
          getRuntime: loadMatrixChannelRuntime,
          listPeersLive: (runtime) => runtime.listMatrixDirectoryPeersLive,
          listGroupsLive: (runtime) => runtime.listMatrixDirectoryGroupsLive,
        }),
      }),
      resolver: matrixResolverAdapter,
      actions: matrixMessageActions,
      secrets: {
        secretTargetRegistryEntries,
        collectRuntimeConfigAssignments,
      },
      setup: {
        ...matrixSetupAdapter,
        singleAccountKeysToMove,
        namedAccountPromotionKeys,
        resolveSingleAccountPromotionTarget,
      },
      bindings: {
        compileConfiguredBinding: ({ conversationId }) =>
          normalizeMatrixAcpConversationId(conversationId),
        matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) =>
          matchMatrixAcpConversation({
            bindingConversationId: compiledBinding.conversationId,
            conversationId,
            parentConversationId,
          }),
        resolveCommandConversation: ({ threadId, originatingTo, commandTo, fallbackTo }) =>
          resolveMatrixCommandConversation({
            threadId,
            originatingTo,
            commandTo,
            fallbackTo,
          }),
      },
      status: createComputedAccountStatusAdapter<ResolvedMatrixAccount, MatrixProbe>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("matrix", accounts),
        buildChannelSummary: ({ snapshot }) =>
          buildProbeChannelStatusSummary(snapshot, { baseUrl: snapshot.baseUrl ?? null }),
        probeAccount: async ({ account, timeoutMs, cfg }) =>
          await createMatrixProbeAccount({
            resolveMatrixAuth: async ({ cfg, accountId }) =>
              (await loadMatrixChannelRuntime()).resolveMatrixAuth({
                cfg,
                accountId,
              }),
            probeMatrix: async (params) =>
              await (await loadMatrixChannelRuntime()).probeMatrix(params),
          })({
            account,
            timeoutMs,
            cfg,
          }),
        resolveAccountSnapshot: ({ account, runtime }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            baseUrl: account.homeserver,
            lastProbeAt: runtime?.lastProbeAt ?? null,
            ...buildTrafficStatusSummary(runtime),
          },
        }),
      }),
      gateway: {
        startAccount: async (ctx) => {
          const account = ctx.account;
          ctx.setStatus({
            accountId: account.accountId,
            baseUrl: account.homeserver,
          });
          ctx.log?.info(
            `[${account.accountId}] starting provider (${account.homeserver ?? "matrix"})`,
          );

          // Serialize startup: wait for any previous startup to complete import phase.
          // This works around a race condition with concurrent dynamic imports.
          //
          // INVARIANT: The import() below cannot hang because:
          // 1. It only loads local ESM modules with no circular awaits
          // 2. Module initialization is synchronous (no top-level await in ./matrix/monitor/index.js)
          // 3. The lock only serializes the import phase, not the provider startup
          const previousLock = matrixStartupLock;
          let releaseLock: () => void = () => {};
          matrixStartupLock = new Promise<void>((resolve) => {
            releaseLock = resolve;
          });
          await previousLock;

          // Lazy import: the monitor pulls the reply pipeline; avoid ESM init cycles.
          // Wrap in try/finally to ensure lock is released even if import fails.
          let monitorMatrixProvider: typeof import("./matrix/monitor/index.js").monitorMatrixProvider;
          try {
            const module = await import("./matrix/monitor/index.js");
            monitorMatrixProvider = module.monitorMatrixProvider;
          } finally {
            // Release lock after import completes or fails
            releaseLock();
          }

          return monitorMatrixProvider({
            runtime: ctx.runtime,
            channelRuntime: ctx.channelRuntime,
            abortSignal: ctx.abortSignal,
            mediaMaxMb: account.config.mediaMaxMb,
            initialSyncLimit: account.config.initialSyncLimit,
            replyToMode: account.config.replyToMode,
            accountId: account.accountId,
            setStatus: ctx.setStatus,
          });
        },
      },
      doctor: matrixDoctor,
      lifecycle: {
        runStartupMaintenance: runMatrixStartupMaintenance,
      },
    },
    security: {
      resolveDmPolicy: resolveMatrixDmPolicy,
      collectWarnings: projectAccountConfigWarningCollector(
        (cfg) => cfg as CoreConfig,
        collectMatrixSecurityWarningsForAccount,
      ),
    },
    pairing: {
      text: createMatrixPairingText(
        async (to, message, options) =>
          await (await loadMatrixChannelRuntime()).sendMessageMatrix(to, message, options),
      ),
    },
    threading: {
      resolveReplyToMode: createScopedAccountReplyToModeResolver<
        ReturnType<typeof resolveMatrixAccountConfig>
      >({
        resolveAccount: adaptScopedAccountAccessor(resolveMatrixAccountConfig),
        resolveReplyToMode: (account) => account.replyToMode,
      }),
      buildToolContext: ({ context, hasRepliedRef }) => {
        const currentTarget = context.To;
        return {
          currentChannelId: normalizeOptionalString(currentTarget),
          currentThreadTs:
            context.MessageThreadId != null ? String(context.MessageThreadId) : undefined,
          currentDirectUserId: resolveMatrixDirectUserId({
            from: context.From,
            to: context.To,
            chatType: context.ChatType,
          }),
          hasRepliedRef,
        };
      },
    },
    outbound: {
      deliveryMode: "direct",
      chunker: chunkTextForOutbound,
      chunkerMode: "markdown",
      textChunkLimit: 4000,
      shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload }) =>
        shouldSuppressLocalMatrixExecApprovalPrompt({
          cfg,
          accountId,
          payload,
        }),
      ...createRuntimeOutboundDelegates({
        getRuntime: loadMatrixChannelRuntime,
        sendText: {
          resolve: (runtime) => runtime.matrixOutbound.sendText,
          unavailableMessage: "Matrix outbound text delivery is unavailable",
        },
        sendMedia: {
          resolve: (runtime) => runtime.matrixOutbound.sendMedia,
          unavailableMessage: "Matrix outbound media delivery is unavailable",
        },
        sendPoll: {
          resolve: (runtime) => runtime.matrixOutbound.sendPoll,
          unavailableMessage: "Matrix outbound poll delivery is unavailable",
        },
      }),
    },
  });
