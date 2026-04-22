import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  composeAccountWarningCollectors,
  createAllowlistProviderOpenWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import {
  createChannelDirectoryAdapter,
  createResolvedDirectoryEntriesLister,
} from "openclaw/plugin-sdk/directory-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  listIrcAccountIds,
  resolveDefaultIrcAccountId,
  resolveIrcAccount,
  type ResolvedIrcAccount,
} from "./accounts.js";
import {
  buildBaseChannelStatusSummary,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  type ChannelPlugin,
} from "./channel-api.js";
import { IrcChannelConfigSchema } from "./config-schema.js";
import { collectIrcMutableAllowlistWarnings } from "./doctor.js";
import { startIrcGatewayAccount } from "./gateway.js";
import {
  isChannelTarget,
  looksLikeIrcTargetId,
  normalizeIrcAllowEntry,
  normalizeIrcMessagingTarget,
} from "./normalize.js";
import { ircOutboundBaseAdapter } from "./outbound-base.js";
import { resolveIrcGroupMatch, resolveIrcRequireMention } from "./policy.js";
import { probeIrc } from "./probe.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { ircSetupAdapter } from "./setup-core.js";
import { ircSetupWizard } from "./setup-surface.js";
import type { CoreConfig, IrcProbe } from "./types.js";

const meta = {
  id: "irc",
  label: "IRC",
  selectionLabel: "IRC (Server + Nick)",
  docsPath: "/channels/irc",
  docsLabel: "irc",
  blurb: "classic IRC networks; host, nick, channels.",
  order: 80,
  detailLabel: "IRC",
  systemImage: "number",
  markdownCapable: true,
};

type IrcChannelRuntimeModule = typeof import("./channel-runtime.js");

let ircChannelRuntimePromise: Promise<IrcChannelRuntimeModule> | undefined;

async function loadIrcChannelRuntime(): Promise<IrcChannelRuntimeModule> {
  ircChannelRuntimePromise ??= import("./channel-runtime.js");
  return await ircChannelRuntimePromise;
}

function normalizePairingTarget(raw: string): string {
  const normalized = normalizeIrcAllowEntry(raw);
  if (!normalized) {
    return "";
  }
  return normalized.split(/[!@]/, 1)[0]?.trim() ?? "";
}

const listIrcDirectoryPeersFromConfig = createResolvedDirectoryEntriesLister<ResolvedIrcAccount>({
  kind: "user",
  resolveAccount: adaptScopedAccountAccessor(resolveIrcAccount),
  resolveSources: (account) => [
    account.config.allowFrom ?? [],
    account.config.groupAllowFrom ?? [],
    ...Object.values(account.config.groups ?? {}).map((group) => group.allowFrom ?? []),
  ],
  normalizeId: (entry) => normalizePairingTarget(entry) || null,
});

const listIrcDirectoryGroupsFromConfig = createResolvedDirectoryEntriesLister<ResolvedIrcAccount>({
  kind: "group",
  resolveAccount: adaptScopedAccountAccessor(resolveIrcAccount),
  resolveSources: (account) => [
    account.config.channels ?? [],
    Object.keys(account.config.groups ?? {}),
  ],
  normalizeId: (entry) => {
    const normalized = normalizeIrcMessagingTarget(entry);
    return normalized && isChannelTarget(normalized) ? normalized : null;
  },
});

const ircConfigAdapter = createScopedChannelConfigAdapter<ResolvedIrcAccount, ResolvedIrcAccount>({
  sectionKey: "irc",
  listAccountIds: listIrcAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveIrcAccount),
  defaultAccountId: resolveDefaultIrcAccountId,
  clearBaseFields: [
    "name",
    "host",
    "port",
    "tls",
    "nick",
    "username",
    "realname",
    "password",
    "passwordFile",
    "channels",
  ],
  resolveAllowFrom: (account: ResolvedIrcAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: normalizeIrcAllowEntry,
    }),
  resolveDefaultTo: (account: ResolvedIrcAccount) => account.config.defaultTo,
});

const resolveIrcDmPolicy = createScopedDmSecurityResolver<ResolvedIrcAccount>({
  channelKey: "irc",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => normalizeIrcAllowEntry(raw),
});

const collectIrcGroupPolicyWarnings =
  createAllowlistProviderOpenWarningCollector<ResolvedIrcAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.irc !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    buildOpenWarning: {
      surface: "IRC channels",
      openBehavior: "allows all channels and senders (mention-gated)",
      remediation: 'Prefer channels.irc.groupPolicy="allowlist" with channels.irc.groups',
    },
  });

const collectIrcSecurityWarnings = composeAccountWarningCollectors<
  ResolvedIrcAccount,
  {
    account: ResolvedIrcAccount;
    cfg: CoreConfig;
  }
>(
  collectIrcGroupPolicyWarnings,
  (account) =>
    !account.config.tls &&
    "- IRC TLS is disabled (channels.irc.tls=false); traffic and credentials are plaintext.",
  (account) =>
    account.config.nickserv?.register &&
    '- IRC NickServ registration is enabled (channels.irc.nickserv.register=true); this sends "REGISTER" on every connect. Disable after first successful registration.',
  (account) =>
    account.config.nickserv?.register &&
    !account.config.nickserv.password?.trim() &&
    "- IRC NickServ registration is enabled but no NickServ password is resolved; set channels.irc.nickserv.password, channels.irc.nickserv.passwordFile, or IRC_NICKSERV_PASSWORD.",
);

export const ircPlugin: ChannelPlugin<ResolvedIrcAccount, IrcProbe> = createChatChannelPlugin({
  base: {
    id: "irc",
    meta: {
      ...meta,
      quickstartAllowFrom: true,
    },
    setup: ircSetupAdapter,
    setupWizard: ircSetupWizard,
    capabilities: {
      chatTypes: ["direct", "group"],
      media: true,
      blockStreaming: true,
    },
    reload: { configPrefixes: ["channels.irc"] },
    configSchema: IrcChannelConfigSchema,
    config: {
      ...ircConfigAdapter,
      hasConfiguredState: ({ env }) =>
        typeof env?.IRC_HOST === "string" &&
        env.IRC_HOST.trim().length > 0 &&
        typeof env?.IRC_NICK === "string" &&
        env.IRC_NICK.trim().length > 0,
      isConfigured: (account) => account.configured,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            host: account.host,
            port: account.port,
            tls: account.tls,
            nick: account.nick,
            passwordSource: account.passwordSource,
          },
        }),
    },
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
    doctor: {
      groupAllowFromFallbackToAllowFrom: false,
      collectMutableAllowlistWarnings: collectIrcMutableAllowlistWarnings,
    },
    groups: {
      resolveRequireMention: ({ cfg, accountId, groupId }) => {
        const account = resolveIrcAccount({ cfg: cfg as CoreConfig, accountId });
        if (!groupId) {
          return true;
        }
        const match = resolveIrcGroupMatch({ groups: account.config.groups, target: groupId });
        return resolveIrcRequireMention({
          groupConfig: match.groupConfig,
          wildcardConfig: match.wildcardConfig,
        });
      },
      resolveToolPolicy: ({ cfg, accountId, groupId }) => {
        const account = resolveIrcAccount({ cfg: cfg as CoreConfig, accountId });
        if (!groupId) {
          return undefined;
        }
        const match = resolveIrcGroupMatch({ groups: account.config.groups, target: groupId });
        return match.groupConfig?.tools ?? match.wildcardConfig?.tools;
      },
    },
    messaging: {
      normalizeTarget: normalizeIrcMessagingTarget,
      targetResolver: {
        looksLikeId: looksLikeIrcTargetId,
        hint: "<#channel|nick>",
      },
    },
    resolver: {
      resolveTargets: async ({ inputs, kind }) => {
        return inputs.map((input) => {
          const normalized = normalizeIrcMessagingTarget(input);
          if (!normalized) {
            return {
              input,
              resolved: false,
              note: "invalid IRC target",
            };
          }
          if (kind === "group") {
            const groupId = isChannelTarget(normalized) ? normalized : `#${normalized}`;
            return {
              input,
              resolved: true,
              id: groupId,
              name: groupId,
            };
          }
          if (isChannelTarget(normalized)) {
            return {
              input,
              resolved: false,
              note: "expected user target",
            };
          }
          return {
            input,
            resolved: true,
            id: normalized,
            name: normalized,
          };
        });
      },
    },
    directory: createChannelDirectoryAdapter({
      listPeers: async (params) => listIrcDirectoryPeersFromConfig(params),
      listGroups: async (params) => {
        const entries = await listIrcDirectoryGroupsFromConfig(params);
        return entries.map((entry) => Object.assign({}, entry, { name: entry.id }));
      },
    }),
    status: createComputedAccountStatusAdapter<ResolvedIrcAccount, IrcProbe>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      buildChannelSummary: ({ account, snapshot }) => ({
        ...buildBaseChannelStatusSummary(snapshot),
        host: account.host,
        port: snapshot.port,
        tls: account.tls,
        nick: account.nick,
        probe: snapshot.probe,
        lastProbeAt: snapshot.lastProbeAt ?? null,
      }),
      probeAccount: async ({ cfg, account, timeoutMs }) =>
        probeIrc(cfg as CoreConfig, { accountId: account.accountId, timeoutMs }),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        extra: {
          host: account.host,
          port: account.port,
          tls: account.tls,
          nick: account.nick,
          passwordSource: account.passwordSource,
        },
      }),
    }),
    gateway: {
      startAccount: async (ctx) =>
        await startIrcGatewayAccount({
          ...ctx,
          cfg: ctx.cfg as CoreConfig,
        }),
    },
  },
  pairing: {
    text: {
      idLabel: "ircUser",
      message: PAIRING_APPROVED_MESSAGE,
      normalizeAllowEntry: (entry) => normalizeIrcAllowEntry(entry),
      notify: async ({ cfg, id, message }) => {
        const target = normalizePairingTarget(id);
        if (!target) {
          throw new Error(`invalid IRC pairing id: ${id}`);
        }
        const { sendMessageIrc } = await loadIrcChannelRuntime();
        await sendMessageIrc(target, message, {
          cfg: cfg as CoreConfig,
        });
      },
    },
  },
  security: {
    resolveDmPolicy: resolveIrcDmPolicy,
    collectWarnings: collectIrcSecurityWarnings,
  },
  outbound: {
    base: ircOutboundBaseAdapter,
    attachedResults: {
      channel: "irc",
      sendText: async ({ cfg, to, text, accountId, replyToId }) => {
        const { sendMessageIrc } = await loadIrcChannelRuntime();
        return await sendMessageIrc(to, text, {
          cfg: cfg as CoreConfig,
          accountId: accountId ?? undefined,
          replyTo: replyToId ?? undefined,
        });
      },
      sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => {
        const { sendMessageIrc } = await loadIrcChannelRuntime();
        return await sendMessageIrc(to, mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text, {
          cfg: cfg as CoreConfig,
          accountId: accountId ?? undefined,
          replyTo: replyToId ?? undefined,
        });
      },
    },
  },
});
