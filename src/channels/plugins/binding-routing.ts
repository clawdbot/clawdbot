/**
 * Channel binding route resolver.
 *
 * Applies configured and runtime conversation bindings to agent route resolution.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import {
  getSessionBindingService,
  inspectSessionBindingByConversation,
  type ConversationRef,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { isPluginOwnedBindingMetadata } from "../../plugins/conversation-binding-metadata.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import { deriveLastRoutePolicy } from "../../routing/resolve-route.js";
import {
  isUnscopedSessionKeySentinel,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { isCronRunSessionKey } from "../../sessions/session-key-utils.js";
import { ensureConfiguredBindingTargetReady } from "./binding-targets.js";
import type { ConfiguredBindingResolution } from "./binding-types.js";
import { resolveConfiguredBinding } from "./configured-binding-registry.js";

const CONFIGURED_BINDING_ROUTE_READY_TIMEOUT_MS = 30_000;

/**
 * Route resolution after applying a configured channel binding.
 */
export type ConfiguredBindingRouteResult = {
  bindingResolution: ConfiguredBindingResolution | null;
  route: ResolvedAgentRoute;
  boundSessionKey?: string;
  boundAgentId?: string;
};

/**
 * Route resolution after applying a runtime conversation binding record.
 */
export type RuntimeConversationBindingRouteResult = {
  /** False only when the authoritative channel-owned binding store is temporarily unavailable. */
  bindingOwnerAvailable?: boolean;
  bindingRecord: SessionBindingRecord | null;
  route: ResolvedAgentRoute;
  boundSessionKey?: string;
  boundAgentId?: string;
  pluginId?: string;
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
  const boundAgentId = resolveAgentIdFromSessionKey(
    boundSessionKey,
    bindingResolution.statefulTarget.agentId,
  );
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

/**
 * Rewrites an agent route using a persisted runtime conversation binding, when applicable.
 */
export function resolveRuntimeConversationBindingRoute(
  params: {
    route: ResolvedAgentRoute;
    /** Set false for read-only ownership checks that must not extend binding liveness. */
    touchBinding?: boolean;
  } & ConfiguredBindingRouteConversationInput,
): RuntimeConversationBindingRouteResult {
  const inspection = inspectSessionBindingByConversation(
    resolveConfiguredBindingConversationRef(params),
  );
  if (inspection.status === "unavailable") {
    return {
      bindingOwnerAvailable: false,
      bindingRecord: null,
      route: params.route,
    };
  }
  const bindingRecord = inspection.binding;
  const boundSessionKey = bindingRecord?.targetSessionKey?.trim();
  if (!bindingRecord || !boundSessionKey) {
    return {
      bindingOwnerAvailable: true,
      bindingRecord: null,
      route: params.route,
    };
  }

  if (isCronRunSessionKey(boundSessionKey)) {
    // Cron run sessions are isolated and short-lived; never route live channel traffic into them.
    logVerbose(
      `ignored runtime conversation binding ${bindingRecord.bindingId} to isolated cron run session ${boundSessionKey}`,
    );
    return {
      bindingOwnerAvailable: true,
      bindingRecord: null,
      route: params.route,
    };
  }

  if (params.touchBinding !== false) {
    getSessionBindingService().touch(
      bindingRecord.bindingId,
      undefined,
      bindingRecord.conversation,
    );
  }
  const pluginId = isPluginOwnedBindingMetadata(bindingRecord.metadata)
    ? bindingRecord.metadata.pluginId.trim()
    : undefined;
  if (pluginId) {
    // Plugin-owned binding records are observed but not route-rewritten by core; the owning
    // plugin is responsible for its runtime target handoff.
    return {
      bindingOwnerAvailable: true,
      bindingRecord,
      pluginId,
      route: params.route,
    };
  }

  // Only canonical sentinels can borrow an agent owner. Opaque targets require plugin metadata.
  const boundAgentId = resolveAgentIdFromSessionKey(
    boundSessionKey,
    isUnscopedSessionKeySentinel(boundSessionKey)
      ? (normalizeOptionalString(bindingRecord.metadata?.agentId) ?? params.route.agentId)
      : undefined,
  );
  return {
    bindingOwnerAvailable: true,
    bindingRecord,
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
