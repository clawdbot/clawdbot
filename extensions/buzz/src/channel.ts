import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { BuzzConfigSchema } from "./config-schema.js";
import { buzzOutboundAdapter, startBuzzGatewayAccount } from "./gateway.js";
import { discoverBuzzRooms } from "./room-discovery.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { buzzSetupAdapter, buzzSetupContract } from "./setup-core.js";
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
      order: 56,
    },
    capabilities: {
      chatTypes: ["group"],
      threads: true,
    },
    reload: { configPrefixes: ["channels.buzz"] },
    configSchema: BuzzConfigSchema,
    setup: buzzSetupAdapter,
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
        hint: "<buzz:channel-uuid>",
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
        const channelId = parseBuzzTarget(rawId);
        return {
          id: channelId,
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
    message: buzzMessageAdapter,
  },
  outbound: buzzOutboundAdapter,
});
