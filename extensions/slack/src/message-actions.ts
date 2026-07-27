// Slack plugin module implements message actions behavior.
import { createActionGate } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { extractToolSend, type ChannelToolSend } from "openclaw/plugin-sdk/tool-send";
import { listEnabledSlackAccounts, resolveSlackAccount } from "./accounts.js";
import { normalizeSlackThreadTsCandidate, resolveSlackThreadTsValue } from "./thread-ts.js";

export function listSlackMessageActions(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ChannelMessageActionName[] {
  const accounts = (
    accountId ? [resolveSlackAccount({ cfg, accountId })] : listEnabledSlackAccounts(cfg)
  ).filter(
    (account) =>
      account.enabled &&
      (account.identity === "user"
        ? account.userTokenSource !== "none"
        : account.botTokenSource !== "none"),
  );
  if (accounts.length === 0) {
    return [];
  }

  const isActionEnabled = (key: string, defaultValue = true) => {
    for (const account of accounts) {
      const gate = createActionGate(
        (account.actions ?? cfg.channels?.slack?.actions) as Record<string, boolean | undefined>,
      );
      if (gate(key, defaultValue)) {
        return true;
      }
    }
    return false;
  };

  const actions = new Set<ChannelMessageActionName>(["send"]);
  if (isActionEnabled("reactions")) {
    actions.add("react");
    actions.add("reactions");
  }
  if (isActionEnabled("messages")) {
    actions.add("read");
    actions.add("edit");
    actions.add("delete");
    actions.add("download-file");
    actions.add("upload-file");
  }
  if (isActionEnabled("pins")) {
    actions.add("pin");
    actions.add("unpin");
    actions.add("list-pins");
  }
  if (isActionEnabled("memberInfo")) {
    actions.add("member-info");
  }
  if (isActionEnabled("emojiList")) {
    actions.add("emoji-list");
  }
  return Array.from(actions);
}

export function extractSlackToolSend(args: Record<string, unknown>): ChannelToolSend | null {
  const action = args.action;
  if (
    action !== "sendMessage" &&
    action !== "uploadFile" &&
    action !== "send" &&
    action !== "upload-file"
  ) {
    return null;
  }
  const extracted = extractToolSend(args, action);
  if (!extracted) {
    return null;
  }
  const nativeThreadTs =
    typeof args.threadTs === "string" ? normalizeSlackThreadTsCandidate(args.threadTs) : undefined;
  const replyTo =
    typeof args.replyTo === "string" ? normalizeSlackThreadTsCandidate(args.replyTo) : undefined;
  const threadTs =
    action === "send"
      ? resolveSlackThreadTsValue({ replyToId: replyTo, threadId: extracted.threadId })
      : action === "upload-file"
        ? (normalizeSlackThreadTsCandidate(extracted.threadId) ?? replyTo)
        : (nativeThreadTs ?? normalizeSlackThreadTsCandidate(extracted.threadId));
  const threadSuppressed =
    extracted.threadSuppressed === true || args.topLevel === true || args.threadTs === null;
  return {
    ...extracted,
    threadId: threadTs ?? extracted.threadId,
    ...(!threadTs && !extracted.threadId && !threadSuppressed ? { threadImplicit: true } : {}),
    ...(threadSuppressed ? { threadSuppressed: true } : {}),
  };
}
