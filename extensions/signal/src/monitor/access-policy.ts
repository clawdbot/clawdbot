import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/security-runtime";
import { isSignalSenderAllowed, type SignalSender } from "../identity.js";

type SignalDmPolicy = "open" | "pairing" | "allowlist" | "disabled";
type SignalGroupPolicy = "open" | "allowlist" | "disabled";

export async function resolveSignalAccessState(params: {
  accountId: string;
  dmPolicy: SignalDmPolicy;
  groupPolicy: SignalGroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  sender: SignalSender;
}) {
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: "signal",
    accountId: params.accountId,
    dmPolicy: params.dmPolicy,
  });
  const resolveAccessDecision = (isGroup: boolean) =>
    resolveDmGroupAccessWithLists({
      isGroup,
      dmPolicy: params.dmPolicy,
      groupPolicy: params.groupPolicy,
      allowFrom: params.allowFrom,
      groupAllowFrom: params.groupAllowFrom,
      storeAllowFrom,
      isSenderAllowed: (allowEntries) => isSignalSenderAllowed(params.sender, allowEntries),
    });
  const dmAccess = resolveAccessDecision(false);
  return {
    resolveAccessDecision,
    dmAccess,
    effectiveDmAllow: dmAccess.effectiveAllowFrom,
    effectiveGroupAllow: dmAccess.effectiveGroupAllowFrom,
  };
}

export async function handleSignalDirectMessageAccess(params: {
  dmPolicy: SignalDmPolicy;
  dmAccessDecision: "allow" | "block" | "pairing";
  senderId: string;
  senderIdLine: string;
  senderDisplay: string;
  senderName?: string;
  accountId: string;
  sendPairingReply: (text: string) => Promise<void>;
  log: (message: string) => void;
}): Promise<boolean> {
  if (params.dmAccessDecision === "allow") {
    return true;
  }
  if (params.dmAccessDecision === "block") {
    if (params.dmPolicy !== "disabled") {
      params.log(`Blocked signal sender ${params.senderDisplay} (dmPolicy=${params.dmPolicy})`);
    }
    return false;
  }
  if (params.dmPolicy === "pairing") {
    await createChannelPairingChallengeIssuer({
      channel: "signal",
      upsertPairingRequest: async ({ id, meta }) =>
        await upsertChannelPairingRequest({
          channel: "signal",
          id,
          accountId: params.accountId,
          meta,
        }),
    })({
      senderId: params.senderId,
      senderIdLine: params.senderIdLine,
      meta: { name: params.senderName },
      sendPairingReply: params.sendPairingReply,
      onCreated: () => {
        params.log(`signal pairing request sender=${params.senderId}`);
      },
      onReplyError: (err) => {
        params.log(`signal pairing reply failed for ${params.senderId}: ${String(err)}`);
      },
    });
  }
  return false;
}
