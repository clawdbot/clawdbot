import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Discord plugin module implements message handlerm preflight behavior.
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

const loadConversationRuntime = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/conversation-binding-runtime"),
);

const loadDiscordSendRuntime = createLazyRuntimeModule(() => import("../send.js"));

function resolveDiscordDmPairingSenderId(sender: DiscordSenderIdentity): string {
  return sender.isPluralKit ? `pk:${sender.id}` : sender.id;
}

export async function resolveDiscordDmPreflightAccess(params: {
  preflight: DiscordMessagePreflightParams;
  author: User;
  sender: DiscordSenderIdentity;
  dmPolicy: DiscordDmPolicy;
  resolvedAccountId: string;
  allowNameMatching: boolean;
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
    cfg: params.preflight.cfg,
    token: params.preflight.token,
    rest: params.preflight.client.rest,
  });
  const commandAuthorized =
    (dmAccess.senderAccess.allowed && dmAccess.commandAccess.authorized) ||
    directBindingRecord != null;
  if (dmAccess.senderAccess.decision === "allow") {
    return { commandAuthorized };
  }
  if (directBindingRecord) {
    logVerbose(
      `discord: allow bound DM conversation ${directBindingConversationId} despite dmPolicy=${params.dmPolicy}`,
    );
    return { commandAuthorized };
  }

  await handleDiscordDmCommandDecision({
    senderAccess: dmAccess.senderAccess,
    accountId: params.resolvedAccountId,
    // Use the resolved sender identity (e.g. PluralKit member UUID) here so
    // the pairing record is keyed under the same stableId that
    // resolveDiscordDmCommandAccess / createDiscordDmIngressSubject use on
    // subsequent inbound messages. Previously this used the raw gateway
    // author id, which only matched non-PK users.
    sender: {
      id: resolveDiscordDmPairingSenderId(params.sender),
      tag: params.sender.tag ?? formatDiscordUserTag(params.author),
      name: params.sender.name ?? params.author.username ?? undefined,
    },
    onPairingCreated: async (code) => {
      logVerbose(
        `discord pairing request sender=${params.author.id} tag=${formatDiscordUserTag(params.author)} reason=${dmAccess.senderAccess.reasonCode}`,
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
        `Blocked unauthorized discord sender ${params.sender.id} (dmPolicy=${params.dmPolicy}, reason=${dmAccess.senderAccess.reasonCode})`,
      );
    },
  });
  return null;
}
