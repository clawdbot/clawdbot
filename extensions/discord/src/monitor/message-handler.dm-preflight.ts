import { formatAllowlistMatchMeta } from "openclaw/plugin-sdk/allow-from";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveDiscordConversationIdentity } from "../conversation-identity.js";
import type { User } from "../internal/discord.js";
import { resolveDiscordDmCommandAccess, type DiscordDmPolicy } from "./dm-command-auth.js";
import { handleDiscordDmCommandDecision } from "./dm-command-decision.js";
import { formatDiscordUserTag } from "./format.js";
import type {
  DiscordMessagePreflightParams,
  DiscordSenderIdentity,
} from "./message-handler.preflight.types.js";

let conversationRuntimePromise:
  | Promise<typeof import("openclaw/plugin-sdk/conversation-binding-runtime")>
  | undefined;
let discordSendRuntimePromise: Promise<typeof import("../send.js")> | undefined;

async function loadConversationRuntime() {
  conversationRuntimePromise ??= import("openclaw/plugin-sdk/conversation-binding-runtime");
  return await conversationRuntimePromise;
}

async function loadDiscordSendRuntime() {
  discordSendRuntimePromise ??= import("../send.js");
  return await discordSendRuntimePromise;
}

export async function resolveDiscordDmPreflightAccess(params: {
  preflight: DiscordMessagePreflightParams;
  author: User;
  sender: DiscordSenderIdentity;
  dmPolicy: DiscordDmPolicy;
  resolvedAccountId: string;
  allowNameMatching: boolean;
  useAccessGroups: boolean;
}): Promise<{ commandAuthorized: boolean } | null> {
  if (params.dmPolicy === "disabled") {
    logVerbose("discord: drop dm (dmPolicy: disabled)");
    return null;
  }

  const directBindingConversationId =
    resolveDiscordConversationIdentity({
      isDirectMessage: true,
      userId: params.author.id,
    }) ?? `user:${params.author.id}`;
  const directBindingRecord = (await loadConversationRuntime())
    .getSessionBindingService()
    .resolveByConversation({
      channel: "discord",
      accountId: params.preflight.accountId,
      conversationId: directBindingConversationId,
    });
  const dmAccess = await resolveDiscordDmCommandAccess({
    accountId: params.resolvedAccountId,
    dmPolicy: params.dmPolicy,
    configuredAllowFrom: params.preflight.allowFrom ?? [],
    sender: {
      id: params.sender.id,
      name: params.sender.name,
      tag: params.sender.tag,
    },
    allowNameMatching: params.allowNameMatching,
    useAccessGroups: params.useAccessGroups,
  });
  const commandAuthorized = dmAccess.commandAuthorized || directBindingRecord != null;
  if (dmAccess.decision === "allow") {
    return { commandAuthorized };
  }
  if (directBindingRecord) {
    logVerbose(
      `discord: allow bound DM conversation ${directBindingConversationId} despite dmPolicy=${params.dmPolicy}`,
    );
    return { commandAuthorized };
  }

  const allowMatchMeta = formatAllowlistMatchMeta(
    dmAccess.allowMatch.allowed ? dmAccess.allowMatch : undefined,
  );
  await handleDiscordDmCommandDecision({
    dmAccess,
    accountId: params.resolvedAccountId,
    sender: {
      id: params.author.id,
      tag: formatDiscordUserTag(params.author),
      name: params.author.username ?? undefined,
    },
    onPairingCreated: async (code) => {
      logVerbose(
        `discord pairing request sender=${params.author.id} tag=${formatDiscordUserTag(params.author)} (${allowMatchMeta})`,
      );
      try {
        const conversationRuntime = await loadConversationRuntime();
        const { sendMessageDiscord } = await loadDiscordSendRuntime();
        await sendMessageDiscord(
          `user:${params.author.id}`,
          conversationRuntime.buildPairingReply({
            channel: "discord",
            idLine: `Your Discord user id: ${params.author.id}`,
            code,
          }),
          {
            cfg: params.preflight.cfg,
            token: params.preflight.token,
            rest: params.preflight.client.rest,
            accountId: params.preflight.accountId,
          },
        );
      } catch (err) {
        logVerbose(`discord pairing reply failed for ${params.author.id}: ${String(err)}`);
      }
    },
    onUnauthorized: async () => {
      logVerbose(
        `Blocked unauthorized discord sender ${params.sender.id} (dmPolicy=${params.dmPolicy}, ${allowMatchMeta})`,
      );
    },
  });
  return null;
}
