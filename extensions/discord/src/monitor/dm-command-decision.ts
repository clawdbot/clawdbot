import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import type { DiscordDmCommandAccess } from "./dm-command-auth.js";

export async function handleDiscordDmCommandDecision(params: {
  dmAccess: DiscordDmCommandAccess;
  accountId: string;
  sender: {
    id: string;
    tag?: string;
    name?: string;
  };
  onPairingCreated: (code: string) => Promise<void>;
  onUnauthorized: () => Promise<void>;
  upsertPairingRequest?: typeof upsertChannelPairingRequest;
}): Promise<boolean> {
  if (params.dmAccess.decision === "allow") {
    return true;
  }

  if (params.dmAccess.decision === "pairing") {
    const upsertPairingRequest = params.upsertPairingRequest ?? upsertChannelPairingRequest;
    const result = await createChannelPairingChallengeIssuer({
      channel: "discord",
      upsertPairingRequest: async ({ id, meta }) =>
        await upsertPairingRequest({
          channel: "discord",
          id,
          accountId: params.accountId,
          meta,
        }),
    })({
      senderId: params.sender.id,
      senderIdLine: `Your Discord user id: ${params.sender.id}`,
      meta: {
        tag: params.sender.tag,
        name: params.sender.name,
      },
      sendPairingReply: async () => {},
    });
    if (result.created && result.code) {
      await params.onPairingCreated(result.code);
    }
    return false;
  }

  await params.onUnauthorized();
  return false;
}
