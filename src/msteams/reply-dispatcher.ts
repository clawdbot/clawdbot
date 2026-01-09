import { resolveEffectiveMessagesConfig } from "../agents/identity.js";
import { createReplyDispatcherWithTyping } from "../auto-reply/reply/reply-dispatcher.js";
import type { ClawdbotConfig, MSTeamsReplyStyle } from "../config/types.js";
import { danger } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import type { StoredConversationReference } from "./conversation-store.js";
import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
} from "./errors.js";
import {
  type MSTeamsAdapter,
  renderReplyPayloadsToMessages,
  sendMSTeamsMessages,
} from "./messenger.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

export function createMSTeamsReplyDispatcher(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  log: MSTeamsMonitorLogger;
  adapter: MSTeamsAdapter;
  appId: string;
  conversationRef: StoredConversationReference;
  context: MSTeamsTurnContext;
  replyStyle: MSTeamsReplyStyle;
  textLimit: number;
}) {
  const sendTypingIndicator = async () => {
    try {
      await params.context.sendActivities([{ type: "typing" }]);
    } catch {
      // Typing indicator is best-effort.
    }
  };

  return createReplyDispatcherWithTyping({
    responsePrefix: resolveEffectiveMessagesConfig(params.cfg, params.agentId)
      .responsePrefix,
    deliver: async (payload) => {
      const messages = renderReplyPayloadsToMessages([payload], {
        textChunkLimit: params.textLimit,
        chunkText: true,
        mediaMode: "split",
      });
      await sendMSTeamsMessages({
        replyStyle: params.replyStyle,
        adapter: params.adapter,
        appId: params.appId,
        conversationRef: params.conversationRef,
        context: params.context,
        messages,
        // Enable default retry/backoff for throttling/transient failures.
        retry: {},
        onRetry: (event) => {
          params.log.debug("retrying send", {
            replyStyle: params.replyStyle,
            ...event,
          });
        },
      });
    },
    onError: (err, info) => {
      const errMsg = formatUnknownError(err);
      const classification = classifyMSTeamsSendError(err);
      const hint = formatMSTeamsSendErrorHint(classification);
      params.runtime.error?.(
        danger(
          `msteams ${info.kind} reply failed: ${errMsg}${hint ? ` (${hint})` : ""}`,
        ),
      );
      params.log.error("reply failed", {
        kind: info.kind,
        error: errMsg,
        classification,
        hint,
      });
    },
    onReplyStart: sendTypingIndicator,
  });
}
