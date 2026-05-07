import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { googleChatApprovalAuth } from "./approval-auth.js";
import {
  formatAllowFromEntry,
  googlechatDirectoryAdapter,
  googlechatGroupsAdapter,
  googlechatMessageAdapter,
  googlechatOutboundAdapter,
  googlechatPairingTextAdapter,
  googlechatSecurityAdapter,
  googlechatThreadingAdapter,
} from "./channel.adapters.js";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  GoogleChatConfigSchema,
  isGoogleChatSpaceTarget,
  isGoogleChatUserTarget,
  listGoogleChatAccountIds,
  normalizeGoogleChatTarget,
  type GoogleChatConfigAccessorAccount,
  resolveGoogleChatConfigAccessorAccount,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccount,
  type ChannelMessageActionAdapter,
  type ChannelStatusIssue,
  type ResolvedGoogleChatAccount,
} from "./channel.deps.runtime.js";
import {
  legacyConfigRules as GOOGLECHAT_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeGoogleChatCompatibilityConfig,
} from "./doctor-contract.js";
import { collectGoogleChatMutableAllowlistWarnings } from "./doctor.js";
import { startGoogleChatGatewayAccount } from "./gateway.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { googlechatSetupAdapter } from "./setup-core.js";
import { googlechatSetupWizard } from "./setup-surface.js";

const loadGoogleChatChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "googleChatChannelRuntime",
);

const meta = {
  id: "googlechat",
  label: "Google Chat",
  selectionLabel: "Google Chat (Chat API)",
  docsPath: "/channels/googlechat",
  docsLabel: "googlechat",
  blurb: "Google Workspace Chat app with HTTP webhook.",
  aliases: ["gchat", "google-chat"],
  order: 55,
  detailLabel: "Google Chat",
  systemImage: "message.badge",
  markdownCapable: true,
};

const googleChatConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedGoogleChatAccount,
  GoogleChatConfigAccessorAccount
>({
  sectionKey: "googlechat",
  listAccountIds: listGoogleChatAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
  resolveAccessorAccount: resolveGoogleChatConfigAccessorAccount,
  defaultAccountId: resolveDefaultGoogleChatAccountId,
  clearBaseFields: [
    "serviceAccount",
    "serviceAccountFile",
    "audienceType",
    "audience",
    "webhookPath",
    "webhookUrl",
    "botUser",
    "name",
  ],
  resolveAllowFrom: (account) => account.config.dm?.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: formatAllowFromEntry,
    }),
  resolveDefaultTo: (account) => account.config.defaultTo,
});

const googlechatActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const accounts = accountId
      ? [resolveGoogleChatAccount({ cfg, accountId })].filter(
          (account) => account.enabled && account.credentialSource !== "none",
        )
      : listGoogleChatAccountIds(cfg)
          .map((id) => resolveGoogleChatAccount({ cfg, accountId: id }))
          .filter((account) => account.enabled && account.credentialSource !== "none");
    if (accounts.length === 0) {
      return null;
    }
    const actions = new Set<ChannelMessageActionName>(["send", "upload-file"]);
    if (accounts.some((account) => account.config.actions?.reactions !== false)) {
      actions.add("react");
      actions.add("reactions");
    }
    return { actions: Array.from(actions) };
  },
  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
  handleAction: async (ctx) => {
    const { googlechatMessageActions } = await import("./actions.js");
    if (!googlechatMessageActions.handleAction) {
      throw new Error("Google Chat actions are not available.");
    }
    return await googlechatMessageActions.handleAction(ctx);
  },
};

export const googlechatPlugin = createChatChannelPlugin({
  base: {
    id: "googlechat",
    meta: { ...meta },
    setup: googlechatSetupAdapter,
    setupWizard: googlechatSetupWizard,
    capabilities: {
      chatTypes: ["direct", "group", "thread"],
      reactions: true,
      threads: true,
      media: true,
      nativeCommands: false,
      blockStreaming: true,
    },
    streaming: {
      blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
    },
    reload: { configPrefixes: ["channels.googlechat"] },
    configSchema: buildChannelConfigSchema(GoogleChatConfigSchema),
    config: {
      ...googleChatConfigAdapter,
      isConfigured: (account) => account.credentialSource !== "none",
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.credentialSource !== "none",
          extra: {
            credentialSource: account.credentialSource,
          },
        }),
    },
    approvalCapability: googleChatApprovalAuth,
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
    groups: googlechatGroupsAdapter,
    messaging: {
      targetPrefixes: ["googlechat", "google-chat", "gchat"],
      normalizeTarget: normalizeGoogleChatTarget,
      targetResolver: {
        looksLikeId: (raw, normalized) => {
          const value = normalized ?? raw.trim();
          return isGoogleChatSpaceTarget(value) || isGoogleChatUserTarget(value);
        },
        hint: "<spaces/{space}|users/{user}>",
      },
    },
    directory: googlechatDirectoryAdapter,
    message: googlechatMessageAdapter,
    resolver: {
      resolveTargets: async ({ inputs, kind }) => {
        const resolved = inputs.map((input) => {
          const normalized = normalizeGoogleChatTarget(input);
          if (!normalized) {
            return { input, resolved: false, note: "empty target" };
          }
          if (kind === "user" && isGoogleChatUserTarget(normalized)) {
            return { input, resolved: true, id: normalized };
          }
          if (kind === "group" && isGoogleChatSpaceTarget(normalized)) {
            return { input, resolved: true, id: normalized };
          }
          return {
            input,
            resolved: false,
            note: "use spaces/{space} or users/{user}",
          };
        });
        return resolved;
      },
    },
    actions: googlechatActions,
    doctor: {
      dmAllowFromMode: "nestedOnly",
      groupModel: "route",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: false,
      legacyConfigRules: GOOGLECHAT_LEGACY_CONFIG_RULES,
      normalizeCompatibilityConfig: normalizeGoogleChatCompatibilityConfig,
      collectMutableAllowlistWarnings: collectGoogleChatMutableAllowlistWarnings,
    },
    status: createComputedAccountStatusAdapter<ResolvedGoogleChatAccount>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      collectStatusIssues: (accounts): ChannelStatusIssue[] =>
        accounts.flatMap((entry) => {
          const accountId = entry.accountId ?? DEFAULT_ACCOUNT_ID;
          const enabled = entry.enabled !== false;
          const configured = entry.configured === true;
          if (!enabled || !configured) {
            return [];
          }
          const issues: ChannelStatusIssue[] = [];
          if (!entry.audience) {
            issues.push({
              channel: "googlechat",
              accountId,
              kind: "config",
              message: "Google Chat audience is missing (set channels.googlechat.audience).",
              fix: "Set channels.googlechat.audienceType and channels.googlechat.audience.",
            });
          }
          if (!entry.audienceType) {
            issues.push({
              channel: "googlechat",
              accountId,
              kind: "config",
              message: "Google Chat audienceType is missing (app-url or project-number).",
              fix: "Set channels.googlechat.audienceType and channels.googlechat.audience.",
            });
          }
          return issues;
        }),
      buildChannelSummary: ({ snapshot }) =>
        buildPassiveProbedChannelStatusSummary(snapshot, {
          credentialSource: snapshot.credentialSource ?? "none",
          audienceType: snapshot.audienceType ?? null,
          audience: snapshot.audience ?? null,
          webhookPath: snapshot.webhookPath ?? null,
          webhookUrl: snapshot.webhookUrl ?? null,
        }),
      probeAccount: async ({ account }) =>
        (await loadGoogleChatChannelRuntime()).probeGoogleChat(account),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.credentialSource !== "none",
        extra: {
          credentialSource: account.credentialSource,
          audienceType: account.config.audienceType,
          audience: account.config.audience,
          webhookPath: account.config.webhookPath,
          webhookUrl: account.config.webhookUrl,
          dmPolicy: account.config.dm?.policy ?? "pairing",
        },
      }),
    }),
    gateway: {
      startAccount: startGoogleChatGatewayAccount,
    },
  },
  pairing: {
    text: googlechatPairingTextAdapter,
  },
  security: googlechatSecurityAdapter,
  threading: googlechatThreadingAdapter,
  outbound: googlechatOutboundAdapter,
});
