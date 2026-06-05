// Tool send helpers normalize model tool-send requests before provider dispatch.
import { readStringValue } from "../../packages/normalization-core/src/string-coerce.js";

export type { ChannelToolSend } from "../channels/plugins/types.public.js";

/** Extract the canonical send target fields from tool arguments when the action matches. */
export function extractToolSend(
  /** Raw model tool arguments supplied to a channel action. */
  args: Record<string, unknown>,
  /** Action name that should be treated as a send action. */
  expectedAction = "sendMessage",
): {
  /** Canonical destination id used by core send routing. */
  to: string;
  /** Optional channel account/profile id when the action includes one. */
  accountId?: string;
  /** Optional thread/topic id, normalized to string for channel send adapters. */
  threadId?: string;
} | null {
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
