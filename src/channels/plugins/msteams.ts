import { chunkMarkdownText } from "../../auto-reply/chunk.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { createMSTeamsPollStoreFs } from "../../msteams/polls.js";
import { sendMessageMSTeams, sendPollMSTeams } from "../../msteams/send.js";
import { resolveMSTeamsCredentials } from "../../msteams/token.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { msteamsOnboardingAdapter } from "./onboarding/msteams.js";
import { PAIRING_APPROVED_MESSAGE } from "./pairing-message.js";
import type { ChannelMessageActionName, ChannelPlugin } from "./types.js";

type ResolvedMSTeamsAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

const meta = {
  id: "msteams",
  label: "Microsoft Teams",
  selectionLabel: "Microsoft Teams (Bot)",
  docsPath: "/msteams",
  docsLabel: "msteams",
  blurb: "bot via Microsoft Teams.",
} as const;

export const msteamsPlugin: ChannelPlugin<ResolvedMSTeamsAccount> = {
  id: "msteams",
  meta: {
    ...meta,
  },
  onboarding: msteamsOnboardingAdapter,
  pairing: {
    idLabel: "msteamsUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(msteams|user):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      await sendMessageMSTeams({
        cfg,
        to: id,
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    polls: true,
    threads: true,
    media: true,
  },
  reload: { configPrefixes: ["channels.msteams"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: cfg.channels?.msteams?.enabled !== false,
      configured: Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
    }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, enabled }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        msteams: {
          ...cfg.channels?.msteams,
          enabled,
        },
      },
    }),
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg } as ClawdbotConfig;
      const nextChannels = { ...cfg.channels };
      delete nextChannels.msteams;
      if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels;
      } else {
        delete next.channels;
      }
      return next;
    },
    isConfigured: (_account, cfg) =>
      Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg }) => cfg.channels?.msteams?.allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    collectWarnings: ({ cfg }) => {
      const groupPolicy = cfg.channels?.msteams?.groupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        `- MS Teams groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.msteams.groupPolicy="allowlist" + channels.msteams.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        msteams: {
          ...cfg.channels?.msteams,
          enabled: true,
        },
      },
    }),
  },
  actions: {
    listActions: ({ cfg }) => {
      const enabled =
        cfg.channels?.msteams?.enabled !== false &&
        Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams));
      if (!enabled) return [];
      return ["poll"] satisfies ChannelMessageActionName[];
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: chunkMarkdownText,
    textChunkLimit: 4000,
    pollMaxOptions: 12,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error(
            "Delivering to MS Teams requires --to <conversationId|user:ID|conversation:ID>",
          ),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ cfg, to, text, deps }) => {
      const send =
        deps?.sendMSTeams ??
        ((to, text) => sendMessageMSTeams({ cfg, to, text }));
      const result = await send(to, text);
      return { channel: "msteams", ...result };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, deps }) => {
      const send =
        deps?.sendMSTeams ??
        ((to, text, opts) =>
          sendMessageMSTeams({ cfg, to, text, mediaUrl: opts?.mediaUrl }));
      const result = await send(to, text, { mediaUrl });
      return { channel: "msteams", ...result };
    },
    sendPoll: async ({ cfg, to, poll }) => {
      const maxSelections = poll.maxSelections ?? 1;
      const result = await sendPollMSTeams({
        cfg,
        to,
        question: poll.question,
        options: poll.options,
        maxSelections,
      });
      const pollStore = createMSTeamsPollStoreFs();
      await pollStore.createPoll({
        id: result.pollId,
        question: poll.question,
        options: poll.options,
        maxSelections,
        createdAt: new Date().toISOString(),
        conversationId: result.conversationId,
        messageId: result.messageId,
        votes: {},
      });
      return result;
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      port: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      port: snapshot.port ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      port: runtime?.port ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const { monitorMSTeamsProvider } = await import("../../msteams/index.js");
      const port = ctx.cfg.channels?.msteams?.webhook?.port ?? 3978;
      ctx.setStatus({ accountId: ctx.accountId, port });
      ctx.log?.info(`starting provider (port ${port})`);
      return monitorMSTeamsProvider({
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
