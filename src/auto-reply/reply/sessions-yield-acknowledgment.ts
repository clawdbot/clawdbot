import type { ReplyPayload } from "../types.js";

export function buildSessionsYieldAcknowledgmentPayload(params: {
  yielded: boolean;
  yieldAcknowledgment?: string;
  isInteractive: boolean;
  isHeartbeat?: boolean;
  silentExpected?: boolean;
  isMessageToolOnly: boolean;
  isSubagentSession: boolean;
  hasExplicitSilentReply: boolean;
  hasVisibleMessageDelivery: boolean;
}): ReplyPayload | undefined {
  const text = params.yieldAcknowledgment?.trim();
  if (
    !params.yielded ||
    !text ||
    !params.isInteractive ||
    params.isHeartbeat === true ||
    params.silentExpected === true ||
    params.isMessageToolOnly ||
    params.isSubagentSession ||
    params.hasExplicitSilentReply ||
    params.hasVisibleMessageDelivery
  ) {
    return undefined;
  }
  return { text };
}
