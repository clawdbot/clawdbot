import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/types";
import type { CoreConfig } from "../types.js";
import {
  bindingMatchesActiveSessionIncarnation,
  getClickClackDiscussionBindingStore,
} from "./binding-store.js";
import { resolveDiscussionBindingAccount } from "./eligibility.js";
import { isDiscussionSessionKey } from "./naming.js";
import { isClickClackDiscussionChannelRevoked } from "./revoked-channel-store.js";

const TARGETED_SESSION_TOOLS = new Set(["sessions_history", "sessions_send", "session_status"]);

function blockedResult(): PluginHookBeforeToolCallResult {
  return {
    block: true,
    blockReason: `ClickClack discussion sessions may use ${[...TARGETED_SESSION_TOOLS].join(", ")} only with their attached main session.`,
  };
}

export function isClickClackDiscussionSessionTarget(params: {
  runtime: PluginRuntime;
  requesterSessionKey: string;
  targetSessionKey: string;
}) {
  const matched = getClickClackDiscussionBindingStore(params.runtime).getByDiscussionSession(
    params.requesterSessionKey,
  );
  if (
    matched &&
    matched.sessionKey === params.targetSessionKey &&
    !isClickClackDiscussionChannelRevoked({
      runtime: params.runtime,
      serverBaseUrl: matched.binding.serverBaseUrl,
      channelId: matched.binding.channelId,
    }) &&
    !matched.binding.archived &&
    bindingMatchesActiveSessionIncarnation(params.runtime, matched.sessionKey, matched.binding) &&
    resolveDiscussionBindingAccount(params.runtime.config.current() as CoreConfig, matched.binding)
      .state === "active"
  ) {
    return matched;
  }
  return undefined;
}

/** Restricts a discussion side session's session tools to its attached main session. */
export function enforceClickClackDiscussionToolTarget(params: {
  runtime: PluginRuntime;
  event: PluginHookBeforeToolCallEvent;
  context: PluginHookToolContext;
}): PluginHookBeforeToolCallResult | undefined {
  const callerSessionKey = params.context.sessionKey;
  if (!callerSessionKey) {
    return undefined;
  }
  const { toolName } = params.event;
  if (toolName !== "session_status" && !toolName.startsWith("sessions_")) {
    return undefined;
  }
  const matched = getClickClackDiscussionBindingStore(params.runtime).getByDiscussionSession(
    callerSessionKey,
  );
  if (!matched) {
    return isDiscussionSessionKey(callerSessionKey) ? blockedResult() : undefined;
  }
  const accountCanObserve = Boolean(
    isClickClackDiscussionSessionTarget({
      runtime: params.runtime,
      requesterSessionKey: callerSessionKey,
      targetSessionKey: matched.sessionKey,
    }),
  );
  const targetsMain =
    accountCanObserve &&
    TARGETED_SESSION_TOOLS.has(toolName) &&
    params.event.params.sessionKey === matched.sessionKey;
  const usesAlternateSendTarget =
    toolName === "sessions_send" &&
    (params.event.params.label !== undefined || params.event.params.agentId !== undefined);
  const mutatesStatus = toolName === "session_status" && params.event.params.model !== undefined;
  const selectsHistoryIncarnation =
    toolName === "sessions_history" && params.event.params.sessionId !== undefined;
  if (targetsMain && !usesAlternateSendTarget && !mutatesStatus && !selectsHistoryIncarnation) {
    return undefined;
  }
  return blockedResult();
}
