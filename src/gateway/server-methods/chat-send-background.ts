import { createHash } from "node:crypto";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { stripInlineDirectiveTagsForDisplay } from "../../utils/directive-tags.js";
import {
  isDashboardSessionTitleCandidate,
  maybeGenerateDashboardSessionTitle,
} from "../dashboard-session-title.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestContext } from "./types.js";

export function resolveWebchatPromptCacheKey(params: {
  agentId: string;
  model: string;
  provider: string;
  sessionKey: string;
}): string {
  const digest = createHash("sha256")
    .update(
      [
        "v1",
        params.provider.trim().toLowerCase(),
        params.model.trim(),
        normalizeAgentId(params.agentId),
        params.sessionKey,
      ].join("\0"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
  return `openclaw-webchat-${digest}`;
}

export function scheduleChatDashboardSessionTitle(params: {
  admittedSessionId: string;
  agentId: string;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  entry: ReturnType<typeof loadSessionEntry>["entry"];
  rawMessage: string;
  sessionKey: string;
  sessionLoadOptions: Parameters<typeof loadSessionEntry>[1];
  storePath: string;
}): void {
  const titleSource = stripInlineDirectiveTagsForDisplay(params.rawMessage).text;
  if (
    !isDashboardSessionTitleCandidate({ sessionKey: params.sessionKey, userMessage: titleSource })
  ) {
    return;
  }
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    const titleEntry =
      params.entry?.sessionId === params.admittedSessionId
        ? params.entry
        : loadSessionEntry(params.sessionKey, params.sessionLoadOptions).entry;
    const titleSessionId = titleEntry?.sessionId;
    if (!titleSessionId) {
      return;
    }
    const updated = await maybeGenerateDashboardSessionTitle({
      cfg: params.cfg,
      agentId: params.agentId,
      entry: titleEntry,
      sessionId: titleSessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      userMessage: titleSource,
    });
    if (updated) {
      emitSessionsChanged(params.context, {
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        reason: "chat.title",
      });
    }
  }).catch((err: unknown) => {
    params.context.logGateway.warn(
      `dashboard session title generation failed: ${formatForLog(err)}`,
    );
  });
}
