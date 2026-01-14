import { readChannelAllowFromStore } from "../../pairing/pairing-store.js";

import {
  allowListMatches,
  normalizeAllowList,
  normalizeAllowListLower,
} from "./allow-list.js";
import type { SlackMonitorContext } from "./context.js";

export async function resolveSlackEffectiveAllowFrom(ctx: SlackMonitorContext) {
  const storeAllowFrom = await readChannelAllowFromStore("slack").catch(
    () => [],
  );
  const allowFrom = normalizeAllowList([...ctx.allowFrom, ...storeAllowFrom]);
  const allowFromLower = normalizeAllowListLower(allowFrom);
  return { allowFrom, allowFromLower };
}

export function isSlackSenderAllowListed(params: {
  allowListLower: string[];
  senderId: string;
  senderName?: string;
}) {
  const { allowListLower, senderId, senderName } = params;
  return (
    allowListLower.length === 0 ||
    allowListMatches({
      allowList: allowListLower,
      id: senderId,
      name: senderName,
    })
  );
}
