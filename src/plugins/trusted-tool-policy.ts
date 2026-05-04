import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "./hook-types.js";
import { getPluginSessionExtensionStateSync } from "./host-hook-state.js";
import type { PluginJsonValue } from "./host-hooks.js";
import { getActivePluginRegistry } from "./runtime.js";

export async function runTrustedToolPolicies(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
  options?: { config?: OpenClawConfig },
): Promise<PluginHookBeforeToolCallResult | undefined> {
  const policies = getActivePluginRegistry()?.trustedToolPolicies ?? [];
  let adjustedParams = event.params;
  let hasAdjustedParams = false;
  let approval: PluginHookBeforeToolCallResult["requireApproval"];
  const sessionExtensionStateCache = new Map<string, Record<string, PluginJsonValue> | undefined>();
  let resolvedSessionConfig: OpenClawConfig | undefined = options?.config;
  let didResolveSessionConfig = Boolean(options?.config);
  const resolveSessionConfig = (): OpenClawConfig | undefined => {
    if (!didResolveSessionConfig) {
      didResolveSessionConfig = true;
      try {
        resolvedSessionConfig = getRuntimeConfig();
      } catch {
        resolvedSessionConfig = undefined;
      }
    }
    return resolvedSessionConfig;
  };
  for (const registration of policies) {
    const policyCtx: PluginHookToolContext = {
      ...ctx,
      // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Plugin callers type JSON reads by namespace.
      getSessionExtension: <T extends PluginJsonValue = PluginJsonValue>(namespace: string) => {
        const normalizedNamespace = namespace.trim();
        const cacheKey = registration.pluginId;
        if (!sessionExtensionStateCache.has(cacheKey)) {
          const config = ctx.sessionKey ? resolveSessionConfig() : undefined;
          sessionExtensionStateCache.set(
            cacheKey,
            config
              ? getPluginSessionExtensionStateSync({
                  cfg: config,
                  pluginId: registration.pluginId,
                  sessionKey: ctx.sessionKey,
                })
              : undefined,
          );
        }
        const pluginState = sessionExtensionStateCache.get(cacheKey);
        if (!normalizedNamespace || !pluginState) {
          return undefined;
        }
        return pluginState[normalizedNamespace] as T | undefined;
      },
    };
    const decision = await registration.policy.evaluate(
      { ...event, params: adjustedParams },
      policyCtx,
    );
    if (!decision) {
      continue;
    }
    if ("allow" in decision && decision.allow === false) {
      return {
        block: true,
        blockReason: decision.reason ?? `blocked by ${registration.policy.id}`,
      };
    }
    // `block: true` is terminal; normalize a missing blockReason to a deterministic
    // reason so downstream diagnostics match the `{ allow: false }` path above.
    if ("block" in decision && decision.block === true) {
      return {
        ...decision,
        blockReason: decision.blockReason ?? `blocked by ${registration.policy.id}`,
      };
    }
    // `block: false` is a no-op (matches the regular `before_tool_call` hook
    // pipeline) — it does NOT short-circuit the policy chain. Params and
    // approvals are remembered so later trusted policies can still inspect or
    // block the final call.
    if ("params" in decision && decision.params) {
      adjustedParams = decision.params;
      hasAdjustedParams = true;
    }
    if ("requireApproval" in decision && decision.requireApproval && !approval) {
      approval = decision.requireApproval;
    }
  }
  if (!hasAdjustedParams && !approval) {
    return undefined;
  }
  return {
    ...(hasAdjustedParams ? { params: adjustedParams } : {}),
    ...(approval ? { requireApproval: approval } : {}),
  };
}
