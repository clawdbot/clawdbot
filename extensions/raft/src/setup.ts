import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
// Raft plugin setup owns only the Raft CLI profile, never Raft credentials.
import { createPatchedAccountSetupAdapter } from "openclaw/plugin-sdk/setup";
import {
  createDetectedBinaryStatus,
  formatDocsLink,
  setSetupChannelEnabled,
} from "openclaw/plugin-sdk/setup";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  listRaftAccountIds,
  RAFT_CHANNEL_ID,
  resolveDefaultRaftAccountId,
  resolveRaftAccount,
  type ResolvedRaftAccount,
} from "./accounts.js";

const raftSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: RAFT_CHANNEL_ID,
  buildPatch: (input) => {
    const profile = normalizeOptionalString(input.profile);
    return profile ? { profile } : {};
  },
  validateInput: ({ cfg, accountId, input }) => {
    if (normalizeOptionalString(input.profile) ?? resolveRaftAccount({ cfg, accountId }).profile) {
      return null;
    }
    return "Raft requires a CLI profile.";
  },
});

export const raftSetupPlugin: ChannelPlugin<ResolvedRaftAccount> = {
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
  setup: raftSetupAdapter,
  config: {
    listAccountIds: listRaftAccountIds,
    resolveAccount: (cfg, accountId) => resolveRaftAccount({ cfg, accountId }),
    defaultAccountId: resolveDefaultRaftAccountId,
    isConfigured: (account) => account.configured,
    isEnabled: (account) => account.enabled,
  },
  setupWizard: {
    channel: RAFT_CHANNEL_ID,
    resolveShouldPromptAccountIds: () => false,
    status: createDetectedBinaryStatus({
      channelLabel: "Raft",
      binaryLabel: "raft",
      configuredLabel: "configured",
      unconfiguredLabel: "needs a CLI profile",
      configuredHint: "configured",
      unconfiguredHint: "install and sign in to the Raft CLI",
      configuredScore: 1,
      unconfiguredScore: 4,
      resolveConfigured: ({ cfg, accountId }) =>
        accountId
          ? resolveRaftAccount({ cfg, accountId }).configured
          : listRaftAccountIds(cfg).some(
              (resolvedAccountId) =>
                resolveRaftAccount({ cfg, accountId: resolvedAccountId }).configured,
            ),
      resolveBinaryPath: () => "raft",
      detectBinary,
    }),
    introNote: {
      title: "Raft setup",
      lines: [
        "Create a Raft External Agent and sign in with the Raft CLI on this Gateway host.",
        `Docs: ${formatDocsLink("/channels/raft", "channels/raft")}`,
      ],
    },
    credentials: [],
    textInputs: [
      {
        inputKey: "profile",
        message: "Raft CLI profile",
        currentValue: ({ cfg, accountId }) =>
          resolveRaftAccount({ cfg, accountId }).profile ?? undefined,
        validate: ({ value }) => (normalizeOptionalString(value) ? undefined : "Required"),
        normalizeValue: ({ value }) => normalizeOptionalString(value) ?? "",
      },
    ],
    completionNote: {
      title: "Raft next steps",
      lines: [
        "Restart the Gateway, then send a Raft message to wake the agent.",
        `Docs: ${formatDocsLink("/channels/raft", "channels/raft")}`,
      ],
    },
    disable: (cfg) => setSetupChannelEnabled(cfg, RAFT_CHANNEL_ID, false),
  },
};
