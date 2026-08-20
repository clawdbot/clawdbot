/**
 * Channel binding route resolver.
 *
 * Applies configured and runtime conversation bindings to agent route resolution.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import {
  getSessionBindingService,
  type ConversationRef,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import { deriveLastRoutePolicy } from "../../routing/resolve-route.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { isCronRunSessionKey } from "../../sessions/session-key-utils.js";
import { ensureConfiguredBindingTargetReady } from "./binding-targets.js";
import type { ConfiguredBindingResolution } from "./binding-types.js";
import { resolveConfiguredBinding } from "./configured-binding-registry.js";

const CONFIGURED_BINDING_ROUTE_READY_TIMEOUT_MS = 30_000;

export type ConfiguredBindingRouteResult = {
  bindingResolution: ConfiguredBindingResolution | null;
  route: ResolvedAgentRoute;
  boundSessionKey?: string;
  boundAgentId?: string;
};

export type RuntimeConversationBindingRouteResult = {
  bindingRecord: SessionBindingRecord | null;
  route: ResolvedAgentRoute;
  boundSessionKey?: string;
  boundAgentId?: string;
};

type ConfiguredBindingRouteConversationInput =
  | {
      conversation: ConversationRef;
    }
  | {
      channel: string;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
    };

function resolveConfiguredBindingConversationRef(
  params: ConfiguredBindingRouteConversationInput,
): ConversationRef {
  if ("conversation" in params) {
    return params.conversation;
  }
  return {
    channel: params.channel,
    accountId: params.accountId,
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  };
}

function isPluginOwnedRuntimeBindingRecord(record: SessionBindingRecord | null): boolean {
  const metadata = record?.metadata;
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  return (
    metadata.pluginBindingOwner === "plugin" &&
    typeof metadata.pluginId === "string" &&
    typeof metadata.pluginRoot === "string"
  );
}

export function resolveRuntimeConversationBindingRouteWithFallback(params: {
  conversation: ConversationRef;
  resolveFallbackRoute: () => ResolvedAgentRoute;
  resolveBoundRoute: (agentId: string) => ResolvedAgentRoute;
}): RuntimeConversationBindingRouteResult {
  const bindingRecord = getSessionBindingService().resolveByConversation(params.conversation);
  const boundSessionKey = bindingRecord?.targetSessionKey?.trim();
  if (!bindingRecord || !boundSessionKey) {
    return { bindingRecord: null, route: params.resolveFallbackRoute() };
  }
  if (isCronRunSessionKey(boundSessionKey)) {
    // Cron run sessions are isolated and short-lived; never refresh or route live traffic to them.
    logVerbose(
      `ignored runtime conversation binding ${bindingRecord.bindingId} to isolated cron run session ${boundSessionKey}`,
    );
    return { bindingRecord: null, route: params.resolveFallbackRoute() };
  }

  getSessionBindingService().touch(bindingRecord.bindingId);
  if (isPluginOwnedRuntimeBindingRecord(bindingRecord)) {
    return { bindingRecord, route: params.resolveFallbackRoute() };
  }

  const boundAgentId = resolveAgentIdFromSessionKey(boundSessionKey);
  const route = params.resolveBoundRoute(boundAgentId);
  return {
    bindingRecord,
    boundSessionKey,
    boundAgentId,
    route: {
      ...route,
      agentId: boundAgentId,
      sessionKey: boundSessionKey,
      lastRoutePolicy: deriveLastRoutePolicy({
        sessionKey: boundSessionKey,
        mainSessionKey: route.mainSessionKey,
      }),
      matchedBy: "binding.channel",
    },
  };
}

/**
 * Rewrites an agent route when the current conversation matches a configured binding.
 */
export function resolveConfiguredBindingRoute(
  params: {
    cfg: OpenClawConfig;
    route: ResolvedAgentRoute;
  } & ConfiguredBindingRouteConversationInput,
): ConfiguredBindingRouteResult {
  const bindingResolution =
    resolveConfiguredBinding({
      cfg: params.cfg,
      conversation: resolveConfiguredBindingConversationRef(params),
    }) ?? null;
  if (!bindingResolution) {
    return {
      bindingResolution: null,
      route: params.route,
    };
  }

  const boundSessionKey = bindingResolution.statefulTarget.sessionKey.trim();
  if (!boundSessionKey) {
    return {
      bindingResolution,
      route: params.route,
    };
  }
  const boundAgentId =
    resolveAgentIdFromSessionKey(boundSessionKey) || bindingResolution.statefulTarget.agentId;
  // Configured bindings own the session key, so recompute last-route policy against that target
  // before downstream delivery records the route.
  return {
    bindingResolution,
    boundSessionKey,
    boundAgentId,
    route: {
      ...params.route,
      sessionKey: boundSessionKey,
      agentId: boundAgentId,
      lastRoutePolicy: deriveLastRoutePolicy({
        sessionKey: boundSessionKey,
        mainSessionKey: params.route.mainSessionKey,
      }),
      matchedBy: "binding.channel",
    },
  };
}

export function resolveRuntimeConversationBindingRoute(
  params: {
    route: ResolvedAgentRoute;
  } & ConfiguredBindingRouteConversationInput,
): RuntimeConversationBindingRouteResult {
  return resolveRuntimeConversationBindingRouteWithFallback({
    conversation: resolveConfiguredBindingConversationRef(params),
    resolveFallbackRoute: () => params.route,
    resolveBoundRoute: () => params.route,
  });
}

/**
 * Ensures a configured binding target is ready without blocking route resolution indefinitely.
 */
export async function ensureConfiguredBindingRouteReady(params: {
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const readyPromise = ensureConfiguredBindingTargetReady(params);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutToken = Symbol("configured-binding-route-ready-timeout");
  const timeoutPromise = new Promise<typeof timeoutToken>((resolve) => {
    timer = setTimeout(() => resolve(timeoutToken), CONFIGURED_BINDING_ROUTE_READY_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    const result = await Promise.race([readyPromise, timeoutPromise]);
    if (result !== timeoutToken) {
      return result;
    }
    // Let late driver work finish for diagnostics, but return a bounded failure to the caller.
    logVerbose(
      `configured binding route ready check timed out after ${
        CONFIGURED_BINDING_ROUTE_READY_TIMEOUT_MS / 1_000
      }s`,
    );
    readyPromise.then(
      (lateResult) =>
        logVerbose(
          `configured binding route ready check settled after timeout (ok=${lateResult.ok})`,
        ),
      (err: unknown) =>
        logVerbose(`configured binding route ready check rejected after timeout: ${String(err)}`),
    );
    return { ok: false, error: "Configured binding route ready check timed out" };
  } finally {
    clearTimeout(timer);
  }
}
