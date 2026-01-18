import { createActionGate, readNumberParam, readStringParam } from "../../agents/tools/common.js";
import { handleSlackAction } from "../../agents/tools/slack-actions.js";
import { loadConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import {
  listEnabledSlackAccounts,
  listSlackAccountIds,
  type ResolvedSlackAccount,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
} from "../../slack/accounts.js";
import { resolveSlackChannelAllowlist } from "../../slack/resolve-channels.js";
import { resolveSlackUserAllowlist } from "../../slack/resolve-users.js";
import { probeSlack } from "../../slack/probe.js";
import { sendMessageSlack } from "../../slack/send.js";
import { getChatChannelMeta } from "../registry.js";
import { SlackConfigSchema } from "../../config/zod-schema.providers-core.js";
import { buildChannelConfigSchema } from "./config-schema.js";
import {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "./config-helpers.js";
import { resolveSlackGroupRequireMention } from "./group-mentions.js";
import { formatPairingApproveHint } from "./helpers.js";
import { looksLikeSlackTargetId, normalizeSlackMessagingTarget } from "./normalize/slack.js";
import { slackOnboardingAdapter } from "./onboarding/slack.js";
import { PAIRING_APPROVED_MESSAGE } from "./pairing-message.js";
import {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "./setup-helpers.js";
import type { ChannelMessageActionName, ChannelPlugin } from "./types.js";
import {
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
} from "./directory-config.js";
import {
  listSlackDirectoryGroupsLive,
  listSlackDirectoryPeersLive,
} from "../../slack/directory-live.js";

const meta = getChatChannelMeta("slack");

// Select the appropriate Slack token for read/write operations.
function getTokenForOperation(
  account: ResolvedSlackAccount,
  operation: "read" | "write",
): string | undefined {
  const userToken = account.config.userToken?.trim() || undefined;
  const botToken = account.botToken?.trim();
  const allowUserWrites = account.config.userTokenReadOnly === false;
  if (operation === "read") return userToken ?? botToken;
  if (!allowUserWrites) return botToken;
  return botToken ?? userToken;
}

export const slackPlugin: ChannelPlugin<ResolvedSlackAccount> = {
  id: "slack",
  meta: {
    ...meta,
  },
  onboarding: slackOnboardingAdapter,
  pairing: {
    idLabel: "slackUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(slack|user):/i, ""),
    notifyApproval: async ({ id }) => {
      const cfg = loadConfig();
      const account = resolveSlackAccount({
        cfg,
        accountId: DEFAULT_ACCOUNT_ID,
      });
      const token = getTokenForOperation(account, "write");
      const botToken = account.botToken?.trim();
      const tokenOverride = token && token !== botToken ? token : undefined;
      if (tokenOverride) {
        await sendMessageSlack(`user:${id}`, PAIRING_APPROVED_MESSAGE, {
          token: tokenOverride,
        });
      } else {
        await sendMessageSlack(`user:${id}`, PAIRING_APPROVED_MESSAGE);
      }
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.slack"] },
  configSchema: buildChannelConfigSchema(SlackConfigSchema),
  config: {
    listAccountIds: (cfg) => listSlackAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveSlackAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultSlackAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "slack",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "slack",
        accountId,
        clearBaseFields: ["botToken", "appToken", "name"],
      }),
    isConfigured: (account) => Boolean(account.botToken && account.appToken),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.botToken && account.appToken),
      botTokenSource: account.botTokenSource,
      appTokenSource: account.appTokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveSlackAccount({ cfg, accountId }).dm?.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.slack?.accounts?.[resolvedAccountId]);
      const allowFromPath = useAccountPath
        ? `channels.slack.accounts.${resolvedAccountId}.dm.`
        : "channels.slack.dm.";
      return {
        policy: account.dm?.policy ?? "pairing",
        allowFrom: account.dm?.allowFrom ?? [],
        allowFromPath,
        approveHint: formatPairingApproveHint("slack"),
        normalizeEntry: (raw) => raw.replace(/^(slack|user):/i, ""),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "open";
      const channelAllowlistConfigured =
        Boolean(account.config.channels) && Object.keys(account.config.channels ?? {}).length > 0;

      if (groupPolicy === "open") {
        if (channelAllowlistConfigured) {
          warnings.push(
            `- Slack channels: groupPolicy="open" allows any channel not explicitly denied to trigger (mention-gated). Set channels.slack.groupPolicy="allowlist" and configure channels.slack.channels.`,
          );
        } else {
          warnings.push(
            `- Slack channels: groupPolicy="open" with no channel allowlist; any channel can trigger (mention-gated). Set channels.slack.groupPolicy="allowlist" and configure channels.slack.channels.`,
          );
        }
      }

      return warnings;
    },
  },
  groups: {
    resolveRequireMention: resolveSlackGroupRequireMention,
  },
  threading: {
    resolveReplyToMode: ({ cfg, accountId }) =>
      resolveSlackAccount({ cfg, accountId }).replyToMode ?? "off",
    allowTagsWhenOff: true,
    buildToolContext: ({ cfg, accountId, context, hasRepliedRef }) => {
      const configuredReplyToMode = resolveSlackAccount({ cfg, accountId }).replyToMode ?? "off";
      const effectiveReplyToMode = context.ThreadLabel ? "all" : configuredReplyToMode;
      return {
        currentChannelId: context.To?.startsWith("channel:")
          ? context.To.slice("channel:".length)
          : undefined,
        currentThreadTs: context.ReplyToId,
        replyToMode: effectiveReplyToMode,
        hasRepliedRef,
      };
    },
  },
  messaging: {
    normalizeTarget: normalizeSlackMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeSlackTargetId,
      hint: "<channelId|user:ID|channel:ID>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async (params) => listSlackDirectoryPeersFromConfig(params),
    listGroups: async (params) => listSlackDirectoryGroupsFromConfig(params),
    listPeersLive: async (params) => listSlackDirectoryPeersLive(params),
    listGroupsLive: async (params) => listSlackDirectoryGroupsLive(params),
  },
  resolver: {
    resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
      const account = resolveSlackAccount({ cfg, accountId });
      const token = account.config.userToken?.trim() || account.botToken?.trim();
      if (!token) {
        return inputs.map((input) => ({
          input,
          resolved: false,
          note: "missing Slack token",
        }));
      }
      if (kind === "group") {
        const resolved = await resolveSlackChannelAllowlist({ token, entries: inputs });
        return resolved.map((entry) => ({
          input: entry.input,
          resolved: entry.resolved,
          id: entry.id,
          name: entry.name,
          note: entry.archived ? "archived" : undefined,
        }));
      }
      const resolved = await resolveSlackUserAllowlist({ token, entries: inputs });
      return resolved.map((entry) => ({
        input: entry.input,
        resolved: entry.resolved,
        id: entry.id,
        name: entry.name,
        note: entry.note,
      }));
    },
  },
  actions: {
    listActions: ({ cfg }) => {
      const accounts = listEnabledSlackAccounts(cfg).filter(
        (account) => account.botTokenSource !== "none",
      );
      if (accounts.length === 0) return [];
      const isActionEnabled = (key: string, defaultValue = true) => {
        for (const account of accounts) {
          const gate = createActionGate(
            (account.actions ?? cfg.channels?.slack?.actions) as Record<
              string,
              boolean | undefined
            >,
          );
          if (gate(key, defaultValue)) return true;
        }
        return false;
      };

      const actions = new Set<ChannelMessageActionName>(["send"]);
      if (isActionEnabled("reactions")) {
        actions.add("react");
        actions.add("reactions");
      }
      if (isActionEnabled("messages")) {
        actions.add("read");
        actions.add("edit");
        actions.add("delete");
      }
      if (isActionEnabled("pins")) {
        actions.add("pin");
        actions.add("unpin");
        actions.add("list-pins");
      }
      if (isActionEnabled("memberInfo")) actions.add("member-info");
      if (isActionEnabled("emojiList")) actions.add("emoji-list");
      return Array.from(actions);
    },
    extractToolSend: ({ args }) => {
      const action = typeof args.action === "string" ? args.action.trim() : "";
      if (action !== "sendMessage") return null;
      const to = typeof args.to === "string" ? args.to : undefined;
      if (!to) return null;
      const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
      return { to, accountId };
    },
    handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
      const resolveChannelId = () =>
        readStringParam(params, "channelId") ?? readStringParam(params, "to", { required: true });

      if (action === "send") {
        const to = readStringParam(params, "to", { required: true });
        const content = readStringParam(params, "message", {
          required: true,
          allowEmpty: true,
        });
        const mediaUrl = readStringParam(params, "media", { trim: false });
        const threadId = readStringParam(params, "threadId");
        const replyTo = readStringParam(params, "replyTo");
        return await handleSlackAction(
          {
            action: "sendMessage",
            to,
            content,
            mediaUrl: mediaUrl ?? undefined,
            accountId: accountId ?? undefined,
            threadTs: threadId ?? replyTo ?? undefined,
          },
          cfg,
          toolContext,
        );
      }

      if (action === "react") {
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const emoji = readStringParam(params, "emoji", { allowEmpty: true });
        const remove = typeof params.remove === "boolean" ? params.remove : undefined;
        return await handleSlackAction(
          {
            action: "react",
            channelId: resolveChannelId(),
            messageId,
            emoji,
            remove,
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      if (action === "reactions") {
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const limit = readNumberParam(params, "limit", { integer: true });
        return await handleSlackAction(
          {
            action: "reactions",
            channelId: resolveChannelId(),
            messageId,
            limit,
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      if (action === "read") {
        const limit = readNumberParam(params, "limit", { integer: true });
        return await handleSlackAction(
          {
            action: "readMessages",
            channelId: resolveChannelId(),
            limit,
            before: readStringParam(params, "before"),
            after: readStringParam(params, "after"),
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      if (action === "edit") {
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const content = readStringParam(params, "message", { required: true });
        return await handleSlackAction(
          {
            action: "editMessage",
            channelId: resolveChannelId(),
            messageId,
            content,
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      if (action === "delete") {
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        return await handleSlackAction(
          {
            action: "deleteMessage",
            channelId: resolveChannelId(),
            messageId,
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      if (action === "pin" || action === "unpin" || action === "list-pins") {
        const messageId =
          action === "list-pins"
            ? undefined
            : readStringParam(params, "messageId", { required: true });
        return await handleSlackAction(
          {
            action:
              action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
            channelId: resolveChannelId(),
            messageId,
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      if (action === "member-info") {
        const userId = readStringParam(params, "userId", { required: true });
        return await handleSlackAction(
          { action: "memberInfo", userId, accountId: accountId ?? undefined },
          cfg,
        );
      }

      if (action === "emoji-list") {
        return await handleSlackAction(
          { action: "emojiList", accountId: accountId ?? undefined },
          cfg,
        );
      }

      throw new Error(`Action ${action} is not supported for provider ${meta.id}.`);
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "slack",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "Slack env tokens can only be used for the default account.";
      }
      if (!input.useEnv && (!input.botToken || !input.appToken)) {
        return "Slack requires --bot-token and --app-token (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "slack",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "slack",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            slack: {
              ...next.channels?.slack,
              enabled: true,
              ...(input.useEnv
                ? {}
                : {
                    ...(input.botToken ? { botToken: input.botToken } : {}),
                    ...(input.appToken ? { appToken: input.appToken } : {}),
                  }),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          slack: {
            ...next.channels?.slack,
            enabled: true,
            accounts: {
              ...next.channels?.slack?.accounts,
              [accountId]: {
                ...next.channels?.slack?.accounts?.[accountId],
                enabled: true,
                ...(input.botToken ? { botToken: input.botToken } : {}),
                ...(input.appToken ? { appToken: input.appToken } : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: null,
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId, deps, replyToId, cfg }) => {
      const send = deps?.sendSlack ?? sendMessageSlack;
      const account = resolveSlackAccount({ cfg, accountId });
      const token = getTokenForOperation(account, "write");
      const botToken = account.botToken?.trim();
      const tokenOverride = token && token !== botToken ? token : undefined;
      const result = await send(to, text, {
        threadTs: replyToId ?? undefined,
        accountId: accountId ?? undefined,
        ...(tokenOverride ? { token: tokenOverride } : {}),
      });
      return { channel: "slack", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId, cfg }) => {
      const send = deps?.sendSlack ?? sendMessageSlack;
      const account = resolveSlackAccount({ cfg, accountId });
      const token = getTokenForOperation(account, "write");
      const botToken = account.botToken?.trim();
      const tokenOverride = token && token !== botToken ? token : undefined;
      const result = await send(to, text, {
        mediaUrl,
        threadTs: replyToId ?? undefined,
        accountId: accountId ?? undefined,
        ...(tokenOverride ? { token: tokenOverride } : {}),
      });
      return { channel: "slack", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      botTokenSource: snapshot.botTokenSource ?? "none",
      appTokenSource: snapshot.appTokenSource ?? "none",
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      const token = account.botToken?.trim();
      if (!token) return { ok: false, error: "missing token" };
      return await probeSlack(token, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = Boolean(account.botToken && account.appToken);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        botTokenSource: account.botTokenSource,
        appTokenSource: account.appTokenSource,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const botToken = account.botToken?.trim();
      const appToken = account.appToken?.trim();
      ctx.log?.info(`[${account.accountId}] starting provider`);
      // Lazy import: the monitor pulls the reply pipeline; avoid ESM init cycles.
      const { monitorSlackProvider } = await import("../../slack/index.js");
      return monitorSlackProvider({
        botToken: botToken ?? "",
        appToken: appToken ?? "",
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: account.config.mediaMaxMb,
        slashCommand: account.config.slashCommand,
      });
    },
  },
};
