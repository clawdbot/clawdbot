import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { parseThreadSessionSuffix } from "openclaw/plugin-sdk/routing";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { BuzzConfigSchema } from "./config-schema.js";
import {
  listBuzzDirectoryGroupsFromConfig,
  listBuzzDirectoryPeersFromConfig,
} from "./directory-config.js";
import {
  getBuzzDirectorySelf,
  listBuzzDirectoryGroupMembers,
  listBuzzDirectoryGroupsLive,
  listBuzzDirectoryPeersLive,
} from "./directory.js";
import { buzzOutboundAdapter, sendBuzzTyping, startBuzzGatewayAccount } from "./gateway.js";
import { discoverBuzzRooms } from "./room-discovery.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { buzzSetupContract } from "./setup-core.js";
import { buzzSetupWizard } from "./setup-surface.js";
import {
  buildBuzzTarget,
  looksLikeBuzzTarget,
  normalizeBuzzTarget,
  parseBuzzTarget,
} from "./target.js";
import {
  listBuzzAccountIds,
  resolveBuzzAccount,
  resolveDefaultBuzzAccountId,
  type ResolvedBuzzAccount,
} from "./types.js";

const buzzMessageAdapter = createChannelMessageAdapterFromOutbound({
  id: "buzz",
  outbound: buzzOutboundAdapter,
});

type BuzzProbeResult = {
  ok: true;
  publicKey: string;
  roomCount: number;
  rooms: Array<{ id: string; name: string }>;
};

function normalizeBuzzThreadingTarget(target: string | undefined): string | undefined {
  if (!target) {
    return undefined;
  }
  try {
    return parseBuzzTarget(target);
  } catch {
    return undefined;
  }
}

export const buzzPlugin = createChatChannelPlugin<ResolvedBuzzAccount, BuzzProbeResult>({
  base: {
    id: "buzz",
    meta: {
      id: "buzz",
      label: "Buzz",
      selectionLabel: "Buzz",
      docsPath: "/channels/buzz",
      docsLabel: "buzz",
      blurb: "Connect OpenClaw agents to Buzz team rooms.",
      markdownCapable: true,
      order: 56,
    },
    capabilities: {
      chatTypes: ["group"],
      threads: true,
    },
    agentPrompt: {
      messageToolHints: () => [
        "- Buzz targets: use a configured room UUID, `buzz:<ROOM_UUID>`, or a unique current room name. Use the UUID when room names are ambiguous.",
        "- Buzz mentions: write a unique current room member as `@Display Name`. For an explicit identity, include `nostr:npub...`; the public key must belong to the target room. Any unresolved or ambiguous label needs an explicit identity for every intended member.",
      ],
    },
    reload: { configPrefixes: ["channels.buzz"] },
    configSchema: BuzzConfigSchema,
    setupContract: buzzSetupContract,
    setupWizard: buzzSetupWizard,
    config: {
      listAccountIds: listBuzzAccountIds,
      resolveAccount: (cfg, accountId) => resolveBuzzAccount({ cfg, accountId }),
      defaultAccountId: resolveDefaultBuzzAccountId,
      isConfigured: (account) => account.configured,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            baseUrl: account.relayUrl,
            publicKey: account.publicKey,
          },
        }),
      resolveAllowFrom: ({ cfg, accountId }) =>
        resolveBuzzAccount({ cfg, accountId }).config.groupAllowFrom,
      resolveDefaultTo: ({ cfg, accountId }) =>
        resolveBuzzAccount({ cfg, accountId }).config.defaultTo,
    },
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
    messaging: {
      targetPrefixes: ["buzz"],
      normalizeTarget: normalizeBuzzTarget,
      inferTargetChatType: () => "group",
      targetResolver: {
        looksLikeId: looksLikeBuzzTarget,
        hint: "<room UUID|configured room name>",
      },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
        const normalized = buildBuzzTarget(parseBuzzTarget(target));
        return buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: "buzz",
          accountId,
          recipientSessionExact: true,
          peer: { kind: "group", id: normalized },
          chatType: "group",
          from: `buzz:${accountId ?? "default"}`,
          to: normalized,
        });
      },
      resolveSessionConversation: ({ rawId }) => {
        const { baseSessionKey, threadId } = parseThreadSessionSuffix(rawId);
        const channelId = parseBuzzTarget(baseSessionKey ?? rawId);
        return {
          id: channelId,
          threadId,
          baseConversationId: channelId,
          parentConversationCandidates: [channelId],
        };
      },
    },
    status: {
      ...createComputedAccountStatusAdapter<ResolvedBuzzAccount>({
        defaultRuntime: createDefaultChannelRuntimeState("default"),
        buildChannelSummary: ({ snapshot }) => ({
          ok: snapshot.configured,
          label: snapshot.configured ? "configured" : "missing config",
          detail: snapshot.baseUrl ?? "",
        }),
        resolveAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          baseUrl: account.relayUrl,
          publicKey: account.publicKey,
        }),
      }),
      probeAccount: async ({ account, timeoutMs }) => {
        const rooms = await discoverBuzzRooms({
          relayUrl: account.relayUrl,
          privateKey: account.privateKey,
          authTag: account.authTag,
          timeoutMs,
        });
        return {
          ok: true,
          publicKey: account.publicKey,
          roomCount: rooms.length,
          rooms: rooms.map((room) => ({ id: room.id, name: room.name })),
        };
      },
    },
    gateway: {
      startAccount: startBuzzGatewayAccount,
    },
    heartbeat: {
      sendTyping: sendBuzzTyping,
    },
    threading: {
      resolveReplyToMode: () => "all",
      matchesToolContextTarget: ({ target, toolContext }) => {
        const normalizedTarget = normalizeBuzzThreadingTarget(target);
        return Boolean(
          normalizedTarget &&
          [toolContext.currentChannelId, toolContext.currentMessagingTarget].some(
            (currentTarget) => normalizeBuzzThreadingTarget(currentTarget) === normalizedTarget,
          ),
        );
      },
      buildToolContext: ({ context, hasRepliedRef }) => {
        const currentMessagingTarget = normalizeOptionalString(context.To);
        const currentChannelId = normalizeBuzzThreadingTarget(
          normalizeOptionalString(context.NativeChannelId) ?? currentMessagingTarget,
        );
        return {
          currentChannelId,
          currentMessagingTarget,
          currentThreadTs:
            context.MessageThreadId == null ? undefined : String(context.MessageThreadId),
          currentMessageId: normalizeOptionalString(context.ReplyToId) ?? context.CurrentMessageId,
          replyToMode: context.ReplyToMode ?? "all",
          hasRepliedRef,
        };
      },
    },
    directory: createChannelDirectoryAdapter({
      self: getBuzzDirectorySelf,
      listPeers: listBuzzDirectoryPeersFromConfig,
      listPeersLive: listBuzzDirectoryPeersLive,
      listGroups: listBuzzDirectoryGroupsFromConfig,
      listGroupsLive: listBuzzDirectoryGroupsLive,
      listGroupMembers: listBuzzDirectoryGroupMembers,
    }),
    message: buzzMessageAdapter,
  },
  outbound: buzzOutboundAdapter,
});
