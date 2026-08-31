import { FAILOVER_REASONS, type FailoverReason } from "../agents/failover/signal.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveProviderHookPlugin,
  resolveProviderPluginsForHooks,
} from "./provider-hook-runtime.js";
import type { ProviderFailoverErrorContext, ProviderPlugin } from "./types.js";

function isFailoverReason(value: unknown): value is FailoverReason {
  return typeof value === "string" && FAILOVER_REASONS.some((reason) => reason === value);
}

// Resolver code is linked eagerly; provider materialization remains inside the
// existing scoped/cold lookup, after the classifier's consultation gate.
export function classifyProviderFailoverSignalWithPlugin(params: {
  provider?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFailoverErrorContext;
}) {
  const plugins = resolveProviderPluginsForScopedHook(params);
  for (const plugin of plugins) {
    if (plugin.matchesContextOverflowError?.(params.context)) {
      return "context_overflow";
    }
    const reason: unknown = plugin.classifyFailoverReason?.(params.context);
    if (reason) {
      // Plugin results cross a runtime boundary; types do not validate external hooks.
      return isFailoverReason(reason) ? reason : undefined;
    }
  }
  return undefined;
}

function resolveProviderPluginsForScopedHook(params: {
  provider?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFailoverErrorContext;
}): ProviderPlugin[] {
  if (!params.provider) {
    return resolveProviderPluginsForHooks(params);
  }
  const plugin = resolveProviderHookPlugin({ ...params, provider: params.provider });
  if (plugin) {
    return [plugin];
  }
  if (hasStructuredFailoverDescriptor(params.context)) {
    return [];
  }
  // Custom provider ids may only name their canonical API in config, and the
  // legacy message classifier only has the runtime id here. Preserve its old
  // broad hook scan for descriptor-free messages, but do not let unrelated
  // hooks override structured HTTP/auth signals.
  return resolveProviderPluginsForHooks(params);
}

function hasStructuredFailoverDescriptor(context: ProviderFailoverErrorContext): boolean {
  return (
    context.status !== undefined || context.code !== undefined || context.errorType !== undefined
  );
}
