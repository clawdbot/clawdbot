export const PAIRING_APPROVED_MESSAGE =
  "\u2705 Clawdbot access approved. Send a message to start chatting.";

export function formatPairingApproveHint(channelId: string): string {
  return `Approve via: clawdbot pairing list ${channelId} / clawdbot pairing approve ${channelId} <code>`;
}
