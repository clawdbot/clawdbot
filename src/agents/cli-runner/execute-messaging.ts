import crypto from "node:crypto";
import { isMessagingToolTargetEvidenceAction } from "../embedded-agent-messaging.js";
import type { MessagingToolSend } from "../embedded-agent-messaging.types.js";
import {
  collectMessagingMediaUrlsFromRecord,
  collectMessagingMediaUrlsFromToolResult,
  extractMessagingToolSend,
} from "../embedded-agent-subscribe.tools.js";
import { stripOpenClawMcpToolPrefix } from "./tool-policy.js";
import type { PreparedCliRunContext } from "./types.js";

export const CLI_MESSAGING_EVIDENCE_MAX_CALLS = 64;

// One canonical prefix-strip implementation: the loopback transport prefix is
// a tool-policy concept shared with the embedded CLI-dispatch bridge, and
// drifting copies would desync tool-name correlation across those surfaces.
export const normalizeCliMessagingToolName = stripOpenClawMcpToolPrefix;

export function extractCliMessagingTarget(
  context: PreparedCliRunContext,
  toolName: string,
  args: Record<string, unknown>,
): MessagingToolSend | undefined {
  const normalizedToolName = normalizeCliMessagingToolName(toolName);
  const currentProvider = context.params.messageChannel ?? context.params.messageProvider;
  const hasExplicitProvider =
    (typeof args.provider === "string" && args.provider.trim().length > 0) ||
    (typeof args.channel === "string" && args.channel.trim().length > 0);
  const targetArgs =
    normalizedToolName === "message" && currentProvider && !hasExplicitProvider
      ? { ...args, provider: currentProvider }
      : args;
  if (!isMessagingToolTargetEvidenceAction(normalizedToolName, targetArgs)) {
    return undefined;
  }
  return extractMessagingToolSend(normalizedToolName, targetArgs, {
    config: context.params.config,
    currentChannelId: context.params.currentChannelId,
    currentThreadId: context.params.currentThreadTs,
    currentMessageId: context.params.currentMessageId,
  });
}

export function buildMessagingToolSendEvidenceKey(send: MessagingToolSend): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        send.tool,
        send.provider,
        send.accountId,
        send.to,
        send.threadId,
        send.threadImplicit,
        send.threadSuppressed,
        send.text,
        send.mediaUrls,
      ]),
    )
    .digest("hex");
}

export function extractCliMessagingContent(
  args: Record<string, unknown>,
  result: unknown,
): Pick<MessagingToolSend, "text" | "mediaUrls"> {
  const text = ["message", "SendMessage", "content", "text", "caption"]
    .map((key) => args[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const mediaUrls = [
    ...collectMessagingMediaUrlsFromRecord(args),
    ...collectMessagingMediaUrlsFromToolResult(result),
  ].filter((url, index, all) => all.indexOf(url) === index);
  return {
    ...(text ? { text } : {}),
    ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
  };
}

export function appendUniqueCliMessagingEvidence(
  values: string[],
  valueKeys: Set<string>,
  additions: readonly string[],
): void {
  for (const addition of additions) {
    if (!addition || valueKeys.has(addition)) {
      continue;
    }
    if (values.length >= CLI_MESSAGING_EVIDENCE_MAX_CALLS) {
      const removed = values.shift();
      if (removed) {
        valueKeys.delete(removed);
      }
    }
    values.push(addition);
    valueKeys.add(addition);
  }
}
