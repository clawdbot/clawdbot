/**
 * Slack-side emission of the `message_sent` plugin hook.
 *
 * Mirrors the Telegram pattern in `extensions/telegram/src/bot/delivery.replies.ts`
 * (`buildTelegramSentHookContext`, `emitMessageSentHooks`, `emitTelegramMessageSentHooks`).
 *
 * Without this, plugins observing `message_sent` see Telegram outbound but not
 * Slack outbound — even though `docs/plugins/hooks.md` documents the hook as
 * firing for all successful outbound deliveries.
 */
import {
  buildCanonicalSentMessageHookContext,
  createInternalHookEvent,
  fireAndForgetHook,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";

type EmitSlackMessageSentHookParams = {
  /** Optional canonical session key. When set, the internal `message:sent` hook fires too. */
  sessionKeyForInternalHooks?: string;
  /** Slack target (channel ID `C…`, DM channel ID `D…`, group `G…`, or user ID `U…`). */
  to: string;
  accountId?: string | null;
  /** The outbound content that was sent. Mirrors `MessageSentEvent.content`. */
  content: string;
  success: boolean;
  error?: string;
  /** Slack message `ts` returned by `chat.postMessage` on success. */
  messageId?: string;
  isGroup?: boolean;
  groupId?: string;
};

function buildSlackSentHookContext(params: EmitSlackMessageSentHookParams) {
  return buildCanonicalSentMessageHookContext({
    to: params.to,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: "slack",
    accountId: params.accountId ?? undefined,
    conversationId: params.to,
    // Mirror the canonical session key into the `message_sent` hook context so
    // plugins observing both `message_sending` and `message_sent` see the same
    // `sessionKey` (and it matches the value the internal `message:sent` hook
    // fires with). This matches the shared outbound emitter in
    // `src/infra/outbound/deliver.ts`.
    sessionKey: params.sessionKeyForInternalHooks,
    messageId: params.messageId,
    isGroup: params.isGroup,
    groupId: params.groupId,
  });
}

function emitInternalSlackMessageSentHook(params: EmitSlackMessageSentHookParams): void {
  if (!params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildSlackSentHookContext(params);
  fireAndForgetHook(
    triggerInternalHook(
      createInternalHookEvent(
        "message",
        "sent",
        params.sessionKeyForInternalHooks,
        toInternalMessageSentContext(canonical),
      ),
    ),
    "slack: message:sent internal hook failed",
  );
}

function emitMessageSentHooks(
  params: EmitSlackMessageSentHookParams & {
    hookRunner: ReturnType<typeof getGlobalHookRunner>;
    enabled: boolean;
  },
): void {
  if (!params.enabled && !params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildSlackSentHookContext(params);
  if (params.enabled) {
    fireAndForgetHook(
      Promise.resolve(
        params.hookRunner!.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      ),
      "slack: message_sent plugin hook failed",
    );
  }
  emitInternalSlackMessageSentHook(params);
}

/**
 * Fire both the plugin `message_sent` hook and (if a session key is supplied)
 * the internal `message:sent` hook for a successful or failed Slack outbound
 * delivery.
 *
 * Safe to call after every `chat.postMessage` — the function self-gates on
 * `hookRunner.hasHooks("message_sent")` so plugins not observing the hook
 * incur no cost.
 */
export function emitSlackMessageSentHooks(params: EmitSlackMessageSentHookParams): void {
  const hookRunner = getGlobalHookRunner();
  emitMessageSentHooks({
    ...params,
    hookRunner,
    enabled: hookRunner?.hasHooks("message_sent") ?? false,
  });
}
