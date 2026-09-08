import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { parseThreadSessionSuffix } from "openclaw/plugin-sdk/routing";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
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
  assertBuzzAccountAvailable,
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
    threading: {
      resolveReplyTransport: ({ replyDelivery, threadId, replyToId, replyToIsExplicit }) => {
        if (replyDelivery?.replyToMode === "off") {
          return { threadId: null, replyToId: null };
        }
        // Implicit replies belong to the root; explicit child targets keep their nesting.
        return threadId && replyToId && !replyToIsExplicit
          ? { threadId, replyToId: String(threadId) }
          : null;
      },
    },
    agentPrompt: {
      messageToolHints: () => [
        "- Buzz targets: use a configured room UUID, `buzz:<ROOM_UUID>`, or a unique current room name. Use the UUID when room names are ambiguous.",
        "- Buzz mentions: write a unique current room member as `@Display Name`. For an explicit identity, include `nostr:npub...`; the public key must belong to the target room. Any unresolved or ambiguous label needs an explicit identity for every intended member.",
      ],
    },
    reload: { configPrefixes: ["channels.buzz"], accountScopedRestart: true },
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
            tokenStatus: account.tokenStatus,
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
      resolveOutboundSessionRoute: ({
        cfg,
        agentId,
        accountId,
        target,
        replyToId,
        threadId,
        currentSessionKey,
      }) => {
        const normalized = buildBuzzTarget(parseBuzzTarget(target));
        const baseRoute = buildChannelOutboundSessionRoute({
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
        return buildThreadAwareOutboundSessionRoute({
          route: baseRoute,
          replyToId,
          threadId,
          currentSessionKey,
          canRecoverCurrentThread: () => true,
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
          extra: {
            baseUrl: account.relayUrl,
            publicKey: account.publicKey,
            tokenStatus: account.tokenStatus,
          },
        }),
      }),
      probeAccount: async ({ account, timeoutMs }) => {
        assertBuzzAccountAvailable(account);
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
