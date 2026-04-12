import { readStringValue } from "../shared/string-coerce.js";

export type { ChannelToolSend } from "../channels/plugins/types.public.js";

/** Extract the canonical send target fields from tool arguments when the action matches. */
export function extractToolSend(
  args: Record<string, unknown>,
  expectedAction = "sendMessage",
): { to: string; accountId?: string; threadId?: string } | null {
  const action = readStringValue(args.action)?.trim() ?? "";
  if (action !== expectedAction) {
    return null;
  }
  const to = readStringValue(args.to);
  if (!to) {
    return null;
  }
  const accountId = readStringValue(args.accountId)?.trim();
  const threadIdRaw =
    typeof args.threadId === "number"
      ? String(args.threadId)
      : (readStringValue(args.threadId)?.trim() ?? "");
  const threadId = threadIdRaw.length > 0 ? threadIdRaw : undefined;
  return { to, accountId, threadId };
}
