// Raft channel plugin wires the wake bridge into the canonical channel runtime.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import {
  buildBaseChannelStatusSummary,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  listRaftAccountIds,
  RAFT_CHANNEL_ID,
  resolveDefaultRaftAccountId,
  resolveRaftAccount,
  type ResolvedRaftAccount,
} from "./accounts.js";
import { raftChannelConfigSchema } from "./config-schema.js";
import { startRaftGatewayAccount } from "./gateway.js";
import { raftSetupPlugin } from "./setup.js";

type RaftProbe = {
  cliFound: boolean;
};

export const raftPlugin: ChannelPlugin<ResolvedRaftAccount, RaftProbe> = createChatChannelPlugin({
  base: {
    id: RAFT_CHANNEL_ID,
    meta: {
      id: RAFT_CHANNEL_ID,
      label: "Raft",
      selectionLabel: "Raft (CLI wake bridge)",
      docsPath: "/channels/raft",
      docsLabel: "raft",
      blurb: "Raft CLI wake bridge for human and agent collaboration.",
      order: 72,
    },
    capabilities: {
      chatTypes: ["direct"],
    },
    setup: raftSetupPlugin.setup,
    setupContract: raftSetupPlugin.setupContract,
    setupWizard: raftSetupPlugin.setupWizard,
    reload: { configPrefixes: ["channels.raft"] },
    configSchema: raftChannelConfigSchema,
    config: {
      listAccountIds: listRaftAccountIds,
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
        resolveRaftAccount({ cfg, accountId }),
      defaultAccountId: resolveDefaultRaftAccountId,
      isConfigured: (account) => account.configured,
      isEnabled: (account) => account.enabled,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            profile: account.profile,
          },
        }),
    },
    status: createComputedAccountStatusAdapter<ResolvedRaftAccount, RaftProbe>({
      defaultRuntime: createDefaultChannelRuntimeState("default"),
      buildChannelSummary: ({ snapshot }) => buildBaseChannelStatusSummary(snapshot),
      probeAccount: async () => ({
        cliFound: await detectBinary("raft"),
      }),
      formatCapabilitiesProbe: ({ probe }) => [
        {
          text: `Raft CLI: ${probe.cliFound ? "found" : "missing"}`,
          ...(probe.cliFound ? {} : { tone: "error" as const }),
        },
      ],
      collectStatusIssues: (accounts) =>
        accounts.flatMap((account) => {
          if (!account.configured) {
            return [
              {
                channel: RAFT_CHANNEL_ID,
                accountId: account.accountId,
                kind: "config",
                message: "Raft account is missing a CLI profile",
                fix: "Set channels.raft.profile or RAFT_PROFILE.",
              },
            ];
          }
          return [];
        }),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name ?? undefined,
        enabled: account.enabled,
        configured: account.configured,
        extra: {
          profile: account.profile,
        },
      }),
    }),
    gateway: {
      startAccount: async (ctx) => await startRaftGatewayAccount(ctx),
    },
  },
});
