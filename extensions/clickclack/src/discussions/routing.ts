import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { CoreConfig } from "../types.js";
import { hasPendingDiscussionOpenForDestination } from "./binding-generation.js";
import {
  attachBindingToCurrentActiveSession,
  getClickClackDiscussionBindingStore,
  type ClickClackDiscussionBinding,
} from "./binding-store.js";
import { resolveDiscussionBindingAccount } from "./eligibility.js";
import { discussionSessionKey } from "./naming.js";
import { isClickClackDiscussionChannelRevoked } from "./revoked-channel-store.js";

type ClickClackDiscussionRoute = {
  agentId: string;
  sessionKey: string;
  systemPrompt: string;
};

type ClickClackDiscussionRouteResolution =
  | { state: "unbound" }
  | { state: "revoked" }
  | { state: "active"; route: ClickClackDiscussionRoute };

export function resolveClickClackDiscussionRoute(params: {
  runtime: PluginRuntime;
  config: CoreConfig;
  accountId: string;
  serverBaseUrl: string;
  workspaceId: string;
  channelId: string;
}): ClickClackDiscussionRouteResolution {
  if (isClickClackDiscussionChannelRevoked(params)) {
    return { state: "revoked" };
  }
  const store = getClickClackDiscussionBindingStore(params.runtime);
  const matched = store.getByChannel(params.serverBaseUrl, params.channelId);
  if (!matched) {
    return {
      state: hasPendingDiscussionOpenForDestination(params) ? "revoked" : "unbound",
    };
  }
  if (matched.binding.accountId !== params.accountId) {
    return { state: "revoked" };
  }
  if (matched.binding.serverBaseUrl !== params.serverBaseUrl.replace(/\/+$/u, "")) {
    return { state: "revoked" };
  }
  if (resolveDiscussionBindingAccount(params.config, matched.binding).state !== "active") {
    return { state: "revoked" };
  }
  let binding: ClickClackDiscussionBinding | undefined;
  try {
    binding = attachBindingToCurrentActiveSession({
      runtime: params.runtime,
      store,
      sessionKey: matched.sessionKey,
      binding: matched.binding,
    });
  } catch (error) {
    params.runtime.logging
      .getChildLogger({ plugin: "clickclack", feature: "discussions" })
      .warn(
        `discussion attachment refresh failed for channel ${params.channelId}: ${String(error)}`,
      );
    return { state: "revoked" };
  }
  if (!binding) {
    return { state: "revoked" };
  }
  const sessionKey = discussionSessionKey({
    runtime: params.runtime,
    agentId: binding.agentId,
    mainSessionKey: matched.sessionKey,
    sessionId: binding.sessionId,
    accountId: params.accountId,
    serverBaseUrl: binding.serverBaseUrl,
    channelId: binding.channelId,
    externalRef: binding.externalRef,
  });
  if (!sessionKey) {
    return { state: "revoked" };
  }
  return {
    state: "active",
    route: {
      agentId: binding.agentId,
      sessionKey,
      systemPrompt: [
        "You are the side agent for a ClickClack discussion attached to an OpenClaw session.",
        `The main session key is ${matched.sessionKey}.`,
        "Observe it with sessions_history and session_status (using changesSince for incremental checks).",
        "Use sessions_send to relay or steer the main session only when the humans in this discussion ask you to.",
        "These session tools are host-scoped to the attached main session; do not attempt session discovery or alternate targets.",
      ].join(" "),
    },
  };
}
