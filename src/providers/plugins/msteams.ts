import { chunkMarkdownText } from "../../auto-reply/chunk.js";
import { createMSTeamsPollStoreFs } from "../../msteams/polls.js";
import { sendMessageMSTeams, sendPollMSTeams } from "../../msteams/send.js";
import { resolveMSTeamsCredentials } from "../../msteams/token.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import type { ProviderPlugin } from "./types.js";

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

export const msteamsPlugin: ProviderPlugin<ResolvedMSTeamsAccount> = {
  id: "msteams",
  meta: {
    ...meta,
    aliases: ["teams"],
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    polls: true,
    threads: true,
    media: true,
  },
  reload: { configPrefixes: ["msteams"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: cfg.msteams?.enabled !== false,
      configured: Boolean(resolveMSTeamsCredentials(cfg.msteams)),
    }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (_account, cfg) =>
      Boolean(resolveMSTeamsCredentials(cfg.msteams)),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  outbound: {
    deliveryMode: "direct",
    chunker: chunkMarkdownText,
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
      return { provider: "msteams", ...result };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, deps }) => {
      const send =
        deps?.sendMSTeams ??
        ((to, text, opts) =>
          sendMessageMSTeams({ cfg, to, text, mediaUrl: opts?.mediaUrl }));
      const result = await send(to, text, { mediaUrl });
      return { provider: "msteams", ...result };
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
      const port = ctx.cfg.msteams?.webhook?.port ?? 3978;
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
